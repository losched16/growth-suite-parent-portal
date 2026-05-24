// /billing/year-end-statement[?year=YYYY]
//
// Parent-facing year-end payment summary. Designed for printing and
// providing to a tax preparer (e.g. for the dependent-care credit).
// This is NOT an IRS 1098-T — those are issued by post-secondary
// institutions. Schools that issue childcare receipts can use this.
//
// Logic:
//   - Default year: current calendar year if it's already January–March
//     (parents often need last year's totals for tax filing); otherwise
//     the previous calendar year.
//   - Pull all successful payments for the family within the calendar
//     year, join to invoices for the description, group by category.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { fmtCents } from '@/lib/billing/fee-math';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ year?: string }>;

interface PaymentRow {
  paid_at: string;
  invoice_number: string;
  invoice_title: string;
  amount_cents: number;
  fee_cents: number;
  // Aggregated category for grouping. NULL = 'other'. Derived per row
  // from the dominant invoice_line_items category (first non-discount).
  category: string | null;
}

interface CategoryTotal {
  category: string;
  amount_cents: number;
}

function defaultYear(): number {
  const today = new Date();
  const month = today.getMonth(); // 0–11
  const year = today.getFullYear();
  // Jan–Mar (months 0–2) → default to previous year for tax-prep season.
  return month <= 2 ? year - 1 : year;
}

export default async function YearEndStatementPage({
  searchParams,
}: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const me = await requireParent();

  const yearArg = sp.year ? parseInt(sp.year, 10) : NaN;
  const year = Number.isFinite(yearArg) && yearArg >= 2020 && yearArg <= 2100
    ? yearArg
    : defaultYear();

  const startOfYear = new Date(Date.UTC(year, 0, 1)).toISOString();
  const startOfNextYear = new Date(Date.UTC(year + 1, 0, 1)).toISOString();

  const [paymentRows, schoolRow, parentRow] = await Promise.all([
    query<PaymentRow>(
      // For each payment, pick the dominant category by joining to the
      // invoice's line items: the first non-discount line's category is
      // a good-enough proxy for v1.
      `SELECT p.created_at AS paid_at,
              i.invoice_number, i.title AS invoice_title,
              p.amount_cents, p.fee_cents,
              (
                SELECT li.category FROM invoice_line_items li
                 WHERE li.invoice_id = i.id
                   AND li.amount_cents > 0
                   AND li.category IS NOT NULL
                 ORDER BY li.position ASC LIMIT 1
              ) AS category
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
        WHERE p.school_id = $1
          AND p.family_id = $2
          AND p.status = 'succeeded'
          AND p.created_at >= $3
          AND p.created_at < $4
        ORDER BY p.created_at ASC`,
      [me.parent.school_id, me.parent.family_id, startOfYear, startOfNextYear],
    ).then((r) => r.rows),
    query<{ name: string }>(
      `SELECT name FROM schools WHERE id = $1`, [me.parent.school_id],
    ).then((r) => r.rows[0] ?? { name: 'Your school' }),
    query<{ display_name: string | null; primary_email: string | null }>(
      `SELECT
         COALESCE(NULLIF(f.display_name, ''),
                  CONCAT_WS(' ', p.first_name, p.last_name)) AS display_name,
         p.email AS primary_email
         FROM families f
         JOIN parents p ON p.family_id = f.id AND p.is_primary = true
        WHERE f.id = $1 LIMIT 1`,
      [me.parent.family_id],
    ).then((r) => r.rows[0] ?? { display_name: null, primary_email: null }),
  ]);

  const totalPaidCents = paymentRows.reduce((s, p) => s + p.amount_cents, 0);
  const totalFeesCents = paymentRows.reduce((s, p) => s + p.fee_cents, 0);

  // Bucket by category
  const byCategory = new Map<string, number>();
  for (const p of paymentRows) {
    const k = p.category || 'other';
    byCategory.set(k, (byCategory.get(k) ?? 0) + p.amount_cents);
  }
  const categoryTotals: CategoryTotal[] = [...byCategory.entries()]
    .map(([category, amount_cents]) => ({ category, amount_cents }))
    .sort((a, b) => b.amount_cents - a.amount_cents);

  return (
    <div className="max-w-3xl mx-auto space-y-5 print:max-w-none">
      <div className="print:hidden flex items-center justify-between">
        <Link href="/billing" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-3 w-3" /> Back to billing
        </Link>
        <div className="flex items-center gap-2">
          <form method="GET" className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Year:</label>
            <select
              name="year"
              defaultValue={String(year)}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
            >
              {[year + 1, year, year - 1, year - 2, year - 3].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <button type="submit" className="rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50">
              Go
            </button>
          </form>
          <PrintButton />
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 print:border-0 print:p-0">
        <div className="border-b border-gray-200 pb-3 mb-4 print:border-gray-400">
          <h1 className="text-xl font-semibold text-gray-900">Year-end payment statement</h1>
          <p className="mt-0.5 text-sm text-gray-600">
            {schoolRow.name} · Calendar year {year}
          </p>
          <p className="mt-1 text-[11px] text-gray-500 italic">
            This statement is provided as a courtesy for your records. It is not an IRS Form
            1098-T or 1099. Check with your tax advisor to confirm what is deductible
            (e.g. dependent-care credit eligibility).
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500">Issued to</div>
            <div className="text-gray-900 font-medium">{parentRow.display_name || '(Family)'}</div>
            {parentRow.primary_email ? (
              <div className="text-xs text-gray-600">{parentRow.primary_email}</div>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">Total paid</div>
            <div className="text-2xl font-semibold text-gray-900 tabular-nums">{fmtCents(totalPaidCents)}</div>
            {totalFeesCents > 0 ? (
              <div className="text-[11px] text-gray-500">
                Includes {fmtCents(totalFeesCents)} in processing fees
              </div>
            ) : null}
          </div>
        </div>

        {categoryTotals.length > 0 ? (
          <div className="mb-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              By category
            </h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {categoryTotals.map((c) => (
                  <tr key={c.category}>
                    <td className="py-1.5 text-gray-700 capitalize">{c.category.replace(/_/g, ' ')}</td>
                    <td className="py-1.5 text-right font-mono">{fmtCents(c.amount_cents)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-300">
                  <td className="py-2 font-semibold text-gray-900">Total</td>
                  <td className="py-2 text-right font-mono font-semibold">{fmtCents(totalPaidCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Payments ({paymentRows.length})
        </h2>
        {paymentRows.length === 0 ? (
          <p className="text-sm italic text-gray-500 py-6 text-center">
            No payments recorded for {schoolRow.name} during {year}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 font-medium">Date</th>
                <th className="py-2 font-medium">Invoice</th>
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {paymentRows.map((p, i) => (
                <tr key={i}>
                  <td className="py-1.5 text-gray-700 whitespace-nowrap">
                    {new Date(p.paid_at).toLocaleDateString()}
                  </td>
                  <td className="py-1.5 text-[11px] font-mono text-gray-600 whitespace-nowrap">
                    {p.invoice_number}
                  </td>
                  <td className="py-1.5 text-gray-900">{p.invoice_title}</td>
                  <td className="py-1.5 text-right font-mono">{fmtCents(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-6 text-[11px] text-gray-500 italic print:mt-12">
          Generated {new Date().toLocaleDateString()} from {schoolRow.name}&apos;s billing records.
          For questions, contact the school office.
        </p>
      </div>
    </div>
  );
}
