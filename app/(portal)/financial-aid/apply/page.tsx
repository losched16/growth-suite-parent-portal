// /financial-aid/apply?year=YYYY-YY&step=N — 7-step wizard.
//
// Each step is its own URL so back/forward + bookmarking work and a
// parent can resume where they left off. The wizard host loads the
// existing application's `responses` jsonb + `wizard_step` so a
// returning parent always lands on the latest unfinished step.
//
// Honors school FA settings (gated in step 1 of validation in
// /api/financial-aid/submit too).

import { redirect, notFound } from 'next/navigation';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { getFinancialAidSettings } from '@/lib/financial-aid/settings';
import { getSection, TOTAL_STEPS, WIZARD_SECTIONS } from '@/lib/financial-aid/wizard-schema';
import { WizardHost } from './_WizardHost';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ year?: string; step?: string; err?: string; saved?: string }>;

interface ApplicationRow {
  id: string;
  household_size: number | null;
  total_annual_income: string | null;
  assets_value: string | null;
  special_circumstances: string | null;
  parent_notes: string | null;
  status: string;
  responses: Record<string, unknown>;
  wizard_step: number;
}

interface StudentRow {
  id: string; first_name: string; last_name: string; preferred_name: string | null;
}

interface ChildRow {
  student_id: string; current_tuition: string | null; requested_aid: string | null;
}

interface RequiredDocsRow {
  document_type: string;
  count: number;
}

export default async function ApplyPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;

  const settings = await getFinancialAidSettings(id.parent.school_id);
  if (!settings.is_enabled) redirect('/home');
  const year = sp.year ?? settings.active_academic_year;

  // Active students for the per-student section
  const { rows: students } = await query<StudentRow>(
    `SELECT id, first_name, last_name, preferred_name FROM students
      WHERE family_id = $1 AND status = 'active' ORDER BY first_name`,
    [id.parent.family_id],
  );
  if (students.length === 0) redirect('/financial-aid');

  // Load existing application (or null)
  const { rows: existing } = await query<ApplicationRow>(
    `SELECT id, household_size, total_annual_income::text, assets_value::text,
            special_circumstances, parent_notes, status, responses, wizard_step
       FROM fa_applications
      WHERE school_id = $1 AND family_id = $2 AND academic_year = $3`,
    [id.parent.school_id, id.parent.family_id, year],
  );
  const app = existing[0] ?? null;

  // Per-student rows (for step 2)
  let childRows: ChildRow[] = [];
  if (app) {
    const { rows: r } = await query<ChildRow>(
      `SELECT student_id, current_tuition::text, requested_aid::text
         FROM fa_application_students WHERE application_id = $1`,
      [app.id],
    );
    childRows = r;
  }

  // Already-uploaded document counts by type — drives the step 7
  // doc checklist UI.
  let docCounts: Record<string, number> = {};
  if (app) {
    const { rows: dc } = await query<RequiredDocsRow>(
      `SELECT document_type, COUNT(*)::int AS count
         FROM fa_application_files
        WHERE application_id = $1
        GROUP BY document_type`,
      [app.id],
    );
    for (const r of dc) docCounts[r.document_type] = r.count;
  }

  // Prior-year app — used for "start from last year" prefill button.
  const { rows: priorRows } = await query<{ responses: Record<string, unknown>; academic_year: string }>(
    `SELECT responses, academic_year FROM fa_applications
      WHERE school_id = $1 AND family_id = $2 AND academic_year < $3 AND status IN ('decided','submitted','under_review','declined')
      ORDER BY academic_year DESC LIMIT 1`,
    [id.parent.school_id, id.parent.family_id, year],
  );
  const priorYear = priorRows[0] ?? null;

  // Resolve step: URL ?step= wins, otherwise resume from saved
  // wizard_step (clamped to 1..TOTAL_STEPS).
  const stepRaw = sp.step ? Number(sp.step) : (app?.wizard_step ?? 1);
  const step = Math.min(Math.max(1, Number.isFinite(stepRaw) ? Math.floor(stepRaw) : 1), TOTAL_STEPS);
  const section = getSection(step);
  if (!section) notFound();

  const finalDecision = app?.status === 'decided' || app?.status === 'withdrawn';
  const deadlinePassed = !!settings.application_deadline
    && new Date(settings.application_deadline) < new Date(new Date().toISOString().slice(0, 10));
  const submissionsClosed = !settings.application_open || deadlinePassed;
  // Editing existing app is still allowed for status='under_review' etc.
  const locked = finalDecision || (submissionsClosed && !app);

  return (
    <WizardHost
      year={year}
      step={step}
      totalSteps={TOTAL_STEPS}
      section={section}
      sections={WIZARD_SECTIONS}
      students={students}
      childRows={childRows}
      responses={app?.responses ?? {}}
      requiredDocs={settings.required_document_types}
      docCounts={docCounts}
      hasExistingApplication={!!app}
      priorYearResponses={priorYear?.responses ?? null}
      priorYear={priorYear?.academic_year ?? null}
      locked={locked}
      finalDecision={finalDecision}
      err={sp.err ?? null}
      savedToast={sp.saved === '1'}
      currentStatus={app?.status ?? 'draft'}
    />
  );
}
