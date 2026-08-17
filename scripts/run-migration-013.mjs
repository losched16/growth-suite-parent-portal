import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '..', 'migrations', '013_form_reminders.sql');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log('Running migration 013_form_reminders.sql...');
await pool.query(readFileSync(sqlPath, 'utf8'));
console.log('Migration complete.');

// Wooster: every 7 days, max 6, 9am Eastern, honor legacy GHL completions.
const wooster = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const r = await pool.query(
  `UPDATE school_branding
      SET reminders_enabled = true,
          reminder_interval_days = 7,
          reminder_max_count = 6,
          reminder_send_hour_local = 9,
          reminder_timezone = 'America/New_York',
          reminder_honor_ghl_completion = true
    WHERE school_id = $1
   RETURNING reminders_enabled, reminder_interval_days, reminder_max_count,
             reminder_send_hour_local, reminder_timezone, reminder_honor_ghl_completion,
             email_provider, support_email`,
  [wooster],
);
console.log('\nWooster reminder config:');
console.log(r.rows[0]);
await pool.end();
