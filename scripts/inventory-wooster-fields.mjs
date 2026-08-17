// Inventory Wooster's GHL custom fields — current folder assignments +
// slot classification, so we can plan the reorg.
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
const fields = (cfs.data.customFields ?? []).filter((f) => f.documentType !== 'folder');
const folders = (cfs.data.customFields ?? []).filter((f) => f.documentType === 'folder');

console.log(`\n=== Existing folders (${folders.length}) ===`);
for (const f of folders) console.log(`  ${f.id}  ${f.name}`);

console.log(`\n=== Total custom fields: ${fields.length} ===`);

// Classify each field by destination
function classify(fieldKey) {
  const key = String(fieldKey ?? '').replace(/^contact\./, '');
  // Parent 2 fields
  if (/^parent_2_/.test(key)) return 'Contact / Parent 2';
  // Slot-prefixed student fields: student_2_..., student_3_..., student_4_...
  const m = /^student_(\d+)_/.exec(key);
  if (m) return `Student ${m[1]}`;
  // Slot-1 student fields: student_...
  if (/^student_/.test(key)) return 'Student 1';
  // Everything else = family/contact-level
  return 'Contact / Family';
}

const buckets = new Map();
for (const f of fields) {
  const dest = classify(f.fieldKey);
  if (!buckets.has(dest)) buckets.set(dest, []);
  buckets.get(dest).push(f);
}

for (const [dest, items] of [...buckets.entries()].sort()) {
  console.log(`\n=== ${dest} (${items.length} fields) ===`);
  const currentFolders = new Map();
  for (const it of items) {
    const fn = folders.find((f) => f.id === it.parentId)?.name ?? '(no folder)';
    currentFolders.set(fn, (currentFolders.get(fn) ?? 0) + 1);
  }
  console.log('  Currently in folders:');
  for (const [fn, n] of currentFolders) console.log(`    ${fn}: ${n}`);
  console.log('  Sample field keys:');
  for (const it of items.slice(0, 8)) console.log(`    ${it.fieldKey}   [${it.dataType}]`);
  if (items.length > 8) console.log(`    ... and ${items.length - 8} more`);
}

// Also — does Wooster have a "enrollment status" or similar field already?
console.log('\n=== Enrollment-status-ish fields (searching) ===');
for (const f of fields) {
  if (/enrollment|status/i.test(String(f.name) + String(f.fieldKey))) {
    console.log(`  ${f.fieldKey}  |  ${f.name}  |  ${f.dataType}`);
  }
}
