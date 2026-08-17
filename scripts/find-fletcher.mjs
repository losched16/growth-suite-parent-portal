import pg from 'pg';
import crypto from 'node:crypto';
const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const fieldsRes = await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json();
const keyById = new Map((fieldsRes.customFields ?? []).map((f) => [f.id, String(f.fieldKey ?? '').replace(/^contact\./, '')]));

// 1. Opportunities named Fletcher (live search)
const os = await (await fetch(`${GHL}/opportunities/search?location_id=${loc}&q=Fletcher&limit=20`, { headers: H })).json();
console.log('Opportunities matching "Fletcher":');
for (const o of os.opportunities ?? []) {
  console.log(`  "${o.name}"  stage=${o.pipelineStageId}  status=${o.status}  contact=${o.contact?.id} (${o.contact?.name})`);
}
// 2. Contacts matching Fletcher
const cs = await (await fetch(`${GHL}/contacts/?locationId=${loc}&query=Fletcher&limit=20`, { headers: H })).json();
console.log('\nContacts matching "Fletcher":');
for (const c of cs.contacts ?? []) {
  const full = (await (await fetch(`${GHL}/contacts/${c.id}`, { headers: H })).json()).contact ?? {};
  const cf = {};
  for (const f of full.customFields ?? []) {
    const k = keyById.get(f.id) ?? f.id;
    if (/^student|enrollment_status/.test(k) && f.value !== '' && f.value != null) cf[k] = f.value;
  }
  console.log(`  ${c.id}: ${full.firstName} ${full.lastName} <${full.email}> tags=[${(full.tags ?? []).join(', ')}]`);
  console.log('     student fields:', cf);
  const dbp = await db.query(`SELECT p.first_name, p.last_name, f.display_name FROM parents p JOIN families f ON f.id=p.family_id WHERE p.school_id=$1 AND p.ghl_contact_id=$2`, [S, c.id]);
  console.log('     in DB as:', dbp.rows.length ? dbp.rows : 'NOT IN DB');
  const st = await db.query(`SELECT first_name, last_name FROM students WHERE school_id=$1 AND metadata->>'ghl_contact_id'=$2`, [S, c.id]);
  console.log('     DB students:', st.rows);
}
// stage names
const stages = await db.query(`SELECT DISTINCT stage_id, stage_name FROM ghl_opportunities WHERE school_id=$1`, [S]);
console.log('\nstage ids:', Object.fromEntries(stages.rows.map((r) => [r.stage_id, r.stage_name])));
await db.end();
