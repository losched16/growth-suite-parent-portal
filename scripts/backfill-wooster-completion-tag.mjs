// One-shot retroactive tag application: for every Wooster family that
// is currently fully complete in our DB, write the school's
// completion_tag to every active parent's GHL contact.
//
// Going forward, the portal-forms submit handler does this
// automatically on the submission that brings a family to 100%. This
// script is the catch-up so families who completed before today get
// tagged too.
//
// Usage:
//   node scripts/backfill-wooster-completion-tag.mjs            # DRY RUN
//   node scripts/backfill-wooster-completion-tag.mjs --apply    # write

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const APPLY = process.argv.includes('--apply');
const WOOSTER = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function decrypt(ct, iv, tag) {
  const raw = process.env.ENCRYPTION_KEY;
  let key = Buffer.from(raw, 'base64');
  if (key.length !== 32) key = Buffer.from(raw, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function main() {
  const sBranding = await pool.query(
    `SELECT completion_tag FROM school_branding WHERE school_id = $1`,
    [WOOSTER],
  );
  const tag = (sBranding.rows[0]?.completion_tag ?? '').trim();
  if (!tag) {
    console.log('No completion_tag configured for Wooster — nothing to do.');
    await pool.end(); return;
  }
  console.log(`Tag: "${tag}"\n`);

  const s = await pool.query(
    `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag FROM schools WHERE id = $1`,
    [WOOSTER],
  );
  const token = decrypt(s.rows[0].ghl_pit_encrypted, s.rows[0].ghl_pit_iv, s.rows[0].ghl_pit_tag);
  const ax = axios.create({
    baseURL: 'https://services.leadconnectorhq.com',
    headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
    timeout: 20_000,
  });

  // Get every Wooster family with students
  const fams = await pool.query(
    `SELECT f.id, f.display_name FROM families f
      WHERE f.school_id = $1 AND f.status='active'
        AND EXISTS (SELECT 1 FROM students s WHERE s.family_id = f.id AND s.status='active')`,
    [WOOSTER],
  );

  const forms = await pool.query(
    `SELECT id, per_student FROM portal_form_definitions
      WHERE school_id = $1 AND is_active=true AND COALESCE(audience,'parents')='parents'`,
    [WOOSTER],
  );

  let completeFams = 0;
  let taggedContacts = 0;
  let failed = 0;

  for (const f of fams.rows) {
    const students = await pool.query(
      `SELECT id FROM students WHERE school_id=$1 AND family_id=$2 AND status='active'`,
      [WOOSTER, f.id],
    );
    if (students.rows.length === 0) continue;
    const sids = students.rows.map((r) => r.id);
    const subs = await pool.query(
      `SELECT form_definition_id, student_id FROM portal_form_submissions
        WHERE school_id=$1 AND COALESCE(is_test,false)=false
          AND status IN ('submitted','paid','pending_payment','legacy_imported')
          AND (family_id=$2 OR student_id=ANY($3::uuid[]))`,
      [WOOSTER, f.id, sids],
    );
    const famSubs = new Set();
    const stuSubs = new Set();
    for (const r of subs.rows) {
      if (r.student_id) stuSubs.add(`${r.form_definition_id}|${r.student_id}`);
      else famSubs.add(r.form_definition_id);
    }
    let complete = true;
    for (const form of forms.rows) {
      if (form.per_student) {
        for (const sid of sids) if (!stuSubs.has(`${form.id}|${sid}`)) { complete = false; break; }
      } else if (!famSubs.has(form.id)) complete = false;
      if (!complete) break;
    }
    if (!complete) continue;
    completeFams++;

    // All active parents on the family with a GHL contact
    const parents = await pool.query(
      `SELECT ghl_contact_id, first_name, last_name FROM parents
        WHERE school_id=$1 AND family_id=$2 AND status='active' AND ghl_contact_id IS NOT NULL`,
      [WOOSTER, f.id],
    );
    if (parents.rows.length === 0) continue;

    for (const p of parents.rows) {
      if (!APPLY) {
        console.log(`  WOULD TAG  ${p.first_name} ${p.last_name} (${f.display_name}) → ${p.ghl_contact_id}`);
        taggedContacts++;
        continue;
      }
      try {
        await ax.post(`/contacts/${p.ghl_contact_id}/tags`, { tags: [tag] });
        console.log(`  TAGGED     ${p.first_name} ${p.last_name} (${f.display_name})`);
        taggedContacts++;
      } catch (err) {
        console.log(`  FAILED     ${p.first_name} ${p.last_name} — ${err.response?.status ?? ''} ${err.response?.data?.message ?? err.message}`);
        failed++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Fully-complete families: ${completeFams}`);
  console.log(`  ${APPLY ? 'Tagged' : 'Would tag'} contacts: ${taggedContacts}`);
  if (APPLY) console.log(`  Failed: ${failed}`);
  if (!APPLY) console.log(`\n  Dry run — rerun with --apply to write.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
