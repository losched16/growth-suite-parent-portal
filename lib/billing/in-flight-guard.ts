// Refuse to start a second payment for an invoice that already has one
// in flight.
//
// The autopay cron has always had this guard (a NOT EXISTS on pending /
// processing payments) because ACH leaves an invoice 'open' for the 3-5
// business days it takes to settle, and without it the nightly run
// re-debited the family every morning. The parent-facing routes never had
// it: Stripe's idempotency key (`pi-<invoice>-<rail>-<save>`) only
// collapses repeat attempts inside a 24-hour window, so a parent who pays,
// sees the invoice still reading "open" two days later, and pays again
// gets debited twice. NLMA/Evenson: two $825 ACH debits, Sept 1 and
// Sept 3, against one $820 invoice.
//
// The local payments row alone is NOT enough to decide this. A row is
// written as 'pending' the moment a PaymentIntent is created — which
// happens when the parent opens the pay page, before they have entered
// anything. Blocking on that would lock a parent out of their own invoice
// forever if they ever abandoned a checkout. So we ask Stripe what the
// PaymentIntent actually did, and reconcile abandoned ones on the way past.

import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';

// Money is committed or moving — a second payment would double-debit.
// requires_action covers ACH microdeposit verification, where the parent
// is mid-flow and a second attempt is still the wrong answer.
const IN_FLIGHT = new Set([
  'processing',
  'succeeded',
  'requires_capture',
  'requires_action',
]);

export interface InFlightResult {
  blocked: boolean;
  /** Parent-facing copy; surfaced by PaymentForm as `detail`. */
  message?: string;
}

export async function checkPaymentInFlight(opts: {
  invoiceId: string;
  stripeAccountId: string;
}): Promise<InFlightResult> {
  const { rows } = await query<{
    id: string;
    stripe_payment_intent_id: string | null;
    amount_cents: number;
    created_at: Date;
  }>(
    `SELECT id, stripe_payment_intent_id, amount_cents, created_at
       FROM payments
      WHERE invoice_id = $1 AND status IN ('pending', 'processing')
      ORDER BY created_at DESC`,
    [opts.invoiceId],
  );
  if (rows.length === 0) return { blocked: false };

  for (const row of rows) {
    // No PaymentIntent to ask about (hand-recorded row) — can't verify,
    // so don't hold the parent's payment hostage to it.
    if (!row.stripe_payment_intent_id) continue;

    let status: string;
    try {
      const pi = await stripe().paymentIntents.retrieve(
        row.stripe_payment_intent_id,
        {},
        { stripeAccount: opts.stripeAccountId },
      );
      status = pi.status;
    } catch (err) {
      // Fail OPEN. A parent who cannot pay calls the office; a guard that
      // silently breaks payments during a Stripe blip is worse than the
      // rare duplicate this is meant to catch.
      console.error('[in-flight-guard] could not retrieve PI', row.stripe_payment_intent_id, err);
      continue;
    }

    if (IN_FLIGHT.has(status)) {
      const when = row.created_at.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric',
      });
      const amount = `$${(row.amount_cents / 100).toFixed(2)}`;
      return {
        blocked: true,
        message:
          `A ${amount} payment for this invoice was submitted on ${when} and is still clearing. ` +
          `Bank transfers take 3-5 business days to settle, and the invoice stays open until they do. ` +
          `Please don't pay again — contact the school office if you think this is a mistake.`,
      };
    }

    // requires_payment_method / requires_confirmation / canceled: the
    // parent opened checkout and never finished. Settle the stale row so
    // it stops reading as money in flight — it inflates the school's
    // "Payment sent" count and would block this attempt on the next pass.
    await query(
      `UPDATE payments
          SET status = 'failed',
              failure_message = $1,
              updated_at = now()
        WHERE id = $2 AND status IN ('pending', 'processing')`,
      [`Checkout not completed (PaymentIntent ${status})`, row.id],
    ).catch((e) => console.error('[in-flight-guard] could not reconcile stale row:', e));
  }

  return { blocked: false };
}
