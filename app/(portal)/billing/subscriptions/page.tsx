// /billing/subscriptions — parent manages their recurring product
// purchases. Each row is a Stripe subscription (created via Checkout)
// tied to a school_products row. Parent can cancel; we POST to Stripe
// which fires customer.subscription.deleted → our webhook updates the
// product_purchases row.

import { CalendarClock, AlertCircle } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { CancelSubscriptionButton } from './CancelSubscriptionButton';

export const dynamic = 'force-dynamic';

interface SubscriptionRow {
  id: string;
  product_id: string;
  product_name: string;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  total_amount_cents: number;
  unit_amount_cents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded';
  stripe_subscription_id: string | null;
  created_at: string;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function SubscriptionsPage() {
  const id = await requireParent();

  const subscriptions = (await query<SubscriptionRow>(
    `SELECT pp.id, pp.product_id, sp.name AS product_name,
            sp.recurring_interval, sp.recurring_installment_count,
            pp.total_amount_cents, pp.unit_amount_cents,
            pp.status, pp.stripe_subscription_id, pp.created_at::text
       FROM product_purchases pp
       JOIN school_products sp ON sp.id = pp.product_id
      WHERE pp.school_id = $1
        AND (pp.family_id = $2 OR LOWER(pp.purchaser_email) = LOWER($3))
        AND sp.product_type = 'recurring'
        AND pp.stripe_subscription_id IS NOT NULL
      ORDER BY pp.created_at DESC`,
    [id.parent.school_id, id.family.id, id.parent.email ?? ''],
  )).rows;

  const active = subscriptions.filter((s) => s.status === 'succeeded' || s.status === 'pending');
  const ended = subscriptions.filter((s) => s.status === 'canceled' || s.status === 'refunded');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">My subscriptions</h1>
        <p className="mt-1 text-sm text-gray-600">
          Recurring charges from your school&rsquo;s store. Cancel anytime — you keep access through
          the end of the current billing period.
        </p>
      </header>

      {active.length === 0 && ended.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-gray-200 bg-white p-12 text-center">
          <CalendarClock className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm text-gray-700 font-medium">No subscriptions yet</p>
          <p className="mt-1 text-xs text-gray-500 max-w-sm mx-auto">
            Recurring purchases from the school store (after-school programs, monthly lunch, etc.)
            will appear here.
          </p>
        </div>
      ) : null}

      {/* Active */}
      {active.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Active ({active.length})
          </h2>
          <div className="space-y-2">
            {active.map((s) => (
              <SubscriptionCard key={s.id} sub={s} canCancel />
            ))}
          </div>
        </section>
      ) : null}

      {/* Ended */}
      {ended.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Ended ({ended.length})
          </h2>
          <div className="space-y-2">
            {ended.map((s) => (
              <SubscriptionCard key={s.id} sub={s} canCancel={false} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SubscriptionCard({ sub, canCancel }: { sub: SubscriptionRow; canCancel: boolean }) {
  return (
    <article className={`rounded-lg border bg-white p-4 ${
      canCancel ? 'border-gray-200' : 'border-gray-200 opacity-75'
    }`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{sub.product_name}</h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
            <span>
              <span className="font-medium">{fmtCents(sub.unit_amount_cents)}</span>
              /{sub.recurring_interval}
              {sub.recurring_installment_count
                ? ` × ${sub.recurring_installment_count}`
                : ''}
            </span>
            <span>·</span>
            <span>Started {fmtDate(sub.created_at)}</span>
            <span>·</span>
            <StatusBadge status={sub.status} />
          </div>
        </div>
        {canCancel && sub.stripe_subscription_id ? (
          <CancelSubscriptionButton purchaseId={sub.id} productName={sub.product_name} />
        ) : null}
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    succeeded:  'bg-emerald-100 text-emerald-800',
    pending:    'bg-amber-100 text-amber-800',
    canceled:   'bg-slate-100 text-slate-700',
    refunded:   'bg-blue-100 text-blue-800',
    failed:     'bg-rose-100 text-rose-800',
  };
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {status}
    </span>
  );
}
