// Wooster — every portal-form answer onto the contact record.
//
// Until now only Emergency Medical copied answers to GHL; the per-student
// forms (Health Conditions / History, Injury History, Medications,
// Enrollment Agreement) sent nothing but a completion date, and Emergency
// Medical's FAMILY-level allergies/medications text was landing in Student
// 1's fields. Compass (other team) and GHL smart lists read the contact, so
// the answers have to live there.
//
//   --create    create missing fields (Student 1–4 folders / Contact folder)
//   --config    write each form's ghl_writeback (live submissions from then on)
//   --backfill  push every family's / student's latest answers
//   (no flag = dry run of all three)
//
//   node --env-file=.env.local scripts/wooster-form-contact-mapping.mjs [--create] [--config] [--backfill]
import pg from 'pg';
import crypto from 'node:crypto';
import axios from 'axios';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const A = { create: process.argv.includes('--create'), config: process.argv.includes('--config'), backfill: process.argv.includes('--backfill') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOLDER = { 1: 'nayZq8K2Co18K3m8281J', 2: 'kO6qmBxFUppEQ4s2isF3', 3: 'gPFvYDaqUzbwULxdeqUB', 4: '07pRp4W9SgakJ1RqMEWv', family: 'FjsK4QyrZ29BNaEssKPR' };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const sc = (await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S])).rows[0];
const kk = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
const dd = crypto.createDecipheriv('aes-256-gcm', kk, sc.ghl_pit_iv); dd.setAuthTag(sc.ghl_pit_tag);
const pit = Buffer.concat([dd.update(sc.ghl_pit_encrypted), dd.final()]).toString('utf8');
const loc = sc.ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };
const nk = (k) => String(k ?? '').replace(/^contact\./, '');
const loadFields = async () => (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
let fields = await loadFields();

const defs = (await db.query(`SELECT id, slug, per_student, field_schema, ghl_writeback FROM portal_form_definitions WHERE school_id=$1 AND is_active ORDER BY slug`, [S])).rows;
const def = (slug) => defs.find((d) => d.slug === slug);
const q = (slug, key) => (def(slug).field_schema ?? []).find((b) => b?.key === key);

// ── matching ────────────────────────────────────────────────────────
const core = (s) => String(s ?? '').toLowerCase()
  .replace(/^\(student \d\)\s*/, '').replace(/^student \d\s*-\s*/, '').replace(/^student \d\s+/, '')
  .replace(/\(.*$/, '').replace(/[:?.]/g, '').replace(/[^a-z0-9&/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const SYN = {
  allergies_list: 'allergies', medications_list: 'medications', other_health_info: 'please list any other health information',
  injury_list: 'please list all injuries and illnesses', had_surgery: 'has your child ever had surgery or serious injury',
  birth_developmental: 'birth & developmental history', incomplete_history_reason: 'if you do not have a complete medical history',
  add_adhd: 'add/adhd', allergy_insect: 'severe stinging insect allergies', allergy_food: 'food allergies', allergy_pollen: 'pollen allergy',
  allergy_latex: 'latex allergy', allergy_medication: 'medication allergy', has_anaphylaxis: 'has anaphylaxis reaction', has_epipen: 'has epipen',
  missing_organs: 'missing/malfunctioning organs', ear_infections: 'ear infections', wears_glasses: 'wears glasses or contacts',
  special_needs: 'special needs or disability', participation_restricted: 'has a provider ever denied or restricted',
  spent_night_in_hospital: 'has your child ever spent the night in the hospital',
  insurance_company: 'insurance company', insurance_policy: 'policy number', insurance_holder: 'policy holder s name',
  emergency_consent: 'in the event of an emergency',
  specialist_name: 'medical specialist name', specialist_phone: 'medical specialist phone', hospital_name: 'hospital name',
};
// short names for fields we create
const SHORT = {
  other_health_info: 'Other Health Information', incomplete_history_reason: 'Incomplete Medical History - Reason',
  tics: 'Tics / Nervous Twitches', emotional_behavioral: 'Emotional / Behavioral Concerns', payment_plan: 'Payment Plan (Enrollment Agreement)',
  plan_exceptions: 'Payment Plan Exceptions', allergy_insect: 'Severe Stinging Insect Allergies', missing_organs: 'Missing/Malfunctioning Organs',
  numbness: 'Numbness (arms, hands, legs, or feet)', weakness: 'Weakness (arms, hands, legs, or feet)', ear_infections: 'Ear Infections',
  spinal_issues: 'Spinal Issues', has_anaphylaxis: 'Has Anaphylaxis Reaction', wears_glasses: 'Wears Glasses or Contacts',
  osteopenia: 'Osteopenia or Osteoporosis', add_adhd: 'ADD/ADHD',
};
function findField(folderKey, want) {
  const w = core(want);
  const pool = fields.filter((f) => f.parentId === FOLDER[folderKey] && !/^form_|^documents_complete/.test(nk(f.fieldKey)) && f.dataType !== 'TEXTBOX_LIST');
  const exact = pool.filter((f) => core(f.name) === w);
  const pref = exact.length ? exact : pool.filter((f) => w.length >= 8 && core(f.name).startsWith(w));
  return pref[0] ?? null;
}
const byKey = (k) => fields.find((f) => nk(f.fieldKey) === k) ?? null;

// ── desired mapping ─────────────────────────────────────────────────
// Each target: { form, q, slot (1-4|'family'), key?: existing key, create?: {name,type,folder} , opts }
const SKIP = new Set(['student_full_name', 'parent_signature', 'agree_terms', 'medical_admin_form', 'signature_date']);
const targets = [];
const NEW_ALWAYS = new Set(['payment_plan', 'plan_exceptions']); // existing RADIO has different options
for (const d of defs) {
  for (const b of d.field_schema ?? []) {
    if (!b?.key || SKIP.has(b.key) || ['header', 'paragraph', 'section', 'divider', 'image', 'signature_stamp', 'student_applicability', 'signature_typed', 'file_upload'].includes(b.type)) continue;
    if (d.slug === 'emergency-medical' && (/^ec[1-5]_/.test(b.key) || b.key === 'additional_emergency_contacts')) continue; // below
    const isChoice = Array.isArray(b.options) && b.options.length > 0;
    const type = b.type === 'textarea' ? 'LARGE_TEXT' : (b.type === 'radio' && isChoice && b.options.every((o) => /^(yes|no)$/i.test(String(o.label ?? o)))) ? 'RADIO' : 'TEXT';
    const slots = d.per_student ? [1, 2, 3, 4] : ['family'];
    for (const s of slots) {
      let hit = null;
      if (!NEW_ALWAYS.has(b.key)) {
        if (s === 1 && b.key === 'add_adhd') hit = byKey('addadhd');
        else if (d.slug === 'emergency-medical' && ['allergies', 'current_medications', 'existing_conditions'].includes(b.key)) hit = null; // family fields, new
        else if (d.slug === 'media-permission') hit = null; // existing roster CHECKBOX has different options
        else hit = findField(s, SYN[b.key] ?? b.label);
      }
      const base = SHORT[b.key] ?? String(b.label ?? b.key).replace(/\(.*$/, '').replace(/[:?]\s*$/, '').trim().slice(0, 70);
      const name = s === 'family'
        ? ({ allergies: 'Emergency Medical - Allergies (family)', current_medications: 'Emergency Medical - Current Medications (family)', existing_conditions: 'Emergency Medical - Existing Conditions (family)', media_channels: 'Media Permission - Approved Uses', roster_authorize: 'Parent Roster - Approved to Share' }[b.key] ?? base)
        : `Student ${s} - ${base}`;
      targets.push({ form: d.slug, q: b.key, slot: s, key: hit ? nk(hit.fieldKey) : null, create: hit ? null : { name, type: d.slug === 'media-permission' ? 'LARGE_TEXT' : type, folder: FOLDER[s] }, choice: isChoice });
    }
  }
}
// Emergency contacts: #1–3 exist (TEXTBOX_LIST phones handled by the writer); #4–5 + additional are new.
for (let n = 1; n <= 5; n++) {
  for (const part of ['name', 'relationship', 'phone']) {
    const existingKey = n <= 3 ? { name: `emergency_contact_${n}_name`, relationship: `emergency_contact_${n}_relationship_to_student`, phone: `emergency_contact_${n}_phone_numbers` }[part] : null;
    targets.push({ form: 'emergency-medical', q: `ec${n}_${part}`, slot: 'family', key: existingKey,
      create: existingKey ? null : { name: `Emergency Contact #${n} ${part === 'relationship' ? 'Relationship to Student' : part === 'phone' ? 'Phone' : 'Name'}`, type: 'TEXT', folder: FOLDER.family }, choice: false });
  }
}
targets.push({ form: 'emergency-medical', q: 'additional_emergency_contacts', slot: 'family', key: null, create: { name: 'Additional Emergency Contacts', type: 'LARGE_TEXT', folder: FOLDER.family }, choice: false });

// value translations onto existing option fields with different wording
const VALUE_MAP = {
  'emergency-medical.emergency_consent': { grant: 'Yes, grant consent for treatment', refuse: 'No, do not consent for treatment' },
  'ode-connectivity.internet_connectivity': { broadband: 'Broadband access from home (cable, DSL, etc.)', mobile: 'Cellular connection from home (hotspot)', none: 'No connection from home' },
  'ode-connectivity.device_type': { computer: 'A laptop, desktop or tablet computer available', phone_only: 'A smartphone', none: 'No device available' },
};

const toCreate = targets.filter((t) => t.create);
console.log(`targets: ${targets.length} | reuse existing: ${targets.length - toCreate.length} | create: ${toCreate.length}`);

// ── 1. create ───────────────────────────────────────────────────────
if (A.create) {
  for (const t of toCreate) {
    const body = { name: t.create.name, dataType: t.create.type, model: 'contact', parentId: t.create.folder };
    if (t.create.type === 'RADIO') body.options = ['Yes', 'No'];
    const r = await fetch(`${GHL}/locations/${loc}/customFields`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log('  ✗', t.create.name, r.status, JSON.stringify(j).slice(0, 140)); continue; }
    t.key = nk(j.customField?.fieldKey); t.created = true;
    await sleep(380);
  }
  fields = await loadFields();
  console.log(`created: ${toCreate.filter((t) => t.created).length}/${toCreate.length}`);
} else {
  for (const t of toCreate) console.log('  would create:', t.create.name, '|', t.create.type, '|', Object.entries(FOLDER).find(([, v]) => v === t.create.folder)?.[0]);
}
// resolve keys of fields created in an earlier --create run (by name)
for (const t of targets) if (!t.key && t.create) { const f = fields.find((x) => x.name === t.create.name && x.parentId === t.create.folder); if (f) t.key = nk(f.fieldKey); }
const unresolved = targets.filter((t) => !t.key);
if (unresolved.length) console.log(`unresolved targets (not created yet): ${unresolved.length}`);

// ── 2. ghl_writeback config ────────────────────────────────────────
const configs = {};
for (const d of defs) {
  // keep completion-date stamps
  const keep = (d.ghl_writeback ?? []).filter((w) => w.field_key === 'signature_date');
  const entries = [...keep];
  const mine = targets.filter((t) => t.form === d.slug && t.key);
  const byQ = new Map();
  for (const t of mine) (byQ.get(t.q) ?? byQ.set(t.q, []).get(t.q)).push(t);
  for (const [qk, ts] of byQ) {
    const vm = VALUE_MAP[`${d.slug}.${qk}`];
    const choice = ts[0].choice;
    if (d.per_student) {
      const bySlot = Object.fromEntries(ts.map((t) => [String(t.slot), t.key]));
      entries.push({ field_key: qk, ghl_field_key: bySlot['1'] ?? ts[0].key, per_student: true, ghl_field_key_by_slot: bySlot, ...(choice ? { write_label: true } : {}), ...(vm ? { value_map: vm } : {}) });
    } else {
      entries.push({ field_key: qk, ghl_field_key: ts[0].key, ...(choice ? { write_label: true } : {}), ...(vm ? { value_map: vm } : {}) });
    }
  }
  configs[d.slug] = entries;
  console.log(`  ${d.slug.padEnd(22)} ${entries.length} mappings`);
}
if (A.config) {
  for (const d of defs) await db.query(`UPDATE portal_form_definitions SET ghl_writeback=$2::jsonb, updated_at=now() WHERE id=$1`, [d.id, JSON.stringify(configs[d.slug])]);
  console.log('config saved');
}

// ── 3. backfill latest answers ─────────────────────────────────────
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function answer(d, resp, qk) {
  let v = resp?.[qk];
  if ((v == null || v === '' || (Array.isArray(v) && !v.length)) && Array.isArray(resp?._legacy_answers)) {
    const b = q(d.slug, qk);
    const la = resp._legacy_answers.find((x) => x.key === qk) ?? resp._legacy_answers.find((x) => norm(x.label) === norm(b?.label));
    v = la?.value;
  }
  return v;
}
function render(d, entry, raw) {
  if (raw == null) return '';
  const b = q(d.slug, entry.field_key);
  const labelOf = new Map((b?.options ?? []).filter((o) => o && typeof o === 'object').map((o) => [String(o.value), String(o.label)]));
  const one = (x) => { const s = String(x ?? ''); if (entry.value_map && s in entry.value_map) return entry.value_map[s]; return entry.write_label ? (labelOf.get(s) ?? s) : s; };
  const v = Array.isArray(raw) ? raw.map(one).filter(Boolean).join(entry.write_label ? '; ' : ', ') : one(raw);
  return String(v).replace(/\r?\n+/g, '\n').trim();
}
const { rows: subs } = await db.query(
  `SELECT DISTINCT ON (s.form_definition_id, COALESCE(s.student_id, s.family_id))
          s.form_definition_id, s.family_id, s.student_id, s.responses, p.ghl_contact_id,
          COALESCE((st.metadata->>'slot'), (st.metadata->>'ghl_slot'))::int AS slot
     FROM portal_form_submissions s
     JOIN parents p ON p.family_id = s.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL
     LEFT JOIN students st ON st.id = s.student_id
    WHERE s.school_id = $1 AND s.voided_at IS NULL AND COALESCE(s.is_test,false) = false
      AND COALESCE(s.is_addendum,false) = false
      AND s.status IN ('submitted','paid','pending_payment','legacy_imported')
    ORDER BY s.form_definition_id, COALESCE(s.student_id, s.family_id), COALESCE(s.submitted_at, s.created_at) DESC`, [S]);
const perContact = new Map(); // contactId → { fieldKey → value }
let values = 0;
for (const s of subs) {
  const d = defs.find((x) => x.id === s.form_definition_id);
  if (!d) continue;
  for (const entry of configs[d.slug]) {
    if (entry.field_key === 'signature_date') continue;
    let key = entry.ghl_field_key;
    if (d.per_student) { if (!s.student_id || !s.slot) continue; key = entry.ghl_field_key_by_slot?.[String(s.slot)]; if (!key) continue; }
    const v = render(d, entry, answer(d, s.responses, entry.field_key));
    if (!v) continue;
    const m = perContact.get(s.ghl_contact_id) ?? perContact.set(s.ghl_contact_id, {}).get(s.ghl_contact_id);
    m[key] = v; values++;
  }
}
console.log(`backfill: ${subs.length} latest submissions → ${values} values on ${perContact.size} contacts`);
if (A.backfill) {
  const { updateContactCustomFields } = await import('../lib/ghl/writes.ts');
  const client = { locationId: loc, axios: axios.create({ baseURL: GHL, headers: H }) };
  let ok = 0, fail = 0;
  for (const [cid, byKeyVals] of perContact) {
    try { await updateContactCustomFields(client, cid, byKeyVals); ok++; } catch (e) { fail++; console.log('  ✗', cid, e?.response?.status, JSON.stringify(e?.response?.data ?? e.message).slice(0, 160)); }
    await sleep(220);
  }
  console.log(`backfill applied: ${ok} contacts ok, ${fail} failed`);
}
await db.end();
