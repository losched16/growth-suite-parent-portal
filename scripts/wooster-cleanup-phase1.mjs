// Wooster roster cleanup — PHASE 1 (GHL is source of truth; no DB edits).
//
//  1. Create per-slot program fields for slots 2–4 (slot 1 already has
//     `select_the_program_this_child_will_attend`; same option list).
//  2. Specific fixes from the sheet: slot-adds, in-place renames, program
//     corrections. Every rename stays in its slot so form signals stick.
//  3. Full-sheet enrolled pass: for every student on the sheet that
//     matches a GHL contact+slot, ensure enrollment_status = enrolled and
//     the contact carries `enrolled - 26/27`. Unmatched rows are reported.
//
//   node --env-file=.env.local scripts/wooster-cleanup-phase1.mjs          # dry-run
//   node --env-file=.env.local scripts/wooster-cleanup-phase1.mjs --apply

import fs from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const CSV = 'C:/Users/thelo/Downloads/form status all forms missing 2026-08-17 - GW --_ MSW.csv';
const ENROLLED_TAG = 'enrolled - 26/27';
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
const nk = (k) => String(k ?? '').replace(/^contact\./, '');

// ── field ids ─────────────────────────────────────────────────────────
let fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const idByKey = () => new Map(fields.map((f) => [nk(f.fieldKey), f.id]));
const PROG_KEY = 'select_the_program_this_child_will_attend';
const progField1 = fields.find((f) => nk(f.fieldKey) === PROG_KEY);
const PROGRAM_OPTIONS = progField1?.picklistOptions ?? [];
const FOLDER = { 2: 'kO6qmBxFUppEQ4s2isF3', 3: 'gPFvYDaqUzbwULxdeqUB', 4: '07pRp4W9SgakJ1RqMEWv' };

// ── 1. per-slot program fields ───────────────────────────────────────
console.log('— per-slot program fields —');
for (const slot of [2, 3, 4]) {
  const key = `student_${slot}_${PROG_KEY}`;
  if (idByKey().has(key)) { console.log(`  · ${key} exists`); continue; }
  if (!apply) { console.log(`  + would create ${key} (${PROGRAM_OPTIONS.length} options)`); continue; }
  const r = await fetch(`${GHL}/locations/${loc}/customFields`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `Student ${slot} Select The Program This Child Will Attend`, dataType: 'SINGLE_OPTIONS', options: PROGRAM_OPTIONS, model: 'contact', parentId: FOLDER[slot], position: 65 }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`  ${r.ok ? '+' : '✗'} ${key} → ${j.customField?.fieldKey ?? JSON.stringify(j).slice(0, 100)}`);
  await sleep(350);
}
if (apply) fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const FID = idByKey();
const fid = (slot, base) => FID.get(slot === 1 ? `student_${base}` : `student_${slot}_${base}`);
const progFid = (slot) => (slot === 1 ? FID.get(PROG_KEY) : FID.get(`student_${slot}_${PROG_KEY}`));
const statusFid = (slot) => fid(slot, 'enrollment_status');
const firstFid = (slot) => fid(slot, 'first_name');
const lastFid = (slot) => fid(slot, 'last_name');

const PROGRAM_ALIAS = { 'high school (grades 9 or 10)': 'High School (Grades 9-12)' };
function programOption(label) {
  const raw = String(label ?? '').trim();
  const aliased = PROGRAM_ALIAS[raw.toLowerCase()] ?? raw;
  const want = aliased.toLowerCase().replace(/\s+/g, ' ');
  if (!want) return null;
  const exact = PROGRAM_OPTIONS.find((o) => o.trim().toLowerCase().replace(/\s+/g, ' ') === want);
  return exact ?? null;
}

// ── DB index of contacts → slots (fresh from the 10-min sync) ─────────
const { rows: fv } = await db.query(
  `SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values
    WHERE school_id=$1 AND value<>'' AND field_key ~ '^student(_\\d)?_(first_name|last_name|enrollment_status)$'`, [S]);
const slotsByContact = new Map();
for (const r of fv) {
  const m = /^student(?:_(\d))?_(first_name|last_name|enrollment_status)$/.exec(r.field_key);
  const slot = Number(m[1] ?? 1);
  const c = slotsByContact.get(r.ghl_contact_id) ?? {};
  (c[slot] ??= {})[m[2]] = r.value;
  slotsByContact.set(r.ghl_contact_id, c);
}
const { rows: prow } = await db.query(
  `SELECT DISTINCT ghl_contact_id, first_name, last_name, email FROM parents WHERE school_id=$1 AND is_primary=true AND ghl_contact_id IS NOT NULL`, [S]);
const { rows: trow } = await db.query(`SELECT ghl_contact_id, tag FROM ghl_contact_tags WHERE school_id=$1`, [S]);
const { rows: pv } = await db.query(
  `SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values WHERE school_id=$1 AND value<>'' AND field_key ~ '^(student_\d_)?select_the_program_this_child_will_attend$'`, [S]);
const progByContact = new Map();
for (const r of pv) { const m = /^(?:student_(\d)_)?select/.exec(r.field_key); const slot = Number(m[1] ?? 1); (progByContact.get(r.ghl_contact_id) ?? progByContact.set(r.ghl_contact_id, {}).get(r.ghl_contact_id))[slot] = r.value; }
const PROGRAM_PASS = process.argv.includes('--programs');
let programSets = 0; const programChanged = []; const programNotes = [];
const tagsByContact = new Map();
for (const r of trow) (tagsByContact.get(r.ghl_contact_id) ?? tagsByContact.set(r.ghl_contact_id, new Set()).get(r.ghl_contact_id)).add(r.tag.toLowerCase());

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const ALIAS = { louie: 'louis', izzabella: 'isabella', diloun: 'diolun', jude: 'julian', lillith: 'lilith', maya: 'maya', 'zong han': 'zong' };
const canonFirst = (s) => { const n = norm(s); return ALIAS[n] ?? ALIAS[n.split(' ')[0]] ?? n.split(' ')[0]; };

function findContact(parentName) {
  const n = norm(parentName);
  if (!n) return [];
  const [f, ...rest] = n.split(' '); const l = rest.at(-1);
  const exact = prow.filter((p) => norm(`${p.first_name} ${p.last_name}`) === n);
  if (exact.length) return exact;
  const fl = prow.filter((p) => norm(p.first_name).split(' ')[0] === f && norm(p.last_name).split(' ').at(-1) === l);
  if (fl.length) return fl;
  return prow.filter((p) => l && norm(p.last_name).split(' ').at(-1) === l);
}
function findSlot(contactId, studentFirst) {
  const slots = slotsByContact.get(contactId) ?? {};
  const want = canonFirst(studentFirst);
  const hits = Object.entries(slots).filter(([, v]) => canonFirst(v.first_name) === want);
  return hits.length === 1 ? Number(hits[0][0]) : null;
}

// ── change queue (per contact) ────────────────────────────────────────
const queue = new Map(); // contactId → { label, fields: Map<fid,value>, tags: Set }
function q(contactId, label, fieldsObj = {}, tags = []) {
  const e = queue.get(contactId) ?? { label, fields: new Map(), tags: new Set() };
  for (const [k, v] of Object.entries(fieldsObj)) if (k && v != null) e.fields.set(k, v);
  for (const t of tags) e.tags.add(t);
  queue.set(contactId, e);
}
const setStudent = (cid, label, slot, first, last, program, opts = {}) => {
  const f = {};
  const put = (id, v) => { if (id) f[id] = v; else notes.push(`missing field id for ${label} slot ${slot} — value "${v}" not written (dry-run only: created on --apply)`); };
  if (first) put(firstFid(slot), first);
  if (last) put(lastFid(slot), last);
  if (opts.enrolled !== false) put(statusFid(slot), 'enrolled');
  const po = programOption(program);
  if (program && !po) notes.push(`program "${program}" is not a valid option — left blank for ${label} slot ${slot}`);
  if (po) put(progFid(slot), po);
  q(cid, label, f, opts.tag === false ? [] : [ENROLLED_TAG]);
};
const notes = [];

// ── 2. specific fixes ─────────────────────────────────────────────────
// A. adds to existing contacts
setStudent('J1xmzO1NySxGV6g7eNQX', 'Martez Phillips', 2, 'Stacey', 'Adams', 'Middle School program 9 am - 3:30 pm');
setStudent('J1xmzO1NySxGV6g7eNQX', 'Martez Phillips', 1, null, null, 'Lower Elementary program 9 am - 3:30 pm'); // real child, same name — mark enrolled
setStudent('H5aLaTpjTVMGod43zFPB', 'Annie Eriksen', 2, 'Bruce', 'Eriksen', "Children's House preschool program (3+ and potty trained) 9 am - noon");
setStudent('ZonfJPTKSqx40FQUdcrj', 'Vanessa Fletcher', 2, 'Victoria', 'Fletcher', 'High School (Grades 9 or 10)');   // slot 2 said "Vanessa"
setStudent('ZonfJPTKSqx40FQUdcrj', 'Vanessa Fletcher', 1, null, null, 'Upper Elementary program 9 am - 3:30 pm');
setStudent('2ocBzBnvYiGC23L6UflY', 'Tiara Schaffter', 2, 'Ivy', 'Fox', 'Lower Elementary program 9 am - 3:30 pm');
setStudent('2ocBzBnvYiGC23L6UflY', 'Tiara Schaffter', 1, null, null, "Children's House Lunchbuncher (Kindergarten) 9 am - 2:30 pm");
setStudent('bn8W9u0Ey34KlMK5U80U', 'Sasha Overmyer', 2, 'Remi', 'Overmyer', "Children's House preschool program (3+ and potty trained) 9 am - noon");
setStudent('iwPyMx89PkX94WEOKMHG', 'Hannah Crocker', 2, 'Jensen', 'Wonnell', 'Five day toddler program (18 months - 3 years) 7:00 am - 6:00 pm');
// B. slot-1 adds to contacts with no student fields
setStudent('eI7OLmtSsprAC7CnY5FE', 'Alissa Pummell', 1, 'Janeane', 'Pummell', 'Middle School program 9 am - 3:30 pm');
setStudent('S38YTL7WCdrSNsmxaltq', 'Chris Reed', 1, 'Knox', 'Reed', '4 day toddler 8-4');
setStudent('mzUbFre3fdGEmBlbnhSq', 'Brandon Nethers', 1, 'Benson', 'Nethers', 'Lower Elementary program 9 am - 3:30 pm');
setStudent('RdxrDvY8P0k3mhVu6dEi', 'Azielia Spitler (contact rename HELD)', 1, 'Azeila', 'Spitler', 'Five day toddler program (18 months - 3 years) 8:00 am - 4:00 pm');
// D. renames in place
setStudent('KLI2KU2CSlO6A3Z9rnEQ', 'Katherine Morgan', 3, 'Charles', 'Morgan', 'Upper Elementary program 9 am - 3:30 pm');
setStudent('sNPVhGh9JUgDCCtI99Cj', 'Meredith Drushal Carmony', 2, 'Heath', 'Carmony', 'Five day toddler program (18 months - 3 years) 8:30 am - noon');
setStudent('luvutQsIv3nrunr4izPd', 'Mia Jiang', 1, 'Zong Han', 'Jiang', 'Five day toddler program (18 months - 3 years) 8:00 am - 4:00 pm');
setStudent('q7SIrcjhNbNv6bN9xmDr', 'Andrei Turchyn', 1, 'Evolet', 'Turchyn', 'Lower Elementary program 9 am - 3:30 pm');
setStudent('q7SIrcjhNbNv6bN9xmDr', 'Andrei Turchyn', 2, null, null, 'Lower Elementary program 9 am - 3:30 pm');
q('ChDd54O49bEDwSY59169', 'Angela Koval', { [firstFid(1)]: 'Izzabella' }); // trim double space only
// Draper: whichever Celia slot (1 or 3) has FEWER form signals becomes Claira (Upper El)
{
  const { rows } = await db.query(
    `SELECT field_key FROM ghl_contact_field_values WHERE school_id=$1 AND ghl_contact_id=$2 AND field_key ~ '^form_.*_s[13]$' AND value<>''`,
    [S, 'mBbrYU23d5otnbh0jaud']);
  const n1 = rows.filter((r) => r.field_key.endsWith('_s1')).length, n3 = rows.filter((r) => r.field_key.endsWith('_s3')).length;
  const clairaSlot = n1 < n3 ? 1 : 3;
  notes.push(`Draper: slot1 has ${n1} form signals, slot3 has ${n3} → slot ${clairaSlot} renamed Celia→Claira (Upper El); the other stays Celia`);
  setStudent('mBbrYU23d5otnbh0jaud', 'Malissa Draper', clairaSlot, 'Claira', 'Draper', 'Upper Elementary program 9 am - 3:30 pm');
}
// F. program corrections on existing kids (contact found by parent, slot by student)
const PROGRAM_FIXES = [
  ['Joshua Deily', 'Freya', 'Upper Elementary program 9 am - 3:30 pm'],
  ['Shaquez Dickens', 'Traeh', "Children's House preschool program (3+ and potty trained) 9 am - noon"],
  ['Grace Murray', 'KaeLani', 'Lower Elementary program 9 am - 3:30 pm'],
  ['Samantha McClintock', 'Austin', 'Lower Elementary program 9 am - 3:30 pm'],
  ['Gwendolyn Miller', 'June', 'Upper Elementary program 9 am - 3:30 pm'],
  ['Elise Neville', 'Valerie', 'Three day toddler program (18 months - 3 years) 8:00 am - 4:00 pm'],
  ['Steven Sigler', 'Isaac', "Children's House Lunchbuncher (Kindergarten) 9 am - 2:30 pm"],
  ['Caren Smith', 'Dashel', 'Upper Elementary program 9 am - 3:30 pm'],
];
for (const [parent, student, program] of PROGRAM_FIXES) {
  const cs = findContact(parent);
  const c = cs.length === 1 ? cs[0] : cs.find((x) => findSlot(x.ghl_contact_id, student));
  const slot = c ? findSlot(c.ghl_contact_id, student) : null;
  if (!c || !slot) { notes.push(`program fix SKIPPED — couldn't locate ${student} under ${parent}`); continue; }
  setStudent(c.ghl_contact_id, `${parent}`, slot, null, null, program);
}

// Duplicate / prospect contacts that must NEVER be enrolled by the sheet pass
// (the real family lives on another contact).
const EXCLUDE = new Set([
  'TZZZ0eABjkZ2UKxahB9o', // "Camille Mullet" — dup of Amanda Good (real, enrolled)
  'g7L74QQGa42fkxSHuorL', // empty second "Martez Phillips"
  'BkVZJYilTpbjbH1CvDph', // empty second "Alissa Pummell"
]);
// ── 3. full-sheet enrolled pass ───────────────────────────────────────
const PLACEHOLDER = /crystal woody|^msw$|^mom$|joe from|email from|^liz$|^lauren$|^jessica$|^tabitha$|^annie$/i;
const csv = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).slice(1);
const parseRow = (line) => { const out = []; let cur = '', inq = false; for (const ch of line) { if (ch === '"') inq = !inq; else if (ch === ',' && !inq) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
let matched = 0, alreadyOk = 0, needStatus = 0, needTag = 0;
const unmatched = [];
for (const line of csv) {
  const cols = parseRow(line);
  const [ghlStudent, ghlParent, , , , , , sFirst, sLast, sheetParent, sheetProgram] = cols;
  if (!sFirst?.trim()) continue;
  // Column A/B come from GHL and are reliable — but only when column A is the
  // SAME student as columns H/I (the two lists are sorted independently, so a
  // row can pair "Porter Mason" with "Beauden Powers"). Otherwise use J.
  const aTokens = norm(ghlStudent).split(' ').map((t) => ALIAS[t] ?? t);
  const sameStudent = !!ghlStudent?.trim() && (aTokens.includes(canonFirst(sFirst)) || aTokens.includes(norm(sLast).split(' ').at(-1)));
  const jOk = sheetParent?.trim() && !PLACEHOLDER.test(sheetParent);
  const parentName = sameStudent ? ghlParent : (jOk ? sheetParent : (ghlStudent?.trim() ? '' : ghlParent));
  let cs = findContact(parentName).filter((p) => !EXCLUDE.has(p.ghl_contact_id));
  if (cs.length !== 1 && jOk) { const alt = findContact(sheetParent).filter((p) => !EXCLUDE.has(p.ghl_contact_id)); if (alt.length === 1) cs = alt; }
  const c = cs.length === 1 ? cs[0] : cs.find((x) => findSlot(x.ghl_contact_id, sFirst));
  const slot = c ? findSlot(c.ghl_contact_id, sFirst) : null;
  if (!c || !slot) {
    // may be one of the adds queued above — those are fine
    const queuedAdd = [...queue.values()].some((e) => [...e.fields.values()].some((v) => norm(v) === norm(sFirst)));
    if (!queuedAdd) unmatched.push(`${sFirst} ${sLast}  (parent: ${parentName})`);
    continue;
  }
  matched++;
  // Program from column K (school's authoritative list): set when the slot's
  // program is blank or different. Slot-1 key is unprefixed; slots 2-4 use the
  // per-slot fields created above.
  if (PROGRAM_PASS) {
    const po = programOption(sheetProgram);
    if (sheetProgram?.trim() && !po) programNotes.push(`${sFirst} ${sLast}: sheet program "${sheetProgram}" isn't a valid option`);
    if (po) {
      const cur = progByContact.get(c.ghl_contact_id)?.[slot] ?? '';
      if (cur !== po) { q(c.ghl_contact_id, `${c.first_name} ${c.last_name}`, { [progFid(slot)]: po }); programSets++; if (cur) programChanged.push(`${sFirst} ${sLast}: "${cur}" → "${po}"`); }
    }
  }
  const st = slotsByContact.get(c.ghl_contact_id)?.[slot]?.enrollment_status;
  const hasTag = tagsByContact.get(c.ghl_contact_id)?.has(ENROLLED_TAG) ?? false;
  const already = queue.get(c.ghl_contact_id);
  const statusQueued = already?.fields.has(statusFid(slot));
  if ((st === 'enrolled' || statusQueued) && (hasTag || already?.tags.has(ENROLLED_TAG))) { alreadyOk++; continue; }
  const f = {}; if (st !== 'enrolled' && !statusQueued) { f[statusFid(slot)] = 'enrolled'; needStatus++; }
  const t = []; if (!hasTag) { t.push(ENROLLED_TAG); needTag++; }
  q(c.ghl_contact_id, `${c.first_name} ${c.last_name}`, f, t);
}

// ── report ────────────────────────────────────────────────────────────
console.log('\n— sheet pass —');
console.log(`  matched to a GHL slot: ${matched}   already enrolled+tagged: ${alreadyOk}   status→enrolled: ${needStatus}   tag adds: ${needTag}`);
console.log(`  unmatched (${unmatched.length}):`); for (const u of unmatched) console.log(`    · ${u}`);
if (PROGRAM_PASS) { console.log(`  program sets: ${programSets} (of which ${programChanged.length} CHANGED an existing value):`); for (const x of programChanged) console.log(`    ~ ${x}`); for (const x of programNotes) console.log(`    ! ${x}`); }
console.log('\n— notes —'); for (const n of notes) console.log(`  · ${n}`);
console.log(`\n— write plan: ${queue.size} contacts —`);
const keyByFid = new Map(fields.map((f) => [f.id, nk(f.fieldKey)]));
for (const [cid, e] of queue) {
  const parts = [...e.fields].map(([id, v]) => `${keyByFid.get(id) ?? id}=${JSON.stringify(v).slice(0, 40)}`);
  console.log(`  ${e.label} (${cid}): ${parts.join(', ')}${e.tags.size ? `  +tags[${[...e.tags]}]` : ''}`);
}
if (!apply) { console.log('\nDRY RUN — re-run with --apply.'); await db.end(); process.exit(0); }

console.log('\n— applying —');
let ok = 0, fail = 0;
for (const [cid, e] of queue) {
  if (e.fields.size) {
    const r = await fetch(`${GHL}/contacts/${cid}`, { method: 'PUT', headers: H, body: JSON.stringify({ customFields: [...e.fields].map(([id, value]) => ({ id, value })) }) });
    if (r.ok) ok++; else { fail++; console.log(`  ✗ ${e.label}: ${r.status} ${(await r.text()).slice(0, 140)}`); }
    await sleep(300);
  }
  if (e.tags.size) {
    const r = await fetch(`${GHL}/contacts/${cid}/tags`, { method: 'POST', headers: H, body: JSON.stringify({ tags: [...e.tags] }) });
    if (!r.ok) console.log(`  ✗ tag ${e.label}: ${r.status}`);
    await sleep(300);
  }
}
console.log(`  contacts updated: ${ok}, failed: ${fail}`);
await db.end();
