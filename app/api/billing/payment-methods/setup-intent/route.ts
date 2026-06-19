// POST /api/billing/payment-methods/setup-intent
//
// Creates a Stripe SetupIntent on the school's connected account so a
// parent can SAVE a card / bank account WITHOUT paying an invoice. This
// is the "add a payment method now" path — needed before any invoice is
// due (e.g. right after signing the enrollment agreement, or while the
// school is still in pre-billing draft mode).
//
// Body (JSON): { rail?: 'card' | 'us_bank_account' }
// Response:    { client_secret, stripe_account_id }
//
// On confirm (client side), Stripe attaches the payment method to the
// family's Customer and fires payment_method.attached → our webhook
// mirrors it into payment_methods AND (autopay_default_on) wires it into
// the family's open autopay tuition installments. So there's no extra
// persistence to do here.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';
import { ensureStripeCustomerForFamily } from '@/lib/stripe/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  rail?: 'card' | 'us_bank_account';
}

export async function POST(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Body = {};
  try { body = await request.json(); }
  catch { /* empty body is fine — defaults to card */ }
  const rail: 'card' | 'us_bank_account' = body.rail === 'us_bank_account' ? 'us_bank_account' : 'card';

  // School's connected payment account.
  const { rows: acctRows } = await query<{ stripe_account_id: string; charges_enabled: boolean }>(
    `SELECT stripe_account_id, charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [session.school_id],
  );
  const acct = acctRows[0];
  if (!acct || !acct.stripe_account_id || !acct.charges_enabled) {
    return NextResponse.json({ error: 'school_not_ready_for_payments' }, { status: 409 });
  }

  // Respect the school's enabled rails.
  const { rows: cfgRows } = await query<{ card_enabled: boolean; ach_enabled: boolean }>(
    `SELECT card_enabled, ach_enabled FROM school_payment_config WHERE school_id = $1`,
    [session.school_id],
  );
  const cardEnabled = cfgRows[0]?.card_enabled ?? true;
  const achEnabled = cfgRows[0]?.ach_enabled ?? true;
  if (rail === 'card' && !cardEnabled) {
    return NextResponse.json({ error: 'card_disabled_by_school' }, { status: 400 });
  }
  if (rail === 'us_bank_account' && !achEnabled) {
    return NextResponse.json({ error: 'ach_disabled_by_school' }, { status: 400 });
  }

  // A SetupIntent MUST attach to a Customer for the method to be reusable
  // for autopay. Unlike a one-off PaymentIntent, there's no fallback.
  let stripeCustomerId: string;
  try {
    stripeCustomerId = await ensureStripeCustomerForFamily({
      schoolId: session.school_id,
      familyId: session.family_id,
      stripeAccountId: acct.stripe_account_id,
    });
  } catch (err) {
    console.error('[setup-intent] ensureStripeCustomer failed:', err);
    return NextResponse.json({ error: 'customer_setup_failed' }, { status: 500 });
  }

  const params: import('stripe').Stripe.SetupIntentCreateParams = {
    customer: stripeCustomerId,
    payment_method_types: rail === 'us_bank_account' ? ['us_bank_account'] : ['card'],
    // off_session: the method will later be charged by our autopay cron
    // without the parent present.
    usage: 'off_session',
    metadata: {
      family_id: session.family_id,
      school_id: session.school_id,
      rail,
      purpose: 'add_payment_method',
    },
  };
  // ACH needs Financial Connections to verify the bank account.
  if (rail === 'us_bank_account') {
    params.payment_method_options = {
      us_bank_account: {
        financial_connections: { permissions: ['payment_method', 'balances'] },
        verification_method: 'automatic',
      },
    };
  }

  try {
    const si = await stripe().setupIntents.create(params, {
      stripeAccount: acct.stripe_account_id,
    });
    return NextResponse.json({
      client_secret: si.client_secret,
      stripe_account_id: acct.stripe_account_id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[setup-intent] failed:', msg);
    return NextResponse.json({ error: 'stripe_error', detail: msg }, { status: 500 });
  }
}
