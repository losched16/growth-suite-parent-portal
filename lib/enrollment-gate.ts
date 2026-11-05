// "Is this family enrolled yet?" — used to hold back portal features (kiosk PINs,
// the Documents page) until a child is Enrolled, for schools that turn the
// matching setting on (settings.pin_requires_enrolled / documents_require_enrolled).
//
// Family-level on purpose: PINs and documents belong to the household, so a
// family with one enrolled child and a newly accepted sibling is enrolled.
// "Enrolled" is the student's enrollment status on the contact, the same value
// the dashboards and attendance board use.

import { query } from '@/lib/db';

export async function familyIsEnrolled(schoolId: string, familyId: string): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM students s
        WHERE s.school_id = $1 AND s.family_id = $2 AND s.status = 'active'
          AND lower(btrim(coalesce(s.metadata->>'enrollment_status', ''))) = 'enrolled'
     ) AS ok`,
    [schoolId, familyId],
  );
  return rows[0]?.ok === true;
}

export const NOT_ENROLLED_PIN_MESSAGE = 'Kiosk PINs open once your child is enrolled.';
