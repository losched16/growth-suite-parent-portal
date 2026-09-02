// Wooster — make GHL current with the portal's medical data (issue #4:
// Compass reads the GHL emergency/allergy/medication fields, so they must
// track the latest portal submissions).
//
//  1. Fix the emergency-medical ghl_writeback mapping: relationships were
//     aimed at emergency_contact_N_relationship (field doesn't exist);
//     the real key is emergency_contact_N_relationship_to_student.
//  2. Backfill: for every family's LATEST emergency-medical submission
//     (submitted or legacy_imported), push EC 1-3 name/phone/relationship,
//     allergies, current medications, doctor/hospital to the primary
//     contact. For every student's LATEST medications submission, push
//     medications_list → student_{slot}_medications.
//  3. Re-enroll Valerie Shepherd (slot 1 on Elise Neville's contact) —
//     un-enrolled 2026-08-17 because she wasn't on the school's roster
//     sheet; the office has confirmed she's a real enrolled student.
//  4. Neutralise the duplicate Rachel Kilgore contact (rkilgore516@gmail
//     .com) — clears its phantom "Charlotte" student fields so the ghost
//     "Kilgore Family" disappears from Family Hub.
//
//   node --env-file=.env.local scripts/wooster-medical-writeback-backfill.mjs [--apply]
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields;
const FID = new Map(fields.map((f) => [String(f.fieldKey).replace(/^contact\./, ''), f.id]));

// ── 1. fix the writeback mapping ─────────────────────────────────────
if (apply) {
  await db.query(
    `UPDATE portal_form_definitions
        SET ghl_writeback = (
          SELECT jsonb_agg(
            CASE WHEN e->>'ghl_field_key' ~ '^emergency_contact_[0-9]_relationship$'
                 THEN jsonb_set(e, '{ghl_field_key}', to_jsonb((e->>'ghl_field_key') || '_to_student'))
                 ELSE e END)
            FROM jsonb_array_elements(ghl_writeback) e),
            updated_at = now()
      WHERE school_id = $1 AND slug = 'emergency-medical'`, [S]);
  console.log('writeback mapping fixed (relationship → _to_student)');
} else console.log('would fix writeback mapping (relationship → _to_student)');

// ── 2a. latest emergency-medical per family ──────────────────────────
const { rows: ems } = await db.query(
  `SELECT DISTINCT ON (ps.family_id)
          ps.family_id, ps.responses, p.ghl_contact_id, f.display_name
     FROM portal_form_submissions ps
     JOIN portal_form_definitions d ON d.id = ps.form_definition_id
     JOIN families f ON f.id = ps.family_id
     JOIN parents p ON p.family_id = ps.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL
    WHERE ps.school_id = $1 AND d.slug = 'emergency-medical'
      AND ps.status IN ('submitted', 'paid', 'legacy_imported')
    ORDER BY ps.family_id, (ps.status <> 'legacy_imported') DESC, ps.created_at DESC`, [S]);
const EM_MAP = [
  ['ec1_name', 'emergency_contact_1_name'], ['ec1_phone', 'emergency_contact_1_phone_numbers'], ['ec1_relationship', 'emergency_contact_1_relationship_to_student'],
  ['ec2_name', 'emergency_contact_2_name'], ['ec2_phone', 'emergency_contact_2_phone_numbers'], ['ec2_relationship', 'emergency_contact_2_relationship_to_student'],
  ['ec3_name', 'emergency_contact_3_name'], ['ec3_phone', 'emergency_contact_3_phone_numbers'], ['ec3_relationship', 'emergency_contact_3_relationship_to_student'],
  ['allergies', 'allergies'], ['current_medications', 'medications'],
  ['doctor_name', 'doctor_name'], ['doctor_phone', 'doctor_phone'], ['hospital_name', 'hospital_name'],
];
let emPlans = [];
for (const r of ems) {
  const resp = r.responses ?? {};
  const cf = [];
  for (const [fk, gk] of EM_MAP) {
    const v = resp[fk] ?? resp._legacy_answers?.[fk];
    const id = FID.get(gk);
    if (id && typeof v === 'string' && v.trim() !== '') cf.push({ id, value: v.trim() });
  }
  if (cf.length) emPlans.push({ cid: r.ghl_contact_id, fam: r.display_name, cf });
}
console.log(`emergency-medical backfill: ${emPlans.length} families (of ${ems.length} with a submission)`);
for (const p of emPlans.slice(0, 3)) console.log('  e.g.', p.fam, '→', p.cf.length, 'fields');

// ── 2b. latest medications per student ───────────────────────────────
const { rows: meds } = await db.query(
  `SELECT DISTINCT ON (ps.student_id)
          ps.responses, p.ghl_contact_id, s.metadata->>'ghl_slot' AS slot,
          s.first_name || ' ' || s.last_name AS student
     FROM portal_form_submissions ps
     JOIN portal_form_definitions d ON d.id = ps.form_definition_id
     JOIN students s ON s.id = ps.student_id
     JOIN parents p ON p.family_id = ps.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL
    WHERE ps.school_id = $1 AND d.slug = 'medications' AND ps.student_id IS NOT NULL
      AND ps.status IN ('submitted', 'paid', 'legacy_imported')
    ORDER BY ps.student_id, (ps.status <> 'legacy_imported') DESC, ps.created_at DESC`, [S]);
let medPlans = [];
for (const r of meds) {
  const v = r.responses?.medications_list ?? r.responses?._legacy_answers?.medications_list;
  const slot = Number(r.slot ?? 1);
  const key = slot === 1 ? 'medications' : `student_${slot}_medications`;
  const id = FID.get(key);
  if (id && typeof v === 'string' && v.trim() !== '') medPlans.push({ cid: r.ghl_contact_id, student: r.student, cf: [{ id, value: v.trim() }] });
}
console.log(`medications backfill: ${medPlans.length} students`);

// ── merge per contact + apply ────────────────────────────────────────
const byContact = new Map();
for (const p of [...emPlans, ...medPlans]) {
  const e = byContact.get(p.cid) ?? { cid: p.cid, cf: new Map() };
  for (const f of p.cf) e.cf.set(f.id, f.value);
  byContact.set(p.cid, e);
}
console.log(`total contacts to update: ${byContact.size}`);

// ── 3 & 4. Valerie + dup Kilgore ─────────────────────────────────────
const VALERIE = { cid: '7qURSS0YVqIzeBHLTEFb', cf: [{ id: FID.get('student_enrollment_status'), value: 'enrolled' }] };
const DUP_KILGORE = { cid: 'obHo2szFRToGYIiT1e43', cf: ['student_first_name', 'student_last_name', 'student_date_of_birth', 'student_gender', 'student_enrollment_status'].filter((k) => FID.get(k)).map((k) => ({ id: FID.get(k), value: '' })) };
console.log('Valerie Shepherd → enrolled (Elise Neville contact, slot 1)');
console.log('dup Rachel Kilgore contact → clear phantom Charlotte fields');

if (!apply) { console.log('\nDRY RUN'); await db.end(); process.exit(0); }

let ok = 0, fail = 0;
const put = async (cid, cfArr) => {
  const r = await fetch(`${GHL}/contacts/${cid}`, { method: 'PUT', headers: H, body: JSON.stringify({ customFields: cfArr }) });
  if (r.ok) ok++; else { fail++; console.log('✗', cid, r.status, (await r.text()).slice(0, 120)); }
  await sleep(220);
};
for (const [cid, e] of byContact) await put(cid, [...e.cf.entries()].map(([id, value]) => ({ id, value })));
await put(VALERIE.cid, VALERIE.cf);
await put(DUP_KILGORE.cid, DUP_KILGORE.cf);
console.log(`applied: ${ok} ok, ${fail} failed`);
await db.end();
