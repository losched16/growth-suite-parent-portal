// Why does one Documents-Requested student show on the roster and another
// not? Compare DB rows + raw GHL contact for both.
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['Roman', 'Victoria'];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
function dec(c2, iv, tag) {
  const k = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(c2), d.final()]).toString('utf8');
}
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
const pit = dec(sc.rows[0].ghl_pit_encrypted, sc.rows[0].ghl_pit_iv, sc.rows[0].ghl_pit_tag);
const loc = sc.rows[0].ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' };

const fieldsRes = await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json();
const keyById = new Map((fieldsRes.customFields ?? []).map((f) => [f.id, String(f.fieldKey ?? '').replace(/^contact\./, '')]));

for (const name of NAMES) {
  console.log(`\n================ ${name} ================`);
  // DB: student rows
  const st = await db.query(
    `SELECT s.id, s.first_name, s.last_name, s.status AS student_status, s.family_id,
            s.metadata->>'ghl_slot' AS slot, s.metadata->>'ghl_contact_id' AS cid,
            e.status AS enrollment_status, e.academic_year
       FROM students s LEFT JOIN enrollments e ON e.student_id = s.id
      WHERE s.school_id = $1 AND (s.first_name ILIKE $2 OR s.last_name ILIKE $2)`,
    [S, name],
  );
  console.log('DB students:'); console.table(st.rows);

  // DB: contacts whose student_* fields mention this name, or whose opp is named this
  const cids = new Set(st.rows.map((r) => r.cid).filter(Boolean));
  const fv = await db.query(
    `SELECT DISTINCT ghl_contact_id FROM ghl_contact_field_values
      WHERE school_id = $1 AND field_key ~ '^student(_\\d+)?_(first|last)_name$' AND value ILIKE $2`,
    [S, name],
  );
  for (const r of fv.rows) cids.add(r.ghl_contact_id);

  for (const cid of cids) {
    console.log(`\n--- GHL contact ${cid} ---`);
    const c = (await (await fetch(`${GHL}/contacts/${cid}`, { headers: H })).json()).contact ?? {};
    console.log(`name: ${c.firstName} ${c.lastName}   email: ${c.email}   tags: ${(c.tags ?? []).join(', ')}`);
    const cf = {};
    for (const f of c.customFields ?? []) {
      const k = keyById.get(f.id) ?? f.id;
      if (/^student|enrollment_status|^parent_2_first/.test(k) && f.value !== '' && f.value != null) cf[k] = f.value;
    }
    console.log('student/enrollment fields:', cf);
    // opps
    const o = await db.query(`SELECT id, stage_name, status FROM ghl_opportunities WHERE school_id=$1 AND ghl_contact_id=$2`, [S, cid]);
    console.log('opps (cache):', o.rows);
    // parents/family rows in DB
    const p = await db.query(`SELECT p.id, p.first_name, p.last_name, p.is_primary, p.status, f.display_name, f.status AS fam_status FROM parents p JOIN families f ON f.id=p.family_id WHERE p.school_id=$1 AND p.ghl_contact_id=$2`, [S, cid]);
    console.log('DB parent/family rows:', p.rows);
  }
}
await db.end();
