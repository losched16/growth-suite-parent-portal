// Server action — edit a student's parent-managed details. Authorization:
// student must belong to the logged-in parent's family.
//
// What's editable here (parent-managed):
//   - Allergy notes
//   - Emergency first contact (name + phone packed into one freetext field
//     — DG stores it that way; schools can rename in their config)
//   - Health-care provider name + phone
//
// NOT editable here (school-controlled):
//   - Name, DOB, classroom, enrollment status, IEP/504 (those need
//     school approval / paperwork)
//
// GHL field keys are derived from the school's field schema using the
// student's slot (stored in students.metadata.ghl_slot) and the standard
// `studentFieldKey(slot, base)` helper.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadGhlClient } from '@/lib/ghl/client';
import { updateContactCustomFields } from '@/lib/ghl/writes';
import { getStudentOwned } from '@/lib/family-data';
import { loadSchoolFieldSchema } from '@/lib/sync/schema-loader';
import { studentFieldKey } from '@/lib/sync/desert-garden-config';

// Maps the parent-portal form field name → the abstract student-field key.
// Operator can extend STUDENT_FIELDS in the per-school config and we'll
// look those up too. If the school doesn't have an abstract key for a
// given form field, we silently skip it (no error — just no GHL write).
const PARENT_EDITABLE_FIELDS = [
  { form_name: 'allergy', abstract_key: 'allergy', label: 'Allergies' },
  { form_name: 'allergy_notes', abstract_key: 'allergyNotes', label: 'Allergy notes' },
  { form_name: 'emergency_first_contact', abstract_key: 'emergencyFirstContact', label: 'Emergency first contact' },
  { form_name: 'health_care_provider', abstract_key: 'healthCareProvider', label: 'Health care provider' },
  { form_name: 'health_care_provider_phone', abstract_key: 'healthCareProviderPhone', label: 'Health care provider phone' },
] as const;

export async function editStudentAction(formData: FormData): Promise<void> {
  const result = await editStudentInner(formData);
  const url = new URL('/family', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Saved.');
  else url.searchParams.set('err', result.error ?? 'Save failed.');
  redirect(`${url.pathname}${url.search}`);
}

async function editStudentInner(
  formData: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const session = await readSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    const studentId = String(formData.get('student_id') ?? '');
    const student = await getStudentOwned(studentId, session.family_id);
    if (!student) return { ok: false, error: 'Student not found in your family.' };

    // Slot lookup — two metadata shapes supported:
    //   • student.metadata.ghl_slot   (DG-era)
    //   • student.metadata.slot       (Wooster-era / current sync)
    const slot = (() => {
      const m = student.metadata;
      const raw = m.ghl_slot ?? m.slot;
      if (typeof raw === 'number') return raw;
      const n = Number(raw ?? 1);
      return Number.isFinite(n) && n >= 1 ? n : 1;
    })();

    // Contact-id lookup — two family-graph shapes supported:
    //   • student.metadata.ghl_contact_id        (per-student contact, DG style)
    //   • student.metadata.ghl_parent_contact_id (slot fields on parent's contact, Wooster style)
    //   • Last resort: family's primary parent's ghl_contact_id
    let ghlContactId: string | null = null;
    if (typeof student.metadata.ghl_contact_id === 'string') {
      ghlContactId = student.metadata.ghl_contact_id;
    } else if (typeof student.metadata.ghl_parent_contact_id === 'string') {
      ghlContactId = student.metadata.ghl_parent_contact_id;
    } else {
      const { rows: pr } = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents
         WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL
         LIMIT 1`,
        [session.family_id],
      );
      ghlContactId = pr[0]?.ghl_contact_id ?? null;
    }

    if (!ghlContactId) {
      // Still no contact — we'll save to family-graph only. Don't block.
      console.warn('[edit-student] no GHL contact id; saving locally only');
    }

    // Build the byKey map. Look up each abstract key in the school's
    // schema. If absent, skip that field (the form field still gets
    // mirrored into family-graph metadata so the value isn't lost).
    const config = await loadSchoolFieldSchema(session.school_id);
    const STUDENT = config.student_fields as Record<string, string>;

    const ghlByKey: Record<string, string> = {};
    const newMetadata: Record<string, unknown> = { ...student.metadata };

    for (const f of PARENT_EDITABLE_FIELDS) {
      const value = formData.get(f.form_name);
      if (value === null) continue; // not present in form — skip
      const stringValue = String(value);
      newMetadata[f.abstract_key] = stringValue;
      const baseKey = STUDENT[f.abstract_key];
      if (baseKey) {
        ghlByKey[studentFieldKey(slot, baseKey)] = stringValue;
      }
    }

    // Don't error if there's nothing to write to GHL — the family-graph
    // metadata write still happens below. This keeps things working when
    // the school's field schema doesn't include the parent-editable field.
    // No GHL row → no GHL push, but the parent's edit is preserved locally.

    // 1) Write to GHL — only if we have a contact id. Otherwise we still
    //    save to family-graph (best-effort) so the parent's edit isn't lost.
    if (ghlContactId) {
      try {
        const client = await loadGhlClient(student.school_id);
        const result = await updateContactCustomFields(client, ghlContactId, ghlByKey);
        if (result.skipped.length > 0) {
          console.warn('[edit-student] some fields skipped (no fieldKey in location):', result.skipped);
        }
      } catch (err) {
        return {
          ok: false,
          error: `Could not save to school's records: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 2) Mirror to family-graph metadata
    await query(
      `UPDATE students SET metadata = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(newMetadata), studentId],
    );

    // 3) Audit
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'edit_student', $4::jsonb)`,
      [
        session.school_id,
        session.parent_id,
        session.family_id,
        JSON.stringify({
          student_id: studentId,
          changed_fields: Object.keys(ghlByKey),
        }),
      ],
    );

    revalidatePath('/family');
    revalidatePath('/home');
    return { ok: true, message: `Updated ${student.first_name}'s details.` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
