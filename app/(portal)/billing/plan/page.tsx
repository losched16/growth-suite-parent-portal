// /billing/plan — parent view of their tuition payment plan.
//
// Shows the family's active enrollment(s), the full installment schedule
// (one row per generated invoice), payment status for each, and a
// shortcut to enable autopay across the whole plan.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Clock, Calendar, AlertTriangle, CreditCard } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { fmtCents } from '@/lib/billing/fee-math';

export const dynamic = 'force-dynamic';

interface EnrollmentRow {
  id: string;
  academic_year: string;
  grid_label: string;
  plan_label: string;
  student_label: string | null;
  total_annual_cents: number;
  installment_count: number;
  status: string;
  addons: Array<{ key: string; label: string; amount_cents: number }>;
}

interface InstallmentRow {
  invoice_id: string;
  invoice_number: string;
  installment_number: number;
  due_at: string;
  total_cents: number;
  amount_paid_cents: number;
  status: string;
  autopay_enabled: boolean;
}

export default async function PlanPage() {
  const me = await requireParent();
  if (!me) notFound();

  const { rows: enrollments } = await query<EnrollmentRow>(
    `SELECT e.id, e.academic_year,
            g.display_name AS grid_label,
            pl.display_name AS plan_label,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label,
            e.total_annual_cents, e.installment_count, e.status,
            e.addons
       FROM family_tuition_enrollments e
       JOIN tuition_grids g ON g.id = e.tuition_grid_id
       JOIN payment_plans pl ON pl.id = e.payment_plan_id
       LEFT JOIN students st ON st.id = e.student_id
      WHERE e.school_id = $1 AND e.family_id = $2
        AND e.status IN ('active', 'paused', 'completed')
      ORDER BY e.academic_year DESC, e.created_at DESC`,
    [me.parent.school_id, me.parent.family_id],
  );

  if (enrollments.length === 0) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Link href="/billing" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-3 w-3" /> Back to billing
        </Link>
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <Calendar className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h1 className="text-base font-semibold text-gray-900">No active payment plan</h1>
          <p className="mt-1 text-sm text-gray-600">
            You aren&rsquo;t enrolled in a tuition payment plan yet. Contact the school office to set one up.
          </p>
        </div>
      </div>
    );
  }

  // Fetch installments for all active enrollments in one batch.
  // Split-billing filter: same rule as /billing — show joint invoices
  // (responsible_parent_id IS NULL) AND my own split invoices
  // (responsible_parent_id = me). Co-parent's invoices stay hidden.
  const enrollmentIds = enrollments.map((e) => e.id);
  const { rows: installments } = await query<InstallmentRow & { enrollment_id: string }>(
    `SELECT (i.source_ref->>'enrollment_id') AS enrollment_id,
            i.id AS invoice_id, i.invoice_number,
            (i.source_ref->>'installment_number')::int AS installment_number,
            i.due_at, i.total_cents, i.amount_paid_cents, i.status,
            i.autopay_enabled
       FROM invoices i
      WHERE i.school_id = $1
        AND i.family_id = $2
        AND i.source = 'tuition_plan'
        AND (i.source_ref->>'enrollment_id') = ANY($3::text[])
        AND (i.responsible_parent_id IS NULL OR i.responsible_parent_id = $4)
      ORDER BY i.due_at ASC`,
    [me.parent.school_id, me.parent.family_id, enrollmentIds, me.parent.id],
  );

  const byEnrollment = new Map<string, InstallmentRow[]>();
  for (const inst of installments) {
    const arr = byEnrollment.get(inst.enrollment_id) ?? [];
    arr.push(inst);
    byEnrollment.set(inst.enrollment_id, arr);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <Link href="/billing" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-3 w-3" /> Back to billing
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Your payment plan</h1>
        <p className="mt-1 text-sm text-gray-600">
          {enrollments.length === 1
            ? `${enrollments[0].installment_count} installment${enrollments[0].installment_count === 1 ? '' : 's'} across the school year.`
            : `${enrollments.length} active enrollments.`}
        </p>
      </header>

      {enrollments.map((e) => (
        <EnrollmentCard
          key={e.id}
          enrollment={e}
          installments={byEnrollment.get(e.id) ?? []}
        />
      ))}
    </div>
  );
}

function EnrollmentCard({
  enrollment, installments,
}: { enrollment: EnrollmentRow; installments: InstallmentRow[] }) {
  const totalPaidCents = installments.reduce((s, i) => s + i.amount_paid_cents, 0);
  const remainingCents = enrollment.total_annual_cents - totalPaidCents;
  const pct = enrollment.total_annual_cents > 0
    ? Math.round((totalPaidCents / enrollment.total_annual_cents) * 100)
    : 0;

  const nextInstallment = installments.find(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );
  const autopayCount = installments.filter((i) => i.autopay_enabled).length;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            {enrollment.grid_label}
            {enrollment.student_label ? ` — ${enrollment.student_label}` : ''}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {enrollment.plan_label} · {enrollment.academic_year}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tabular-nums text-gray-900">{fmtCents(enrollment.total_annual_cents)}</div>
          <div className="text-[11px] text-gray-500">annual total</div>
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-baseline justify-between text-xs mb-1">
          <span className="text-gray-700">{fmtCents(totalPaidCents)} paid</span>
          <span className="text-gray-500">{fmtCents(remainingCents)} remaining</span>
        </div>
        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Next-up callout */}
      {nextInstallment ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Next due</div>
            <div className="mt-0.5 text-sm text-emerald-900">
              {fmtDate(nextInstallment.due_at)} · <strong>{fmtCents(nextInstallment.total_cents - nextInstallment.amount_paid_cents)}</strong>
            </div>
          </div>
          <Link
            href={`/billing/pay/${nextInstallment.invoice_id}?return_to=/billing/plan`}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 inline-flex items-center gap-1"
          >
            <CreditCard className="h-3 w-3" /> Pay now
          </Link>
        </div>
      ) : null}

      {/* Add-on snapshot */}
      {enrollment.addons.length > 0 ? (
        <details className="rounded-md bg-gray-50 border border-gray-100 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-gray-700">
            Includes {enrollment.addons.length} add-on{enrollment.addons.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-0.5 text-xs">
            {enrollment.addons.map((a) => (
              <li key={a.key} className="flex justify-between">
                <span>{a.label}</span>
                <span className="tabular-nums text-gray-600">{fmtCents(a.amount_cents)}/yr</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Schedule table */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Installment schedule</h3>
          {autopayCount > 0 ? (
            <span className="text-[10px] text-emerald-700">
              {autopayCount} of {installments.length} on autopay
            </span>
          ) : null}
        </div>
        <ul className="divide-y divide-gray-100 rounded border border-gray-200 overflow-hidden">
          {installments.map((inst) => (
            <InstallmentRowItem key={inst.invoice_id} inst={inst} />
          ))}
        </ul>
        {installments.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 bg-white p-4 text-center text-xs text-gray-500 italic">
            No installments generated yet. Contact the school if this looks wrong.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InstallmentRowItem({ inst }: { inst: InstallmentRow }) {
  const dueDate = new Date(inst.due_at);
  const overdue = (inst.status === 'open' || inst.status === 'partially_paid')
    && dueDate < new Date();

  const statusBadge = inst.status === 'paid' ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
      <CheckCircle2 className="h-3 w-3" /> Paid
    </span>
  ) : inst.status === 'partially_paid' ? (
    <span className="text-[10px] font-semibold text-amber-700">Partial</span>
  ) : inst.status === 'voided' ? (
    <span className="text-[10px] font-semibold text-gray-500">Voided</span>
  ) : overdue ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-rose-700">
      <AlertTriangle className="h-3 w-3" /> Overdue
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-500">
      <Clock className="h-3 w-3" /> Open
    </span>
  );

  return (
    <li className="px-3 py-2 flex items-center gap-3 hover:bg-gray-50">
      <div className="w-8 text-center text-[11px] font-mono text-gray-500">
        #{inst.installment_number}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900">{fmtDate(inst.due_at)}</div>
        <div className="text-[10px] text-gray-500 font-mono">{inst.invoice_number}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-mono tabular-nums text-gray-900">{fmtCents(inst.total_cents)}</div>
        <div className="flex items-center gap-2 justify-end">
          {statusBadge}
          {inst.autopay_enabled ? (
            <span className="text-[10px] text-blue-700 font-medium">⚡ autopay</span>
          ) : null}
        </div>
      </div>
      {inst.status === 'open' || inst.status === 'partially_paid' ? (
        <Link
          href={`/billing/pay/${inst.invoice_id}?return_to=/billing/plan`}
          className="text-[11px] text-emerald-700 font-medium hover:underline whitespace-nowrap"
        >
          Pay →
        </Link>
      ) : <span className="w-10" />}
    </li>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
