// MCS (Montessori Children's School) — reconcile the school's roster sheet
// against GHL. READ-ONLY. Pulls every contact live from GHL (the family
// graph only holds the contacts that passed the DG household gate), then
// matches sheet families → contacts by Parent 1 name, students → slots,
// Parent 2 → parent_2_* fields / existing "parent 2" contacts, tags → tags.
//
//   node --env-file=.env.local scripts/mcs-recon.mjs [--json out.json]
import fs from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';

const S = 'a8b6674a-2515-4f2e-9897-73a968de7fe1';
const GHL = 'https://services.leadconnectorhq.com';
const CSV = 'C:/Users/thelo/Downloads/Montessori Growth Suite Input - Sheet1 (1).csv';
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
await db.end();
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

// ── 1. all contacts, live ─────────────────────────────────────────────
const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const keyById = new Map(fields.map((f) => [f.id, String(f.fieldKey ?? '').replace(/^contact\./, '')]));
const contacts = [];
let startAfterId, startAfter;
for (;;) {
  const u = new URL(`${GHL}/contacts/`);
  u.searchParams.set('locationId', loc); u.searchParams.set('limit', '100');
  if (startAfterId) { u.searchParams.set('startAfterId', startAfterId); u.searchParams.set('startAfter', String(startAfter)); }
  const j = await (await fetch(u, { headers: H })).json();
  const page = j.contacts ?? [];
  for (const c of page) {
    const cf = {};
    for (const f of c.customFields ?? []) { const k = keyById.get(f.id); if (k && f.value != null && String(f.value).trim() !== '') cf[k] = f.value; }
    contacts.push({ id: c.id, first: c.firstName ?? '', last: c.lastName ?? '', email: c.email ?? '', phone: c.phone ?? '', tags: (c.tags ?? []).map((t) => t.toLowerCase()), cf });
  }
  if (page.length < 100 || !j.meta?.startAfterId) break;
  startAfterId = j.meta.startAfterId; startAfter = j.meta.startAfter;
  await sleep(150);
}
console.log(`GHL contacts: ${contacts.length}`);

// ── 2. parse sheet ────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const raw = parseCsv(fs.readFileSync(CSV, 'utf8')).slice(1);
const students = []; // {first,last,program,tags:[],parents:[]}
let cur = null;
for (const r of raw) {
  const [name, tag, parent] = r.map((x) => String(x ?? '').trim());
  if (name) {
    let first, last;
    if (name.includes(',')) { [last, first] = name.split(',').map((x) => x.trim()); }
    else { const p = name.split(/\s+/); last = p.pop(); first = p.join(' '); }
    cur = { first, last, program: tag, tags: [], parents: [] };
    students.push(cur);
    if (parent) cur.parents.push(parent);
    continue;
  }
  if (!cur) continue;
  if (tag) cur.tags.push(...tag.split(';').map((t) => t.trim()).filter(Boolean));
  if (parent) cur.parents.push(parent);
}
// families keyed by Parent 1 name (+ Parent 2 name)
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/"[^"]*"/g, ' ').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const families = new Map();
for (const st of students) {
  const p1 = st.parents[0] ?? '', p2 = st.parents[1] ?? '', extra = st.parents.slice(2);
  const key = norm(p1) + '|' + norm(p2);
  const f = families.get(key) ?? { p1, p2, extra, students: [], tags: new Set() };
  f.students.push(st);
  for (const t of st.tags) f.tags.add(t);
  f.tags.add(st.program);
  families.set(key, f);
}
console.log(`sheet: ${students.length} students in ${families.size} families`);

// ── 3. match ──────────────────────────────────────────────────────────
const nameOf = (c) => norm(`${c.first} ${c.last}`);
const firstTok = (s) => norm(s).split(' ')[0];
const lastTok = (s) => norm(s).split(' ').at(-1);
function findContacts(personName) {
  const n = norm(personName); if (!n) return [];
  const exact = contacts.filter((c) => nameOf(c) === n);
  if (exact.length) return exact;
  const f = firstTok(personName), l = lastTok(personName);
  const fl = contacts.filter((c) => firstTok(c.first) === f && lastTok(c.last) === l);
  if (fl.length) return fl;
  // P2-in-fields: contact whose parent_2 name matches
  return [];
}
const slotsOf = (c) => {
  const out = [];
  for (let s = 1; s <= 4; s++) {
    const p = s === 1 ? 'student_' : `student_${s}_`;
    const fn = c.cf[`${p}first_name`]; if (fn) out.push({ slot: s, first: fn, last: c.cf[`${p}last_name`] ?? '' });
  }
  return out;
};

const report = { matched: [], p1_missing: [], p1_ambiguous: [] };
let stFound = 0, stMissing = 0, p2InFields = 0, p2OwnContact = 0, p2NoEmail = 0, p2Absent = 0, p2None = 0;
const tagDiffs = [];
for (const [, f] of families) {
  const cands = findContacts(f.p1);
  if (cands.length === 0) { report.p1_missing.push(f); continue; }
  if (cands.length > 1) { report.p1_ambiguous.push({ f, cands: cands.map((c) => `${c.first} ${c.last} <${c.email}> [${c.tags.join(',')}]`) }); }
  // prefer a candidate that has student fields / is not tagged parent 2
  cands.sort((a, b) => (Number(slotsOf(b).length > 0) - Number(slotsOf(a).length > 0)) || (Number(a.tags.includes('parent 2')) - Number(b.tags.includes('parent 2'))));
  const c = cands[0];
  const slots = slotsOf(c);
  const kids = f.students.map((st) => {
    const hit = slots.find((s) => firstTok(s.first) === firstTok(st.first)) ?? null;
    if (hit) stFound++; else stMissing++;
    return { name: `${st.first} ${st.last}`, program: st.program, slot: hit?.slot ?? null };
  });
  // P2
  let p2 = 'none';
  if (f.p2) {
    const own = findContacts(f.p2).filter((x) => x.id !== c.id);
    const inFields = c.cf.parent_2_first_name && firstTok(c.cf.parent_2_first_name) === firstTok(f.p2);
    if (own.length) { p2 = `own contact (${own[0].email || 'no email'})${own[0].tags.includes('parent 2') ? ' tagged parent 2' : ''}`; p2OwnContact++; }
    else if (inFields) { p2 = c.cf.parent_2_email ? `in fields (${c.cf.parent_2_email})` : 'in fields, NO email'; if (c.cf.parent_2_email) p2InFields++; else p2NoEmail++; }
    else { p2 = 'ABSENT'; p2Absent++; }
  } else p2None++;
  // tags
  const want = [...f.tags].map((t) => t.toLowerCase());
  const missingTags = want.filter((t) => !c.tags.includes(t));
  const extraProgTags = c.tags.filter((t) => ['stepping stones', 'primary', 'lower elementary', 'upper elementary', 'adolescent', 'new', 'alumni'].includes(t) && !want.includes(t));
  if (missingTags.length || extraProgTags.length) tagDiffs.push({ p1: f.p1, add: missingTags, remove: extraProgTags });
  report.matched.push({ p1: f.p1, contact: `${c.first} ${c.last} <${c.email}>`, id: c.id, tags: c.tags, kids, slotsInGhl: slots.map((s) => `${s.slot}:${s.first} ${s.last}`), p2: f.p2, p2_state: p2, extra: f.extra });
}

console.log(`\nfamilies matched to a P1 contact: ${report.matched.length} | P1 NOT FOUND: ${report.p1_missing.length} | ambiguous: ${report.p1_ambiguous.length}`);
console.log(`students found in a slot: ${stFound} | students missing from contact: ${stMissing}`);
console.log(`Parent 2 — own contact already: ${p2OwnContact} | in P1 fields w/ email: ${p2InFields} | in fields NO email: ${p2NoEmail} | absent: ${p2Absent} | no P2 on sheet: ${p2None}`);
console.log(`families whose tags differ from sheet: ${tagDiffs.length}`);
console.log('\nP1 NOT FOUND:'); for (const f of report.p1_missing) console.log(`  · ${f.p1} / ${f.p2 || '—'} — ${f.students.map((s) => `${s.first} ${s.last} (${s.program})`).join(', ')}`);
console.log('\nAMBIGUOUS P1:'); for (const a of report.p1_ambiguous) console.log(`  · ${a.f.p1}: ${a.cands.join(' || ')}`);
console.log('\nSTUDENTS MISSING FROM THEIR CONTACT:'); for (const m of report.matched) for (const k of m.kids) if (!k.slot) console.log(`  · ${k.name} (${k.program}) → ${m.contact} has [${m.slotsInGhl.join('; ')}]`);
console.log('\nPARENT 2 ABSENT (name not in fields, no own contact):'); for (const m of report.matched) if (m.p2_state === 'ABSENT') console.log(`  · ${m.p2} (family of ${m.p1})`);
console.log('\nTAG DIFFS (sample 30):'); for (const t of tagDiffs.slice(0, 30)) console.log(`  · ${t.p1}: +[${t.add.join(', ')}] -[${t.remove.join(', ')}]`);
console.log('\nEXTRA ADULTS:'); for (const m of report.matched) if (m.extra.length) console.log(`  · ${m.p1}: ${m.extra.join(', ')}`);

const out = process.argv.indexOf('--json');
if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify({ contacts, families: [...families.values()], report, tagDiffs }, null, 1));
