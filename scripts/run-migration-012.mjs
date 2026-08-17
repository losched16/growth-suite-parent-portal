import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const sqlPath = join(projectRoot, 'migrations', '012_advance_on_completion.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const sql = readFileSync(sqlPath, 'utf8');
console.log('Running migration 012_advance_on_completion.sql...');
await pool.query(sql);
console.log('Migration complete.');

const cols = await pool.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='school_branding'
      AND column_name IN ('enrollment_tag','pipeline_move_from_stage','pipeline_move_to_stage')
    ORDER BY column_name`,
);
console.log('New columns:', cols.rows.map((r) => r.column_name).join(', '));

// Configure Wooster
const wooster = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const r = await pool.query(
  `UPDATE school_branding
      SET enrollment_tag = 'enrolled - 26/27',
          pipeline_move_from_stage = 'Documents Requested',
          pipeline_move_to_stage = 'Enrolled'
    WHERE school_id = $1
   RETURNING completion_tag, enrollment_tag, pipeline_move_from_stage, pipeline_move_to_stage`,
  [wooster],
);
console.log('\nWooster branding row now:');
console.log(r.rows[0]);

await pool.end();
