// Product-purchase → GHL writeback. Called from the Stripe webhook
// when a product_purchases row flips to 'succeeded'.
//
// Steps:
//   1. Look up the GHL contact by email (case-insensitive).
//   2. If found: write the configured custom field to today's date,
//      attach an optional tag, and record the contact ID on the
//      purchase row so future events can find it.
//   3. If NOT found: optionally create the contact (we always create
//      so the school has a CRM record of the buyer).
//   4. Trigger an optional GHL workflow (if `ghl_workflow_id` is set).
//
// Everything is best-effort — webhook handlers should not throw on
// GHL failures (Stripe will retry the event forever if we 500, but
// the underlying charge already succeeded).

import { loadGhlClient, type GhlClient } from './client';
import { searchContacts } from './contacts';
import { updateContactCustomFields } from './writes';
import { query } from '@/lib/db';

export interface ProductPurchaseLite {
  id: string;
  school_id: string;
  product_id: string;
  purchaser_email: string | null;
  purchaser_name: string | null;
  purchaser_phone: string | null;
  total_amount_cents: number;
  ghl_contact_id: string | null;
}

export interface ProductLite {
  id: string;
  name: string;
  ghl_writeback_field: string | null;
  ghl_workflow_id: string | null;
}

export async function writebackProductPurchaseToGhl(
  purchaseId: string,
): Promise<{ ok: boolean; reason?: string; contactId?: string }> {
  // Load purchase + product config
  const { rows } = await query<ProductPurchaseLite & ProductLite & { product_name: string }>(
    `SELECT pp.id, pp.school_id, pp.product_id,
            pp.purchaser_email, pp.purchaser_name, pp.purchaser_phone,
            pp.total_amount_cents, pp.ghl_contact_id,
            sp.id AS product_id, sp.name AS product_name,
            sp.ghl_writeback_field, sp.ghl_workflow_id
       FROM product_purchases pp
       JOIN school_products sp ON sp.id = pp.product_id
      WHERE pp.id = $1`,
    [purchaseId],
  );
  if (rows.length === 0) return { ok: false, reason: 'purchase_not_found' };
  const p = rows[0];

  if (!p.purchaser_email) return { ok: false, reason: 'no_email_on_purchase' };

  let client: GhlClient;
  try {
    client = await loadGhlClient(p.school_id);
  } catch (e) {
    return { ok: false, reason: `ghl_client: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 1. Try to find an existing contact by email
  let contactId = p.ghl_contact_id;
  if (!contactId) {
    try {
      const found = await searchContacts({
        client,
        filters: [{ field: 'email', operator: 'eq', value: p.purchaser_email.toLowerCase().trim() }],
        pageLimit: 5,
        maxPages: 1,
      });
      if (found.length > 0) contactId = found[0].id;
    } catch (e) {
      // Search failed — continue with create fallback
      console.warn('[product-writeback] search failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // 2. If still no contact, create one
  if (!contactId) {
    try {
      const [firstName, ...lastParts] = (p.purchaser_name ?? '').trim().split(/\s+/);
      const lastName = lastParts.join(' ') || undefined;
      const { data } = await client.axios.post<{ contact?: { id: string } }>('/contacts/', {
        locationId: client.locationId,
        email: p.purchaser_email.toLowerCase().trim(),
        firstName: firstName || undefined,
        lastName,
        phone: p.purchaser_phone || undefined,
        source: 'Growth Suite — Product Purchase',
        tags: ['gs-product-buyer'],
      });
      contactId = data.contact?.id ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 422 / 409 likely means a contact already exists with that email
      // but our search missed it (different normalization). Try once more.
      console.warn('[product-writeback] create failed:', msg);
      if (/already exists|duplicate/i.test(msg)) {
        try {
          const found = await searchContacts({
            client,
            filters: [{ field: 'email', operator: 'eq', value: p.purchaser_email.toLowerCase().trim() }],
            pageLimit: 5, maxPages: 1,
          });
          if (found.length > 0) contactId = found[0].id;
        } catch { /* swallow */ }
      }
      if (!contactId) return { ok: false, reason: `ghl_create_failed: ${msg}` };
    }
  }

  // 3. Stamp contact ID back onto purchase row
  if (contactId && contactId !== p.ghl_contact_id) {
    await query(
      `UPDATE product_purchases SET ghl_contact_id = $1, updated_at = now() WHERE id = $2`,
      [contactId, purchaseId],
    );
  }

  // 4. Write the per-product writeback field (date stamp of purchase)
  if (p.ghl_writeback_field && contactId) {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const result = await updateContactCustomFields(client, contactId, {
        [p.ghl_writeback_field]: today,
      });
      if (result.skipped.length > 0) {
        console.warn(
          `[product-writeback] field key ${p.ghl_writeback_field} not found in school's GHL — skipped`,
        );
      }
    } catch (e) {
      console.warn('[product-writeback] custom field update failed:', e instanceof Error ? e.message : String(e));
      // Non-fatal — the purchase still succeeded
    }
  }

  // 5. Trigger optional workflow
  if (p.ghl_workflow_id && contactId) {
    try {
      await client.axios.post(`/contacts/${contactId}/workflow/${p.ghl_workflow_id}`, {});
    } catch (e) {
      console.warn('[product-writeback] workflow trigger failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Always tag the contact so the school can segment Growth-Suite buyers
  try {
    await client.axios.post(`/contacts/${contactId}/tags`, {
      tags: ['gs-product-buyer'],
    });
  } catch {
    // Tagging is a nice-to-have, don't surface failures
  }

  return { ok: true, contactId: contactId ?? undefined };
}
