// /forms-v2 — list of available forms for the parent's school, with
// per-student completion status.
//
// Each row shows: title, category, brief description, and a
// per-student completion indicator. Click → /forms-v2/{slug}.

import Link from 'next/link';
import { CheckCircle2, Circle, FileText, History, Clock } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { loadStudentsForFamily } from '@/lib/family-data';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface DefRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  required_for: string | null;
  fee_amount: string | null;
  one_submission_per_year: boolean;
  resubmission_allowed: boolean;
  needs_review: boolean;
}

interface SubRow {
  form_definition_id: string;
  student_id: string | null;
  status: string;
  submitted_at: string;
  is_legacy: boolean;
}

interface FlagCountRow {
  form_definition_id: string | null;
  flag_count: string;
}

const CURRENT_YEAR = '2025-26';

const CATEGORY_LABEL: Record<string, string> = {
  permission: 'Permission',
  trip: 'Field Trip',
  medical: 'Medical',
  registration: 'Registration',
  release: 'Release',
  legal: 'Legal',
};

const CATEGORY_ORDER = ['registration', 'medical', 'permission', 'release', 'legal', 'trip'];

type SearchParams = Promise<{ submitted?: string }>;

export default async function FormsV2ListPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const { submitted } = await searchParams;

  const [defs, students, subs, flagCounts] = await Promise.all([
    query<DefRow>(
      `SELECT id, slug, display_name, description, category, per_student,
              required_for, fee_amount, one_submission_per_year,
              resubmission_allowed, needs_review
       FROM portal_form_definitions
       WHERE school_id = $1 AND is_active = true
       ORDER BY
         CASE category
           WHEN 'registration' THEN 1
           WHEN 'medical' THEN 2
           WHEN 'permission' THEN 3
           WHEN 'release' THEN 4
           WHEN 'legal' THEN 5
           WHEN 'trip' THEN 6
           ELSE 9
         END,
         display_name`,
      [id.parent.school_id],
    ).then((r) => r.rows),
    loadStudentsForFamily(id.parent.family_id),
    // Include legacy_imported as "submitted" for completion-tracking purposes.
    // Drop the year filter so legacy submissions (whatever year they were
    // stamped with) still count.
    query<SubRow>(
      `SELECT form_definition_id, student_id, status, submitted_at,
              (legacy_source IS NOT NULL) AS is_legacy
       FROM portal_form_submissions
       WHERE family_id = $1
         AND status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')`,
      [id.parent.family_id],
    ).then((r) => r.rows),
    // Per-form flag counts so the list can show ⚠ badges.
    query<FlagCountRow>(
      `SELECT form_definition_id, COUNT(*)::text AS flag_count
       FROM portal_migration_flags
       WHERE school_id = $1 AND family_id = $2 AND status = 'pending'
       GROUP BY form_definition_id`,
      [id.parent.school_id, id.parent.family_id],
    ).then((r) => r.rows),
  ]);

  const flagCountByDefId = new Map<string, number>();
  let crossFormFlagCount = 0;
  for (const fc of flagCounts) {
    if (fc.form_definition_id) {
      flagCountByDefId.set(fc.form_definition_id, Number(fc.flag_count));
    } else {
      crossFormFlagCount += Number(fc.flag_count);
    }
  }
  const totalFlagCount = flagCounts.reduce((acc, fc) => acc + Number(fc.flag_count), 0);

  // Group submissions by form for fast lookup.
  const submittedByForm = new Map<string, Set<string>>(); // formId → studentIds (or empty set for per-family done)
  const familyDone = new Set<string>();
  for (const s of subs) {
    if (s.student_id) {
      const ex = submittedByForm.get(s.form_definition_id) ?? new Set();
      ex.add(s.student_id);
      submittedByForm.set(s.form_definition_id, ex);
    } else {
      familyDone.add(s.form_definition_id);
    }
  }

  // Form done = all students covered (per-student) OR family submission exists
  function isFormComplete(def: DefRow): boolean {
    if (def.per_student) {
      if (students.length === 0) return false;
      const set = submittedByForm.get(def.id);
      if (!set) return false;
      return students.every((s) => set.has(s.id));
    }
    return familyDone.has(def.id);
  }

  function studentsDone(def: DefRow): string[] {
    if (!def.per_student) return [];
    const set = submittedByForm.get(def.id);
    if (!set) return [];
    return students.filter((s) => set.has(s.id)).map((s) => s.preferred_name || s.first_name);
  }

  // Group by category for the layout
  const byCategory = new Map<string, DefRow[]>();
  for (const def of defs) {
    const cat = def.category ?? 'other';
    const ex = byCategory.get(cat) ?? [];
    ex.push(def);
    byCategory.set(cat, ex);
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];

  const total = defs.length;
  const complete = defs.filter((d) => isFormComplete(d)).length;
  const pct = total ? Math.round((complete / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Forms</h1>
          <p className="mt-1 text-sm text-gray-600">
            {total === 0
              ? 'No forms configured by your school yet.'
              : `${complete} of ${total} complete (${pct}%) for the ${CURRENT_YEAR} year.`}
          </p>
        </div>
        <Link
          href="/forms-v2/history"
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          <History className="h-3.5 w-3.5" /> Submission history
        </Link>
      </header>

      {submitted ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Submitted! You can review the entry on your history page.
        </div>
      ) : null}

      {totalFlagCount > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-start gap-2">
            <span className="text-lg leading-none">⚠️</span>
            <div className="flex-1 text-sm">
              <div className="font-semibold text-amber-900">
                {totalFlagCount} {totalFlagCount === 1 ? 'item' : 'items'} need your attention
              </div>
              <div className="text-xs text-amber-800 mt-0.5">
                We moved your account from the old form system. Some of your previous answers may need
                review or per-student confirmation. Look for the ⚠ badges below to find what needs your input.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {total > 0 ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: 'var(--brand)' }}
          />
        </div>
      ) : null}

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h2 className="text-base font-semibold text-gray-900">No forms yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Your school hasn&apos;t added any forms to fill out yet. Check back later.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {orderedCategories.map((cat) => (
            <section key={cat} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {CATEGORY_LABEL[cat] ?? cat}
              </h2>
              <ul className="space-y-2">
                {(byCategory.get(cat) ?? []).map((def) => (
                  <FormRow
                    key={def.id}
                    def={def}
                    complete={isFormComplete(def)}
                    studentsDone={studentsDone(def)}
                    totalStudents={students.length}
                    flagCount={flagCountByDefId.get(def.id) ?? 0}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function FormRow({
  def, complete, studentsDone, totalStudents, flagCount,
}: {
  def: DefRow;
  complete: boolean;
  studentsDone: string[];
  totalStudents: number;
  flagCount: number;
}) {
  return (
    <li>
      <Link
        href={`/forms-v2/${def.slug}`}
        className={`flex items-start gap-3 rounded-lg border px-4 py-3 transition ${
          complete ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
        }`}
      >
        <div className="mt-0.5">
          {complete ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <Circle className="h-5 w-5 text-gray-300" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{def.display_name}</h3>
            <div className="flex items-center gap-2">
              {def.fee_amount && Number(def.fee_amount) > 0 ? (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800">
                  ${Number(def.fee_amount).toFixed(2)} fee
                </span>
              ) : null}
              {def.needs_review ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                  Draft
                </span>
              ) : null}
              {complete ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
                  Complete
                </span>
              ) : def.per_student && studentsDone.length > 0 ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                  {studentsDone.length}/{totalStudents} done
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-700">
                  <Clock className="inline h-3 w-3 mr-0.5" /> Pending
                </span>
              )}
              {flagCount > 0 ? (
                <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900" title={`${flagCount} item(s) to review`}>
                  ⚠ {flagCount}
                </span>
              ) : null}
            </div>
          </div>
          {def.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-gray-600">{def.description}</p>
          ) : null}
          {def.per_student && studentsDone.length > 0 && !complete ? (
            <p className="mt-1 text-[11px] text-emerald-700">Done for: {studentsDone.join(', ')}</p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
