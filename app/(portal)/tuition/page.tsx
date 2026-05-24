// /tuition — parent picks a payment plan + add-ons for each student
// the school has set up. Tuition amounts come from
// `family_tuition_enrollments` (created by school admin via FACTS CSV
// import or manual entry — never by the parent directly).
//
// Three states per student:
//   1. No enrollment row yet → "Your school is still setting up your
//      tuition" placeholder.
//   2. Enrollment row exists, parent hasn't picked a plan → plan picker
//      + add-on toggles + "First payment date" callout.
//   3. Plan picked → schedule + payment-method-on-file status.

import Link from 'next/link';
import { CreditCard, Calendar, CheckCircle2, AlertCircle } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { TuitionPlanPicker } from './TuitionPlanPicker';

export const dynamic = 'force-dynamic';

const ACADEMIC_YEAR = '2026-27';

interface EnrollmentRow {
  id: string;
  student_id: string;
  student_first_name: string;
  student_preferred_name: string | null;
  student_last_name: string;
  student_grade_level: string | null;
  tuition_grid_id: string | null;
  grid_display_name: string | null;
  payment_plan_id: string | null;
  plan_display_name: string | null;
  plan_installment_count: number | null;
  annual_tuition_cents: number;
  addons: Array<{ key: string; label: string; amount_cents: number; selected?: boolean }>;
  total_annual_cents: number;
  installment_count: number;
  schedule: { kind?: string; months?: string[]; first_payment_at?: string } | null;
  status: string;
  installments_generated_at: string | null;
}

interface PlanOption {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  installment_count: number;
  discount_basis_points: number;
  schedule_template: { kind?: string; months?: string[] };
}

interface SchoolConfigRow {
  late_fee_amount_cents: number;
  late_fee_grace_days: number;
  monthly_plan_admin_fee_bp: number;
  annual_plan_discount_bp: number;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function TuitionPage() {
  const id = await requireParent();

  // Load enrollments for this family + this academic year
  const enrollments = (await query<EnrollmentRow>(
    `SELECT fte.id, fte.student_id,
            s.first_name AS student_first_name,
            s.preferred_name AS student_preferred_name,
            s.last_name AS student_last_name,
            s.metadata->>'grade_level' AS student_grade_level,
            fte.tuition_grid_id, tg.display_name AS grid_display_name,
            fte.payment_plan_id, pp.display_name AS plan_display_name,
            pp.installment_count AS plan_installment_count,
            fte.annual_tuition_cents, fte.addons,
            fte.total_annual_cents, fte.installment_count, fte.schedule,
            fte.status, fte.installments_generated_at
       FROM family_tuition_enrollments fte
       JOIN students s ON s.id = fte.student_id
       LEFT JOIN tuition_grids tg ON tg.id = fte.tuition_grid_id
       LEFT JOIN payment_plans pp ON pp.id = fte.payment_plan_id
      WHERE fte.family_id = $1
        AND fte.school_id = $2
        AND fte.academic_year = $3
      ORDER BY s.date_of_birth NULLS LAST`,
    [id.family.id, id.parent.school_id, ACADEMIC_YEAR],
  )).rows;

  // Load all available payment plans for this school (the picker shows these)
  const planOptions = (await query<PlanOption>(
    `SELECT id, slug, display_name, description, installment_count,
            discount_basis_points, schedule_template
       FROM payment_plans
      WHERE school_id = $1 AND is_active = true
      ORDER BY position ASC, installment_count ASC`,
    [id.parent.school_id],
  )).rows;

  // School payment config (for late fees + plan-level fees display)
  const schoolConfig = (await query<SchoolConfigRow>(
    `SELECT late_fee_amount_cents, late_fee_grace_days, monthly_plan_admin_fee_bp, annual_plan_discount_bp
       FROM school_payment_config WHERE school_id = $1`,
    [id.parent.school_id],
  )).rows[0];

  // Load all students in the family — to surface "your other students
  // don't have tuition set up yet" when only some have enrollments
  const allStudents = (await query<{
    id: string; first_name: string; preferred_name: string | null; last_name: string;
  }>(
    `SELECT id, first_name, preferred_name, last_name
       FROM students
      WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
    [id.family.id, id.parent.school_id],
  )).rows;

  const enrolledStudentIds = new Set(enrollments.map((e) => e.student_id));
  const studentsWithoutEnrollment = allStudents.filter((s) => !enrolledStudentIds.has(s.id));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Tuition &amp; Payments</h1>
        <p className="mt-1 text-sm text-gray-600">
          Your {ACADEMIC_YEAR} tuition for each student. Pick a payment plan, save a payment method,
          and you&rsquo;re set — we&rsquo;ll bill automatically per the schedule.
        </p>
      </header>

      {/* Students who DO have tuition set up */}
      {enrollments.map((e) => (
        <EnrollmentCard
          key={e.id}
          enrollment={e}
          planOptions={planOptions}
          schoolConfig={schoolConfig}
        />
      ))}

      {/* Students who DON'T have tuition set up — friendly placeholder */}
      {studentsWithoutEnrollment.map((s) => (
        <article key={s.id} className="rounded-lg border border-dashed border-gray-300 bg-gray-50/40 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <h3 className="text-base font-semibold text-gray-800">
                {s.preferred_name || s.first_name} {s.last_name}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                Your school hasn&rsquo;t finalized this student&rsquo;s {ACADEMIC_YEAR} tuition yet.
                You&rsquo;ll be notified when it&rsquo;s ready to review.
              </p>
            </div>
          </div>
        </article>
      ))}

      {enrollments.length === 0 && studentsWithoutEnrollment.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gradient-to-br from-emerald-50 to-white p-8 text-center">
          <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
            <CreditCard className="h-6 w-6 text-emerald-700" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">No students on file</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            If this looks wrong, please contact the school office.
          </p>
        </div>
      ) : null}

      <div className="rounded-md border border-blue-200 bg-blue-50/60 p-4 text-xs text-blue-900">
        <p className="font-medium mb-1">A note about your payment plan</p>
        <p>
          Once you pick a plan and save a payment method, we&rsquo;ll automatically charge on each
          scheduled date.{' '}
          {schoolConfig
            ? `Late fee is ${fmtCents(schoolConfig.late_fee_amount_cents)} after a ${schoolConfig.late_fee_grace_days}-day grace period.`
            : ''}
          {' '}Need to change plans later? Email the school office.
        </p>
      </div>
    </div>
  );
}

function EnrollmentCard({
  enrollment, planOptions, schoolConfig,
}: {
  enrollment: EnrollmentRow;
  planOptions: PlanOption[];
  schoolConfig: SchoolConfigRow | undefined;
}) {
  const display = enrollment.student_preferred_name || enrollment.student_first_name;
  const hasPlan = !!enrollment.payment_plan_id;
  const enrolledAddons = Array.isArray(enrollment.addons) ? enrollment.addons : [];
  const selectedAddons = enrolledAddons.filter((a) => a.selected !== false && a.amount_cents > 0);
  const baseTuition = enrollment.annual_tuition_cents;
  const addonTotal = selectedAddons.reduce((sum, a) => sum + a.amount_cents, 0);

  return (
    <article className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <header className="border-b border-gray-100 bg-gray-50 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              {display} {enrollment.student_last_name}
            </h3>
            {enrollment.grid_display_name ? (
              <p className="mt-0.5 text-xs text-gray-600">{enrollment.grid_display_name}</p>
            ) : enrollment.student_grade_level ? (
              <p className="mt-0.5 text-xs text-gray-600">{enrollment.student_grade_level}</p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Annual</div>
            <div className="text-2xl font-semibold text-gray-900 tabular-nums">{fmtCents(enrollment.total_annual_cents)}</div>
          </div>
        </div>
      </header>

      <div className="p-4 space-y-4">
        {/* Tuition breakdown */}
        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between text-gray-700">
            <span>Base tuition</span>
            <span className="tabular-nums">{fmtCents(baseTuition)}</span>
          </div>
          {selectedAddons.map((a) => (
            <div key={a.key} className="flex items-center justify-between text-gray-700">
              <span>+ {a.label}</span>
              <span className="tabular-nums">{fmtCents(a.amount_cents)}</span>
            </div>
          ))}
          <div className="border-t border-gray-200 pt-1 flex items-center justify-between font-semibold text-gray-900">
            <span>Total annual</span>
            <span className="tabular-nums">{fmtCents(baseTuition + addonTotal)}</span>
          </div>
        </div>

        {/* Plan picker OR confirmed plan */}
        {hasPlan ? (
          <ConfirmedPlan enrollment={enrollment} />
        ) : (
          <TuitionPlanPicker
            enrollmentId={enrollment.id}
            planOptions={planOptions}
            availableAddons={enrolledAddons}
            baseTuitionCents={baseTuition}
            schoolConfig={schoolConfig}
          />
        )}
      </div>
    </article>
  );
}

function ConfirmedPlan({ enrollment }: { enrollment: EnrollmentRow }) {
  const monthlyEstimate =
    enrollment.installment_count > 0
      ? Math.round(enrollment.total_annual_cents / enrollment.installment_count)
      : enrollment.total_annual_cents;
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-700 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-emerald-900">
            Plan locked in: {enrollment.plan_display_name}
          </div>
          <div className="mt-1 text-xs text-emerald-800">
            {enrollment.installment_count === 1
              ? `One payment of ${fmtCents(enrollment.total_annual_cents)}.`
              : `${enrollment.installment_count} payments of about ${fmtCents(monthlyEstimate)} each.`}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs">
            <Link
              href="/billing/plan"
              className="inline-flex items-center gap-1 text-emerald-800 underline hover:text-emerald-900"
            >
              <Calendar className="h-3 w-3" /> View schedule
            </Link>
            <Link
              href="/billing/payment-methods"
              className="inline-flex items-center gap-1 text-emerald-800 underline hover:text-emerald-900"
            >
              <CreditCard className="h-3 w-3" /> Manage payment method
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
