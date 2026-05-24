// POST /api/billing/payment-methods/{methodId}/remove
//
// Detaches a payment method from the family's Stripe Customer and
// deactivates the local row. The webhook handler also deactivates on
// payment_method.detached, so this is safe even if either side fails.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ methodId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { methodId } = await params;
  const session = await readSession();
  if (!session) return NextResponse.redirect(new URL('/login', request.url), 303);

  const url = new URL('/billing/payment-methods', request.url);

  const { rows } = await query<{
    stripe_payment_method_id: string;
    stripe_account_id: string;
    is_default: boolean;
  }>(
    `SELECT pm.stripe_payment_method_id, pa.stripe_account_id, pm.is_default
       FROM payment_methods pm
       JOIN payment_accounts pa ON pa.school_id = pm.school_id
      WHERE pm.id = $1 AND pm.school_id = $2 AND pm.family_id = $3 AND pm.active = true`,
    [methodId, session.school_id, session.family_id],
  );
  const m = rows[0];
  if (!m) {
    url.searchParams.set('err', 'Payment method not found.');
    return NextResponse.redirect(url, 303);
  }

  // Detach in Stripe (best-effort — local row gets deactivated either way).
  try {
    await stripe().paymentMethods.detach(
      m.stripe_payment_method_id,
      undefined,
      { stripeAccount: m.stripe_account_id },
    );
  } catch (err) {
    console.error('[remove-payment-method] Stripe detach failed:', err);
  }

  await query(
    `UPDATE payment_methods SET active = false, is_default = false, updated_at = now()
      WHERE id = $1`,
    [methodId],
  );

  // If we just removed the default, promote another active method (if any).
  if (m.is_default) {
    await query(
      `UPDATE payment_methods SET is_default = true, updated_at = now()
        WHERE id = (
          SELECT id FROM payment_methods
            WHERE school_id = $1 AND family_id = $2 AND active = true
            ORDER BY created_at DESC LIMIT 1
        )`,
      [session.school_id, session.family_id],
    );
  }

  url.searchParams.set('msg', 'Payment method removed.');
  return NextResponse.redirect(url, 303);
}
