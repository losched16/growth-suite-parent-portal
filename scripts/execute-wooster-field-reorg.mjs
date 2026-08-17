// Execute Wooster's GHL custom-field reorg:
//   1. Create folders: Contact, Student 1, Student 2, Student 3, Student 4
//   2. Move every non-garbage field into its folder:
//        - form_*_sN tracking fields → Student N (per-student form history)
//        - student_N_* → Student N;  bare student_* → Student 1
//        - bare fields with a student_2_ twin → Student 1
//        - parent_2_* + everything else → Contact
//        - garbage duplicates (contactcontact*, _copy chains) → left alone
//   3. Create student_[N_]enrollment_status SINGLE_OPTIONS fields in each
//      Student folder.
//
// Folder moves change ONLY parentId — field ids, keys, and values are
// untouched, so form tracking / workflows / sync keep working.
//
// GHL API quirks (learned on NLMA):
//   - folder create returns id at customFieldFolder.id
//   - re-creating an existing folder 400s with meta.existingId
//   - field PUT requires name+dataType+model alongside parentId
//   - pace ~300ms between calls to dodge 429s
//
// Usage:
//   node --env-file=.env.local scripts/execute-wooster-field-reorg.mjs            # dry-run
//   node --env-file=.env.local scripts/execute-wooster-field-reorg.mjs --apply

import pg from 'pg';
import crypto from 'node:crypto';

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apply = process.argv.includes('--apply');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
function dec(c2, iv, tag) {
  const k = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(c2), d.final()]).toString('utf8');
}
const sc = await db.query(
  `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`,
  [SCHOOL_ID],
);
const pit = dec(sc.rows[0].ghl_pit_encrypted, sc.rows[0].ghl_pit_iv, sc.rows[0].ghl_pit_tag);
const loc = sc.rows[0].ghl_location_id;
await db.end();

const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const nk = (f) => (f ?? '').replace(/^contact\./, '');
const listAll = async () =>
  (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];

async function folderId(name) {
  const r = await fetch(`${GHL}/locations/${loc}/customFields`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name, documentType: 'folder', model: 'contact' }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j?.customFieldFolder?.id ?? null;
  return j?.meta?.existingId ?? null; // 400 "Folder already exists"
}

// ---- classification ----
const all = await listAll();
const fields = all.filter((f) => f.documentType !== 'folder');

const baresWithSiblings = new Set();
for (const f of fields) {
  const m = /^student_(\d+)_(.+)$/.exec(nk(f.fieldKey));
  if (m && Number(m[1]) >= 2) baresWithSiblings.add(m[2]);
}
function isGarbage(k) {
  if (/^contactcontact/.test(k)) return true;
  if ((k.match(/_(copy|[a-z0-9]{3}_copy)/g) ?? []).length >= 2) return true;
  return false;
}
function targetName(key) {
  if (isGarbage(key)) return null;
  const fm = /_s([1-4])$/.exec(key);
  if (/^form_/.test(key) && fm) return `Student ${fm[1]}`; // per-student form tracking
  const m = /^student_(\d+)_/.exec(key);
  if (m) return `Student ${m[1]}`;
  if (/^student_/.test(key)) return 'Student 1';
  if (baresWithSiblings.has(key)) return 'Student 1';
  return 'Contact'; // parent_2_*, family data, family-level form_*_complete
}

const plan = new Map(); // folderName → [fields]
let skipped = 0;
for (const f of fields) {
  const t = targetName(nk(f.fieldKey));
  if (!t) { skipped++; continue; }
  if (!plan.has(t)) plan.set(t, []);
  plan.get(t).push(f);
}

const FOLDER_NAMES = ['Contact', 'Student 1', 'Student 2', 'Student 3', 'Student 4'];
console.log(`Fields on location: ${fields.length}; garbage skipped: ${skipped}`);
for (const n of FOLDER_NAMES) console.log(`  ${n}: ${(plan.get(n) ?? []).length} fields`);

const NEW_FIELDS = [
  { key: 'student_enrollment_status', name: 'Student Enrollment Status', folder: 'Student 1' },
  { key: 'student_2_enrollment_status', name: 'Student 2 Enrollment Status', folder: 'Student 2' },
  { key: 'student_3_enrollment_status', name: 'Student 3 Enrollment Status', folder: 'Student 3' },
  { key: 'student_4_enrollment_status', name: 'Student 4 Enrollment Status', folder: 'Student 4' },
];
const STATUS_OPTIONS = ['enrolled', 'pending', 'withdrawn', 'accepted', 'applied', 'inquiry', 'declined'];

if (!apply) {
  console.log('\nDRY RUN — examples of routing:');
  for (const n of FOLDER_NAMES) {
    const list = (plan.get(n) ?? []).slice(0, 5);
    console.log(`  --- ${n} ---`);
    for (const f of list) console.log(`    ${nk(f.fieldKey)}`);
  }
  console.log(`\nWould create ${NEW_FIELDS.length} enrollment-status fields with options: ${STATUS_OPTIONS.join(', ')}`);
  console.log('Re-run with --apply to execute.');
  process.exit(0);
}

// ---- execute ----
console.log('\n— creating folders —');
const ids = {};
for (const n of FOLDER_NAMES) {
  ids[n] = await folderId(n);
  console.log(`  "${n}" → ${ids[n] ?? 'FAILED'}`);
  await sleep(300);
}
if (FOLDER_NAMES.some((n) => !ids[n])) {
  console.error('Folder create failed — aborting before any moves.');
  process.exit(1);
}

console.log('\n— moving fields —');
let moved = 0, already = 0, failed = 0;
for (const [folderName, list] of plan) {
  const target = ids[folderName];
  for (const f of list) {
    if (f.parentId === target) { already++; continue; }
    // Option-type fields (RADIO / SINGLE_OPTIONS / …) reject a PUT that
    // doesn't re-send their options list — include it when present.
    const body = { name: f.name, dataType: f.dataType, model: 'contact', parentId: target };
    if (Array.isArray(f.picklistOptions) && f.picklistOptions.length > 0) {
      body.options = f.picklistOptions;
    }
    const r = await fetch(`${GHL}/locations/${loc}/customFields/${f.id}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify(body),
    });
    if (r.ok) { moved++; process.stdout.write(`\r  moved ${moved}…    `); }
    else { failed++; console.log(`\n  ✗ ${nk(f.fieldKey)}: ${r.status} ${(await r.text()).slice(0, 110)}`); }
    await sleep(300);
  }
}
console.log(`\n  moved ${moved}, already correct ${already}, failed ${failed}`);

console.log('\n— creating enrollment-status fields —');
for (const nf of NEW_FIELDS) {
  const r = await fetch(`${GHL}/locations/${loc}/customFields`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: nf.name,
      dataType: 'SINGLE_OPTIONS',
      options: STATUS_OPTIONS, // create/update use `options`; reads return `picklistOptions`
      model: 'contact',
      parentId: ids[nf.folder],
      fieldKey: `contact.${nf.key}`,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) console.log(`  + ${nf.key} → ${j?.customField?.id}`);
  else if (/already exists|duplicate/i.test(JSON.stringify(j))) console.log(`  · ${nf.key} (exists)`);
  else console.log(`  ✗ ${nf.key}: ${r.status} ${JSON.stringify(j).slice(0, 150)}`);
  await sleep(350);
}

// ---- verify ----
console.log('\n— verify read-back —');
const after = await listAll();
for (const nf of NEW_FIELDS) {
  const f = after.find((x) => nk(x.fieldKey) === nf.key);
  if (!f) { console.log(`  ✗ ${nf.key} NOT FOUND`); continue; }
  console.log(`  ${nf.key}: dataType=${f.dataType}, options=[${(f.picklistOptions ?? []).join(', ')}], folder=${f.parentId === ids[nf.folder] ? nf.folder : 'WRONG'}`);
}
const stillUnfoldered = after.filter((f) => f.documentType !== 'folder' && !f.parentId && !isGarbage(nk(f.fieldKey)));
console.log(`  non-garbage fields still unfoldered: ${stillUnfoldered.length}`);
for (const f of stillUnfoldered.slice(0, 10)) console.log(`    ${nk(f.fieldKey)}`);
