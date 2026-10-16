// Wooster: link per-student form submissions that were saved without a
// student (portal before Aug 18, plus some earlier-form imports) to the
// child named in "Student full name". Per-student reports, the roster and
// the GHL writeback all key on student_id, so these answers were invisible.
// Unique match within the submission's own family only; ambiguous or
// unnamed rows are left alone and listed. --apply writes (with a backup
// table of the linked ids → revert: UPDATE ... SET student_id = NULL).
import pg from 'pg';
const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const APPLY = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const clean = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[“”"'’]/g, ' ').replace(/[^a-z ]+/g, ' ').replace(/\b(ii|iii|iv|jr|sr)\b/g, ' ').replace(/\s+/g, ' ').trim();
const { rows: subs } = await db.query(
  `SELECT s.id, s.family_id, s.status, d.slug, s.responses->>'student_full_name' AS sfn, s.submitted_at
     FROM portal_form_submissions s JOIN portal_form_definitions d ON d.id = s.form_definition_id
    WHERE s.school_id = $1 AND d.per_student AND s.student_id IS NULL AND s.voided_at IS NULL
      AND COALESCE(s.is_test, false) = false
      AND s.status IN ('submitted','paid','pending_payment','legacy_imported')`, [S]);
const { rows: kids } = await db.query(
  `SELECT id, family_id, first_name, last_name, preferred_name FROM students WHERE school_id = $1 AND status = 'active'`, [S]);
const byFam = new Map();
for (const k of kids) (byFam.get(k.family_id) ?? byFam.set(k.family_id, []).get(k.family_id)).push(k);

// nicknames parents typed that aren't a prefix of the legal name
const NICK = { ellie: ['eleanor', 'elizabeth', 'ellen'], finn: ['griffin', 'finnegan', 'finley'] };

// one-letter typos in a surname ("McClintok") still match
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function match(sfn, fam) {
  const raw = String(sfn ?? '');
  const nick = /[“"]([^”"]+)[”"]/.exec(raw)?.[1];
  const n = clean(raw); if (!n) return { why: 'no name' };
  const toks = n.split(' ');
  const cands = (fam ?? []).filter((k) => {
    const last = clean(k.last_name), firsts = [clean(k.first_name), clean(k.preferred_name)].filter(Boolean);
    const lastToks = last.split(' ');
    if (!last || !(n.includes(last) || toks.some((t) => lastToks.some((l) => near(t, l))))) return false;
    const given = [...toks.filter((t) => !lastToks.some((l) => near(t, l))), ...(nick ? [clean(nick)] : [])];
    return firsts.some((f) => given.some((g) => g === f || NICK[g]?.includes(f) || (g.length >= 3 && f.length >= 3 && (f.startsWith(g) || g.startsWith(f)))));
  });
  if (cands.length === 1) return { kid: cands[0] };
  return { why: cands.length ? 'ambiguous' : 'no match in family' };
}

const plan = [], skipped = [];
// A submission saved with no family (or one whose family has no children)
// can only match on the exact full name, unique across the school — and
// then moves to that child's family.
const exactSchoolWide = (sfn) => {
  const hits = kids.filter((k) => clean(`${k.first_name} ${k.last_name}`) === clean(sfn) || (k.preferred_name && clean(`${k.preferred_name} ${k.last_name}`) === clean(sfn)));
  return hits.length === 1 ? hits[0] : null;
};
for (const s of subs) {
  const fam = byFam.get(s.family_id);
  if (!fam?.length) {
    const k = exactSchoolWide(s.sfn);
    if (k) { plan.push({ ...s, student_id: k.id, kid: `${k.first_name} ${k.last_name}`, move_family: k.family_id }); continue; }
  }
  const m = match(s.sfn, fam);
  if (m.kid) plan.push({ ...s, student_id: m.kid.id, kid: `${m.kid.first_name} ${m.kid.last_name}` });
  else skipped.push({ ...s, why: m.why, fam: (byFam.get(s.family_id) ?? []).map((k) => `${k.first_name} ${k.last_name}`).join(', ') });
}
const tally = (arr, f) => arr.reduce((m, x) => (m[f(x)] = (m[f(x)] ?? 0) + 1, m), {});
console.log('unlinked', subs.length, '| will link', plan.length, tally(plan, (x) => `${x.slug}/${x.status}`));
console.log('skipped', skipped.length, tally(skipped, (x) => `${x.why}/${x.status}`));
for (const p of plan.filter((x) => clean(x.sfn) !== clean(x.kid))) console.log('  fuzzy:', JSON.stringify(p.sfn), '→', p.kid);
console.log('  moved to the child family (had none):', plan.filter((x) => x.move_family).length);
for (const s of skipped.filter((x) => x.why !== 'no name')) console.log('  skip:', s.why, JSON.stringify(s.sfn), '| family:', s.fam, '|', s.slug);

if (APPLY && plan.length) {
  await db.query(`CREATE TABLE IF NOT EXISTS _bak_wooster_linked_subs_20261016 (submission_id uuid PRIMARY KEY, student_id uuid, old_family_id uuid, linked_at timestamptz DEFAULT now())`);
  for (const p of plan) {
    await db.query(`INSERT INTO _bak_wooster_linked_subs_20261016 (submission_id, student_id, old_family_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [p.id, p.student_id, p.family_id]);
    await db.query(`UPDATE portal_form_submissions SET student_id = $2, family_id = COALESCE($3, family_id) WHERE id = $1 AND student_id IS NULL`, [p.id, p.student_id, p.move_family ?? null]);
  }
  console.log('linked', plan.length, '(backup: _bak_wooster_linked_subs_20261016)');
}
await db.end();
