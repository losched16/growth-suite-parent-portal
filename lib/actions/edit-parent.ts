// Server action — edit logged-in parent's own contact info.
// Authorization: only the parent themselves can edit their own row.
// Cannot edit a different parent (even spouse).
//
// Order of writes: GHL first (source of truth), then family-graph
// (so the change appears immediately even before next sync).

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadGhlClient } from '@/lib/ghl/client';
import { updateContactStandardFields } from '@/lib/ghl/writes';
import { getParentOwned } from '@/lib/family-data';

export interface EditParentResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function editParentAction(formData: FormData): Promise<void> {
  const result = await editParentInner(formData);
  // Redirect always — encode result in query params so the page can show it.
  const url = new URL('/family', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Saved.');
  else url.searchParams.set('err', result.error ?? 'Save failed.');
  redirect(`${url.pathname}${url.search}`);
}

async function editParentInner(formData: FormData): Promise<EditParentResult> {
  try {
    const session = await readSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    const parentId = String(formData.get('parent_id') ?? '');
    if (parentId !== session.parent_id) {
      return { ok: false, error: 'You can only edit your own contact info.' };
    }

    const parent = await getParentOwned(parentId, session.family_id);
    if (!parent) return { ok: false, error: 'Parent not found.' };

    const firstName = String(formData.get('first_name') ?? '').trim();
    const lastName = String(formData.get('last_name') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();
    // Checkbox: present and "1" → private; absent → not private.
    // Only the parent themselves can flip this for their own record.
    const isPrivate = formData.get('is_private_from_co_parents') === '1';

    // Per-student assignments. The picker emits checkboxes named
    // `assigned_students[]` — value is either the literal "all" (the
    // first checkbox that means "applies to every kid in the family")
    // or a student UUID. If "all" is present, we clear all assignment
    // rows for this parent (empty = applies to everyone, the
    // historical default). Otherwise we replace with the picked subset.
    const assignedRaw = formData.getAll('assigned_students[]').map(String);
    const wantsAll = assignedRaw.includes('all');
    const picked = wantsAll ? [] : assignedRaw.filter((v) => v && v !== 'all');

    if (!firstName || !lastName) {
      return { ok: false, error: 'First and last name are required.' };
    }

    // 1) Write to GHL first (source of truth) — only if there's a contact id
    if (parent.ghl_contact_id) {
      try {
        const client = await loadGhlClient(parent.school_id);
        await updateContactStandardFields(client, parent.ghl_contact_id, {
          firstName,
          lastName,
          phone: phone || '',
        });
      } catch (err) {
        return {
          ok: false,
          error: `Could not save to school's contact record: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 2) Mirror to family-graph (including the privacy toggle)
    await query(
      `UPDATE parents
       SET first_name = $1, last_name = $2, phone = $3,
           is_private_from_co_parents = $5,
           updated_at = now()
       WHERE id = $4`,
      [firstName, lastName, phone || null, parentId, isPrivate],
    );

    // 2b) Re-set per-student assignments. Always wipe + reinsert to
    // keep the "applies to all → empty rows" invariant. Scope by
    // family_id so a manipulated payload can't target some other
    // family's students.
    await query(`DELETE FROM parent_student_assignments WHERE parent_id = $1`, [parentId]);
    if (picked.length > 0) {
      await query(
        `INSERT INTO parent_student_assignments (school_id, parent_id, student_id)
         SELECT $1, $2, s.id
           FROM students s
          WHERE s.id = ANY($3::uuid[])
            AND s.family_id = $4
            AND s.school_id = $1`,
        [parent.school_id, parentId, picked, session.family_id],
      );
    }

    // 3) Audit — track privacy flips separately so school staff can
    // reconstruct who flagged themselves and when. Helpful in custody-
    // dispute scenarios.
    const changedFields = ['first_name', 'last_name', 'phone'];
    if (parent.is_private_from_co_parents !== isPrivate) {
      changedFields.push(`is_private_from_co_parents:${parent.is_private_from_co_parents}→${isPrivate}`);
    }
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'edit_parent', $4::jsonb)`,
      [
        session.school_id,
        session.parent_id,
        session.family_id,
        JSON.stringify({ changed_fields: changedFields }),
      ],
    );

    revalidatePath('/family');
    revalidatePath('/home');
    return { ok: true, message: 'Your contact info was saved.' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
