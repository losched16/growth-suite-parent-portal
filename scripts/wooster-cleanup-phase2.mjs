// Wooster roster cleanup — PHASE 2: "the sheet is closer to the truth than GHL".
// Everything in GHL; nothing written to our DB. Every step is reversible
// (statuses blanked not deleted; duplicate contacts neutralised not removed).
//
//   node --env-file=.env.local scripts/wooster-cleanup-phase2.mjs          # dry-run
//   node --env-file=.env.local scripts/wooster-cleanup-phase2.mjs --apply

import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const TAG = 'enrolled - 26/27';
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
const CONTACT_FOLDER = 'FjsK4QyrZ29BNaEssKPR';

let fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
let FID = new Map(fields.map((f) => [nk(f.fieldKey), f.id]));
const fid = (slot, base) => FID.get(slot === 1 ? `student_${base}` : `student_${slot}_${base}`);
const PROG = 'select_the_program_this_child_will_attend';
const progFid = (slot) => (slot === 1 ? FID.get(PROG) : FID.get(`student_${slot}_${PROG}`));

const log = [];
const ops = []; // {label, kind, contactId, body?, tagsAdd?, tagsRemove?, create?}
const cf = (slot, base, value) => ({ id: fid(slot, base), value });
const student = (slot, first, last, program) => [
  cf(slot, 'first_name', first), cf(slot, 'last_name', last), cf(slot, 'enrollment_status', 'enrolled'),
  ...(program ? [{ id: progFid(slot), value: program }] : []),
];
const clearSlot = (slot) => [cf(slot, 'first_name', ''), cf(slot, 'last_name', ''), cf(slot, 'enrollment_status', ''), { id: progFid(slot), value: '' }];
const unenroll = (slot) => [cf(slot, 'enrollment_status', '')];

// ── 0. Parent 2 email field (Wooster has none — root cause of co-parent dup contacts) ──
if (!FID.has('parent_2_email')) {
  ops.push({ label: 'CREATE FIELD parent_2_email (EMAIL) in Contact folder', kind: 'field',
    body: { name: 'Parent 2 Email', dataType: 'EMAIL', model: 'contact', parentId: CONTACT_FOLDER, position: 25 } });
}

// ── 1. Sheet-only students → create contacts / add to contact ────────
ops.push({ label: 'CREATE Jessika Rice + Nova Barbera (Upper El)', kind: 'create',
  create: { firstName: 'Jessika', lastName: 'Rice', email: 'destinationtreasuretrove87@gmail.com', tags: [TAG],
    customFields: student(1, 'Nova', 'Barbera', 'Upper Elementary program 9 am - 3:30 pm') } });
ops.push({ label: 'CREATE Kelsey Brubaker + James Blair (High School)', kind: 'create',
  create: { firstName: 'Kelsey', lastName: 'Brubaker', email: 'craydenk@gmail.com', tags: [TAG],
    customFields: student(1, 'James', 'Blair', 'High School (Grades 9-12)') } });
ops.push({ label: 'CREATE Yen Huynh + Enzo Kratko (5-day toddler 8-4)', kind: 'create',
  create: { firstName: 'Yen', lastName: 'Huynh', email: 'brian.kratko@icloud.com', tags: [TAG],
    customFields: student(1, 'Enzo', 'Kratko', 'Five day toddler program (18 months - 3 years) 8:00 am - 4:00 pm') } });
// Sophia Snodgrass → Abigail Shepp (sheet's email = her contact); Tristan Dixon (not on sheet) un-enrolled
ops.push({ label: 'Abigail Shepp: +Sophia Snodgrass s2 (Middle School); Tristan Dixon s1 → un-enrolled', kind: 'update', contactId: 'g7hI4PG4nUF7JgEgeiM9',
  body: { customFields: [...student(2, 'Sophia', 'Snodgrass', 'Middle School program 9 am - 3:30 pm'), ...unenroll(1)] } });

// ── 2. GHL-enrolled but NOT on the sheet → un-enroll (blank status; keep records) ──
const UNENROLL = [
  ['Gwendolyn Miller — June Miller (my v1 error)', 'QaatgViqtPbQML3peJ0i', [1], true],
  ['Elise Neville — Valerie Shepherd (my v1 error)', '7qURSS0YVqIzeBHLTEFb', [1], true],
  ['Roger Proper — Reed Landon', null, [1], true],
  ['Rolando Humberto Hernandez — Landon Hernandez', null, [1], true],
  ['Amanda Graybeal — Aiden Graybeal', null, [1], true],
  ['Emily Hartzler — Alice Gunn', null, [1], true],
  ['Tabitha King (staff contact) — Connor King', 'PD5c1WknR5fYKxvTH2tL', [1], true],
  ['Shaquez Dickens — Tirips Dickens s2 (Luos/Traeh stay)', 'KN1VAdmNsZ6PQ9U7CcK6', [2], false],
  ['Arlette — Alexander & Simon Tomski', null, [1, 2], true],
  ['Elizabeth Ann McWeeny — Hunter Flickinger', null, [1], true],
];
// resolve the null contact ids from DB parents by name
const db2 = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db2.connect();
for (const u of UNENROLL) {
  if (u[1]) continue;
  const name = u[0].split(' — ')[0].replace(/\s*\(.*\)/, '').trim();
  const [first, ...rest] = name.split(' ');
  const { rows } = await db2.query(
    `SELECT DISTINCT ghl_contact_id FROM parents WHERE school_id=$1 AND is_primary AND lower(first_name)=lower($2) AND lower(last_name)=lower($3)`,
    [S, first, rest.join(' ')]);
  if (rows.length === 1) u[1] = rows[0].ghl_contact_id; else log.push(`!! could not resolve contact for "${name}" (${rows.length} hits) — skipped`);
}
await db2.end();
for (const [label, cid, slots, removeTag] of UNENROLL) {
  if (!cid) continue;
  ops.push({ label: `UN-ENROLL ${label}`, kind: 'update', contactId: cid,
    body: { customFields: slots.flatMap(unenroll) }, tagsRemove: removeTag ? [TAG] : [] });
}

// ── 3. Duplicates ────────────────────────────────────────────────────
ops.push({ label: 'Crystal Woody: clear duplicate Raice s2 (s1 keeps forms)', kind: 'update', contactId: 'MmWgnOD646k8N8aZb2Ve', body: { customFields: clearSlot(2) } });
ops.push({ label: 'tabetha Dunlap (real, 4zIQ): clear duplicate Priscilla s3', kind: 'update', contactId: '4zIQNJpEappLQBB0wQmJ', body: { customFields: clearSlot(3) } });
ops.push({ label: 'Tabetha Dunlap (typo-email dup xnUD): clear s1+s2, drop tag → office deletes', kind: 'update', contactId: 'xnUDceLtJs6BrkJtNwH7', body: { customFields: [...clearSlot(1), ...clearSlot(2)] }, tagsRemove: [TAG] });
ops.push({ label: 'Brandy Welsh (typo-email dup N0dp): clear Logan s1, drop tag → office deletes', kind: 'update', contactId: 'N0dp1G88kpAkG6SrHxvk', body: { customFields: clearSlot(1) }, tagsRemove: [TAG] });
ops.push({ label: '"Camille Mullet" dup contact: clear s1+s2 (real family = Amanda Good)', kind: 'update', contactId: 'TZZZ0eABjkZ2UKxahB9o', body: { customFields: [...clearSlot(1), ...clearSlot(2)] } });
// Prentice: Quinta has the forms → stays primary; Andrew becomes Parent 2 (with email → keeps portal login); his own contact's Freya slot cleared
ops.push({ label: 'Quinta Prentice: Parent 2 = Andrew Prentice <andrew398600@gmail.com>', kind: 'update', contactId: 'UPFoq2SqAQq7IJ0uSm3Q', deferredP2: { first: 'Andrew', last: 'Prentice', email: 'andrew398600@gmail.com' } });
ops.push({ label: 'Andrew Prentice contact: clear Freya s1 (now on Quinta\'s as P2)', kind: 'update', contactId: 'NS6ZKJJXEvTodab8Vxoi', body: { customFields: clearSlot(1) } });

// ── 4. Renames per sheet ─────────────────────────────────────────────
ops.push({ label: 'Fletcher s1: Diolun → Diloun', kind: 'update', contactId: 'ZonfJPTKSqx40FQUdcrj', body: { customFields: [cf(1, 'first_name', 'Diloun')] } });
ops.push({ label: 'Langevoort s1: Lilith Woodas → Lillith Woodith', kind: 'update', contactId: 'sHLZ03tTKge2lA0BNEv9', body: { customFields: [cf(1, 'first_name', 'Lillith'), cf(1, 'last_name', 'Woodith')] } });
ops.push({ label: 'Stout s2: Jett → Brogan + program 5-day toddler 8:30-noon', kind: 'update', contactId: '7Dg8pmDZZObv2QNViQ7q', body: { customFields: [cf(2, 'first_name', 'Brogan'), { id: progFid(2), value: 'Five day toddler program (18 months - 3 years) 8:30 am - noon' }] } });
ops.push({ label: 'Contact "Azielia Spitler" → Teri Malcuit (student stays Azeila Spitler)', kind: 'update', contactId: 'RdxrDvY8P0k3mhVu6dEi', body: { firstName: 'Teri', lastName: 'Malcuit' } });

// ── 5. Parent 2 names/emails ─────────────────────────────────────────
ops.push({ label: 'Martez Phillips: Parent 2 = Stacey Adams (no email on sheet)', kind: 'update', contactId: 'J1xmzO1NySxGV6g7eNQX', deferredP2: { first: 'Stacey', last: 'Adams', email: null } });
ops.push({ label: 'Mia Jiang: Parent 2 = Frank Jiang <Frankjjiang@gmail.com>', kind: 'update', contactId: 'luvutQsIv3nrunr4izPd', deferredP2: { first: 'Frank', last: 'Jiang', email: 'Frankjjiang@gmail.com' } });

// ── report ───────────────────────────────────────────────────────────
console.log(`\n=== PHASE 2 PLAN (${ops.length} ops) ===`);
for (const o of ops) console.log(`  • ${o.label}${o.tagsRemove?.length ? `   [−tag ${o.tagsRemove}]` : ''}`);
for (const l of log) console.log(`  ${l}`);
if (!apply) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0); }

// ── apply ────────────────────────────────────────────────────────────
console.log('\n=== APPLY ===');
let ok = 0, fail = 0;
for (const o of ops) {
  try {
    if (o.kind === 'field') {
      const r = await fetch(`${GHL}/locations/${loc}/customFields`, { method: 'POST', headers: H, body: JSON.stringify(o.body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 120)}`);
      fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
      FID = new Map(fields.map((f) => [nk(f.fieldKey), f.id]));
      console.log(`  ✓ ${o.label} → ${j.customField?.fieldKey}`);
    } else if (o.kind === 'create') {
      const r = await fetch(`${GHL}/contacts/`, { method: 'POST', headers: H, body: JSON.stringify({ locationId: loc, ...o.create }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`);
      console.log(`  ✓ ${o.label} → contact ${j.contact?.id}`);
    } else {
      let body = o.body ?? {};
      if (o.deferredP2) {
        const p = o.deferredP2;
        const cfs = [{ id: FID.get('parent_2_first_name'), value: p.first }, { id: FID.get('parent_2_last_name'), value: p.last }];
        if (p.email && FID.get('parent_2_email')) cfs.push({ id: FID.get('parent_2_email'), value: p.email });
        body = { customFields: cfs };
      }
      if (body.customFields) body.customFields = body.customFields.filter((c) => c.id);
      const r = await fetch(`${GHL}/contacts/${o.contactId}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      if (o.tagsRemove?.length) {
        const t = await fetch(`${GHL}/contacts/${o.contactId}/tags`, { method: 'DELETE', headers: H, body: JSON.stringify({ tags: o.tagsRemove }) });
        if (!t.ok) console.log(`    ! tag remove ${t.status}`);
      }
      console.log(`  ✓ ${o.label}`);
    }
    ok++;
  } catch (e) { fail++; console.log(`  ✗ ${o.label}: ${e.message}`); }
  await sleep(320);
}
console.log(`\nok ${ok}, failed ${fail}`);
