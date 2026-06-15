// Best-effort GHL writeback when a parent sets their portal password.
//
// Why: the welcome-email workflow in GHL is scoped via a smart list
// filter on `contact.portal_password_set_at IS empty`. Without writing
// that timestamp back, the smart list never shrinks — every parent
// stays in the reminder cadence forever after they sign in.
//
// Strategy:
//   - Fire-and-forget. If the lookup fails or the GHL field doesn't
//     exist in the location yet, log + return. NEVER block / fail
//     the password-set flow.
//   - Only attempt when the parent has a linked ghl_contact_id.
//     Unmatched parents (~55% of Wooster currently) just skip silently.
//   - The custom field key is `portal_password_set_at`. Wooster admin
//     creates this in Settings → Custom Fields (Date/Time type) before
//     turning on the workflow. Until they do, this helper is a no-op.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { updateContactCustomFields } from '@/lib/ghl/writes';

export const PASSWORD_SET_AT_FIELD_KEY = 'portal_password_set_at';

export async function ghlWritebackPasswordSetAt(parentId: string): Promise<void> {
  try {
    const { rows } = await query<{ ghl_contact_id: string | null; school_id: string }>(
      `SELECT ghl_contact_id, school_id FROM parents WHERE id = $1`,
      [parentId],
    );
    const p = rows[0];
    if (!p) return;
    if (!p.ghl_contact_id) {
      // Parent isn't matched to a GHL contact yet. Common for ~55% of
      // existing Wooster parents until the sync re-pairs them.
      console.log(`[ghl-pw-writeback] skipped: no ghl_contact_id for parent ${parentId}`);
      return;
    }

    const client = await loadGhlClient(p.school_id);
    // GHL Date/Time fields accept ISO 8601 → send the same now() value
    // we just wrote to the DB.
    const value = new Date().toISOString();
    const result = await updateContactCustomFields(client, p.ghl_contact_id, {
      [PASSWORD_SET_AT_FIELD_KEY]: value,
    });
    if (result.updated === 0) {
      // Field doesn't exist in this location's custom-field catalog yet.
      // Logged so we can spot it when reviewing logs, but harmless —
      // the workflow on the GHL side won't fire until the field exists
      // anyway.
      console.log(`[ghl-pw-writeback] skipped: ${PASSWORD_SET_AT_FIELD_KEY} field not present in GHL location for parent ${parentId}`);
    }
  } catch (e) {
    // Don't bubble up — password-set already succeeded; this is purely
    // for the GHL workflow plumbing.
    console.error(`[ghl-pw-writeback] failed for parent ${parentId}:`, e instanceof Error ? e.message : e);
  }
}
