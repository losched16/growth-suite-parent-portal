// Per-form CRM tags applied when a family submits (migration 097,
// portal_form_definitions.submit_tags). Lets the office segment
// sign-ups ("flag football 2026") into a tag smart list and email the
// group any time — no exports.
//
// Fired from the portal submit handler as a fire-and-forget effect.
// Tags every ACTIVE parent on the family that has a GHL contact (P1's
// tags also mirror to P2 on the 15-min cron, so both paths converge).
// GHL tag writes are idempotent — re-submissions are harmless.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';

export async function applySubmitTags(opts: {
  schoolId: string;
  familyId: string;
  tags: string[];
}): Promise<{ tagged: number }> {
  const tags = (opts.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (tags.length === 0) return { tagged: 0 };

  const { rows: parents } = await query<{ ghl_contact_id: string }>(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'
        AND ghl_contact_id IS NOT NULL`,
    [opts.schoolId, opts.familyId],
  );
  if (parents.length === 0) return { tagged: 0 };

  let tagged = 0;
  const client = await loadGhlClient(opts.schoolId);
  for (const p of parents) {
    try {
      await client.axios.post(`/contacts/${p.ghl_contact_id}/tags`, { tags });
      tagged++;
    } catch (err) {
      console.warn('[submit-tags] tag write failed for contact', p.ghl_contact_id, ':',
        err instanceof Error ? err.message : String(err));
    }
  }
  return { tagged };
}
