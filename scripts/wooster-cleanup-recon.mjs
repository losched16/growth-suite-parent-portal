// READ-ONLY reconnaissance for the Wooster roster cleanup sheet.
// For every family the sheet touches: does the parent contact exist in
// GHL, what's in its student slots right now, what forms/submissions
// exist per slot in our DB. No writes.
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' };
const fieldsRes = await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json();
const keyById = new Map((fieldsRes.customFields ?? []).map((f) => [f.id, String(f.fieldKey ?? '').replace(/^contact\./, '')]));

async function searchContacts(q) {
  const r = await (await fetch(`${GHL}/contacts/?locationId=${loc}&query=${encodeURIComponent(q)}&limit=10`, { headers: H })).json();
  await sleep(250);
  return r.contacts ?? [];
}
async function contactDetail(id) {
  const c = (await (await fetch(`${GHL}/contacts/${id}`, { headers: H })).json()).contact ?? {};
  await sleep(250);
  const slots = {};
  const prog = {};
  for (const f of c.customFields ?? []) {
    const k = keyById.get(f.id) ?? f.id;
    if (f.value == null || f.value === '') continue;
    let m = /^student(?:_(\d))?_(first_name|last_name|enrollment_status)$/.exec(k);
    if (m) { const s = m[1] ?? '1'; (slots[s] ??= {})[m[2]] = f.value; }
    if (k === 'select_the_program_this_child_will_attend') prog['1'] = f.value;
    m = /^student_(\d)_.*program/.exec(k); if (m) prog[m[1]] = f.value;
    if (/^\(?student\s*(\d)/i.test(String(f.name ?? ''))) {}
  }
  return { id: c.id, name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(), email: c.email ?? null, tags: c.tags ?? [], slots, prog };
}
async function dbSubs(contactId) {
  const r = await db.query(
    `SELECT s.metadata->>'ghl_slot' AS slot, s.first_name, s.last_name,
            (SELECT COUNT(*) FROM portal_form_submissions ps WHERE ps.student_id = s.id AND ps.status IN ('submitted','paid','pending_payment','legacy_imported'))::int AS subs
       FROM students s WHERE s.school_id=$1 AND s.metadata->>'ghl_contact_id'=$2 ORDER BY 1`,
    [S, contactId],
  );
  return r.rows;
}

const CASES = [
  // [label, search terms...]
  ['A. Stacey Adams → Martez Phillips (slot?)', 'Martez Phillips'],
  ['B. Nova Barbera → Jessika Rice', 'Jessika Rice', 'Rice', 'Barbera', 'destinationtreasuretrove87@gmail.com'],
  ['C. James Blair → Kelsey Brubaker', 'Kelsey Brubaker', 'Brubaker', 'Blair', 'craydenk@gmail.com'],
  ['D. Bruce Eriksen → Annie Eriksen', 'Annie Eriksen', 'Eriksen'],
  ['E. Victoria Fletcher → Vanessa Fletcher', 'Vanessa Fletcher'],
  ['F. Ivy Fox → Tiara Schaffter', 'Tiara Schaffter', 'Schaffter'],
  ['G. Isabella Koval vs Izzabella Griffith → Angela Koval', 'Angela Koval', 'Griffith'],
  ['H. Enzo Kratko → Yen Huynh', 'Yen Huynh', 'Huynh', 'Kratko', 'brian.kratko@icloud.com', 'neufae@yahoo.com'],
  ['I. Benson Nethers → parent unknown', 'Nethers', 'Benson'],
  ['J. Remi Overmyer → Sasha Overmyer', 'Sasha Overmyer'],
  ['K. Janeane Pummell → parent unknown', 'Pummell', 'alissa.pummell@gmail.com', 'rebelandpirate@yahoo.com'],
  ['L. Knox Reed → parent unknown', 'Reed', 'reedcri83@gmail.com'],
  ['M. Sophia Snodgrass → "Mom"', 'Snodgrass', 'ladyangel3444@gmail.com'],
  ['N. Azeila Spitler → Teri Malcuit', 'Spitler', 'Malcuit', 'ilmdmty@gmail.com'],
  ['O. Beauden Powers → Ciara Powers', 'Ciara Powers', 'Powers', 'ciarapowers1031@gmail.com'],
  ['P. Jensen Wonnell → Hannah Crocker', 'Hannah Crocker'],
  ['Q. Draper (Celia dup → Claira?)', 'Malissa Draper'],
  ['R. Turchyn (Penny/Evolet)', 'Turchyn'],
  ['S. Stout (Jett vs Brogan)', 'Kristen Stout'],
  ['T. Morgan (Katherine → Charles)', 'Katherine Morgan'],
  ['U. Carmony (Heath Carmony Samuel)', 'Carmony'],
  ['V. Jiang (Han Jiang Zong)', 'Mia Jiang', 'Jiang'],
  ['W. Mullet — contact named "Camille Mullet", parent = Amanda Good', 'Mullet', 'Amanda Good'],
  ['X. Woodas/Woodith Lilith → Natalie Langevoort', 'Langevoort', 'Woodas', 'Woodith'],
  ['Y. Mason Porter (in GHL, NOT on list)', 'Karley', 'Porter'],
  ['Z. Sigler/Malcuit', 'Sigler'],
  ['AA. Allison Allison', 'Allison'],
];

for (const [label, ...terms] of CASES) {
  console.log(`\n══════ ${label}`);
  const seen = new Set();
  for (const t of terms) {
    const hits = await searchContacts(t);
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const d = await contactDetail(h.id);
      const subs = await dbSubs(h.id);
      const slotStr = Object.entries(d.slots).map(([s, v]) => `s${s}: ${v.first_name ?? '?'} ${v.last_name ?? '?'}${v.enrollment_status ? ` [${v.enrollment_status}]` : ''}`).join(' | ') || '(no student fields)';
      const subStr = subs.map((r) => `s${r.slot} ${r.first_name} ${r.last_name}: ${r.subs} subs`).join(' | ') || '(no DB students)';
      console.log(`  ${d.name}  <${d.email}>  id=${d.id}  tags=[${d.tags.join(', ')}]  (matched "${t}")`);
      console.log(`     GHL slots: ${slotStr}`);
      console.log(`     DB/forms : ${subStr}`);
    }
  }
  if (seen.size === 0) console.log('  (no contacts found for any term)');
}
await db.end();
