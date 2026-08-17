// Legacy-imported submissions store the raw GHL form payload: answers keyed
// by GHL contact-custom-field ID (e.g. "xp7dLXXVA1KkOv4wbCq3": "Scarlett")
// plus tracking noise. The portal renders by portal schema key, so those
// rows read blank. This adds `responses._legacy_answers` — an ordered
// [{label, value}] list resolved via the school's GHL custom-field labels —
// so the saved copy shows what the parent actually submitted.
//
// Idempotent (recomputes _legacy_answers each run). Never touches other keys.
//   node --env-file=.env.local scripts/enrich-legacy-submission-answers.mjs [--apply] [--school <uuid>]

import pg from 'pg';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const S = argv.includes('--school') ? argv[argv.indexOf('--school') + 1] : '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
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
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' };
const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const labelById = new Map(fields.map((f) => [f.id, String(f.name ?? '').trim()]));
const labelByKey = new Map(fields.map((f) => [String(f.fieldKey ?? '').replace(/^contact\./, ''), String(f.name ?? '').trim()]));

// Keys that are tracking / identity metadata, never an answer.
const SKIP = new Set([
  'ip', 'eventData', 'formId', 'Timezone', 'sessionId', 'contact_id', 'query_contact_id', 'fbc', 'fbp',
  'location_id', 'location', 'submissionId', 'signatureHash', 'fieldsOriSequance', '_ghl_submission_id',
  '_ghl_form_name', '_imported_at', '_legacy_answers', 'contactSessionIds', 'full_address', 'source',
  'email', 'first_name', 'last_name', 'phone', 'name', 'city', 'state', 'country', 'postal_code', 'address',
  'timezone', 'date_of_birth', 'tags', 'website', 'company_name',
]);
const humanize = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function valueToText(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (v.url) return { file: v.url, name: v.meta?.originalname ?? v.meta?.filename ?? 'attachment' };
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    return JSON.stringify(v);
  }
  return String(v);
}

const { rows } = await db.query(
  `SELECT s.id, s.responses, d.field_schema
     FROM portal_form_submissions s JOIN portal_form_definitions d ON d.id = s.form_definition_id
    WHERE s.school_id = $1 AND s.status = 'legacy_imported'`, [S]);
console.log(`legacy rows: ${rows.length}`);

let updated = 0, withAnswers = 0, emptyAnswers = 0;
const sample = [];
for (const r of rows) {
  const schemaKeys = new Set();
  const walk = (b) => { if (!b) return; if (Array.isArray(b)) return b.forEach(walk); if (typeof b === 'object') { if (b.key) schemaKeys.add(b.key); for (const v of Object.values(b)) if (typeof v === 'object') walk(v); } };
  walk(r.field_schema);
  const resp = r.responses ?? {};
  // Preserve GHL's original question order when available.
  const order = Array.isArray(resp.fieldsOriSequance) ? resp.fieldsOriSequance.filter((x) => typeof x === 'string' && x !== 'header') : [];
  const keys = [...new Set([...order, ...Object.keys(resp)])].filter((k) => k in resp && !SKIP.has(k) && !schemaKeys.has(k) && !/_(drawn|signed_at)$/.test(k));
  const answers = [];
  for (const k of keys) {
    const text = valueToText(resp[k]);
    if (text == null) continue;
    const label = labelById.get(k) ?? labelByKey.get(k) ?? humanize(k);
    answers.push({ key: k, label, ...(typeof text === 'object' ? text : { value: text }) });
  }
  if (answers.length) withAnswers++; else emptyAnswers++;
  if (sample.length < 3 && answers.length) sample.push({ id: r.id, answers: answers.slice(0, 5) });
  if (apply) {
    await db.query(`UPDATE portal_form_submissions SET responses = responses || jsonb_build_object('_legacy_answers', $2::jsonb) WHERE id = $1`, [r.id, JSON.stringify(answers)]);
    updated++;
  }
}
console.log(JSON.stringify({ apply, updated, rows_with_extra_answers: withAnswers, rows_with_none: emptyAnswers }, null, 1));
console.log('sample:', JSON.stringify(sample, null, 1).slice(0, 1500));
await db.end();
