// /billing/payment-methods — parent's saved payment methods.
//
// Lists all active payment methods (saved cards + bank accounts).
// Parents can:
//   - Set one as default for autopay
//   - Remove (deactivate) a method
//   - Add a new one by clicking "Add card" / "Add bank" → routes to a
//     small Stripe SetupIntent flow
// New methods get added via Phase 2's "save during checkout" path
// primarily; the standalone add UI is for parents who want to set up
// autopay before any invoices are due.

import Link from 'next/link';
import { ArrowLeft, CreditCard, Landmark, CheckCircle2, Trash2, Star, Plus } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ msg?: string; err?: string; added?: string }>;

interface PaymentMethodRow {
  id: string;
  type: 'card' | 'us_bank_account';
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  created_at: string;
}

export default async function PaymentMethodsPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;

  const { rows: methods } = await query<PaymentMethodRow>(
    `SELECT id, type, brand, last4, exp_month, exp_year, is_default, created_at
       FROM payment_methods
      WHERE school_id = $1 AND family_id = $2 AND active = true
      ORDER BY is_default DESC, created_at DESC`,
    [id.parent.school_id, id.parent.family_id],
  );

  return (
    <div className="space-y-5 max-w-2xl">
      <Link href="/billing" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-3 w-3" /> Back to billing
      </Link>

      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Payment methods</h1>
          <p className="mt-1 text-sm text-gray-600">
            Saved cards and bank accounts. Set one as the default for autopay.
          </p>
        </div>
        <Link
          href="/billing/payment-methods/add"
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          style={{ background: 'var(--brand)' }}
        >
          <Plus className="h-4 w-4" /> Add method
        </Link>
      </header>

      {sp.added ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Payment method saved. It may take a moment to appear below — refresh if you don&rsquo;t see it yet.
        </div>
      ) : null}
      {sp.msg ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
      ) : null}
      {sp.err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
      ) : null}

      {methods.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <CreditCard className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h2 className="text-base font-semibold text-gray-900">No saved payment methods yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Add a card or bank account so your tuition payments draft automatically on each due date.
            You won&rsquo;t be charged just for adding one.
          </p>
          <Link
            href="/billing/payment-methods/add"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            style={{ background: 'var(--brand)' }}
          >
            <Plus className="h-4 w-4" /> Add a payment method
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {methods.map((m) => <MethodRow key={m.id} m={m} />)}
        </ul>
      )}

      <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600">
        <strong>About autopay:</strong> when an invoice is due, we&rsquo;ll charge the default
        method automatically on the school&rsquo;s allowed payment days. You&rsquo;ll get a receipt
        every time. To turn autopay off for an invoice, open it and use the toggle.
      </div>
    </div>
  );
}

function MethodRow({ m }: { m: PaymentMethodRow }) {
  const display = m.type === 'card'
    ? `${(m.brand ?? 'card').toUpperCase()} ····${m.last4 ?? ''}${m.exp_month && m.exp_year ? ` · exp ${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)}` : ''}`
    : `${m.brand ?? 'Bank'} ····${m.last4 ?? ''}`;

  return (
    <li className="px-4 py-3 flex flex-wrap items-center gap-3">
      <div className="rounded-md bg-gray-100 p-2 text-gray-700">
        {m.type === 'card' ? <CreditCard className="h-4 w-4" /> : <Landmark className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 font-mono">{display}</span>
          {m.is_default ? (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 inline-flex items-center gap-0.5">
              <CheckCircle2 className="h-3 w-3" /> Default
            </span>
          ) : null}
        </div>
        <div className="text-[11px] text-gray-500">
          Added {new Date(m.created_at).toLocaleDateString()}
        </div>
      </div>
      <div className="flex gap-2">
        {!m.is_default ? (
          <form action={`/api/billing/payment-methods/${m.id}/default`} method="POST">
            <button type="submit" className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
              <Star className="h-3 w-3" /> Set default
            </button>
          </form>
        ) : null}
        <form action={`/api/billing/payment-methods/${m.id}/remove`} method="POST">
          <button type="submit" className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-rose-50 hover:text-rose-700">
            <Trash2 className="h-3 w-3" /> Remove
          </button>
        </form>
      </div>
    </li>
  );
}
