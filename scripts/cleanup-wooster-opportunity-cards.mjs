// Wooster pipeline cleanup: ONE opportunity card per enrolled student, named
// "First Last", in the most-advanced stage it already reached. Partial cards
// ("Dylan", "Dylan ", "Garret Crocker") that duplicate a student are deleted;
// if a student has only partial cards, the best one is RENAMED instead.
// Cards that don't match any enrolled student on that contact are left alone
// and listed for the office.
//
//   node --env-file=.env.local scripts/cleanup-wooster-opportunity-cards.mjs [--apply]
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
function dec(c2, iv, tag) {
  const k = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(c2), d.final()]).toString('utf8');
}
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
const pit = dec(sc.rows[0].ghl_pit_encrypted, sc.rows[0].ghl_pit_iv, sc.rows[0].ghl_pit_tag);
const loc = sc.rows[0].ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

// Stage ranking (higher = more advanced). Unknown stages rank 0.
const { rows: stages } = await db.query(`SELECT DISTINCT stage_id, stage_name, pipeline_id FROM ghl_opportunities WHERE school_id=$1`, [S]);
const RANK = { 'enrolled': 6, 'documents requested': 5, 'tour show': 3, 'tour no show': 2, 'interest': 1, 'admissions not offered': 0 };
const stageName = new Map(stages.map((s) => [s.stage_id, s.stage_name]));
const rank = (sid) => RANK[(stageName.get(sid) ?? '').toLowerCase()] ?? 0;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
// Damerau-Levenshtein distance ≤ 1 (one insert/delete/substitute/transposition): "garret"~"garrett", "diolun"~"diloun", "isabella"~"izzabella"? (that's 2 — handled by alias below)
function close(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (edits++) return false;
    if (a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; } // transposition
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const ALIAS = { isabella: 'izzabella', louie: 'louis', jude: 'julian' };
const tok0 = (s) => { const t = norm(s).split(' ')[0]; return ALIAS[t] ?? t; };

// Enrolled students grouped by primary contact.
const { rows: kids } = await db.query(
  `SELECT p.ghl_contact_id cid, s.first_name, s.last_name, s.preferred_name
     FROM students s JOIN enrollments e ON e.student_id = s.id
     JOIN parents p ON p.family_id = s.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL
    WHERE s.school_id = $1 AND e.status = 'enrolled' ORDER BY p.ghl_contact_id`, [S]);
const byContact = new Map();
for (const k of kids) (byContact.get(k.cid) ?? byContact.set(k.cid, []).get(k.cid)).push(k);

const plan = { keep: 0, rename: [], delete: [], unmatched: [], noCard: [] };
let i = 0;
for (const [cid, students] of byContact) {
  i++;
  const r = await fetch(`${GHL}/opportunities/search?location_id=${loc}&contact_id=${cid}&limit=50`, { headers: H });
  const opps = ((await r.json()).opportunities ?? []).filter((o) => o.status !== 'deleted');
  await sleep(180);
  const used = new Set();
  for (const st of students) {
    const full = norm(`${st.first_name} ${st.last_name}`);
    const first = norm(st.first_name).split(' ')[0];
    const pref = st.preferred_name ? norm(st.preferred_name).split(' ')[0] : null;
    // candidates: exact full name, OR first-name token match (partials/misspellings of the surname),
    // but NOT the parent's own name.
    const cands = opps.filter((o) => {
      if (used.has(o.id)) return false;
      const n = norm(o.name);
      if (!n) return false;
      if (n === full) return true;
      const t = ALIAS[n.split(' ')[0]] ?? n.split(' ')[0];
      const f0 = ALIAS[first] ?? first;
      if (close(t, f0) || (pref && close(t, pref))) {
        // only if no OTHER student on this contact has a first name this close
        const others = students.filter((x) => x !== st && close(tok0(x.first_name), t));
        return others.length === 0;
      }
      return false;
    });
    if (cands.length === 0) { plan.noCard.push(`${st.first_name} ${st.last_name}`); continue; }
    // best = exact name first, then highest stage, then open status
    cands.sort((a, b) => (Number(norm(b.name) === full) - Number(norm(a.name) === full)) || (rank(b.pipelineStageId) - rank(a.pipelineStageId)) || (Number(b.status === 'open') - Number(a.status === 'open')));
    const best = cands[0]; used.add(best.id);
    // the best card keeps the HIGHEST stage reached by any duplicate
    const topStage = cands.reduce((acc, o) => (rank(o.pipelineStageId) > rank(acc.pipelineStageId) ? o : acc), best);
    const wantName = `${st.first_name} ${st.last_name}`;
    const needsRename = best.name.trim() !== wantName;
    const needsStage = topStage.pipelineStageId !== best.pipelineStageId;
    if (needsRename || needsStage) plan.rename.push({ id: best.id, from: best.name, to: wantName, stageFrom: stageName.get(best.pipelineStageId), stageTo: stageName.get(topStage.pipelineStageId), pipelineId: best.pipelineId, stageId: topStage.pipelineStageId });
    else plan.keep++;
    for (const dup of cands.slice(1)) { used.add(dup.id); plan.delete.push({ id: dup.id, name: dup.name, stage: stageName.get(dup.pipelineStageId), student: wantName }); }
  }
  for (const o of opps) if (!used.has(o.id)) plan.unmatched.push(`${o.name} [${stageName.get(o.pipelineStageId)}] on contact ${cid}`);
}
console.log(`contacts scanned: ${byContact.size}`);
console.log(`keep as-is: ${plan.keep} | rename/restage: ${plan.rename.length} | delete duplicates: ${plan.delete.length} | students with no card: ${plan.noCard.length} | unmatched cards left alone: ${plan.unmatched.length}`);
console.log('\nRENAME / RESTAGE (sample):'); for (const x of plan.rename.slice(0, 25)) console.log(`  "${x.from}" → "${x.to}"${x.stageFrom !== x.stageTo ? ` · ${x.stageFrom} → ${x.stageTo}` : ''}`);
console.log('\nDELETE (sample):'); for (const x of plan.delete.slice(0, 40)) console.log(`  ✗ "${x.name}" [${x.stage}]  (dup of ${x.student})`);
console.log('\nUNMATCHED (left alone, sample):'); for (const x of plan.unmatched.slice(0, 25)) console.log(`  · ${x}`);
console.log('\nNO CARD (sample):', plan.noCard.slice(0, 20).join(', '));
if (!apply) { console.log('\nDRY RUN'); await db.end(); process.exit(0); }

let ok = 0, fail = 0;
for (const x of plan.rename) {
  const r = await fetch(`${GHL}/opportunities/${x.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: x.to, pipelineId: x.pipelineId, pipelineStageId: x.stageId }) });
  if (r.ok) ok++; else { fail++; console.log('✗ rename', x.from, r.status); }
  await sleep(250);
}
for (const x of plan.delete) {
  const r = await fetch(`${GHL}/opportunities/${x.id}`, { method: 'DELETE', headers: H });
  if (r.ok) ok++; else { fail++; console.log('✗ delete', x.name, r.status); }
  await sleep(250);
}
console.log(`applied: ${ok} ok, ${fail} failed`);
await db.end();
