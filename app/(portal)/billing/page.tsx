// /billing — parent's billing portal.
//
// Lists all invoices for the family: outstanding (open + partially_paid)
// first, then paid (collapsed), then voided (collapsed).

import Link from 'next/link';
import { Receipt, ExternalLink, CheckCircle2, CreditCard, FileText, Calendar } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { fmtCents } from '@/lib/billing/fee-math';

export const dynamic = 'force-dynamic';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  title: string;
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  due_at: string;
  issued_at: string | null;
  paid_at: string | null;
  has_pending_payment: boolean;
}

export default async function BillingPage() {
  const id = await requireParent();

  // Split-billing filter: for divorced/separated families, each parent
  // is the responsible party for their own invoices. We show invoices
  // where either:
  //   - responsible_parent_id IS NULL (joint invoice — both parents see it), OR
  //   - responsible_parent_id = me     (my own share invoice)
  // This means a co-parent's split invoices NEVER leak into my portal
  // view, while pre-existing joint invoices keep working.
  const { rows: invoices } = await query<InvoiceRow>(
    `SELECT id, invoice_number, title, status, total_cents, amount_paid_cents,
            due_at, issued_at, paid_at,
            EXISTS (
              SELECT 1 FROM payments p
               WHERE p.invoice_id = invoices.id
                 AND p.status IN ('pending', 'processing')
            ) AS has_pending_payment
       FROM invoices
      WHERE school_id = $1 AND family_id = $2 AND status <> 'draft'
        AND (responsible_parent_id IS NULL OR responsible_parent_id = $3)
      ORDER BY
        CASE status
          WHEN 'open' THEN 1
          WHEN 'partially_paid' THEN 1
          WHEN 'paid' THEN 2
          ELSE 3
        END,
        due_at`,
    [id.parent.school_id, id.parent.family_id, id.parent.id],
  );

  const outstanding = invoices.filter((i) => i.status === 'open' || i.status === 'partially_paid');
  const paid = invoices.filter((i) => i.status === 'paid');
  const other = invoices.filter((i) => !['open', 'partially_paid', 'paid'].includes(i.status));

  const totalOwed = outstanding.reduce((acc, i) => acc + (i.total_cents - i.amount_paid_cents), 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Billing</h1>
          <p className="mt-1 text-sm text-gray-600">
            {outstanding.length === 0
              ? "You have no outstanding invoices. Nice."
              : `${outstanding.length} outstanding invoice${outstanding.length === 1 ? '' : 's'} · ${fmtCents(totalOwed)} due`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/billing/plan"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
          >
            <Calendar className="h-3.5 w-3.5" /> Payment plan
          </Link>
          <Link
            href="/billing/year-end-statement"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-3.5 w-3.5" /> Year-end statement
          </Link>
          <Link
            href="/billing/payment-methods"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <CreditCard className="h-3.5 w-3.5" /> Payment methods
          </Link>
        </div>
      </header>

      {outstanding.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Outstanding
          </h2>
          <ul className="space-y-2">
            {outstanding.map((inv) => <OutstandingInvoiceRow key={inv.id} inv={inv} />)}
          </ul>
        </section>
      ) : null}

      {paid.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Paid ({paid.length})
          </h2>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {paid.slice(0, 20).map((inv) => <PaidInvoiceRow key={inv.id} inv={inv} />)}
          </ul>
        </section>
      ) : null}

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <Receipt className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <p className="text-sm text-gray-600">No invoices yet.</p>
          <p className="mt-1 text-xs text-gray-500">
            Your school will send invoices here as they bill for tuition, deposits, or other items.
          </p>
        </div>
      ) : null}

      {other.length > 0 ? (
        <details className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <summary className="cursor-pointer text-xs text-gray-600">Voided / refunded ({other.length})</summary>
          <ul className="mt-2 divide-y divide-gray-100">
            {other.map((inv) => <PaidInvoiceRow key={inv.id} inv={inv} />)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function OutstandingInvoiceRow({ inv }: { inv: InvoiceRow }) {
  const due = new Date(inv.due_at);
  const now = new Date();
  // A payment already in flight (ACH sits in 'pending' for a few business
  // days) means this ISN'T unpaid — never show "Overdue" while it clears, or
  // the parent panics and pays a second time (usually by card, with a fee).
  const overdue = due < now && !inv.has_pending_payment;
  const amount = inv.total_cents - inv.amount_paid_cents;
  return (
    <li>
      <Link
        href={`/billing/pay/${inv.id}`}
        className="flex items-start gap-3 rounded-lg border-2 border-gray-200 bg-white p-4 transition hover:border-gray-300 hover:shadow-sm"
      >
        <Receipt className="h-5 w-5 text-gray-400 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{inv.title}</h3>
            <div className="text-base font-bold text-gray-900">{fmtCents(amount)}</div>
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 font-mono">{inv.invoice_number}</div>
          {inv.has_pending_payment ? (
            <div className="mt-1 text-xs text-emerald-700">
              ⏳ Payment processing — a bank payment is clearing (a few business days). No need to pay again.
            </div>
          ) : (
            <div className={`mt-1 text-xs ${overdue ? 'text-red-700' : 'text-gray-600'}`}>
              {overdue ? '⚠ Overdue — ' : 'Due '}
              {due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              {inv.amount_paid_cents > 0 ? ` · ${fmtCents(inv.amount_paid_cents)} paid so far` : ''}
            </div>
          )}
        </div>
        <div className="flex items-center text-xs font-medium text-emerald-700">
          Pay <ExternalLink className="ml-1 h-3 w-3" />
        </div>
      </Link>
    </li>
  );
}

function PaidInvoiceRow({ inv }: { inv: InvoiceRow }) {
  return (
    <li className="px-4 py-2.5 flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{inv.title}</div>
        <div className="text-[11px] text-gray-500 font-mono">{inv.invoice_number}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-mono text-gray-700">{fmtCents(inv.total_cents)}</div>
        <div className="text-[11px] text-gray-500 flex items-center justify-end gap-1">
          {inv.status === 'paid' ? (
            <><CheckCircle2 className="h-3 w-3 text-emerald-600" /> {inv.paid_at ? new Date(inv.paid_at).toLocaleDateString() : 'Paid'}</>
          ) : inv.status}
        </div>
      </div>
    </li>
  );
}
