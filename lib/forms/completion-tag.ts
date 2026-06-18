// Auto-apply a "forms completed" GHL tag when a family reaches 100%
// form completion. Triggered from the portal form submit handler as a
// fire-and-forget effect.
//
// Family is "fully complete" when every active student has a
// submission for every active per-student form AND the family has a
// submission for every active family-level form. Mirrors the
// PortalFormsTracker definition so the dashboard and the tag stay
// consistent.
//
// Tag is per-school via school_branding.completion_tag. If empty / NULL
// the school hasn't opted in and this whole effect is a no-op. Tag
// writes are idempotent on GHL's side (POST /contacts/{id}/tags) so
// re-firing on a re-submission after the family is already complete
// is harmless.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';

interface FormRow { id: string; per_student: boolean }
interface StudentRow { id: string }
interface SubRow { form_definition_id: string; student_id: string | null }

async function isFamilyFullyComplete(schoolId: string, familyId: string): Promise<boolean> {
  const { rows: forms } = await query<FormRow>(
    `SELECT id, per_student
       FROM portal_form_definitions
      WHERE school_id = $1
        AND is_active = true
        AND COALESCE(audience, 'parents') = 'parents'`,
    [schoolId],
  );
  if (forms.length === 0) return false;

  const { rows: students } = await query<StudentRow>(
    `SELECT id FROM students
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'`,
    [schoolId, familyId],
  );
  if (students.length === 0) return false;
  const studentIds = students.map((s) => s.id);

  const { rows: subs } = await query<SubRow>(
    `SELECT form_definition_id, student_id
       FROM portal_form_submissions
      WHERE school_id = $1
        AND COALESCE(is_test, false) = false
        AND status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        AND (family_id = $2 OR student_id = ANY($3::uuid[]))`,
    [schoolId, familyId, studentIds],
  );

  const familySubs = new Set<string>();      // formId
  const studentSubs = new Set<string>();     // formId|studentId
  for (const s of subs) {
    if (s.student_id) studentSubs.add(`${s.form_definition_id}|${s.student_id}`);
    else familySubs.add(s.form_definition_id);
  }

  for (const form of forms) {
    if (form.per_student) {
      for (const sid of studentIds) {
        if (!studentSubs.has(`${form.id}|${sid}`)) return false;
      }
    } else {
      if (!familySubs.has(form.id)) return false;
    }
  }
  return true;
}

interface ParentToTag { ghl_contact_id: string; first_name: string }

export async function maybeApplyCompletionTag(opts: {
  schoolId: string;
  familyId: string;
}): Promise<{ applied: boolean; reason?: string; tagged_parents?: number }> {
  // Load the school's completion-tag config. NULL → opt-out.
  const { rows: brandingRows } = await query<{ completion_tag: string | null }>(
    `SELECT completion_tag FROM school_branding WHERE school_id = $1`,
    [opts.schoolId],
  );
  const tag = (brandingRows[0]?.completion_tag ?? '').trim();
  if (!tag) return { applied: false, reason: 'no_completion_tag_configured' };

  const complete = await isFamilyFullyComplete(opts.schoolId, opts.familyId);
  if (!complete) return { applied: false, reason: 'family_not_yet_complete' };

  // Get every active parent on the family that has a GHL contact.
  const { rows: parents } = await query<ParentToTag>(
    `SELECT ghl_contact_id, first_name
       FROM parents
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'
        AND ghl_contact_id IS NOT NULL`,
    [opts.schoolId, opts.familyId],
  );
  if (parents.length === 0) return { applied: false, reason: 'no_ghl_addressable_parents' };

  let tagged = 0;
  try {
    const client = await loadGhlClient(opts.schoolId);
    for (const p of parents) {
      try {
        await client.axios.post(`/contacts/${p.ghl_contact_id}/tags`, { tags: [tag] });
        tagged++;
      } catch (err) {
        console.warn('[completion-tag] tag write failed for contact', p.ghl_contact_id, ':',
          err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('[completion-tag] GHL client load failed:', err);
    return { applied: false, reason: 'ghl_client_load_failed' };
  }

  return { applied: tagged > 0, tagged_parents: tagged };
}
