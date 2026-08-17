// The first create passed fieldKey explicitly and GHL double-prefixed it
// (contact.contactstudent_enrollment_status). Delete those 4 mangled
// fields (created minutes ago, zero data) and re-create with name only —
// GHL derives the clean key from the name.
import pg from 'pg';
import crypto from 'node:crypto';

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const MANGLED = [
  'IjlJvsRNf5ot9V92Zay4',
  'V2LGMpkimZKXhk4BK9Qh',
  '3GHPGedFoxPWseE0BdFF',
  'CC6PNJt0xqR1fpEKHJWJ',
];

console.log('— deleting mangled fields —');
for (const id of MANGLED) {
  const r = await fetch(`${GHL}/locations/${loc}/customFields/${id}`, { method: 'DELETE', headers: H });
  console.log(`  ${id}: ${r.status}`);
  await sleep(300);
}

const NEW_FIELDS = [
  { name: 'Student Enrollment Status', expectKey: 'student_enrollment_status', folderId: 'nayZq8K2Co18K3m8281J' },
  { name: 'Student 2 Enrollment Status', expectKey: 'student_2_enrollment_status', folderId: 'kO6qmBxFUppEQ4s2isF3' },
  { name: 'Student 3 Enrollment Status', expectKey: 'student_3_enrollment_status', folderId: 'gPFvYDaqUzbwULxdeqUB' },
  { name: 'Student 4 Enrollment Status', expectKey: 'student_4_enrollment_status', folderId: '07pRp4W9SgakJ1RqMEWv' },
];
const STATUS_OPTIONS = ['enrolled', 'pending', 'withdrawn', 'accepted', 'applied', 'inquiry', 'declined'];

console.log('\n— re-creating with name-derived keys —');
for (const nf of NEW_FIELDS) {
  const r = await fetch(`${GHL}/locations/${loc}/customFields`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: nf.name,
      dataType: 'SINGLE_OPTIONS',
      options: STATUS_OPTIONS,
      model: 'contact',
      parentId: nf.folderId,
    }),
  });
  const j = await r.json().catch(() => ({}));
  const f = j.customField ?? {};
  const ok = r.ok && String(f.fieldKey).endsWith(nf.expectKey);
  console.log(`  ${ok ? '✓' : '✗'} ${nf.name}: key=${f.fieldKey ?? '?'} id=${f.id ?? '?'} ${!r.ok ? JSON.stringify(j).slice(0, 120) : ''}`);
  await sleep(350);
}

console.log('\n— final verify —');
const list = await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json();
const hits = (list.customFields ?? []).filter((f) => /enrollment_status/i.test(String(f.fieldKey)));
for (const f of hits) console.log(`  ${f.fieldKey}  options=[${(f.picklistOptions ?? []).join(',')}]`);
