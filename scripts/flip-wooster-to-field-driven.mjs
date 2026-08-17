// Flip Wooster's sync from tag-driven to field-driven enrollment:
//   1. Map enrollmentStatus → 'enrollment_status' in school_field_schemas
//      (slot pattern: student_enrollment_status / student_N_enrollment_status).
//   2. Remove settings.roster_tag_filter — the per-student status field is
//      now the source of truth; no more family-level forced-enrolled.
//
// After this, the office sets a student's status in GHL (or the portal
// auto-sets it on form completion) and the dashboards follow per student.
import pg from 'pg';

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const r1 = await db.query(
  `UPDATE school_field_schemas
      SET student_fields = student_fields || '{"enrollmentStatus": "enrollment_status"}'::jsonb
    WHERE school_id = $1
   RETURNING student_fields`,
  [SCHOOL_ID],
);
console.log('student_fields now:', r1.rows[0].student_fields);

const r2 = await db.query(
  `UPDATE schools
      SET settings = settings - 'roster_tag_filter'
    WHERE id = $1
   RETURNING settings`,
  [SCHOOL_ID],
);
console.log('settings now:', r2.rows[0].settings);

await db.end();
