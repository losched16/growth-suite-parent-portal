// MCS (Montessori Children's School) — restructure contacts to the platform
// model from the school's roster sheet:
//   Parent 1 contact = family record (all students in slots 1–4, per-student
//                      Enrollment Status + Program, Parent 2 in parent_2_*,
//                      tags per sheet)
//   Parent 2 contact = communication mirror (tagged "parent 2"/"parent",
//                      student fields cleared; tags mirrored by the sync)
//
//   node --env-file=.env.local scripts/mcs-restructure.mjs          # dry-run
//   node --env-file=.env.local scripts/mcs-restructure.mjs --apply
import fs from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';

const S = 'a8b6674a-2515-4f2e-9897-73a968de7fe1';
const GHL = 'https://services.leadconnectorhq.com';
const CSV = 'C:/Users/thelo/Downloads/Montessori Growth Suite Input - Sheet1 (1).csv';
const STUDENT_FOLDER = '1y63kDBHFhvbEEY7zXt7';
const PROGRAMS = ['Stepping Stones', 'Primary', 'Lower Elementary', 'Upper Elementary', 'Adolescent'];
const STATUS_OPTIONS = ['enrolled', 'pending', 'withdrawn', 'accepted', 'applied', 'inquiry', 'declined'];
const MANAGED_TAGS = new Set(['stepping stones', 'primary', 'lower elementary', 'upper elementary', 'adolescent', 'new']);
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
await db.end();
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const nk = (k) => String(k ?? '').replace(/^contact\./, '');

// ── 1. field kit ──────────────────────────────────────────────────────
let fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const haveKey = () => new Set(fields.map((f) => nk(f.fieldKey)));
const slotKey = (slot, base) => (slot === 1 ? `student_${base}` : `student_${slot}_${base}`);
const WANT_FIELDS = [];
for (let s = 1; s <= 4; s++) {
  const pfx = s === 1 ? 'Student' : `Student ${s}`;
  WANT_FIELDS.push({ key: slotKey(s, 'enrollment_status'), name: `${pfx} Enrollment Status`, options: STATUS_OPTIONS });
  WANT_FIELDS.push({ key: slotKey(s, 'program'), name: `${pfx} Program`, options: PROGRAMS });
}
console.log('— field kit —');
for (const w of WANT_FIELDS) {
  if (haveKey().has(w.key)) { console.log(`  · ${w.key} exists`); continue; }
  if (!apply) { console.log(`  + would create ${w.key}`); continue; }
  const r = await fetch(`${GHL}/locations/${loc}/customFields`, { method: 'POST', headers: H, body: JSON.stringify({ name: w.name, dataType: 'SINGLE_OPTIONS', options: w.options, model: 'contact', parentId: STUDENT_FOLDER, position: 5 }) });
  const j = await r.json().catch(() => ({}));
  console.log(`  ${r.ok ? '+' : '✗'} ${w.key} → ${j.customField?.fieldKey ?? JSON.stringify(j).slice(0, 120)}`);
  await sleep(350);
}
if (apply) fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const FID = new Map(fields.map((f) => [nk(f.fieldKey), f.id]));
const keyById = new Map(fields.map((f) => [f.id, nk(f.fieldKey)]));
const fid = (k) => { const id = FID.get(k); if (!id && apply) throw new Error(`missing field ${k}`); return id ?? `<${k}>`; };

// ── 2. contacts, live ─────────────────────────────────────────────────
const contacts = [];
{
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
    startAfterId = j.meta.startAfterId; startAfter = j.meta.startAfter; await sleep(150);
  }
}
const byId = new Map(contacts.map((c) => [c.id, c]));
console.log(`GHL contacts: ${contacts.length}`);

// ── 3. sheet ──────────────────────────────────────────────────────────
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
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/"[^"]*"/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const ft = (s) => norm(s).split(' ')[0] ?? '';
const lt = (s) => norm(s).split(' ').at(-1) ?? '';
const cleanName = (s) => String(s ?? '').replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'll']);
const toks = (s) => norm(s).split(' ').filter((t) => t && !SUFFIX.has(t));
const ftk = (s) => toks(s)[0] ?? '';
const ltk = (s) => toks(s).at(-1) ?? '';
// Damerau-Levenshtein ≤ 1
function close(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (edits++) return false;
    if (a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; }
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// first names: equal, 1 typo apart, or nickname (one is a ≥4-char prefix of the other: chris/christopher)
const sameFirst = (a, b) => !!a && !!b && (close(a, b) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))));
const samePerson = (a, b) => !!a && !!b && sameFirst(ftk(a), ftk(b)) && ltk(a) === ltk(b);
// same person under a name variant (maiden name / nickname): first OR last matches
const likelySame = (a, b) => !!a && !!b && (sameFirst(ftk(a), ftk(b)) || ltk(a) === ltk(b));

const students = []; let cur = null;
for (const r of parseCsv(fs.readFileSync(CSV, 'utf8')).slice(1)) {
  const [name, tag, parent] = r.map((x) => String(x ?? '').trim());
  if (name) {
    let first, last;
    if (name.includes(',')) { [last, first] = name.split(',').map((x) => x.trim()); }
    else { const p = name.split(/\s+/); last = p.pop(); first = p.join(' '); }
    cur = { first: cleanName(first), last: cleanName(last), program: tag, tags: [], parents: [] };
    students.push(cur); if (parent) cur.parents.push(parent); continue;
  }
  if (!cur) continue;
  if (tag) cur.tags.push(...tag.split(';').map((t) => t.trim()).filter(Boolean));
  if (parent) cur.parents.push(parent);
}
// families keyed by Parent 1
const families = new Map();
for (const st of students) {
  const p1 = cleanName(st.parents[0] ?? '');
  const key = norm(p1);
  const f = families.get(key) ?? { p1, p2s: [], students: [], tags: new Set() };
  f.students.push(st);
  for (const p of st.parents.slice(1)) { const nm = cleanName(p); if (nm && !f.p2s.some((x) => samePerson(x, nm)) && !samePerson(nm, p1)) f.p2s.push(nm); }
  for (const t of st.tags) f.tags.add(t);
  f.tags.add(st.program);
  families.set(key, f);
}
console.log(`sheet: ${students.length} students / ${families.size} families`);

// ── 4. resolve ────────────────────────────────────────────────────────
const slotsOf = (c) => { const o = []; for (let s = 1; s <= 4; s++) { const fn = c.cf[slotKey(s, 'first_name')]; if (fn) o.push({ slot: s, first: fn, last: c.cf[slotKey(s, 'last_name')] ?? '' }); } return o; };
const holds = (c, st) => slotsOf(c).some((s) => ft(s.first) === ft(st.first) && lt(s.last) === lt(st.last));
const byName = (name, excl = new Set()) => {
  const n = norm(name); if (!n) return [];
  let hits = contacts.filter((c) => !excl.has(c.id) && norm(`${c.first} ${c.last}`) === n);
  if (!hits.length) hits = contacts.filter((c) => !excl.has(c.id) && ft(c.first) === ft(name) && lt(c.last) === lt(name));
  return hits;
};
// explicit P1 aliases (contact name ≠ sheet name, confirmed by the child on the contact)
const P1_ALIAS = { 'naneshka pagan': 'naneshka pagan velez', 'lijuan wei': 'kyla hou' };
// "Kyla Hou" contact is named after the child; it already holds Caisheng Hou as
// Parent 2 (own email/mobile), so the contact itself is Lijuan Wei.
const RENAME = { 'kyla hou': { firstName: 'Lijuan', lastName: 'Wei' } };
const SWAP_P1 = { 'caisheng hou': 'Lijuan Wei' };
// loose first-name match for "is this the same Parent 2 already in the fields"
const sameFirstLoose = (a, b) => sameFirst(a, b) || (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3));

const plan = []; const flags = [];
for (const [, f] of families) {
  let p2Names = [...f.p2s];
  if (SWAP_P1[norm(f.p1)]) { p2Names = [f.p1, ...p2Names.filter((n) => !samePerson(n, SWAP_P1[norm(f.p1)]))]; f.p1 = SWAP_P1[norm(f.p1)]; }
  let p1 = null, how = 'name';
  const alias = P1_ALIAS[norm(f.p1)];
  if (alias) { p1 = byName(alias)[0] ?? null; how = 'alias'; }
  if (!p1) {
    const cands = byName(f.p1).filter((c) => !p2Names.some((n) => samePerson(`${c.first} ${c.last}`, n)));
    cands.sort((a, b) => (slotsOf(b).length - slotsOf(a).length) || (Number(a.tags.includes('parent 2')) - Number(b.tags.includes('parent 2'))) || (Number(!!b.email) - Number(!!a.email)));
    p1 = cands[0] ?? null;
    if (cands.length > 1) flags.push(`ambiguous P1 ${f.p1}: ${cands.map((c) => `${c.first} ${c.last} <${c.email}>`).join(' || ')} → using first`);
  }
  if (!p1) {
    // fallback: the contact that already holds one of this family's children
    const holders = contacts.filter((c) => f.students.some((st) => holds(c, st)));
    const uniq = [...new Map(holders.map((c) => [c.id, c])).values()];
    if (uniq.length >= 1) {
      uniq.sort((a, b) => slotsOf(b).length - slotsOf(a).length);
      p1 = uniq[0]; how = 'holder';
      // the sheet's Parent 1 becomes a Parent 2 entry — unless the holder IS that
      // person under a name variant (Hannah Smith → Hannah Hatfield) and not a listed P2
      const holderIsP2 = p2Names.some((n) => samePerson(`${p1.first} ${p1.last}`, n));
      if (holderIsP2 || !likelySame(`${p1.first} ${p1.last}`, f.p1)) {
        const p1name = f.p1;
        const idx = p2Names.findIndex((n) => samePerson(`${p1.first} ${p1.last}`, n));
        if (idx >= 0) p2Names.splice(idx, 1);
        p2Names.unshift(p1name);
      }
    }
  }
  if (!p1) { plan.push({ f, create: true, p2Names }); continue; }

  // students → slots
  const existing = slotsOf(p1);
  const usedSlots = new Set(existing.map((s) => s.slot));
  const kids = [];
  for (const st of f.students) {
    const stFirst = ft(st.first), hit = existing.find((s) => close(ft(s.first), stFirst) || norm(s.first) === norm(st.first));
    if (hit) { kids.push({ st, slot: hit.slot, isNew: false }); continue; }
    let slot = 1; while (usedSlots.has(slot)) slot++;
    if (slot > 4) { flags.push(`${f.p1}: no free slot for ${st.first} ${st.last}`); continue; }
    usedSlots.add(slot);
    // copy DOB/gender from another contact that holds this child
    const donor = contacts.find((c) => c.id !== p1.id && holds(c, st));
    const dslot = donor ? slotsOf(donor).find((s) => ft(s.first) === ft(st.first)).slot : null;
    kids.push({ st, slot, isNew: true, dob: donor ? donor.cf[slotKey(dslot, 'date_of_birth')] : undefined, gender: donor ? donor.cf[slotKey(dslot, 'gender')] : undefined });
  }

  // the same child entered twice on this contact (Hays: Amelia in slot 1 and 3) → clear the extra slot
  const matchedSlots = new Set(kids.map((k) => k.slot));
  const dupSlots = existing.filter((s) => !matchedSlots.has(s.slot) && existing.some((o) => matchedSlots.has(o.slot) && close(ft(o.first), ft(s.first)) && lt(o.last) === lt(s.last))).map((s) => s.slot);
  if (dupSlots.length) flags.push(`${p1.first} ${p1.last}: duplicate child slot(s) ${dupSlots.join(',')} will be cleared`);

  // parent 2 resolution
  const p2 = p2Names.filter((n, i, arr) => arr.findIndex((m) => samePerson(m, n)) === i).map((n) => {
    const own = byName(n, new Set([p1.id]))[0] ?? null;
    const inFields = !!p1.cf.parent_2_first_name && sameFirstLoose(ftk(p1.cf.parent_2_first_name), ftk(n));
    return { name: n, own, inFields };
  });
  p2.sort((a, b) => (Number(!!b.own) - Number(!!a.own)) || (Number(!!b.inFields) - Number(!!a.inFields)));
  const primaryP2 = p2[0] ?? null; const extras = p2.slice(1);
  plan.push({ f, p1, how, kids, dupSlots, primaryP2, extras, rename: RENAME[norm(`${p1.first} ${p1.last}`)] ?? null });
}

// ── 5. report ─────────────────────────────────────────────────────────
const n = (pred) => plan.filter(pred).length;
console.log(`\nfamilies: ${plan.length} | P1 by name: ${n((p) => p.how === 'name')} | by alias: ${n((p) => p.how === 'alias')} | by child-holder (other parent's contact): ${n((p) => p.how === 'holder')} | NEW contact needed: ${n((p) => p.create)}`);
const newKids = plan.flatMap((p) => (p.kids ?? []).filter((k) => k.isNew));
console.log(`students: ${plan.flatMap((p) => p.kids ?? []).length} placed | ${newKids.length} added to a slot (${newKids.filter((k) => k.dob).length} with DOB copied from the other parent's contact)`);
console.log(`parent 2: own contact ${n((p) => p.primaryP2?.own)} | fields only ${n((p) => p.primaryP2 && !p.primaryP2.own)} | none ${n((p) => !p.primaryP2 && !p.create)} | extra adults → Parent 3/4: ${plan.reduce((a, p) => a + (p.extras?.length ?? 0), 0)}`);
console.log('\nP1 resolved via the other parent\'s contact (sheet P1 → Parent 2 field):');
for (const p of plan) if (p.how === 'holder') console.log(`  · ${p.f.p1} → contact ${p.p1.first} ${p.p1.last} <${p.p1.email}>; P2 field ← ${p.primaryP2?.name ?? '—'}${p.primaryP2?.own ? ' (own contact)' : ''}`);
console.log('\nNEW contacts needed:'); for (const p of plan) if (p.create) console.log(`  · ${p.f.p1} (${p.f.students.map((s) => s.first).join(', ')})`);
console.log('\nP2 contacts that will be cleared of student fields + tagged parent 2:');
for (const p of plan) if (p.primaryP2?.own && slotsOf(p.primaryP2.own).length) console.log(`  · ${p.primaryP2.own.first} ${p.primaryP2.own.last} <${p.primaryP2.own.email}> holds [${slotsOf(p.primaryP2.own).map((s) => s.first).join(', ')}] → family of ${p.p1.first} ${p.p1.last}`);
console.log('\nExtras → Parent 3/4:'); for (const p of plan) for (const e of p.extras ?? []) console.log(`  · ${e.name} (${p.p1.first} ${p.p1.last})${e.own ? ' own contact' : ''}`);
console.log('\nChildren on the Parent 1 contact that are NOT on the sheet (left as-is, not enrolled):');
for (const p of plan) if (p.p1) { const used = new Set((p.kids ?? []).map((k) => k.slot)); for (const s of slotsOf(p.p1)) if (!used.has(s.slot)) console.log(`  · ${s.first} ${s.last} on ${p.p1.first} ${p.p1.last} (sheet: ${p.f.students.map((x) => x.first).join(', ')})`); }
console.log('\nParent 2 field already held a DIFFERENT person (will be replaced):');
for (const p of plan) if (p.p1 && p.primaryP2 && !p.primaryP2.inFields && p.p1.cf.parent_2_first_name) console.log(`  · ${p.p1.first} ${p.p1.last}: fields say ${p.p1.cf.parent_2_first_name} ${p.p1.cf.parent_2_last_name ?? ''} <${p.p1.cf.parent_2_email ?? ''}> → sheet says ${p.primaryP2.name}${p.primaryP2.own ? ' (own contact ' + p.primaryP2.own.email + ')' : ''}`);
console.log('\nFLAGS:'); for (const x of flags) console.log('  ! ' + x);

if (!apply) { console.log('\nDRY RUN — nothing written'); process.exit(0); }

// ── 6. apply ──────────────────────────────────────────────────────────
const put = async (id, body) => { const r = await fetch(`${GHL}/contacts/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) }); if (!r.ok) console.log('  ✗ PUT', id, r.status, (await r.text()).slice(0, 160)); await sleep(220); return r.ok; };
const post = async (body) => { const r = await fetch(`${GHL}/contacts/`, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) console.log('  ✗ POST', r.status, JSON.stringify(j).slice(0, 160)); await sleep(220); return j.contact ?? null; };
const tagSet = (cur, add, remove) => { const s = new Set(cur.map((t) => t.toLowerCase())); for (const t of remove) s.delete(t.toLowerCase()); for (const t of add) s.add(t.toLowerCase()); return [...s]; };
let ok = 0, fail = 0;
for (const p of plan) {
  const famTags = [...p.f.tags];
  let p1 = p.p1;
  if (p.create) {
    const [first, ...rest] = p.f.p1.split(' ');
    const c = await post({ locationId: loc, firstName: first, lastName: rest.join(' '), tags: ['parent 1', 'parent', ...famTags] });
    if (!c) { fail++; continue; }
    p1 = { id: c.id, first, last: rest.join(' '), email: '', phone: '', tags: [], cf: {} };
    p.kids = p.f.students.map((st, i) => ({ st, slot: i + 1, isNew: true }));
    p.primaryP2 = p.p2Names?.[0] ? { name: p.p2Names[0], own: byName(p.p2Names[0])[0] ?? null } : null; p.extras = [];
  }
  // P1 custom fields
  const cf = [];
  for (const k of p.kids) {
    if (k.isNew) {
      cf.push({ id: fid(slotKey(k.slot, 'first_name')), value: k.st.first }, { id: fid(slotKey(k.slot, 'last_name')), value: k.st.last });
      if (k.dob) cf.push({ id: fid(slotKey(k.slot, 'date_of_birth')), value: k.dob });
      if (k.gender) cf.push({ id: fid(slotKey(k.slot, 'gender')), value: k.gender });
    }
    cf.push({ id: fid(slotKey(k.slot, 'enrollment_status')), value: 'enrolled' }, { id: fid(slotKey(k.slot, 'program')), value: k.st.program });
  }
  for (const slot of p.dupSlots ?? []) for (const base of ['first_name', 'last_name', 'date_of_birth', 'gender']) if (p1.cf[slotKey(slot, base)]) cf.push({ id: fid(slotKey(slot, base)), value: '' });
  if (p.primaryP2) {
    const [pf, ...pr] = p.primaryP2.name.split(' ');
    if (!p.primaryP2.inFields) cf.push({ id: fid('parent_2_first_name'), value: pf }, { id: fid('parent_2_last_name'), value: pr.join(' ') });
    const own = p.primaryP2.own;
    const conflict = !p.primaryP2.inFields && !!p1.cf.parent_2_first_name; // fields held a different person
    if (own?.email && (!p1.cf.parent_2_email || !p.primaryP2.inFields)) cf.push({ id: fid('parent_2_email'), value: own.email });
    else if (conflict && p1.cf.parent_2_email) cf.push({ id: fid('parent_2_email'), value: '' });
    if (own?.phone && (!p1.cf.parent_2_mobile || conflict)) cf.push({ id: fid('parent_2_mobile'), value: own.phone });
    else if (conflict && p1.cf.parent_2_mobile) cf.push({ id: fid('parent_2_mobile'), value: '' });
  }
  const extraKeys = [['parent_3_name', 'parent_3_email', 'parent_3_phone_number'], ['parent_4_name', 'parent_4_email', 'parent_4_phone_number']];
  (p.extras ?? []).slice(0, 2).forEach((e, i) => {
    const [kn, ke, kp] = extraKeys[i];
    if (!p1.cf[kn]) cf.push({ id: fid(kn), value: e.name });
    if (e.own?.email && !p1.cf[ke]) cf.push({ id: fid(ke), value: e.own.email });
    if (e.own?.phone && !p1.cf[kp]) cf.push({ id: fid(kp), value: e.own.phone });
  });
  const wantProg = p.f.students.map((s) => s.program.toLowerCase());
  const removeTags = [...MANAGED_TAGS].filter((t) => !famTags.map((x) => x.toLowerCase()).includes(t) && !wantProg.includes(t)).concat(['parent 2']);
  const body = { customFields: cf, tags: tagSet(p1.tags, ['parent 1', 'parent', ...famTags], removeTags) };
  if (p.rename) Object.assign(body, p.rename);
  (await put(p1.id, body)) ? ok++ : fail++;

  // P2 own contact (+ extras with own contacts): mirror, clear student fields
  const mirrors = [p.primaryP2?.own, ...(p.extras ?? []).map((e) => e.own)].filter(Boolean).filter((c) => c.id !== p1.id);
  for (const m of mirrors) {
    const clear = [];
    for (const s of slotsOf(m)) for (const base of ['first_name', 'last_name', 'date_of_birth', 'gender', 'enrollment_status', 'program']) if (m.cf[slotKey(s.slot, base)]) clear.push({ id: fid(slotKey(s.slot, base)), value: '' });
    (await put(m.id, { customFields: clear, tags: tagSet(m.tags, ['parent 2', 'parent', ...famTags], ['parent 1']) })) ? ok++ : fail++;
  }
}
console.log(`\napplied: ${ok} ok, ${fail} failed`);
