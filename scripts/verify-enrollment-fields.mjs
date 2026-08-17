// Check the 4 just-created enrollment-status fields by ID — what
// fieldKey did GHL actually assign, and did the options land?
import pg from 'pg';
import crypto from 'node:crypto';

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';

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

const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' };

const IDS = [
  'IjlJvsRNf5ot9V92Zay4',
  'V2LGMpkimZKXhk4BK9Qh',
  '3GHPGedFoxPWseE0BdFF',
  'CC6PNJt0xqR1fpEKHJWJ',
];

for (const id of IDS) {
  const r = await fetch(`${GHL}/locations/${loc}/customFields/${id}`, { headers: H });
  const j = await r.json().catch(() => ({}));
  const f = j.customField ?? j;
  console.log(`${id}: key=${f.fieldKey}  name=${f.name}  type=${f.dataType}  options=[${(f.picklistOptions ?? f.options ?? []).join(',')}]  parentId=${f.parentId}`);
}

// Also search the full list for anything enrollment-ish
const list = await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json();
const hits = (list.customFields ?? []).filter((f) => /enrollment_status/i.test(String(f.fieldKey)));
console.log(`\nList-search hits for enrollment_status: ${hits.length}`);
for (const f of hits) console.log(`  ${f.fieldKey}  (${f.id})`);
