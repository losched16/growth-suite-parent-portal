// Per-parent student scoping. A parent with rows in
// parent_student_assignments is RESTRICTED to those students across the
// portal and kiosk (blended families: Maelynn's biological father sees
// Maelynn only, never his ex's other children). No rows = unrestricted
// (the default for every normal parent — back-compatible).
//
// Set by the office from the Student Roster family panel. Preserved
// across sync rebuilds via DATA_PRESERVE.

import { query } from '@/lib/db';

// null = unrestricted (no assignment rows). Array = ONLY these ids.
export async function allowedStudentIds(parentId: string): Promise<string[] | null> {
  const { rows } = await query<{ student_id: string }>(
    `SELECT student_id FROM parent_student_assignments WHERE parent_id = $1`,
    [parentId],
  );
  if (rows.length === 0) return null;
  return rows.map((r) => r.student_id);
}

export function filterStudents<T extends { id: string }>(students: T[], allowed: string[] | null): T[] {
  if (allowed === null) return students;
  const set = new Set(allowed);
  return students.filter((s) => set.has(s.id));
}

// Guard for single-student actions (check-in, form submit, upload):
// throws away nothing, just answers "may this parent act on this kid".
export async function parentMayAccessStudent(parentId: string, studentId: string): Promise<boolean> {
  const allowed = await allowedStudentIds(parentId);
  return allowed === null || allowed.includes(studentId);
}
