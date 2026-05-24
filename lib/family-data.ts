// Read helpers for the logged-in parent's family. All queries scope by
// family_id from the session — never trust a family_id from the URL.

import { query } from '@/lib/db';

export interface ParentRow {
  id: string;
  family_id: string;
  school_id: string;
  ghl_contact_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  role: string;
  status: string;
  // Privacy flag for divorced / separated families. When true, other
  // parents in the same family see masked contact info and can't edit
  // this record (and shouldn't be able to overwrite their data via
  // shared family-level form submissions). School staff always see
  // the full record.
  is_private_from_co_parents: boolean;
  updated_at: string;
}

export interface StudentRow {
  id: string;
  family_id: string;
  school_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  status: string;
  metadata: Record<string, unknown>;
  // From most-recent enrollment
  enrollment_status: string | null;
  classroom_id: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string | null;
}

export async function loadParentsForFamily(familyId: string): Promise<ParentRow[]> {
  const { rows } = await query<ParentRow>(
    `SELECT id, family_id, school_id, ghl_contact_id, first_name, last_name,
            email, phone, is_primary, role, status,
            is_private_from_co_parents, updated_at
     FROM parents
     WHERE family_id = $1
     ORDER BY is_primary DESC, first_name`,
    [familyId],
  );
  return rows;
}

export async function loadStudentsForFamily(familyId: string): Promise<StudentRow[]> {
  const { rows } = await query<StudentRow>(
    `SELECT
       s.id, s.family_id, s.school_id, s.first_name, s.last_name, s.preferred_name,
       s.date_of_birth, s.gender, s.status, s.metadata,
       e.status AS enrollment_status,
       e.classroom_id,
       c.name AS classroom_name,
       c.lead_teacher_name,
       e.schedule,
       e.academic_year
     FROM students s
     LEFT JOIN LATERAL (
       SELECT * FROM enrollments e2
       WHERE e2.student_id = s.id
       ORDER BY e2.created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     WHERE s.family_id = $1 AND s.status = 'active'
     ORDER BY s.first_name`,
    [familyId],
  );
  return rows;
}

// Per-parent student assignments. Empty list = "applies to all
// students in the family" (the historical default). Non-empty = the
// parent explicitly belongs to that subset only — used for blended /
// step-family setups where one kid has Mom+Dad and another kid in the
// same family has Mom+Stepdad.
export interface ParentStudentAssignment {
  parent_id: string;
  student_id: string;
  relationship: string | null;
  is_primary_for_student: boolean;
}

export async function loadParentStudentAssignments(familyId: string): Promise<ParentStudentAssignment[]> {
  const { rows } = await query<ParentStudentAssignment>(
    `SELECT psa.parent_id, psa.student_id, psa.relationship, psa.is_primary_for_student
       FROM parent_student_assignments psa
       JOIN parents p ON p.id = psa.parent_id
      WHERE p.family_id = $1`,
    [familyId],
  );
  return rows;
}

// Authorization helpers: caller passes a session-derived familyId.
// Returns the row only if it belongs to that family. Used by edit actions
// so a malicious parent can't pass an arbitrary parent_id/student_id.
export async function getParentOwned(parentId: string, familyId: string): Promise<ParentRow | null> {
  const { rows } = await query<ParentRow>(
    `SELECT id, family_id, school_id, ghl_contact_id, first_name, last_name,
            email, phone, is_primary, role, status, updated_at
     FROM parents WHERE id = $1 AND family_id = $2`,
    [parentId, familyId],
  );
  return rows[0] ?? null;
}

export async function getStudentOwned(studentId: string, familyId: string): Promise<StudentRow | null> {
  const { rows } = await query<StudentRow>(
    `SELECT
       s.id, s.family_id, s.school_id, s.first_name, s.last_name, s.preferred_name,
       s.date_of_birth, s.gender, s.status, s.metadata,
       e.status AS enrollment_status,
       e.classroom_id,
       c.name AS classroom_name,
       c.lead_teacher_name,
       e.schedule,
       e.academic_year
     FROM students s
     LEFT JOIN LATERAL (
       SELECT * FROM enrollments e2
       WHERE e2.student_id = s.id
       ORDER BY e2.created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     WHERE s.id = $1 AND s.family_id = $2`,
    [studentId, familyId],
  );
  return rows[0] ?? null;
}
