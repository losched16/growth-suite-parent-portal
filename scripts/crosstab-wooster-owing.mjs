import pg from 'pg';
const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(
  `WITH fam AS (
     SELECT f.id, f.display_name,
       EXISTS (SELECT 1 FROM portal_form_submissions s
                WHERE s.family_id = f.id
                  AND s.status IN ('submitted','paid','pending_payment','legacy_imported')) AS has_sub,
       EXISTS (SELECT 1 FROM ghl_contact_field_values v
                 JOIN parents p ON p.ghl_contact_id = v.ghl_contact_id
                              AND p.family_id = f.id AND p.is_primary = true
                WHERE v.school_id = f.school_id AND v.field_key LIKE 'form\\_%' AND v.value <> '') AS has_ghl,
       (SELECT string_agg(DISTINCT e.status, ',')
          FROM students st JOIN enrollments e ON e.student_id = st.id
         WHERE st.family_id = f.id AND st.status = 'active') AS statuses,
       EXISTS (SELECT 1 FROM parents p WHERE p.family_id = f.id AND p.password_set_at IS NOT NULL) AS has_login
     FROM families f WHERE f.school_id = $1 AND f.status = 'active')
   SELECT statuses, has_sub, has_ghl, has_login, COUNT(*)::int AS n
     FROM fam GROUP BY 1,2,3,4 ORDER BY n DESC`,
  [S],
);
console.table(r.rows);
await c.end();
