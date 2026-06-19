// /billing/payment-methods/add — standalone "add a payment method" flow.
//
// Lets a parent save a card / bank account before any invoice is due
// (e.g. right after signing the enrollment agreement, or while the
// school is still in pre-billing draft mode). Drives a SetupIntent, so
// nothing is charged. The saved method is auto-wired into the family's
// autopay tuition installments by the payment_method.attached webhook.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { AddPaymentMethodForm } from './AddPaymentMethodForm';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ return_to?: string }>;

// Only allow bouncing back to known internal portal paths after save.
function safeReturnTo(raw: string | undefined): string {
  if (!raw) return '/billing/payment-methods';
  // Must be a same-origin absolute path to an allowed area; no protocol.
  if (/^\/(billing|home)(\/|\?|$)/.test(raw)) return raw;
  return '/billing/payment-methods';
}

export default async function AddPaymentMethodPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireParent();
  if (!me) notFound();
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.return_to);

  const { rows: acctRows } = await query<{ charges_enabled: boolean }>(
    `SELECT charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [me.parent.school_id],
  );
  const ready = acctRows[0]?.charges_enabled === true;

  const { rows: cfgRows } = await query<{ card_enabled: boolean; ach_enabled: boolean }>(
    `SELECT card_enabled, ach_enabled FROM school_payment_config WHERE school_id = $1`,
    [me.parent.school_id],
  );
  const cardEnabled = cfgRows[0]?.card_enabled ?? true;
  const achEnabled = cfgRows[0]?.ach_enabled ?? true;

  return (
    <div className="max-w-md mx-auto space-y-5">
      <Link href="/billing/payment-methods" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-3 w-3" /> Back to payment methods
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Add a payment method</h1>
        <p className="mt-1 text-sm text-gray-600">
          Save a card or bank account so your tuition payments draft automatically. You won&rsquo;t be charged now.
        </p>
      </header>

      {!ready ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Your school hasn&rsquo;t finished setting up payments yet. Please check back soon — you&rsquo;ll be able to add a payment method here.</span>
        </div>
      ) : (
        <AddPaymentMethodForm cardEnabled={cardEnabled} achEnabled={achEnabled} returnTo={returnTo} />
      )}
    </div>
  );
}
