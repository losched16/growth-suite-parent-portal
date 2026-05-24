// Off-session autopay charge for a single invoice.
//
// Used by the daily cron (/api/cron/process-autopay). Given an invoice
// that has autopay_enabled + autopay_payment_method_id set, create an
// off-session PaymentIntent on the school's connected account using
// the saved payment method.
//
// On success: webhook handler marks the invoice paid (same path as
// any other payment). On failure: schedule a retry per the school's
// retry_schedule_days config.
//
// Returns one of:
//   { ok: true, payment_intent_id }
//   { ok: false, reason: 'no_account' | 'no_method' | 'requires_action' | 'declined' | 'unknown',
//     message?: string }

import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';
import { computeFees, type FeeConfig, type PaymentRail } from './fee-math';

export interface AutopayChargeResult {
  ok: boolean;
  reason?: 'no_account' | 'no_method' | 'requires_action' | 'declined' | 'unknown';
  message?: string;
  payment_intent_id?: string;
}

interface InvoiceForCharge {
  id: string;
  school_id: string;
  family_id: string;
  invoice_number: string;
  title: string;
  subtotal_cents: number;
  platform_fee_cents: number;
  amount_paid_cents: number;
  autopay_payment_method_id: string | null;
}

export async function chargeAutopayInvoice(invoiceId: string): Promise<AutopayChargeResult> {
  // Load invoice + autopay payment method + school's Stripe account + fee config.
  const { rows: invRows } = await query<InvoiceForCharge>(
    `SELECT id, school_id, family_id, invoice_number, title,
            subtotal_cents, platform_fee_cents, amount_paid_cents,
            autopay_payment_method_id
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const inv = invRows[0];
  if (!inv) return { ok: false, reason: 'unknown', message: 'invoice not found' };
  if (!inv.autopay_payment_method_id) return { ok: false, reason: 'no_method' };

  const { rows: pmRows } = await query<{
    stripe_payment_method_id: string;
    stripe_customer_id: string;
    type: 'card' | 'us_bank_account';
  }>(
    `SELECT stripe_payment_method_id, stripe_customer_id, type
       FROM payment_methods WHERE id = $1 AND active = true`,
    [inv.autopay_payment_method_id],
  );
  const pm = pmRows[0];
  if (!pm) return { ok: false, reason: 'no_method', message: 'payment method not active' };

  const { rows: acctRows } = await query<{ stripe_account_id: string; charges_enabled: boolean }>(
    `SELECT stripe_account_id, charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [inv.school_id],
  );
  const acct = acctRows[0];
  if (!acct || !acct.charges_enabled) return { ok: false, reason: 'no_account' };

  const { rows: cfgRows } = await query<{
    pass_card_fee: boolean;
    pass_ach_fee: boolean;
    card_enabled: boolean;
    ach_enabled: boolean;
    processing_fee_label: string;
  }>(
    `SELECT pass_card_fee, pass_ach_fee, card_enabled, ach_enabled, processing_fee_label
       FROM school_payment_config WHERE school_id = $1`,
    [inv.school_id],
  );
  const cfg: FeeConfig = cfgRows[0] ? {
    passCardFee: cfgRows[0].pass_card_fee,
    passAchFee: cfgRows[0].pass_ach_fee,
    cardEnabled: cfgRows[0].card_enabled,
    achEnabled: cfgRows[0].ach_enabled,
    processingFeeLabel: cfgRows[0].processing_fee_label,
  } : { passCardFee: true, passAchFee: false, cardEnabled: true, achEnabled: true, processingFeeLabel: 'Processing fee' };

  const rail: PaymentRail = pm.type === 'us_bank_account' ? 'us_bank_account' : 'card';
  const subtotalRemaining = Math.max(0, inv.subtotal_cents - Math.max(0, inv.amount_paid_cents - inv.platform_fee_cents));
  const platformFeeRemaining = inv.amount_paid_cents >= inv.platform_fee_cents ? 0 : inv.platform_fee_cents;
  const breakdown = computeFees({ rail, subtotal_cents: subtotalRemaining, platform_fee_cents: platformFeeRemaining, config: cfg });

  if (breakdown.total_cents <= 0) return { ok: false, reason: 'unknown', message: 'nothing owed' };

  // Idempotency: use a key tied to (invoice, attempt_count) so retries
  // create new PaymentIntents but a single attempt is idempotent.
  const { rows: attemptRow } = await query<{ retry_attempt_count: number }>(
    `SELECT retry_attempt_count FROM invoices WHERE id = $1`, [inv.id],
  );
  const attemptCount = attemptRow[0]?.retry_attempt_count ?? 0;
  const idempotencyKey = `autopay-${inv.id}-${attemptCount}`;

  try {
    const pi = await stripe().paymentIntents.create(
      {
        amount: breakdown.total_cents,
        currency: 'usd',
        customer: pm.stripe_customer_id,
        payment_method: pm.stripe_payment_method_id,
        payment_method_types: [pm.type],
        application_fee_amount: breakdown.platform_fee_cents > 0 ? breakdown.platform_fee_cents : undefined,
        confirm: true,
        off_session: true,
        description: `${inv.invoice_number} · ${inv.title} (autopay)`,
        metadata: {
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          family_id: inv.family_id,
          school_id: inv.school_id,
          rail,
          autopay: 'true',
          attempt: String(attemptCount + 1),
        },
        statement_descriptor_suffix: inv.invoice_number.slice(0, 22),
      },
      {
        idempotencyKey,
        stripeAccount: acct.stripe_account_id,
      },
    );

    // Persist a pending payments row so the webhook update can find it.
    await query(
      `INSERT INTO payments
         (school_id, invoice_id, family_id, stripe_payment_intent_id,
          stripe_payment_method_type, stripe_payment_method_id,
          amount_cents, platform_fee_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
         amount_cents = EXCLUDED.amount_cents,
         platform_fee_cents = EXCLUDED.platform_fee_cents,
         updated_at = now()`,
      [
        inv.school_id, inv.id, inv.family_id, pi.id,
        pm.type, pm.stripe_payment_method_id,
        breakdown.total_cents, breakdown.platform_fee_cents,
      ],
    );

    if (pi.status === 'succeeded' || pi.status === 'processing') {
      return { ok: true, payment_intent_id: pi.id };
    }
    if (pi.status === 'requires_action' || pi.status === 'requires_payment_method') {
      return { ok: false, reason: 'requires_action', message: 'Payment requires customer action (e.g., 3D Secure)' };
    }
    return { ok: false, reason: 'unknown', message: `PaymentIntent status: ${pi.status}` };
  } catch (err) {
    // Stripe throws on declines / errors. Categorize by type.
    const e = err as { type?: string; code?: string; message?: string; raw?: { decline_code?: string } };
    const msg = e.message ?? String(err);
    if (e.type === 'StripeCardError' || e.code === 'card_declined' || e.code === 'insufficient_funds') {
      return { ok: false, reason: 'declined', message: msg };
    }
    if (e.code === 'authentication_required') {
      return { ok: false, reason: 'requires_action', message: msg };
    }
    return { ok: false, reason: 'unknown', message: msg };
  }
}
