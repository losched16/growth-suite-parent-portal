// POST /api/billing/subscriptions/[purchaseId]/cancel
//
// Parent cancels their own recurring product subscription. Cancellation
// is at-period-end — they keep access through whatever they've already
// paid for. Webhook (customer.subscription.deleted) flips the
// product_purchases.status to 'canceled' when Stripe actually ends it.
//
// Auth: parent-session-authed. The purchase must be tied to the
// logged-in parent's family OR have purchaser_email matching.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ purchaseId: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { purchaseId } = await params;

  // Load purchase + verify ownership + load Stripe Connect account
  const { rows } = await query<{
    id: string;
    school_id: string;
    family_id: string | null;
    purchaser_email: string | null;
    status: string;
    stripe_subscription_id: string | null;
    stripe_account_id: string | null;
  }>(
    `SELECT pp.id, pp.school_id, pp.family_id, pp.purchaser_email, pp.status,
            pp.stripe_subscription_id, pa.stripe_account_id
       FROM product_purchases pp
       LEFT JOIN payment_accounts pa ON pa.school_id = pp.school_id
      WHERE pp.id = $1`,
    [purchaseId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'purchase_not_found' }, { status: 404 });
  }
  const p = rows[0];

  // Authorization: must belong to this parent's family, or match their email
  const ownsByFamily = p.family_id && p.family_id === session.family_id;
  const ownsByEmail = !!(p.purchaser_email
    && session.email
    && p.purchaser_email.toLowerCase() === session.email.toLowerCase());
  if (!ownsByFamily && !ownsByEmail) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (p.school_id !== session.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Must be a recurring subscription
  if (!p.stripe_subscription_id) {
    return NextResponse.json(
      { error: 'not_recurring', detail: 'This purchase is not a recurring subscription.' },
      { status: 409 },
    );
  }
  if (p.status === 'canceled') {
    return NextResponse.json({ ok: true, already_canceled: true });
  }
  if (!p.stripe_account_id) {
    return NextResponse.json(
      { error: 'school_not_connected', detail: 'School Stripe Connect account missing.' },
      { status: 503 },
    );
  }

  // Cancel at period end — parent keeps access through what they paid for
  try {
    const s = stripe();
    await s.subscriptions.update(
      p.stripe_subscription_id,
      { cancel_at_period_end: true },
      { stripeAccount: p.stripe_account_id },
    );
    // Webhook will fire customer.subscription.deleted at period end and
    // flip status to 'canceled'. In the meantime we don't update the
    // DB — the subscription is still active until period end.
    return NextResponse.json({ ok: true, canceled_at_period_end: true });
  } catch (e) {
    return NextResponse.json(
      { error: 'stripe_cancel_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
