// Wooster — the GHL inquiry forms map "Child's Date of Birth" to the
// contact's BUILT-IN Date of Birth, i.e. the parent's own birthday slot.
// Move each child-age DOB found there into the right Student N Date of
// Birth field and clear the parent's. Families with several children: the
// child whose program fits the age; ambiguous or conflicting → reported, not
// touched.
//
//   node --env-file=.env.local scripts/wooster-move-child-dob-off-parent.mjs [--apply]
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = new Date('2026-09-01T00:00:00Z');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
const kk = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
const dd = crypto.createDecipheriv('aes-256-gcm', kk, sc.rows[0].ghl_pit_iv); dd.setAuthTag(sc.rows[0].ghl_pit_tag);
const pit = Buffer.concat([dd.update(sc.rows[0].ghl_pit_encrypted), dd.final()]).toString('utf8');
const loc = sc.rows[0].ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

const { rows: kids } = await db.query(
  `SELECT p.ghl_contact_id, s.first_name, s.last_name, COALESCE((s.metadata->>'ghl_slot')::int, 1) AS slot,
          s.metadata->>'program' AS program
     FROM parents p JOIN students s ON s.family_id = p.family_id AND s.status = 'active'
    WHERE p.school_id = $1 AND p.is_primary AND p.ghl_contact_id IS NOT NULL`, [S]);
await db.end();
const kidsBy = new Map();
for (const k of kids) (kidsBy.get(k.ghl_contact_id) ?? kidsBy.set(k.ghl_contact_id, []).get(k.ghl_contact_id)).push(k);

const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields;
const fid = new Map(fields.map((f) => [String(f.fieldKey).replace(/^contact\./, ''), f.id]));
const dobKey = (slot) => (slot === 1 ? 'student_date_of_birth' : `student_${slot}_date_of_birth`);

// age range (years at Sept 1) each program plausibly holds
function band(program) {
  const p = String(program ?? '').toLowerCase();
  if (/toddler/.test(p)) return [1, 3.6];
  if (/children'?s house|kindergarten|lunchbunch|preschool|primary/.test(p)) return [2.5, 7];
  if (/lower el/.test(p)) return [5.5, 10];
  if (/upper el/.test(p)) return [8.5, 13];
  if (/middle/.test(p)) return [11, 15.5];
  if (/high school/.test(p)) return [13.5, 19.5];
  return null;
}
const toMDY = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const sameDate = (a, b) => {
  const pa = new Date(a), pb = new Date(b);
  return !isNaN(pa) && !isNaN(pb) && pa.toISOString().slice(0, 10) === pb.toISOString().slice(0, 10);
};

// all contacts carrying a built-in DOB
const withDob = [];
{
  let sa, sat;
  for (;;) {
    const u = new URL(`${GHL}/contacts/`); u.searchParams.set('locationId', loc); u.searchParams.set('limit', '100');
    if (sa) { u.searchParams.set('startAfterId', sa); u.searchParams.set('startAfter', String(sat)); }
    const j = await (await fetch(u, { headers: H })).json();
    const page = j.contacts ?? [];
    for (const c of page) if (c.dateOfBirth) withDob.push(c);
    if (page.length < 100 || !j.meta?.startAfterId) break;
    sa = j.meta.startAfterId; sat = j.meta.startAfter; await sleep(120);
  }
}

const out = { moved: [], clearedOnly: [], skipped: [] };
for (const c of withDob) {
  const iso = String(c.dateOfBirth).slice(0, 10);
  const age = (REF - new Date(`${iso}T00:00:00Z`)) / (365.25 * 864e5);
  const who = `${c.firstName} ${c.lastName}`;
  if (age >= 20) { out.skipped.push(`${who}: ${iso} looks like an adult's own birthday — left alone`); continue; }
  if (/\btest\b|losch/i.test(who)) { out.skipped.push(`${who}: test record — left alone`); continue; }
  const fam = kidsBy.get(c.id) ?? [];
  if (fam.length === 0) { out.skipped.push(`${who}: ${iso} — no students on this contact`); continue; }
  let target = fam.length === 1 ? fam[0] : null;
  if (!target) {
    const fits = fam.filter((k) => { const b = band(k.program); return b && age >= b[0] && age <= b[1]; });
    if (fits.length === 1) target = fits[0];
  }
  if (!target) { out.skipped.push(`${who}: ${iso} (age ${age.toFixed(1)}) — can't tell which of ${fam.map((k) => `${k.first_name} [${k.program ?? '?'}]`).join(', ')}`); continue; }

  const full = (await (await fetch(`${GHL}/contacts/${c.id}`, { headers: H })).json()).contact;
  await sleep(110);
  const key = dobKey(target.slot);
  const existing = (full.customFields ?? []).find((f) => f.id === fid.get(key))?.value;
  const b = band(target.program);
  const note = b && (age < b[0] || age > b[1]) ? ` ⚠ age ${age.toFixed(1)} is unusual for ${target.program}` : '';
  let write = true;
  if (existing && String(existing).trim()) {
    if (sameDate(existing, iso)) write = false;
    else { out.skipped.push(`${who}: parent DOB ${iso} vs ${target.first_name}'s existing ${existing} — conflict, left alone`); continue; }
  }
  const body = { dateOfBirth: null };
  if (write) body.customFields = [{ id: fid.get(key), field_value: toMDY(iso) }];
  (write ? out.moved : out.clearedOnly).push(`${who} → ${target.first_name} ${target.last_name} (slot ${target.slot}) ${toMDY(iso)}${note}`);
  if (!apply) continue;
  const r = await fetch(`${GHL}/contacts/${c.id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  if (!r.ok) out.skipped.push(`${who}: PUT failed ${r.status} ${(await r.text()).slice(0, 100)}`);
  await sleep(160);
}
console.log(`contacts with a built-in DOB: ${withDob.length}`);
console.log(`\nMOVED to the student field (${out.moved.length}):`); for (const x of out.moved) console.log('  ' + x);
console.log(`\nAlready on the student — parent copy cleared (${out.clearedOnly.length}):`); for (const x of out.clearedOnly) console.log('  ' + x);
console.log(`\nLEFT ALONE (${out.skipped.length}):`); for (const x of out.skipped) console.log('  ' + x);
console.log(apply ? '\nAPPLIED' : '\nDRY RUN');
