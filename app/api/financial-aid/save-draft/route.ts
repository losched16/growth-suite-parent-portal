// POST /api/financial-aid/save-draft
//
// Upserts a draft fa_applications row for the parent's family + the
// given academic_year. Body (JSON):
//   academic_year       string (YYYY-YY)
//   step                number (1..7)
//   responses           full responses object (we store as-is to JSONB)
//   students            { [student_id]: { include, tuition, ask } }
//   advance             bool — set wizard_step to step+1 if true
//   submit_now          bool — flip status to 'submitted' + set submitted_at
//
// Auth: parent session. Force-scoped to the parent's family + school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query, withTransaction } from '@/lib/db';
import { getFinancialAidSettings } from '@/lib/financial-aid/settings';

export const dynamic = 'force-dynamic';

interface Body {
  academic_year?: string;
  step?: number;
  responses?: Record<string, unknown>;
  students?: Record<string, { include?: boolean; tuition?: string | null; ask?: string | null }>;
  advance?: boolean;
  submit_now?: boolean;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body) return NextResponse.json({ error: 'bad_body' }, { status: 400 });

  const settings = await getFinancialAidSettings(session.school_id);
  if (!settings.is_enabled) {
    return NextResponse.json({ error: 'not_enabled' }, { status: 403 });
  }

  // For submit, also gate on application_open + deadline.
  if (body.submit_now) {
    const deadlinePassed = !!settings.application_deadline
      && new Date(settings.application_deadline) < new Date(new Date().toISOString().slice(0, 10));
    if (!settings.application_open || deadlinePassed) {
      return NextResponse.json({ error: 'closed', detail: 'Applications are not currently open. Drafts can still be saved.' }, { status: 403 });
    }
  }

  const year = (body.academic_year && /^\d{4}-\d{2}$/.test(body.academic_year))
    ? body.academic_year
    : settings.active_academic_year;
  const step = Math.min(Math.max(1, Math.floor(Number(body.step ?? 1))), 7);
  const responses = body.responses && typeof body.responses === 'object' ? body.responses : {};

  // Validate student ids belong to the family
  const { rows: studentRows } = await query<{ id: string }>(
    `SELECT id FROM students WHERE family_id = $1 AND status = 'active'`,
    [session.family_id],
  );
  const validIds = new Set(studentRows.map((s) => s.id));

  // Build per-student input list
  const studentInputs: Array<{ id: string; tuition: number | null; ask: number | null }> = [];
  for (const id of validIds) {
    const sv = body.students?.[id];
    if (!sv?.include) continue;
    studentInputs.push({
      id,
      tuition: sv.tuition && !isNaN(Number(sv.tuition)) ? Number(sv.tuition) : null,
      ask:     sv.ask     && !isNaN(Number(sv.ask))     ? Number(sv.ask)     : null,
    });
  }

  // On submit, require at least one student. On save-draft, allow zero.
  if (body.submit_now && studentInputs.length === 0) {
    return NextResponse.json({ error: 'no_students', detail: 'Please mark at least one student attending the school in step 2.' }, { status: 400 });
  }

  // Family totals computed from per-student inputs (kept for backwards
  // compat with the admin queue widget).
  const totalTuition  = studentInputs.reduce((s, x) => s + (x.tuition ?? 0), 0);
  const totalRequested = studentInputs.reduce((s, x) => s + (x.ask ?? 0), 0);

  // Pull legacy flat fields out of responses so the admin queue's
  // SQL filters keep working (filter by household_size, income, etc.).
  const flat = extractLegacyFlatFields(responses);

  // Compute final wizard_step: step+1 if advancing, otherwise the
  // greater of step and the existing wizard_step (don't rewind).
  const nextWizardStep = body.advance ? Math.min(step + 1, 7) : step;
  const nowSubmit = !!body.submit_now;

  const applicationId = await withTransaction(async (q) => {
    const { rows: app } = await q<{ id: string }>(
      `INSERT INTO fa_applications (
         school_id, family_id, academic_year,
         household_size, total_annual_income, assets_value,
         current_tuition_owed, requested_aid,
         special_circumstances, parent_notes,
         status, submitted_at,
         responses, wizard_step, last_saved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13::jsonb, $14, now())
       ON CONFLICT (school_id, family_id, academic_year) DO UPDATE
         SET household_size = COALESCE(EXCLUDED.household_size, fa_applications.household_size),
             total_annual_income = COALESCE(EXCLUDED.total_annual_income, fa_applications.total_annual_income),
             assets_value = COALESCE(EXCLUDED.assets_value, fa_applications.assets_value),
             current_tuition_owed = EXCLUDED.current_tuition_owed,
             requested_aid = EXCLUDED.requested_aid,
             special_circumstances = COALESCE(EXCLUDED.special_circumstances, fa_applications.special_circumstances),
             parent_notes = COALESCE(EXCLUDED.parent_notes, fa_applications.parent_notes),
             status = CASE
               WHEN fa_applications.status IN ('decided','withdrawn') THEN fa_applications.status
               WHEN $11 = 'submitted' THEN 'submitted'
               ELSE fa_applications.status
             END,
             submitted_at = CASE
               WHEN $11 = 'submitted' AND fa_applications.submitted_at IS NULL THEN now()
               ELSE fa_applications.submitted_at
             END,
             responses = EXCLUDED.responses,
             wizard_step = GREATEST(fa_applications.wizard_step, EXCLUDED.wizard_step),
             last_saved_at = now()
       RETURNING id`,
      [
        session.school_id, session.family_id, year,
        flat.household_size, flat.total_annual_income, flat.assets_value,
        totalTuition || null, totalRequested || null,
        flat.special_circumstances, flat.parent_notes,
        nowSubmit ? 'submitted' : 'draft',
        nowSubmit ? new Date().toISOString() : null,
        JSON.stringify(responses), nextWizardStep,
      ],
    );
    const appId = app[0].id;

    // Replace per-student child rows (preserve recommended_award).
    const { rows: existing } = await q<{ student_id: string; recommended_award: string | null; award_note: string | null }>(
      `SELECT student_id, recommended_award, award_note FROM fa_application_students WHERE application_id = $1`,
      [appId],
    );
    const awardMap = new Map(existing.map((r) => [r.student_id, { rec: r.recommended_award, note: r.award_note }]));
    await q(`DELETE FROM fa_application_students WHERE application_id = $1`, [appId]);
    for (const s of studentInputs) {
      const prior = awardMap.get(s.id);
      await q(
        `INSERT INTO fa_application_students
           (application_id, student_id, current_tuition, requested_aid, recommended_award, award_note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [appId, s.id, s.tuition, s.ask, prior?.rec ?? null, prior?.note ?? null],
      );
    }

    return appId;
  });

  // Admin notify email on submit
  if (nowSubmit && settings.admin_notify_emails.length > 0) {
    import('@/lib/email').then(({ sendBrandedEmail }) => {
      const subject = `New financial aid application · ${year}`;
      const html = `<p>A family just submitted a financial aid application for the ${year} school year.</p>
<p>Review it in the Financial Aid queue (admin dashboards).</p>
<p>Application ID: <code>${applicationId}</code><br/>Total requested aid: $${totalRequested.toLocaleString()}<br/>Students included: ${studentInputs.length}</p>`;
      const text = `New financial aid application for ${year}.\n\nID: ${applicationId}\nTotal requested: $${totalRequested.toLocaleString()}\nStudents: ${studentInputs.length}`;
      return Promise.allSettled(settings.admin_notify_emails.map((to) =>
        sendBrandedEmail({ to, schoolId: session.school_id, subject, html, text }),
      ));
    }).catch((e) => console.error('[fa/save-draft] notify failed:', e));
  }

  return NextResponse.json({ ok: true, application_id: applicationId, submitted: nowSubmit });
}

// Pull legacy flat fields out of the responses object so the admin
// queue keeps working without a schema migration.
function extractLegacyFlatFields(responses: Record<string, unknown>) {
  const household = (responses.household as Record<string, unknown>) ?? {};
  const income    = (responses.income as Record<string, unknown>) ?? {};
  const assets    = (responses.assets as Record<string, unknown>) ?? {};
  const finalSec  = (responses.final as Record<string, unknown>) ?? {};

  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sumIncome = ['w2_adult_1','w2_adult_2','self_employed_income','dividend_interest_income','capital_gains','rental_income','support_received','other_income']
    .map((k) => num(income[k])).filter((n): n is number => n !== null);
  const sumAssets = ['checking_savings','investments','retirement','cd_money_market','business_equity','other_assets']
    .map((k) => num(assets[k])).filter((n): n is number => n !== null);

  return {
    household_size: num(household.household_size),
    total_annual_income: sumIncome.length > 0 ? sumIncome.reduce((s, n) => s + n, 0) : null,
    assets_value: sumAssets.length > 0 ? sumAssets.reduce((s, n) => s + n, 0) : null,
    special_circumstances: (finalSec.special_circumstances as string) ?? null,
    parent_notes: (finalSec.parent_notes_final as string) ?? null,
  };
}
