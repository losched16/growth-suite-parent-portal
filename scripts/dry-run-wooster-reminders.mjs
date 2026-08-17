// Preview EXACTLY who the reminder cron would email at Wooster right now
// (no sends, no log rows). Uses the same lib the cron uses via tsx.
import pg from 'pg';

const wooster = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Run with: npx --yes tsx --env-file=.env.local scripts/dry-run-wooster-reminders.mjs
const { loadPendingForms } = await import('../lib/forms/pending.ts');

const { rows: fams } = await pool.query(
  `SELECT f.id, f.display_name,
          (SELECT string_agg(p.email, ', ') FROM parents p WHERE p.family_id = f.id AND p.status='active' AND p.email IS NOT NULL) AS emails
     FROM families f
    WHERE f.school_id = $1 AND f.status = 'active'
      AND EXISTS (SELECT 1 FROM parents p WHERE p.family_id = f.id AND p.status = 'active' AND p.email IS NOT NULL AND p.email <> '')
      AND EXISTS (SELECT 1 FROM students s JOIN enrollments e ON e.student_id = s.id
                   WHERE s.family_id = f.id AND s.status = 'active' AND e.status = 'enrolled')
    ORDER BY f.display_name`,
  [wooster],
);

let owing = 0, complete = 0;
const byCount = {};
const sample = [];
for (const f of fams) {
  const pend = await loadPendingForms({ schoolId: wooster, familyId: f.id, honorGhlCompletion: true, enrolledOnly: true });
  if (pend.length === 0) { complete++; continue; }
  owing++;
  byCount[pend.length] = (byCount[pend.length] ?? 0) + 1;
  if (sample.length < 12) sample.push({ family: f.display_name, emails: f.emails, outstanding: pend.map((p) => p.display_name + (p.per_student ? ` (${p.missing_student_ids.length} student${p.missing_student_ids.length === 1 ? '' : 's'})` : '')).join(' | ') });
}
console.log(`Families scanned: ${fams.length}`);
console.log(`  complete (no reminder): ${complete}`);
console.log(`  owing forms (would get reminder #1 today): ${owing}`);
console.log('  outstanding-count distribution:', byCount);
console.log('\nSample of families that WOULD be reminded:');
console.table(sample);

// Spot check: Tracy Cosgriff (legacy Final Forms completions) must be COMPLETE
const { rows: tc } = await pool.query(
  `SELECT f.id, f.display_name FROM families f JOIN parents p ON p.family_id=f.id
    WHERE f.school_id=$1 AND (p.last_name ILIKE 'Cosgriff' OR p.first_name ILIKE 'Tracy') LIMIT 3`,
  [wooster],
);
for (const t of tc) {
  const pend = await loadPendingForms({ schoolId: wooster, familyId: t.id, honorGhlCompletion: true, enrolledOnly: true });
  const pendNoGhl = await loadPendingForms({ schoolId: wooster, familyId: t.id, honorGhlCompletion: false });
  console.log(`\nSpot check ${t.display_name}: with legacy honor → ${pend.length} owed; without → ${pendNoGhl.length} owed`);
  if (pend.length) console.log('   still owed:', pend.map((p) => p.display_name).join(', '));
}
await pool.end();
