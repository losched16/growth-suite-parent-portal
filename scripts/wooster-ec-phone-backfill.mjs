// Wooster — emergency-contact phones into GHL, in the format the field type
// actually accepts. "Emergency Contact #N Phone Numbers" are TEXTBOX_LIST
// fields: a plain-string write returns 200 and changes nothing, so portal
// submissions never reached them, and the values that ARE there sit under
// option ids from an older form version (invisible in the contact screen).
//
// Per family primary contact, per EC slot 1–3:
//   latest Emergency Medical submission has a phone → write it
//   otherwise, a stale-keyed value exists          → keep it, re-key it
// Written as { <current option id>: text, <stale ids>: "" } (writes merge;
// "" removes a stale entry).
//
//   node --env-file=.env.local scripts/wooster-ec-phone-backfill.mjs [--apply]
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const sc = await db.query(`SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id=$1`, [S]);
const kk = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
const dd = crypto.createDecipheriv('aes-256-gcm', kk, sc.rows[0].ghl_pit_iv); dd.setAuthTag(sc.rows[0].ghl_pit_tag);
const pit = Buffer.concat([dd.update(sc.rows[0].ghl_pit_encrypted), dd.final()]).toString('utf8');
const loc = sc.rows[0].ghl_location_id;
const H = { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' };

const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields;
const SLOT = {};
for (const n of [1, 2, 3]) {
  const f = fields.find((x) => x.fieldKey === `contact.emergency_contact_${n}_phone_numbers`);
  const opt = (f?.picklistOptions ?? []).find((o) => o && o.id)?.id;
  if (!f || !opt) throw new Error(`EC${n} phone field/option missing`);
  SLOT[n] = { id: f.id, opt };
}

function tidy(v) {
  const parts = String(v ?? '').split(',').map((p) => p.trim()).filter((p) => p && !/^[A-Za-z ()]+-\s*$/.test(p));
  if (parts.length === 1) return parts[0].replace(/^Cell \(Primary\)\s*-?\s*/i, '').trim();
  return parts.join(', ');
}

// latest emergency-medical submission per family (real submissions beat legacy imports)
const { rows: subs } = await db.query(
  `SELECT DISTINCT ON (ps.family_id) ps.family_id, ps.responses, p.ghl_contact_id
     FROM portal_form_submissions ps
     JOIN portal_form_definitions d ON d.id = ps.form_definition_id AND d.slug = 'emergency-medical'
     JOIN parents p ON p.family_id = ps.family_id AND p.is_primary AND p.ghl_contact_id IS NOT NULL
    WHERE ps.school_id = $1 AND ps.status IN ('submitted', 'paid', 'legacy_imported')
    ORDER BY ps.family_id, (ps.status <> 'legacy_imported') DESC, ps.created_at DESC`, [S]);
const portal = new Map(subs.map((r) => [r.ghl_contact_id, r.responses ?? {}]));
// every primary contact (families without a submission may still hold stale values)
const { rows: prim } = await db.query(
  `SELECT DISTINCT p.ghl_contact_id FROM parents p WHERE p.school_id=$1 AND p.is_primary AND p.status='active' AND p.ghl_contact_id IS NOT NULL`, [S]);
await db.end();

const stat = { contacts: 0, fromPortal: 0, rekeyedStale: 0, staleCleared: 0, unchanged: 0, writes: 0, failed: 0 };
for (const { ghl_contact_id: cid } of prim) {
  const c = (await (await fetch(`${GHL}/contacts/${cid}`, { headers: H })).json()).contact;
  await sleep(110);
  if (!c) continue;
  stat.contacts++;
  const cur = new Map((c.customFields ?? []).map((f) => [f.id, f.value]));
  const resp = portal.get(cid) ?? {};
  const out = [];
  for (const n of [1, 2, 3]) {
    const { id, opt } = SLOT[n];
    const val = cur.get(id) && typeof cur.get(id) === 'object' ? cur.get(id) : {};
    const staleKeys = Object.keys(val).filter((k) => k !== opt);
    const staleText = staleKeys.map((k) => String(val[k] ?? '').trim()).find(Boolean) ?? '';
    const fromPortal = tidy(resp[`ec${n}_phone`]);
    const want = fromPortal || String(val[opt] ?? '').trim() || tidy(staleText);
    if (!want && staleKeys.length === 0) continue;
    if (want === String(val[opt] ?? '').trim() && staleKeys.length === 0) { stat.unchanged++; continue; }
    const obj = {};
    for (const k of staleKeys) obj[k] = '';
    if (want) obj[opt] = want;
    out.push({ id, field_value: obj });
    if (fromPortal) stat.fromPortal++; else if (want) stat.rekeyedStale++; else stat.staleCleared++;
  }
  if (out.length === 0) continue;
  stat.writes++;
  if (stat.writes <= 5) console.log(`  ${c.firstName} ${c.lastName}:`, JSON.stringify(out.map((o) => Object.values(o.field_value).filter(Boolean)[0] ?? '(cleared)')));
  if (!apply) continue;
  const r = await fetch(`${GHL}/contacts/${cid}`, { method: 'PUT', headers: H, body: JSON.stringify({ customFields: out }) });
  if (!r.ok) { stat.failed++; console.log('  ✗', cid, r.status, (await r.text()).slice(0, 120)); }
  await sleep(160);
}
console.log(apply ? 'APPLIED' : 'DRY RUN', JSON.stringify(stat));
