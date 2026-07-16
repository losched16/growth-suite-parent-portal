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
  has_pending_payment: boolean;
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

  // Is the school live yet? Before go-live (billing_active=false) the
  // installments exist as DRAFTS — we still show them to the family as a
  // read-only SCHEDULE PREVIEW so they can see exactly what they'll pay
  // and when, and get their payment method on file ahead of time. Nothing
  // is charged while in draft mode.
  const { rows: cfgRows } = await query<{ billing_active: boolean }>(
    `SELECT COALESCE(billing_active, false) AS billing_active
       FROM school_payment_config WHERE school_id = $1`,
    [me.parent.school_id],
  );
  const billingActive = cfgRows[0]?.billing_active === true;

  // Does the family already have a payment method on file? Drives the
  // "add a payment method" prompt — the key step so installments draft
  // automatically.
  const { rows: pmRows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM payment_methods
      WHERE school_id = $1 AND family_id = $2 AND active = true`,
    [me.parent.school_id, me.parent.family_id],
  );
  const hasPaymentMethod = Number(pmRows[0]?.n ?? 0) > 0;

  // Fetch installments for all active enrollments in one batch.
  // Split-billing filter: same rule as /billing — show joint invoices
  // (responsible_parent_id IS NULL) AND my own split invoices
  // (responsible_parent_id = me). Co-parent's invoices stay hidden.
  // We INCLUDE drafts here (unlike /billing) so the schedule preview
  // renders pre-go-live; draft rows are shown as "Scheduled", never payable.
  const enrollmentIds = enrollments.map((e) => e.id);
  const { rows: installments } = await query<InstallmentRow & { enrollment_id: string }>(
    `SELECT (i.source_ref->>'enrollment_id') AS enrollment_id,
            i.id AS invoice_id, i.invoice_number,
            (i.source_ref->>'installment_number')::int AS installment_number,
            i.due_at, i.total_cents, i.amount_paid_cents, i.status,
            i.autopay_enabled,
            EXISTS (
              SELECT 1 FROM payments p
               WHERE p.invoice_id = i.id AND p.status IN ('pending', 'processing')
            ) AS has_pending_payment
       FROM invoices i
      WHERE i.school_id = $1
        AND i.family_id = $2
        AND i.source = 'tuition_plan'
        AND i.status <> 'voided'
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

      {/* Add-a-payment-method prompt — the one step a family needs to do so
          their installments draft automatically. Shown until a method is
          on file, in both draft mode and live. */}
      {!hasPaymentMethod ? (
        <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <CreditCard className="h-6 w-6 text-emerald-700 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-emerald-900">Add your payment method</h2>
              <p className="mt-0.5 text-sm text-emerald-800">
                Add a card or bank account once, and every payment below drafts automatically on its
                date — you&rsquo;ll get a receipt each time. {billingActive ? '' : 'Nothing is charged until the school starts billing.'}
              </p>
              <Link
                href="/billing/payment-methods/add?return_to=/billing/plan"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
              >
                <CreditCard className="h-4 w-4" /> Add a payment method
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {/* Pre-go-live note: the schedule below is real but not yet charging. */}
      {!billingActive ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-start gap-2">
          <Calendar className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            This is your payment schedule for the year. <strong>Payments haven&rsquo;t started yet</strong> — nothing
            will be drawn until {enrollments[0]?.academic_year ? `the ${enrollments[0].academic_year} school year billing` : 'the school'} begins.
            Add your payment method now so you&rsquo;re all set.
          </span>
        </div>
      ) : null}

      {enrollments.map((e) => (
        <EnrollmentCard
          key={e.id}
          enrollment={e}
          installments={byEnrollment.get(e.id) ?? []}
          billingActive={billingActive}
        />
      ))}
    </div>
  );
}

function EnrollmentCard({
  enrollment, installments, billingActive,
}: { enrollment: EnrollmentRow; installments: InstallmentRow[]; billingActive: boolean }) {
  const totalPaidCents = installments.reduce((s, i) => s + i.amount_paid_cents, 0);
  const remainingCents = enrollment.total_annual_cents - totalPaidCents;
  const pct = enrollment.total_annual_cents > 0
    ? Math.round((totalPaidCents / enrollment.total_annual_cents) * 100)
    : 0;

  const nextInstallment = installments.find(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );
  // Pre-go-live: the earliest scheduled (draft) installment, to preview
  // when the first draw will happen.
  const firstScheduled = installments.find((i) => i.status === 'draft');
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

      {/* Next-up callout. Live: the next open invoice with a Pay button.
          Pre-go-live: a read-only preview of the first scheduled draw. */}
      {billingActive && nextInstallment ? (
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
      ) : !billingActive && firstScheduled ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">First payment scheduled</div>
          <div className="mt-0.5 text-sm text-blue-900">
            {fmtDate(firstScheduled.due_at)} · <strong>{fmtCents(firstScheduled.total_cents)}</strong>
            <span className="text-blue-700"> — drafts automatically once your payment method is on file.</span>
          </div>
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
  // Draft installments exist before the school goes live — they're a
  // scheduled preview, never payable yet.
  const isScheduledPreview = inst.status === 'draft';
  // A bank payment in flight isn't overdue — it's clearing.
  const overdue = (inst.status === 'open' || inst.status === 'partially_paid')
    && dueDate < new Date() && !inst.has_pending_payment;

  const statusBadge = inst.status === 'paid' ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
      <CheckCircle2 className="h-3 w-3" /> Paid
    </span>
  ) : inst.status === 'partially_paid' ? (
    <span className="text-[10px] font-semibold text-amber-700">Partial</span>
  ) : inst.status === 'voided' ? (
    <span className="text-[10px] font-semibold text-gray-500">Voided</span>
  ) : inst.has_pending_payment ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
      <Clock className="h-3 w-3" /> Processing
    </span>
  ) : isScheduledPreview ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600">
      <Calendar className="h-3 w-3" /> Scheduled
    </span>
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
