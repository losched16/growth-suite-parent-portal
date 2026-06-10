// POST /api/billing/public/create-payment-intent
//
// Public (no-login) sibling of /api/billing/create-payment-intent.
// Used by the tokenized public pay page (/pay/<id>?t=<token>) so a
// recipient who has no parent-portal account — a GHL contact, a
// one-off billee — can still pay an invoice.
//
// Auth = the invoice's public_pay_token (constant-time compared), NOT a
// session. Everything else mirrors the session endpoint: PaymentIntent
// on the school's connected account, application fee for the platform
// setup fee, a pending payments row. Differences: no saved Customer
// (one-off charge) and family_id may be NULL.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';
import { computeFees, type FeeConfig, type PaymentRail } from '@/lib/billing/fee-math';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body { invoice_id?: string; rail?: PaymentRail; pay_token?: string }

function tokenMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(request: NextRequest) {
  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const invoiceId = body.invoice_id;
  const payToken = (body.pay_token ?? '').trim();
  const rail: PaymentRail = body.rail === 'us_bank_account' ? 'us_bank_account' : 'card';
  if (!invoiceId || !payToken) return NextResponse.json({ error: 'missing_params' }, { status: 400 });

  const { rows: invRows } = await query<{
    id: string; school_id: string; family_id: string | null; status: string;
    subtotal_cents: number; platform_fee_cents: number; amount_paid_cents: number;
    invoice_number: string; title: string; public_pay_token: string | null;
  }>(
    `SELECT id, school_id, family_id, status, subtotal_cents, platform_fee_cents,
            amount_paid_cents, invoice_number, title, public_pay_token
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const inv = invRows[0];
  if (!inv) return NextResponse.json({ error: 'invoice_not_found' }, { status: 404 });
  if (!inv.public_pay_token || !tokenMatches(payToken, inv.public_pay_token)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (inv.status === 'paid' || inv.status === 'voided') {
    return NextResponse.json({ error: 'invoice_not_payable', status: inv.status }, { status: 409 });
  }

  const { rows: acctRows } = await query<{ stripe_account_id: string; charges_enabled: boolean }>(
    `SELECT stripe_account_id, charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [inv.school_id],
  );
  const acct = acctRows[0];
  if (!acct || !acct.charges_enabled) {
    return NextResponse.json({ error: 'school_not_ready_for_payments' }, { status: 409 });
  }

  const { rows: cfgRows } = await query<{
    pass_card_fee: boolean; pass_ach_fee: boolean; card_enabled: boolean;
    ach_enabled: boolean; processing_fee_label: string;
  }>(
    `SELECT pass_card_fee, pass_ach_fee, card_enabled, ach_enabled, processing_fee_label
       FROM school_payment_config WHERE school_id = $1`,
    [inv.school_id],
  );
  const cfg: FeeConfig = cfgRows[0] ? {
    passCardFee: cfgRows[0].pass_card_fee, passAchFee: cfgRows[0].pass_ach_fee,
    cardEnabled: cfgRows[0].card_enabled, achEnabled: cfgRows[0].ach_enabled,
    processingFeeLabel: cfgRows[0].processing_fee_label,
  } : { passCardFee: true, passAchFee: false, cardEnabled: true, achEnabled: true, processingFeeLabel: 'Processing fee' };

  if (rail === 'us_bank_account' && !cfg.achEnabled) return NextResponse.json({ error: 'ach_disabled_by_school' }, { status: 400 });
  if (rail === 'card' && !cfg.cardEnabled) return NextResponse.json({ error: 'card_disabled_by_school' }, { status: 400 });

  const subtotalRemaining = Math.max(0, inv.subtotal_cents - Math.max(0, inv.amount_paid_cents - inv.platform_fee_cents));
  const platformFeeRemaining = inv.amount_paid_cents >= inv.platform_fee_cents ? 0 : inv.platform_fee_cents;
  const breakdown = computeFees({ rail, subtotal_cents: subtotalRemaining, platform_fee_cents: platformFeeRemaining, config: cfg });

  const idempotencyKey = `pi-pub-${inv.id}-${rail}`;
  const piParams: import('stripe').Stripe.PaymentIntentCreateParams = {
    amount: breakdown.total_cents,
    currency: 'usd',
    payment_method_types: rail === 'card' ? ['card'] : ['us_bank_account'],
    application_fee_amount: breakdown.platform_fee_cents > 0 ? breakdown.platform_fee_cents : undefined,
    description: `${inv.invoice_number} · ${inv.title}`,
    metadata: {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      family_id: inv.family_id ?? '',
      school_id: inv.school_id,
      rail,
      public: 'true',
    },
    statement_descriptor_suffix: inv.invoice_number.slice(0, 22),
  };
  if (rail === 'us_bank_account') {
    piParams.payment_method_options = {
      us_bank_account: {
        financial_connections: { permissions: ['payment_method', 'balances'] },
        verification_method: 'automatic',
      },
    };
  }

  try {
    const pi = await stripe().paymentIntents.create(piParams, {
      idempotencyKey,
      stripeAccount: acct.stripe_account_id,
    });

    await query(
      `INSERT INTO payments
         (school_id, invoice_id, family_id, stripe_payment_intent_id,
          stripe_payment_method_type, amount_cents, platform_fee_cents, status,
          paid_by_parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL)
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
         amount_cents = EXCLUDED.amount_cents,
         platform_fee_cents = EXCLUDED.platform_fee_cents,
         updated_at = now()`,
      [inv.school_id, inv.id, inv.family_id, pi.id, rail, breakdown.total_cents, breakdown.platform_fee_cents],
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
    console.error('[public/create-payment-intent] failed:', msg);
    return NextResponse.json({ error: 'stripe_error', detail: msg }, { status: 500 });
  }
}
