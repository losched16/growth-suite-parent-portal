// Applicant students — admissions schools that take their application in the
// parent portal (Nativity).
//
// An applicant's family is created when the school invites them to apply
// (dashboards: /api/webhooks/ghl/applicant-invite) and has NO student yet. The
// application form (settings.applicant_student.form_slug) is what introduces
// the child: submitting it creates a student record for them, with an
// `application_submitted` enrollment. That record is what the per-student
// document forms (report cards, NWEA/MAP, IEP/504) attach to, so each child's
// documents hang off the child — and are still there, on the same student,
// when the school later marks them Enrolled.
//
// Safe by construction:
//   - the enrollment is NOT 'enrolled', so the child stays off the enrolled
//     roster, classroom hubs and the attendance board (all require 'enrolled');
//   - matched by name inside the family, so a re-submitted or corrected
//     application updates the child instead of duplicating them;
//   - each child gets the next contact "student slot" (1..4). Slot 1 is the
//     one the full application is written back to; a second child's detail
//     answers stay on the portal submission and only their NAME goes to the
//     next slot — the first child's CRM answers are never overwritten.
//
// Config (schools.settings.applicant_student), e.g. Nativity:
//   { form_slug: 'nativity-application', first_name_field: 'student_first_name',
//     last_name_field: 'student_last_name', dob_field: 'student_dob',
//     academic_year: '2027-28',
//     metadata_fields: { current_grade: 'current_grade', current_school: 'current_school' } }

import { query, withTransaction } from '@/lib/db';

export interface ApplicantStudentConfig {
  form_slug: string;
  first_name_field: string;
  last_name_field: string;
  dob_field: string | null;
  status: string;
  academic_year: string | null;
  metadata_fields: Record<string, string>;
}

export interface ApplicantStudentResult {
  studentId: string;
  slot: number | null;       // contact student slot (1..4); null = all four in use
  created: boolean;
  firstName: string;
  lastName: string;
}

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ');
const key = (s: unknown) => norm(s).toLowerCase();

export async function loadApplicantStudentConfig(schoolId: string): Promise<ApplicantStudentConfig | null> {
  const { rows } = await query<{ cfg: Record<string, unknown> | null }>(
    `SELECT settings->'applicant_student' AS cfg FROM schools WHERE id = $1`,
    [schoolId],
  );
  const c = rows[0]?.cfg;
  if (!c || typeof c !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const form_slug = s(c.form_slug);
  const first = s(c.first_name_field);
  const last = s(c.last_name_field);
  if (!form_slug || !first || !last) return null;
  const mf: Record<string, string> = {};
  if (c.metadata_fields && typeof c.metadata_fields === 'object') {
    for (const [k, v] of Object.entries(c.metadata_fields as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) mf[k] = v.trim();
    }
  }
  return {
    form_slug, first_name_field: first, last_name_field: last,
    dob_field: s(c.dob_field), status: s(c.status) ?? 'application_submitted',
    academic_year: s(c.academic_year), metadata_fields: mf,
  };
}

export async function ensureApplicantStudent(opts: {
  schoolId: string;
  familyId: string;
  submissionId: string;
  responses: Record<string, unknown>;
  cfg: ApplicantStudentConfig;
}): Promise<ApplicantStudentResult | null> {
  const { schoolId, familyId, submissionId, responses, cfg } = opts;
  const firstName = norm(responses[cfg.first_name_field]);
  const lastName = norm(responses[cfg.last_name_field]);
  if (!firstName || !lastName) return null;

  const dobRaw = cfg.dob_field ? norm(responses[cfg.dob_field]) : '';
  const dob = /^\d{4}-\d{2}-\d{2}/.test(dobRaw) ? dobRaw.slice(0, 10) : null;
  const meta: Record<string, unknown> = {};
  for (const [metaKey, formKey] of Object.entries(cfg.metadata_fields)) {
    const v = norm(responses[formKey]);
    if (v) meta[metaKey] = v;
  }

  // The family's current children, to match by name and to pick the next slot.
  const { rows: kids } = await query<{ id: string; first_name: string; last_name: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, first_name, last_name, metadata FROM students
      WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
    [familyId, schoolId],
  );
  const slotOf = (m: Record<string, unknown> | null) => {
    const n = parseInt(String(m?.ghl_slot ?? m?.slot ?? ''), 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  };

  // Same child (re-submission / corrected application): update, don't duplicate.
  const same = kids.find((k) => key(k.first_name) === key(firstName) && key(k.last_name) === key(lastName));
  if (same) {
    const isApplicant = same.metadata?.applicant === true;
    // Only an applicant record is edited from the application; a child who is
    // already a real student keeps the school's data untouched.
    if (isApplicant) {
      await query(
        `UPDATE students
            SET date_of_birth = COALESCE($2::date, date_of_birth),
                metadata = metadata || $3::jsonb, updated_at = now()
          WHERE id = $1`,
        [same.id, dob, JSON.stringify({ ...meta, application_submission_id: submissionId })],
      );
    }
    return { studentId: same.id, slot: slotOf(same.metadata) ?? 1, created: false, firstName, lastName };
  }

  // A new child: the next free contact slot (1..4).
  const used = kids.map((k) => slotOf(k.metadata)).filter((n): n is number => n !== null);
  const next = Math.max(0, ...used, kids.length) + 1;
  const slot = next <= 4 ? next : null;

  const { rows: sRows } = await query<{ ghl_contact_id: string | null }>(
    `SELECT ghl_contact_id FROM parents WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL LIMIT 1`,
    [familyId],
  );
  const { rows: yr } = await query<{ y: string | null }>(
    `SELECT settings->>'academic_year' AS y FROM schools WHERE id = $1`, [schoolId],
  );
  const academicYear = cfg.academic_year ?? yr[0]?.y ?? '2026-27';

  const studentId = await withTransaction(async (q) => {
    const { rows } = await q<{ id: string }>(
      `INSERT INTO students (family_id, school_id, first_name, last_name, date_of_birth, status, metadata)
       VALUES ($1, $2, $3, $4, $5::date, 'active', $6::jsonb) RETURNING id`,
      [familyId, schoolId, firstName, lastName, dob, JSON.stringify({
        ...meta,
        applicant: true,
        application_submission_id: submissionId,
        ...(slot ? { ghl_slot: slot } : {}),
        ...(sRows[0]?.ghl_contact_id ? { ghl_contact_id: sRows[0].ghl_contact_id } : {}),
      })],
    );
    await q(
      `INSERT INTO enrollments (student_id, school_id, academic_year, status, metadata)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [rows[0].id, schoolId, academicYear, cfg.status],
    );
    return rows[0].id;
  });

  return { studentId, slot, created: true, firstName, lastName };
}
