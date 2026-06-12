// POST /api/billing/create-payment-intent
//
// Creates (or retrieves) a Stripe PaymentIntent on the school's
// connected account for a specific invoice + payment rail.
//
// Body (JSON):
//   { invoice_id: string, rail: 'card' | 'us_bank_account' }
//
// Response (JSON):
//   { client_secret: string, payment_intent_id: string,
//     amount_cents: number, fee_breakdown: FeeBreakdown }
//
// Money routing:
//   - The PaymentIntent is created on the school's connected account
//     (Stripe-Account header), so settled funds land in the school's
//     bank account, not ours.
//   - If platform_fee_cents > 0, we set application_fee_amount to that
//     value, which Stripe collects into our platform account.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';
import { ensureStripeCustomerForFamily } from '@/lib/stripe/customer';
import { computeFees, type FeeConfig, type PaymentRail } from '@/lib/billing/fee-math';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  invoice_id?: string;
  rail?: PaymentRail;
  // If true, save the payment method to the family's Stripe Customer
  // for future autopay charges. Stripe stores the method; we mirror it
  // into payment_methods via the payment_method.attached webhook.
  save_for_future_use?: boolean;
}

export async function POST(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const invoiceId = body.invoice_id;
  const rail: PaymentRail = body.rail === 'us_bank_account' ? 'us_bank_account' : 'card';
  const saveForFutureUse = !!body.save_for_future_use;
  if (!invoiceId) return NextResponse.json({ error: 'missing_invoice_id' }, { status: 400 });

  // Load invoice, scoped to the family.
  const { rows: invRows } = await query<{
    id: string;
    school_id: string;
    family_id: string;
    status: string;
    subtotal_cents: number;
    platform_fee_cents: number;
    amount_paid_cents: number;
    invoice_number: string;
    title: string;
    includes_platform_setup_fee: boolean;
  }>(
    `SELECT id, school_id, family_id, status, subtotal_cents, platform_fee_cents,
            amount_paid_cents, invoice_number, title, includes_platform_setup_fee
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const inv = invRows[0];
  if (!inv) return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  if (inv.family_id !== session.family_id || inv.school_id !== session.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (inv.status === 'paid' || inv.status === 'voided') {
    return NextResponse.json({ error: 'invoice_not_payable', status: inv.status }, { status: 409 });
  }

  // Load school's payment account + fee config
  const { rows: acctRows } = await query<{ stripe_account_id: string; charges_enabled: boolean }>(
    `SELECT stripe_account_id, charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [inv.school_id],
  );
  const acct = acctRows[0];
  if (!acct || !acct.charges_enabled) {
    return NextResponse.json({ error: 'school_not_ready_for_payments' }, { status: 409 });
  }

  const { rows: cfgRows } = await query<{
    pass_card_fee: boolean;
    pass_ach_fee: boolean;
    card_enabled: boolean;
    ach_enabled: boolean;
    processing_fee_label: string;
    default_currency: string | null;
  }>(
    `SELECT pass_card_fee, pass_ach_fee, card_enabled, ach_enabled, processing_fee_label,
            default_currency
       FROM school_payment_config WHERE school_id = $1`,
    [inv.school_id],
  );
  // Per-school currency (standalone Canadian schools charge CAD).
  const currency = (cfgRows[0]?.default_currency ?? 'usd').toLowerCase();
  const cfg: FeeConfig = cfgRows[0] ? {
    passCardFee: cfgRows[0].pass_card_fee,
    passAchFee: cfgRows[0].pass_ach_fee,
    cardEnabled: cfgRows[0].card_enabled,
    achEnabled: cfgRows[0].ach_enabled,
    processingFeeLabel: cfgRows[0].processing_fee_label,
  } : { passCardFee: true, passAchFee: false, cardEnabled: true, achEnabled: true, processingFeeLabel: 'Processing fee' };

  if (rail === 'us_bank_account' && !cfg.achEnabled) {
    return NextResponse.json({ error: 'ach_disabled_by_school' }, { status: 400 });
  }
  if (rail === 'card' && !cfg.cardEnabled) {
    return NextResponse.json({ error: 'card_disabled_by_school' }, { status: 400 });
  }

  // Compute fees. For partial-paid invoices, only the remainder of the
  // subtotal is owed; the platform fee was either paid already or
  // remains to be paid.
  const subtotalRemaining = Math.max(0, inv.subtotal_cents - Math.max(0, inv.amount_paid_cents - inv.platform_fee_cents));
  const platformFeeRemaining = inv.amount_paid_cents >= inv.platform_fee_cents ? 0 : inv.platform_fee_cents;
  const breakdown = computeFees({
    rail, subtotal_cents: subtotalRemaining, platform_fee_cents: platformFeeRemaining, config: cfg,
  });

  // Lazy-create the family's Stripe Customer on the school's connected
  // account. Required whenever we want to save a payment method, and
  // useful in all cases (Stripe dashboard groups payments by customer).
  let stripeCustomerId: string | null = null;
  try {
    stripeCustomerId = await ensureStripeCustomerForFamily({
      schoolId: inv.school_id,
      familyId: inv.family_id,
      stripeAccountId: acct.stripe_account_id,
    });
  } catch (err) {
    console.error('[create-payment-intent] ensureStripeCustomer failed:', err);
    // Non-fatal — we can still charge a one-off without a Customer.
  }

  // Create or retrieve PaymentIntent.
  // Idempotency key keyed on (invoice, rail, save_for_future_use) so
  // toggling the save checkbox doesn't reuse a stale PI.
  const idempotencyKey = `pi-${inv.id}-${rail}-${saveForFutureUse ? 'save' : 'oneoff'}`;

  const piParams: import('stripe').Stripe.PaymentIntentCreateParams = {
    amount: breakdown.total_cents,
    currency,
    payment_method_types: rail === 'card' ? ['card'] : ['us_bank_account'],
    application_fee_amount: breakdown.platform_fee_cents > 0 ? breakdown.platform_fee_cents : undefined,
    description: `${inv.invoice_number} · ${inv.title}`,
    metadata: {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      family_id: inv.family_id,
      school_id: inv.school_id,
      rail,
      save_for_future_use: saveForFutureUse ? 'true' : 'false',
    },
    statement_descriptor_suffix: inv.invoice_number.slice(0, 22),
    customer: stripeCustomerId ?? undefined,
    // setup_future_usage: 'off_session' tells Stripe to save the PM
    // for autopay use after the parent finishes this checkout.
    setup_future_usage: saveForFutureUse ? 'off_session' : undefined,
  };

  // For ACH, request Financial Connections to verify the account.
  if (rail === 'us_bank_account') {
    piParams.payment_method_options = {
      us_bank_account: {
        financial_connections: {
          permissions: ['payment_method', 'balances'],
        },
        verification_method: 'automatic',
      },
    };
  }

  try {
    const pi = await stripe().paymentIntents.create(piParams, {
      idempotencyKey,
      stripeAccount: acct.stripe_account_id,
    });

    // Persist a pending payments row so we have a local pointer immediately
    // (webhook updates status on success/failure).
    await query(
      `INSERT INTO payments
         (school_id, invoice_id, family_id, stripe_payment_intent_id,
          stripe_payment_method_type, amount_cents, platform_fee_cents, status,
          paid_by_parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
         amount_cents = EXCLUDED.amount_cents,
         platform_fee_cents = EXCLUDED.platform_fee_cents,
         updated_at = now()`,
      [
        inv.school_id, inv.id, inv.family_id, pi.id,
        rail, breakdown.total_cents, breakdown.platform_fee_cents,
        session.parent_id,
      ],
    );

    return NextResponse.json({
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      amount_cents: breakdown.total_cents,
      fee_breakdown: breakdown,
      stripe_account_id: acct.stripe_account_id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-payment-intent] failed:', msg);
    return NextResponse.json({ error: 'stripe_error', detail: msg }, { status: 500 });
  }
}
