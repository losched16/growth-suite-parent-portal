import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const CROCKER_CONTACT = 'iwPyMx89PkX94WEOKMHG';

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

const client = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${pit}`,
    Version: '2021-07-28',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

// Search opportunities for this contact
const search = await client.get('/opportunities/search', {
  params: { location_id: school.ghl_location_id, contact_id: CROCKER_CONTACT, limit: 20 },
});
const opps = search.data.opportunities ?? [];
console.log(`Found ${opps.length} opportunities for Crocker contact:`);
for (const o of opps) {
  console.log(`  ${o.name}   [stage: ${o.pipelineStageName ?? o.pipeline_stage_id}]   status=${o.status}   opp_id=${o.id}`);
}

// Also show the contact's student_* custom fields
const contactRes = await client.get(`/contacts/${CROCKER_CONTACT}`);
const c = contactRes.data.contact ?? contactRes.data;
console.log(`\nContact: ${c.firstName} ${c.lastName}`);
const studentFields = (c.customFields ?? []).filter((f) => /student/i.test(f.fieldValueString ? '' : '') || false);
// Better: filter by name once we have the map. Just print all with 'student' in value.
const cfs = await client.get(`/locations/${school.ghl_location_id}/customFields`);
const fields = cfs.data.customFields ?? [];
const byId = new Map(fields.map((f) => [f.id, f.fieldKey ?? f.name]));
console.log('\nCrocker student-related fields:');
for (const cf of (c.customFields ?? [])) {
  const key = byId.get(cf.id) ?? cf.id;
  if (/student/i.test(String(key))) {
    console.log(`  ${key} = ${JSON.stringify(cf.value)}`);
  }
}

await pool.end();
