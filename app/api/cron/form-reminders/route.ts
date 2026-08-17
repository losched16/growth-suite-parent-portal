// GET /api/cron/form-reminders — automated form-completion reminders.
//
// Vercel Cron hits this every hour. For each school with reminders
// enabled, sends only when the school's LOCAL hour matches its
// configured send hour, so one hourly cron serves every timezone.
// See lib/forms/reminders.ts for the cadence + email.
//
// Query params (operator/testing only — still require the cron secret):
//   ?dry=1                 compute + count, send nothing, log nothing
//   ?force=1               ignore the send-hour gate
//   ?school=<uuid>         limit to one school
//   ?family=<uuid>         limit to one family (with ?school)
//
// Auth: fail-closed on CRON_SECRET (same policy as process-autopay).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadReminderSchools, runRemindersForSchool } from '@/lib/forms/reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !secret) {
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 401 });
  }
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const sp = request.nextUrl.searchParams;
  const dryRun = sp.get('dry') === '1';
  const force = sp.get('force') === '1';
  const onlySchool = sp.get('school');
  const onlyFamily = sp.get('family');

  const startedAt = Date.now();
  const schools = (await loadReminderSchools()).filter((s) => !onlySchool || s.school_id === onlySchool);
  const results = [];
  for (const cfg of schools) {
    try {
      results.push(await runRemindersForSchool(cfg, { dryRun, force, onlyFamilyId: onlyFamily }));
    } catch (e) {
      results.push({
        school_id: cfg.school_id, school_name: cfg.school_name, ran: false,
        reason: `crashed: ${e instanceof Error ? e.message : String(e)}`,
        families_scanned: 0, families_owing: 0, families_due: 0,
        emails_sent: 0, emails_failed: 0, errors: [],
      });
    }
  }
  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    duration_ms: Date.now() - startedAt,
    schools_enabled: schools.length,
    results,
  });
}
