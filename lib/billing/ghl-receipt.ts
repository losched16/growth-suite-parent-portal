// Payment receipts via GoHighLevel.
//
// When a school sets school_payment_config.ghl_receipt_webhook_url, we
// POST payment success/failure events to that GHL workflow inbound-
// webhook URL. The school then builds the actual email in GHL's
// workflow builder using their own template + merge fields — they own
// the template, edit it anytime, and see receipts in the contact's
// conversation history.
//
// Mirrors the form webhook fan-out in lib/forms/post-submit-effects.ts:
// 5s timeout, fire-and-forget, never throws into the payment flow.
//
// The payload is FLAT and merge-field-friendly so GHL can map fields
// like {{inboundWebhookRequest.amount_formatted}} directly into the
// email. Contact identifiers (email/phone/ghl_contact_id) are included
// so the workflow can resolve the right contact.

import { query } from '@/lib/db';

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export type PaymentEvent = 'payment.succeeded' | 'payment.failed';

interface GhlReceiptRow {
  webhook_url: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_title: string;
  school_id: string;
  school_name: string;
  ghl_location_id: string | null;
  family_id: string;
  amount_cents: number;
  pm_brand: string | null;
  pm_last4: string | null;
  pm_type: string | null;
  parent_first: string | null;
  parent_last: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  ghl_contact_id: string | null;
}

// Pull everything the GHL payload needs in one query: the payment +
// invoice + school (incl. the configured webhook url) + the family's
// PRIMARY active parent (the one the receipt should address / match in
// GHL).
async function loadForGhl(paymentIntentId: string): Promise<GhlReceiptRow | null> {
  const { rows } = await query<GhlReceiptRow>(
    `SELECT cfg.ghl_receipt_webhook_url AS webhook_url,
            p.invoice_id, i.invoice_number, i.title AS invoice_title,
            p.school_id, s.name AS school_name, s.ghl_location_id,
            p.family_id, p.amount_cents,
            pm.brand AS pm_brand, pm.last4 AS pm_last4, pm.type AS pm_type,
            pp.first_name AS parent_first, pp.last_name AS parent_last,
            pp.email AS parent_email, pp.phone AS parent_phone,
            pp.ghl_contact_id
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN schools  s ON s.id = p.school_id
       LEFT JOIN school_payment_config cfg ON cfg.school_id = p.school_id
       LEFT JOIN payment_methods pm ON pm.stripe_payment_method_id = p.stripe_payment_method_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, email, phone, ghl_contact_id
           FROM parents
          WHERE family_id = p.family_id AND school_id = p.school_id AND status = 'active'
          ORDER BY is_primary DESC, created_at ASC
          LIMIT 1
       ) pp ON true
      WHERE p.stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  return rows[0] ?? null;
}

function cardSummary(r: GhlReceiptRow): string {
  if (r.pm_brand) return `${r.pm_brand.toUpperCase()} ····${r.pm_last4 ?? ''}`.trim();
  return r.pm_type ?? 'saved method';
}

// Fire the payment event to the school's GHL webhook. No-op when the
// school hasn't configured a URL (most schools, until they opt in).
export async function sendPaymentEventToGhl(
  paymentIntentId: string,
  opts: { event: PaymentEvent; failureReason?: string | null },
): Promise<void> {
  try {
    const r = await loadForGhl(paymentIntentId);
    if (!r || !r.webhook_url) return; // not configured → silently skip

    const amountFormatted = `$${(r.amount_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const nowIso = new Date().toISOString();

    // FLAT payload — every value is a string/number GHL can drop into
    // an email template as a merge field with no nesting gymnastics.
    const payload = {
      event: opts.event,                              // 'payment.succeeded' | 'payment.failed'
      // contact identifiers (GHL matches/updates the contact off these)
      contact_id: r.ghl_contact_id ?? '',
      email: r.parent_email ?? '',
      phone: r.parent_phone ?? '',
      first_name: r.parent_first ?? '',
      last_name: r.parent_last ?? '',
      // payment details (merge fields for the email body)
      amount_formatted: amountFormatted,
      amount_cents: r.amount_cents,
      invoice_number: r.invoice_number,
      invoice_title: r.invoice_title,
      card_summary: cardSummary(r),
      payment_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      payment_date_iso: nowIso,
      school_name: r.school_name,
      receipt_url: `${PARENT_PORTAL_BASE}/billing/pay/${r.invoice_id}`,
      failure_reason: opts.failureReason ?? '',
      // routing context
      school_id: r.school_id,
      ghl_location_id: r.ghl_location_id ?? '',
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(r.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrowthSuite-PaymentWebhook/1' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) console.warn(`[ghl-receipt] ${opts.event} → webhook returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Never let a receipt failure roll back the payment-state update.
    console.warn('[ghl-receipt] failed:', err instanceof Error ? err.message : String(err));
  }
}
