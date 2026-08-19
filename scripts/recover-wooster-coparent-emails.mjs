// Recover Parent-2 emails that the portal's "Add another parent" collected
// but could not persist to GHL (Wooster had no parent_2_email field until
// 2026-08-19), so the snapshot sync rebuilt the co-parent without an email
// and their invite links stopped resolving.
//
// For every add_co_parent audit event with an email: inviter → family →
// primary GHL contact → write parent_2_email (only when that family has
// exactly one email-less Parent 2 row, so we never guess).
//
//   node --env-file=.env.local scripts/recover-wooster-coparent-emails.mjs [--apply]
import pg from 'pg';
import crypto from 'node:crypto';

const S = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const GHL = 'https://services.leadconnectorhq.com';
const apply = process.argv.includes('--apply');
const SKIP_EMAILS = new Set(['testajoe@hotmail.com']); // test entry

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
const fields = (await (await fetch(`${GHL}/locations/${loc}/customFields?model=contact`, { headers: H })).json()).customFields ?? [];
const P2_EMAIL_ID = fields.find((f) => String(f.fieldKey).replace(/^contact\./, '') === 'parent_2_email')?.id;
if (!P2_EMAIL_ID) { console.error('parent_2_email field missing'); process.exit(1); }

const { rows: events } = await db.query(
  `SELECT l.created_at, l.parent_id AS inviter_id, l.detail->>'new_parent_email' AS email
     FROM parent_portal_audit_log l
    WHERE l.school_id = $1 AND l.event_type = 'add_co_parent'
      AND COALESCE(l.detail->>'new_parent_email','') <> ''
    ORDER BY l.created_at`, [S]);

const plan = [];
for (const e of events) {
  const email = e.email.trim().toLowerCase();
  if (SKIP_EMAILS.has(email)) { plan.push({ email, action: 'skip (test)' }); continue; }
  const { rows: inv } = await db.query(
    `SELECT p.family_id, p.first_name||' '||p.last_name AS inviter, p.ghl_contact_id, f.display_name
       FROM parents p JOIN families f ON f.id = p.family_id WHERE p.id = $1 AND p.school_id = $2`, [e.inviter_id, S]);
  if (!inv.length) { plan.push({ email, action: 'SKIP — inviter parent row not found' }); continue; }
  const fam = inv[0];
  const { rows: p2s } = await db.query(
    `SELECT id, first_name, last_name, email FROM parents WHERE family_id = $1 AND is_primary = false AND status = 'active' ORDER BY created_at`, [fam.family_id]);
  const { rows: primary } = await db.query(
    `SELECT ghl_contact_id, email FROM parents WHERE family_id = $1 AND is_primary = true LIMIT 1`, [fam.family_id]);
  const pc = primary[0];
  if (!pc?.ghl_contact_id) { plan.push({ email, family: fam.display_name, action: 'SKIP — no primary contact' }); continue; }
  if ((pc.email ?? '').toLowerCase() === email) { plan.push({ email, family: fam.display_name, action: 'skip — same as primary email' }); continue; }
  if (p2s.some((p) => (p.email ?? '').toLowerCase() === email)) { plan.push({ email, family: fam.display_name, action: 'already on file' }); continue; }
  const blank = p2s.filter((p) => !p.email);
  if (blank.length !== 1) { plan.push({ email, family: fam.display_name, action: `SKIP — ${blank.length} email-less P2 rows (${p2s.map((p) => p.first_name).join('/') || 'none'}) — ambiguous` }); continue; }
  plan.push({ email, family: fam.display_name, inviter: fam.inviter, p2: `${blank[0].first_name} ${blank[0].last_name}`, contact: pc.ghl_contact_id, action: 'WRITE parent_2_email' });
}
console.table(plan.map((p) => ({ family: p.family ?? '', p2: p.p2 ?? '', email: p.email, action: p.action })));
if (!apply) { console.log('DRY RUN'); await db.end(); process.exit(0); }

let ok = 0, fail = 0;
for (const p of plan) {
  if (!p.action.startsWith('WRITE')) continue;
  const r = await fetch(`${GHL}/contacts/${p.contact}`, { method: 'PUT', headers: H, body: JSON.stringify({ customFields: [{ id: P2_EMAIL_ID, value: p.email }] }) });
  if (r.ok) ok++; else { fail++; console.log('✗', p.family, r.status, (await r.text()).slice(0, 120)); }
  await new Promise((s) => setTimeout(s, 300));
}
console.log(`written ${ok}, failed ${fail}`);
await db.end();
