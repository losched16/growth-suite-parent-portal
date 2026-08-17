// One-shot backfill: for every Wooster family that is already fully
// form-complete (has the "forms completed - 26/27" tag), apply the
// "enrolled - 26/27" tag AND move every open "Documents Requested"
// opportunity to "Enrolled".
//
// This catches every family that finished forms before the auto-advance
// hook was deployed. Safe to re-run — tag writes are idempotent and
// opportunities already in the target stage are skipped.
//
// Usage:
//   node --env-file=.env.local scripts/backfill-wooster-advance.mjs         # dry-run
//   node --env-file=.env.local scripts/backfill-wooster-advance.mjs --apply # actually do it

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import axios from 'axios';
import crypto from 'node:crypto';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const DASHBOARDS_ROOT = join(projectRoot, '..', 'growth-suite-dashboards');

const apply = process.argv.includes('--apply');
const SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const ENROLLMENT_TAG = 'enrolled - 26/27';
const FROM_STAGE = 'Documents Requested';
const TO_STAGE = 'Enrolled';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Decrypt the PIT the same way lib/crypto does (aes-256-gcm, key is
// base64-encoded 32-byte ENCRYPTION_KEY).
function decryptPit(encrypted, iv, tag) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const { rows: schoolRows } = await pool.query(
  `SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE id = $1`,
  [SCHOOL_ID],
);
const school = schoolRows[0];
let pit;
try {
  pit = decryptPit(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
} catch (e) {
  console.error('PIT decrypt failed. Trying alternate env key.');
  throw e;
}

const client = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${pit}`,
    Version: '2021-07-28',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 30_000,
});

// Find every Wooster family whose primary parent's contact already has
// the "forms completed - 26/27" tag AND has at least one opp still in
// Documents Requested. (Restricting on both keeps this to the 32
// families the head of school pointed out.)
const { rows: stuck } = await pool.query(
  `SELECT DISTINCT
          f.id AS family_id,
          f.display_name,
          p.ghl_contact_id AS contact_id
     FROM families f
     JOIN parents p
       ON p.family_id = f.id AND p.is_primary = true
      AND p.ghl_contact_id IS NOT NULL
     JOIN ghl_contact_tags t
       ON t.school_id = f.school_id AND t.ghl_contact_id = p.ghl_contact_id
      AND LOWER(t.tag) = 'forms completed - 26/27'
     JOIN ghl_opportunities o
       ON o.school_id = f.school_id AND o.ghl_contact_id = p.ghl_contact_id
      AND o.stage_name = $2 AND o.status = 'open'
    WHERE f.school_id = $1
    ORDER BY f.display_name`,
  [SCHOOL_ID, FROM_STAGE],
);
console.log(`Found ${stuck.length} stuck famil${stuck.length === 1 ? 'y' : 'ies'} to advance.\n`);

const summary = {
  families: 0,
  tag_writes: 0,
  opps_moved: 0,
  opps_already_in_target: 0,
  errors: [],
};

for (const f of stuck) {
  console.log(`— ${f.display_name} (contact ${f.contact_id})`);

  // Look up target stage id per pipeline.
  const { rows: opps } = await pool.query(
    `SELECT id, pipeline_id, stage_id FROM ghl_opportunities
      WHERE school_id = $1 AND ghl_contact_id = $2
        AND stage_name = $3 AND status = 'open'`,
    [SCHOOL_ID, f.contact_id, FROM_STAGE],
  );
  console.log(`   ${opps.length} opp(s) in ${FROM_STAGE}`);

  // Resolve target stage id per pipeline.
  const targetByPipeline = new Map();
  for (const o of opps) {
    if (targetByPipeline.has(o.pipeline_id)) continue;
    const { rows: t } = await pool.query(
      `SELECT DISTINCT stage_id FROM ghl_opportunities
        WHERE school_id = $1 AND pipeline_id = $2 AND stage_name = $3 LIMIT 1`,
      [SCHOOL_ID, o.pipeline_id, TO_STAGE],
    );
    if (t.length === 0) {
      summary.errors.push(`${f.display_name}: no "${TO_STAGE}" stage in pipeline ${o.pipeline_id}`);
      continue;
    }
    targetByPipeline.set(o.pipeline_id, t[0].stage_id);
  }

  // Get every active parent's contact for the tag.
  const { rows: parents } = await pool.query(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'
        AND ghl_contact_id IS NOT NULL`,
    [SCHOOL_ID, f.family_id],
  );

  if (!apply) {
    console.log(`   would tag ${parents.length} parent(s) with "${ENROLLMENT_TAG}"`);
    for (const o of opps) {
      const target = targetByPipeline.get(o.pipeline_id);
      if (!target) { console.log(`   would SKIP opp ${o.id} (no target stage)`); continue; }
      if (target === o.stage_id) { console.log(`   would SKIP opp ${o.id} (already in target)`); continue; }
      console.log(`   would MOVE opp ${o.id} → ${TO_STAGE} (stage ${target})`);
    }
    continue;
  }

  // Apply: tag parents.
  for (const p of parents) {
    try {
      await client.post(`/contacts/${p.ghl_contact_id}/tags`, { tags: [ENROLLMENT_TAG] });
      summary.tag_writes++;
    } catch (err) {
      summary.errors.push(`${f.display_name} tag ${p.ghl_contact_id}: ${err.response?.status ?? ''} ${err.message}`);
    }
  }

  // Apply: move opps.
  for (const o of opps) {
    const target = targetByPipeline.get(o.pipeline_id);
    if (!target) continue;
    if (target === o.stage_id) { summary.opps_already_in_target++; continue; }
    try {
      await client.put(`/opportunities/${o.id}`, {
        pipelineId: o.pipeline_id,
        pipelineStageId: target,
      });
      summary.opps_moved++;
    } catch (err) {
      summary.errors.push(`${f.display_name} move opp ${o.id}: ${err.response?.status ?? ''} ${err.message}`);
    }
  }
  summary.families++;
}

console.log('\n=== summary ===');
console.log(summary);
if (!apply) console.log('\nDry run — pass --apply to actually write.');

await pool.end();
