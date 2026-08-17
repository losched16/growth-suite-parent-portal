// Plan Wooster's GHL custom-field reorg into 6 folders:
//   Contact / Family
//   Contact / Parent 2
//   Student 1
//   Student 2
//   Student 3
//   Student 4
//
// Smart classifier: a bare field like `special_needs_or_disability`
// counts as Student 1 iff a slot-2 twin (`student_2_special_needs_or_disability`)
// exists on the location. Everything else with no slot signal falls into
// Contact / Family. Garbage duplicate fields (double "contactcontact"
// prefix, "_copy" chains) are called out separately so we can skip them.
//
// This script is READ-ONLY — no writes to GHL. Produces the plan to
// confirm before executing.

import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';

function decryptPit(encrypted, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const { rows: schoolRows } = await pool.query(
  `SELECT ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag, ghl_location_id
     FROM schools WHERE id = $1`,
  [SCHOOL_ID],
);
const school = schoolRows[0];
const pit = decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
await pool.end();

const client = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${pit}`,
    Version: '2021-07-28',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

const cfs = await client.get(`/locations/${school.ghl_location_id}/customFields`);
const items = cfs.data.customFields ?? [];
const fields = items.filter((f) => f.documentType !== 'folder');
const folders = items.filter((f) => f.documentType === 'folder');

// Normalize field_key (strip contact. prefix)
function normalizeKey(k) {
  return String(k ?? '').replace(/^contact\./, '');
}

// Build lookup: which BARE base names have a slot-2 twin? (or 3/4)
// bare name = the field key with any leading student_ removed
// A key like `student_2_special_needs_or_disability` → base = `special_needs_or_disability`
// If we find that base bare on the location, it's Student 1.
const baresWithSiblings = new Set();
for (const f of fields) {
  const k = normalizeKey(f.fieldKey);
  const m = /^student_(\d+)_(.+)$/.exec(k);
  if (m && Number(m[1]) >= 2) baresWithSiblings.add(m[2]);
}

// Garbage detector: obvious form-generated duplicates
function isGarbageDuplicate(k) {
  // Double "contact" prefix from webhook auto-mapping bugs
  if (/^contactcontact/.test(k)) return true;
  // Chain of _copy or _\w{3}_copy segments (>= 2 copies)
  const copyChain = (k.match(/_(copy|[a-z0-9]{3}_copy)/g) ?? []).length;
  if (copyChain >= 2) return true;
  return false;
}

function classify(fieldKey) {
  const key = normalizeKey(fieldKey);
  // Parent 2
  if (/^parent_2_/.test(key)) return 'Contact / Parent 2';
  // Slot-prefixed 2/3/4
  const m = /^student_(\d+)_/.exec(key);
  if (m) return `Student ${m[1]}`;
  // Bare student_first_name / student_last_name / student_date_of_birth
  if (/^student_/.test(key)) return 'Student 1';
  // Bare field whose base has a slot-2 twin → belongs under Student 1
  if (baresWithSiblings.has(key)) return 'Student 1';
  // Everything else → Contact/Family
  return 'Contact / Family';
}

const buckets = new Map();
let garbageCount = 0;
for (const f of fields) {
  const k = normalizeKey(f.fieldKey);
  if (isGarbageDuplicate(k)) { garbageCount++; continue; }
  const dest = classify(f.fieldKey);
  if (!buckets.has(dest)) buckets.set(dest, []);
  buckets.get(dest).push(f);
}

console.log(`\n=== Wooster field reorg — planned ===`);
console.log(`Total fields on location: ${fields.length}`);
console.log(`Existing folders: ${folders.length}`);
console.log(`Garbage/duplicate fields to SKIP: ${garbageCount}`);
console.log();

const desiredOrder = [
  'Contact / Family',
  'Contact / Parent 2',
  'Student 1',
  'Student 2',
  'Student 3',
  'Student 4',
];
let plannedMoves = 0;
for (const dest of desiredOrder) {
  const list = buckets.get(dest) ?? [];
  console.log(`--- ${dest} — ${list.length} fields ---`);
  for (const f of list.slice(0, 6)) console.log(`  ${normalizeKey(f.fieldKey)}   [${f.dataType}]`);
  if (list.length > 6) console.log(`  ... and ${list.length - 6} more`);
  plannedMoves += list.length;
  console.log();
}

console.log(`Total move ops: ${plannedMoves} (create 6 folders + move ${plannedMoves} fields).`);
console.log(`At ~200ms per API call sequential with a 300ms pause = ~${Math.round((6 + plannedMoves) * 0.5)}s.`);

// Show the 4 new enrollment_status fields I'd add
console.log('\n=== New fields to ADD after reorg ===');
console.log('  Student 1 folder:  student_enrollment_status       [SINGLE_OPTIONS]  — enrolled/pending/withdrawn/accepted/applied/inquiry/declined');
console.log('  Student 2 folder:  student_2_enrollment_status     [SINGLE_OPTIONS]');
console.log('  Student 3 folder:  student_3_enrollment_status     [SINGLE_OPTIONS]');
console.log('  Student 4 folder:  student_4_enrollment_status     [SINGLE_OPTIONS]');

// Show the garbage examples so Joe can see what would be skipped
const garbage = fields.filter((f) => isGarbageDuplicate(normalizeKey(f.fieldKey))).slice(0, 10);
console.log('\n=== Garbage-duplicate examples (would SKIP the move for these — office can clean up separately) ===');
for (const g of garbage) console.log(`  ${normalizeKey(g.fieldKey)}`);
if (garbageCount > 10) console.log(`  ... and ${garbageCount - 10} more`);
