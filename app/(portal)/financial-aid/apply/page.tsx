// /financial-aid/apply?year=YYYY-YY — one application per family per
// year. Lists all the family's active students; parent checks which
// ones attend this school and provides per-student tuition + requested
// aid. Household-level financials (income, assets, narrative) are
// captured once at the top.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ year?: string; err?: string }>;

interface StudentRow {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  metadata: Record<string, unknown> | null;
}

interface ExistingChild {
  student_id: string;
  current_tuition: string | null;
  requested_aid: string | null;
}

interface ExistingApp {
  id: string;
  household_size: number | null;
  total_annual_income: string | null;
  assets_value: string | null;
  special_circumstances: string | null;
  parent_notes: string | null;
  status: string;
}

export default async function ApplyPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;
  const year = sp.year ?? '2025-26';

  const { rows: students } = await query<StudentRow>(
    `SELECT id, first_name, last_name, preferred_name, metadata
     FROM students
     WHERE family_id = $1 AND status = 'active'
     ORDER BY first_name`,
    [id.parent.family_id],
  );
  if (students.length === 0) {
    redirect('/financial-aid');
  }

  // Pre-fill if an application + per-student rows already exist
  const { rows: existing } = await query<ExistingApp>(
    `SELECT id, household_size, total_annual_income, assets_value,
            special_circumstances, parent_notes, status
     FROM fa_applications
     WHERE school_id = $1 AND family_id = $2 AND academic_year = $3`,
    [id.parent.school_id, id.parent.family_id, year],
  );
  const existingApp = existing[0] ?? null;
  const existingChildren = new Map<string, ExistingChild>();
  if (existingApp) {
    const { rows } = await query<ExistingChild>(
      `SELECT student_id, current_tuition, requested_aid
       FROM fa_application_students WHERE application_id = $1`,
      [existingApp.id],
    );
    for (const r of rows) existingChildren.set(r.student_id, r);
  }

  // Lock down if decision is already final
  const locked = existingApp?.status === 'decided' || existingApp?.status === 'withdrawn';

  return (
    <div className="space-y-4">
      <Link href="/financial-aid" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-3 w-3" /> Back to Financial Aid
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Financial Aid Application</h1>
        <p className="mt-1 text-sm text-gray-600">
          One application per family per school year.
          Check each student attending the school for {year}, and provide per-student tuition + the aid amount you&apos;re requesting.
        </p>
      </header>

      {locked ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This application has already been {existingApp?.status} for the {year} school year and is locked.
          Contact the school if you need to make changes.
        </div>
      ) : null}

      {sp.err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
      ) : null}

      <form
        action="/api/financial-aid/submit"
        method="POST"
        encType="multipart/form-data"
        className="space-y-5"
      >
        <input type="hidden" name="academic_year" value={year} />

        {/* Household */}
        <Section title="Household" subtitle="Tell us about your family.">
          <Field label="Household size" hint="Number of people living in the home (including all students).">
            <input
              type="number"
              name="household_size"
              min={1}
              max={20}
              required
              defaultValue={existingApp?.household_size ?? ''}
              disabled={locked}
              className={inputCls}
              placeholder="e.g. 4"
            />
          </Field>
        </Section>

        {/* Financials */}
        <Section title="Financial picture" subtitle="Your best estimate is fine — supporting docs can clarify later.">
          <Field label="Total annual household income ($)" hint="All sources before tax: salary, self-employment, investment, government benefits.">
            <input
              type="number"
              name="total_annual_income"
              min={0}
              required
              step="0.01"
              defaultValue={existingApp?.total_annual_income ?? ''}
              disabled={locked}
              className={inputCls}
              placeholder="e.g. 95000"
            />
          </Field>
          <Field label="Total household assets ($)" hint="Savings, investments, home equity, other major assets. Approximate is fine.">
            <input
              type="number"
              name="assets_value"
              min={0}
              required
              step="0.01"
              defaultValue={existingApp?.assets_value ?? ''}
              disabled={locked}
              className={inputCls}
              placeholder="e.g. 50000"
            />
          </Field>
        </Section>

        {/* Students at this school */}
        <Section
          title="Students attending this school"
          subtitle="Check each student attending in this school year and enter their tuition + the aid you'd like to request for them."
        >
          <div className="space-y-3">
            {students.map((s) => {
              const childRow = existingChildren.get(s.id);
              const checked = !!childRow;
              return <StudentLine key={s.id} student={s} childRow={childRow} defaultChecked={checked} locked={locked} />;
            })}
          </div>
          <p className="text-[11px] text-gray-500">
            Only check students currently attending or applying for this school year. Aid amounts are
            per-student; you can request a different amount for each child.
          </p>
        </Section>

        {/* Narrative */}
        <Section title="Tell us your story" subtitle="Anything you'd like the school to know about your situation.">
          <Field label="Special circumstances (optional)" hint="Medical bills, job loss, divorce, multiple children in tuition-charging schools, etc.">
            <textarea
              name="special_circumstances"
              rows={4}
              defaultValue={existingApp?.special_circumstances ?? ''}
              disabled={locked}
              className={inputCls}
              placeholder="Optional narrative — anything that helps us understand your situation."
            />
          </Field>
          <Field label="Additional notes (optional)">
            <textarea
              name="parent_notes"
              rows={2}
              defaultValue={existingApp?.parent_notes ?? ''}
              disabled={locked}
              className={inputCls}
              placeholder="Any other context, questions, or requests."
            />
          </Field>
        </Section>

        {/* Documents */}
        <Section title="Supporting documents" subtitle="Optional now — you can upload more after submitting if needed.">
          <Field label="Tax return / W-2 / pay stubs" hint="PDF, JPG, or PNG. Up to 10 MB per file. Hold ⌘ / Ctrl to pick multiple.">
            <input
              type="file"
              name="files"
              multiple
              accept=".pdf,.jpg,.jpeg,.png"
              disabled={locked}
              className="block w-full text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-gray-200"
            />
          </Field>
        </Section>

        {!locked ? (
          <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
            <button
              type="submit"
              className="rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              style={{ background: 'var(--brand)' }}
            >
              {existingApp ? 'Update application' : 'Submit application'}
            </button>
            <Link href="/financial-aid" className="text-xs text-gray-500 hover:text-gray-700">
              Cancel
            </Link>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function StudentLine({
  student: s,
  childRow,
  defaultChecked,
  locked,
}: {
  student: StudentRow;
  childRow: ExistingChild | undefined;
  defaultChecked: boolean;
  locked: boolean;
}) {
  const fullName = `${s.first_name} ${s.last_name}`.trim();
  const grade = (s.metadata?.['grade_level'] as string | undefined) ?? '';
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 space-y-2">
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          name={`include_${s.id}`}
          value="1"
          defaultChecked={defaultChecked}
          disabled={locked}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span className="font-medium text-gray-900">{fullName}</span>
        {grade ? <span className="text-xs text-gray-500">· {grade}</span> : null}
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-6">
        <Field label="This student's annual tuition ($)">
          <input
            type="number"
            name={`tuition_${s.id}`}
            min={0}
            step="0.01"
            defaultValue={childRow?.current_tuition ?? ''}
            disabled={locked}
            className={inputCls}
            placeholder="e.g. 15835"
          />
        </Field>
        <Field label="Aid you're requesting for this student ($)">
          <input
            type="number"
            name={`requested_${s.id}`}
            min={0}
            step="0.01"
            defaultValue={childRow?.requested_aid ?? ''}
            disabled={locked}
            className={inputCls}
            placeholder="e.g. 6000"
          />
        </Field>
      </div>
    </div>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200 disabled:bg-gray-50 disabled:text-gray-500';

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold text-gray-900">{title}</legend>
      {subtitle ? <p className="text-xs text-gray-500 -mt-2">{subtitle}</p> : null}
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">{label}</span>
      {hint ? <span className="block text-[11px] text-gray-500 mt-0.5">{hint}</span> : null}
      {children}
    </label>
  );
}
