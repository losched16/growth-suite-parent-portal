// /pay/[schoolSlug]/[productSlug]/thanks — confirmation page after
// Stripe Checkout completes. We look up the purchase by `purchase` id
// (passed in success_url from the checkout API) and show a friendly
// receipt.
//
// We deliberately don't re-poll Stripe here — the webhook handler
// (separate route, TODO) is the source of truth for status. This page
// just reads the latest DB state.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Mail } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolSlug: string; productSlug: string }>;
type SearchParams = Promise<{ purchase?: string; session_id?: string }>;

interface PurchaseRow {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'refunded';
  purchaser_email: string | null;
  total_amount_cents: number;
  quantity: number;
  product_name: string;
  school_name: string;
}

export default async function ThanksPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { schoolSlug, productSlug } = await params;
  const sp = await searchParams;
  if (!sp.purchase) notFound();

  const rows = (await query<PurchaseRow>(
    `SELECT pp.id, pp.status, pp.purchaser_email, pp.total_amount_cents, pp.quantity,
            sp.name AS product_name, s.name AS school_name
       FROM product_purchases pp
       JOIN school_products sp ON sp.id = pp.product_id
       JOIN schools s ON s.id = pp.school_id
      WHERE pp.id = $1`,
    [sp.purchase],
  )).rows;
  if (rows.length === 0) notFound();
  const p = rows[0];

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full text-center bg-white border border-gray-200 rounded-lg p-6 sm:p-8">
        {p.status === 'succeeded' ? (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
            <h1 className="mt-3 text-xl font-semibold text-gray-900">Thank you!</h1>
            <p className="mt-2 text-sm text-gray-700">
              Your payment of{' '}
              <span className="font-semibold">${(p.total_amount_cents / 100).toFixed(2)}</span>{' '}
              to {p.school_name} for <strong>{p.product_name}</strong> went through successfully.
            </p>
            {p.purchaser_email ? (
              <p className="mt-3 text-xs text-gray-500 inline-flex items-center gap-1">
                <Mail className="h-3 w-3" /> A receipt was sent to {p.purchaser_email}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
              <span className="text-amber-700 text-2xl">…</span>
            </div>
            <h1 className="mt-3 text-xl font-semibold text-gray-900">Payment processing</h1>
            <p className="mt-2 text-sm text-gray-700">
              We&rsquo;ve received your details and Stripe is finishing the charge.
              You&rsquo;ll get an email confirmation shortly. You can safely close this page.
            </p>
            <p className="mt-3 text-[11px] text-gray-500">
              Reference: {p.id.slice(0, 8)}
            </p>
          </>
        )}

        <div className="mt-6">
          <Link
            href={`/pay/${schoolSlug}/${productSlug}`}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            ← Back
          </Link>
        </div>
      </div>
    </div>
  );
}
