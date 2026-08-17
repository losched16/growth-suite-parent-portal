// Backfill Wooster's new per-student enrollment-status GHL fields from
// the current DB truth (enrollments.status per student), then the sync
// can be flipped from tag-driven to field-driven.
//
// For each family: primary parent's contact gets
//   student_[N_]enrollment_status = <status>  (N from student.metadata.ghl_slot)
//
// Usage:
//   node --env-file=.env.local scripts/backfill-enrollment-status-fields.mjs           # dry-run
//   node --env-file=.env.local scripts/backfill-enrollment-status-fields.mjs --apply

import pg from 'pg';
import crypto from 'node:crypto';

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apply = process.argv.includes('--apply');

const FIELD_ID_BY_SLOT = {
  1: 'iraikgY2kt6jdWcPoN3Z', // student_enrollment_status
  2: 'gqVxNCIJR0KAK84T9pYP', // student_2_enrollment_status
  3: 'uab2taZ7JbAsLh7Dyruj', // student_3_enrollment_status
  4: 'sAju1Y83h0oyLKk6FIiy', // student_4_enrollment_status
};

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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

// Every student with a slot + their family's primary contact + status.
const { rows } = await db.query(
  `SELECT p.ghl_contact_id AS cid,
          (s.metadata->>'ghl_slot')::int AS slot,
          s.first_name, s.last_name,
          e.status
     FROM students s
     JOIN parents p ON p.family_id = s.family_id AND p.is_primary = true AND p.ghl_contact_id IS NOT NULL
     JOIN enrollments e ON e.student_id = s.id
    WHERE s.school_id = $1
      AND (s.metadata->>'ghl_slot') IS NOT NULL
    ORDER BY p.ghl_contact_id, slot`,
  [SCHOOL_ID],
);
await db.end();

// Group by contact → [{slot, status}]
const byContact = new Map();
for (const r of rows) {
  if (!FIELD_ID_BY_SLOT[r.slot]) { console.log(`  ! slot ${r.slot} out of range for ${r.first_name} ${r.last_name}`); continue; }
  if (!byContact.has(r.cid)) byContact.set(r.cid, []);
  byContact.get(r.cid).push(r);
}

const statusCounts = {};
for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
console.log(`Students to stamp: ${rows.length} across ${byContact.size} contacts`);
console.log('Status distribution:', statusCounts);

if (!apply) {
  let shown = 0;
  for (const [cid, list] of byContact) {
    if (shown++ >= 5) break;
    console.log(`  ${cid}: ${list.map((r) => `s${r.slot}=${r.status} (${r.first_name})`).join(', ')}`);
  }
  console.log('\nDry run — pass --apply to write to GHL.');
  process.exit(0);
}

let updated = 0, failed = 0;
for (const [cid, list] of byContact) {
  const customFields = list.map((r) => ({ id: FIELD_ID_BY_SLOT[r.slot], value: r.status }));
  const r = await fetch(`${GHL}/contacts/${cid}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ customFields }),
  });
  if (r.ok) { updated++; process.stdout.write(`\r  updated ${updated}/${byContact.size}…   `); }
  else { failed++; console.log(`\n  ✗ ${cid}: ${r.status} ${(await r.text()).slice(0, 120)}`); }
  await sleep(300);
}
console.log(`\nDone: ${updated} contacts updated, ${failed} failed.`);
