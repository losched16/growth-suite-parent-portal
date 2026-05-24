// POST /api/webhooks/stripe
//
// Single Stripe webhook endpoint for the platform. Handles:
//   - account.updated         → mirror connected-account state into
//                               payment_accounts (charges_enabled, etc.)
//   - payment_intent.succeeded → record payment success
//   - payment_intent.payment_failed → record failure for retry scheduler
//   - charge.refunded         → record refund
//   - invoice.* (later phases)
//
// Signature verification uses STRIPE_WEBHOOK_SECRET.
//
// Note: This endpoint is excluded from session auth via Next.js route
// matchers — Stripe needs to hit it without cookies.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';
import { sendPaymentReceiptEmail, sendPaymentFailureEmail } from '@/lib/billing/send-payment-email';
import type Stripe from 'stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe/webhook] STRIPE_WEBHOOK_SECRET not set');
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }

  const sig = request.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing_signature' }, { status: 400 });

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[stripe/webhook] signature verify failed:', err);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;

      case 'payment_intent.succeeded':
        // First try the standard tuition-invoice path; then try the
        // product-purchase path (idempotent, both no-op if the PI
        // isn't theirs).
        await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        await handleProductPurchaseSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        await handleProductPurchaseFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        await handleProductPurchaseRefunded(event.data.object as Stripe.Charge);
        break;

      // Product catalog: a Checkout Session completed. Pulls out the
      // PI / subscription IDs and stamps them on product_purchases so
      // subsequent payment_intent.* events can match by ID.
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      // Recurring product subscriptions
      case 'invoice.paid':
        await handleSubscriptionInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(event.data.object as Stripe.Subscription);
        break;

      case 'payment_method.attached':
        await handlePaymentMethodAttached(event.data.object as Stripe.PaymentMethod, event.account);
        break;

      case 'payment_method.detached':
        await handlePaymentMethodDetached(event.data.object as Stripe.PaymentMethod);
        break;

      default:
        // Unhandled event types are still ack'd 200 so Stripe doesn't retry.
        // Log so we know what we're ignoring.
        console.log('[stripe/webhook] unhandled event type:', event.type);
    }

    // Audit log every event we process for debugging.
    await query(
      `INSERT INTO stripe_webhook_log (event_id, event_type, payload, processed_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event.data.object)],
    ).catch(() => undefined);

    return NextResponse.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe/webhook] handler error:', msg);
    // Return 500 so Stripe retries. We've logged the issue.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handleAccountUpdated(account: Stripe.Account): Promise<void> {
  await query(
    `UPDATE payment_accounts
        SET charges_enabled = $1,
            payouts_enabled = $2,
            details_submitted = $3,
            requirements_currently_due = $4::jsonb,
            last_synced_at = now(),
            updated_at = now()
      WHERE stripe_account_id = $5`,
    [
      account.charges_enabled,
      account.payouts_enabled,
      account.details_submitted,
      JSON.stringify(account.requirements?.currently_due ?? []),
      account.id,
    ],
  );
}

// Update the local payments + invoices rows when a PaymentIntent
// succeeds. Also stamp families.platform_setup_fee_paid_at when the
// platform fee was charged on this payment.
async function handlePaymentSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  const { rows: pmRows } = await query<{
    id: string; invoice_id: string | null; family_id: string;
    platform_fee_cents: number; amount_cents: number;
  }>(
    `SELECT id, invoice_id, family_id, platform_fee_cents, amount_cents
       FROM payments WHERE stripe_payment_intent_id = $1`,
    [pi.id],
  );
  if (pmRows.length === 0) {
    // Safety net — webhook fired faster than our create-pi handler.
    const invoiceId = pi.metadata?.invoice_id ?? null;
    const familyId = pi.metadata?.family_id ?? null;
    const schoolId = pi.metadata?.school_id ?? null;
    if (invoiceId && familyId && schoolId) {
      await query(
        `INSERT INTO payments
           (school_id, invoice_id, family_id, stripe_payment_intent_id,
            amount_cents, status)
         VALUES ($1, $2, $3, $4, $5, 'succeeded')
         ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
           status = 'succeeded', updated_at = now()`,
        [schoolId, invoiceId, familyId, pi.id, pi.amount_received],
      );
    }
    return;
  }
  const pmRow = pmRows[0];

  const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
  const balanceTxn = charge?.balance_transaction && typeof charge.balance_transaction === 'object'
    ? charge.balance_transaction : null;

  await query(
    `UPDATE payments
        SET status = 'succeeded',
            stripe_charge_id = $1,
            stripe_payment_method_id = $2,
            stripe_payment_method_type = $3,
            fee_cents = $4,
            destination_amount_cents = $5,
            updated_at = now()
      WHERE id = $6`,
    [
      charge?.id ?? null,
      typeof charge?.payment_method === 'string' ? charge.payment_method : null,
      charge?.payment_method_details?.type ?? null,
      balanceTxn?.fee ?? 0,
      pi.amount_received - (pi.application_fee_amount ?? 0),
      pmRow.id,
    ],
  );

  // Bump the invoice's amount_paid + status.
  if (pmRow.invoice_id) {
    await query(
      `UPDATE invoices
          SET amount_paid_cents = amount_paid_cents + $1,
              status = CASE
                WHEN amount_paid_cents + $1 >= total_cents THEN 'paid'
                WHEN amount_paid_cents + $1 > 0 THEN 'partially_paid'
                ELSE status
              END,
              paid_at = CASE
                WHEN amount_paid_cents + $1 >= total_cents THEN now()
                ELSE paid_at
              END,
              updated_at = now()
        WHERE id = $2`,
      [pmRow.amount_cents, pmRow.invoice_id],
    );

    // Close-loop for form-submission invoices: when the invoice is
    // fully paid, flip any linked portal_form_submissions row out of
    // 'pending_payment' into 'paid'. This is what unlocks the form on
    // the parent's history view (and unblocks downstream enrollment).
    await query(
      `UPDATE portal_form_submissions s
          SET status = 'paid', updated_at = now()
         FROM invoices i
        WHERE s.invoice_id = i.id
          AND i.id = $1
          AND i.status = 'paid'
          AND s.status = 'pending_payment'`,
      [pmRow.invoice_id],
    ).catch((e) => console.error('[stripe/webhook] submission close-loop failed:', e));
  }

  // First-time platform fee → stamp the family.
  if (pmRow.platform_fee_cents > 0) {
    await query(
      `UPDATE families
          SET platform_setup_fee_paid_at = COALESCE(platform_setup_fee_paid_at, now())
        WHERE id = $1`,
      [pmRow.family_id],
    );
  }

  // Receipt email — best-effort, never throws into the webhook ack.
  await sendPaymentReceiptEmail(pi.id).catch(() => undefined);
}

async function handlePaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
  const lastError = pi.last_payment_error;
  await query(
    `UPDATE payments
        SET status = 'failed',
            failure_code = $1,
            failure_message = $2,
            updated_at = now()
      WHERE stripe_payment_intent_id = $3`,
    [lastError?.code ?? null, lastError?.message ?? null, pi.id],
  );
  // Failure email — best-effort.
  await sendPaymentFailureEmail(pi.id, lastError?.message ?? null).catch(() => undefined);
}

async function handleChargeRefunded(ch: Stripe.Charge): Promise<void> {
  await query(
    `UPDATE payments
        SET status = CASE WHEN $1 = amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
            updated_at = now()
      WHERE stripe_charge_id = $2`,
    [ch.amount_refunded, ch.id],
  );
  // Mirror refund onto invoice status.
  await query(
    `UPDATE invoices i
        SET status = CASE WHEN p.status = 'refunded' THEN 'refunded' ELSE 'partially_refunded' END,
            updated_at = now()
       FROM payments p
      WHERE p.stripe_charge_id = $1 AND p.invoice_id = i.id`,
    [ch.id],
  );
}

// When Stripe attaches a PaymentMethod to a Customer (because the
// parent clicked "Save for future use" on checkout), mirror it into
// our payment_methods table so the autopay engine + the parent's UI
// can see it.
//
// `event.account` is the connected-account id (the school's Stripe
// account). We use it to scope the lookup to the right school.
async function handlePaymentMethodAttached(
  pm: Stripe.PaymentMethod,
  stripeAccountId: string | undefined,
): Promise<void> {
  if (!pm.customer || typeof pm.customer !== 'string') return; // unattached
  if (!stripeAccountId) {
    console.warn('[stripe/webhook] payment_method.attached without connected account id; skipping');
    return;
  }

  // Look up which (school, family) this Customer maps to. We stored the
  // mapping in families.stripe_customer_ids as { school_id: cus_... }.
  const { rows } = await query<{ school_id: string; family_id: string }>(
    `SELECT s.id AS school_id, f.id AS family_id
       FROM families f
       JOIN payment_accounts pa ON pa.school_id = f.school_id
       JOIN schools s ON s.id = f.school_id
      WHERE pa.stripe_account_id = $1
        AND f.stripe_customer_ids ->> s.id::text = $2`,
    [stripeAccountId, pm.customer],
  );
  const m = rows[0];
  if (!m) {
    console.warn('[stripe/webhook] payment_method.attached for unknown customer:', pm.customer);
    return;
  }

  const isCard = pm.type === 'card';
  const isBank = pm.type === 'us_bank_account';
  if (!isCard && !isBank) return; // unsupported type for our UI

  // Brand / display info
  const brand = isCard ? (pm.card?.brand ?? null) : (pm.us_bank_account?.bank_name ?? null);
  const last4 = isCard ? (pm.card?.last4 ?? null) : (pm.us_bank_account?.last4 ?? null);
  const expMonth = isCard ? (pm.card?.exp_month ?? null) : null;
  const expYear = isCard ? (pm.card?.exp_year ?? null) : null;

  // Should this become the default? If the family has no active methods
  // yet, yes. Otherwise leave the existing default alone.
  const { rows: existing } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payment_methods
       WHERE school_id = $1 AND family_id = $2 AND active = true`,
    [m.school_id, m.family_id],
  );
  const shouldBeDefault = Number(existing[0]?.count ?? 0) === 0;

  await query(
    `INSERT INTO payment_methods
       (school_id, family_id, stripe_payment_method_id, stripe_customer_id,
        type, brand, last4, exp_month, exp_year, is_default, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
     ON CONFLICT (school_id, stripe_payment_method_id) DO UPDATE SET
       brand = EXCLUDED.brand,
       last4 = EXCLUDED.last4,
       exp_month = EXCLUDED.exp_month,
       exp_year = EXCLUDED.exp_year,
       active = true,
       updated_at = now()`,
    [
      m.school_id, m.family_id, pm.id, pm.customer,
      pm.type, brand, last4, expMonth, expYear,
      shouldBeDefault,
    ],
  );
}

async function handlePaymentMethodDetached(pm: Stripe.PaymentMethod): Promise<void> {
  await query(
    `UPDATE payment_methods
        SET active = false, is_default = false, updated_at = now()
      WHERE stripe_payment_method_id = $1`,
    [pm.id],
  );
}

// ─── Product purchases (school_products / product_purchases) ──────────
// These handlers correlate Stripe events back to our product_purchases
// rows using the gs_purchase_id metadata we attached at checkout time.
// All operations are idempotent — a missing metadata tag means it's
// not a product purchase, so we silently no-op.

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const purchaseId = session.metadata?.gs_purchase_id;
  if (!purchaseId) return;  // not a product-purchase session

  const piId  = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  const subId = typeof session.subscription   === 'string' ? session.subscription   : session.subscription?.id   ?? null;

  // Stamp PI / subscription IDs onto the purchase row so subsequent
  // PI events can match. For one-time/donation: the PI will succeed
  // shortly and that fires handleProductPurchaseSucceeded. For
  // subscriptions: invoice.paid fires for each billing cycle.
  await query(
    `UPDATE product_purchases
        SET stripe_payment_intent_id = COALESCE($1, stripe_payment_intent_id),
            stripe_subscription_id   = COALESCE($2, stripe_subscription_id),
            updated_at = now()
      WHERE id = $3`,
    [piId, subId, purchaseId],
  );
}

async function handleProductPurchaseSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  const purchaseId = pi.metadata?.gs_purchase_id;
  if (!purchaseId) return;

  const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;

  await query(
    `UPDATE product_purchases
        SET status = 'succeeded',
            stripe_payment_intent_id = $1,
            stripe_charge_id = $2,
            updated_at = now()
      WHERE id = $3 AND status != 'succeeded'`,
    [pi.id, charge?.id ?? null, purchaseId],
  );

  // TODO (next pass): write back to GHL contact custom field if the
  // product has ghl_writeback_field configured. Look up contact by
  // email, set the field to today's date, optionally trigger workflow.
}

async function handleProductPurchaseFailed(pi: Stripe.PaymentIntent): Promise<void> {
  const purchaseId = pi.metadata?.gs_purchase_id;
  if (!purchaseId) return;
  await query(
    `UPDATE product_purchases
        SET status = 'failed', updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [purchaseId],
  );
}

async function handleProductPurchaseRefunded(charge: Stripe.Charge): Promise<void> {
  const purchaseId = charge.metadata?.gs_purchase_id
    || (typeof charge.payment_intent === 'object' && charge.payment_intent?.metadata?.gs_purchase_id);
  if (!purchaseId) return;
  await query(
    `UPDATE product_purchases
        SET status = 'refunded',
            refunded_at = now(),
            refunded_amount_cents = $1,
            refund_reason = $2,
            updated_at = now()
      WHERE id = $3`,
    [charge.amount_refunded ?? 0, charge.refunds?.data?.[0]?.reason ?? null, purchaseId],
  );
}

async function handleSubscriptionInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  // Stripe API moved the subscription pointer to `parent.subscription_details.subscription`
  // in the 2025 API revision; older invoices still set `subscription` at the top level.
  // We probe both for resilience across API versions.
  const inv = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const rawSub = inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
  const subId  = typeof rawSub === 'string' ? rawSub : rawSub?.id ?? null;
  if (!subId) return;

  // Find the purchase tied to this subscription
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM product_purchases WHERE stripe_subscription_id = $1 LIMIT 1`,
    [subId],
  );
  if (rows.length === 0) return;

  // For recurring products we mark the row 'succeeded' on the first
  // paid invoice. Each subsequent invoice is logged but doesn't change
  // the purchase row's status — the row represents the subscription
  // overall. Per-billing-cycle granularity will come in a separate
  // table (product_subscription_invoices) when we need reporting.
  await query(
    `UPDATE product_purchases
        SET status = 'succeeded', updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [rows[0].id],
  );
}

async function handleSubscriptionCanceled(sub: Stripe.Subscription): Promise<void> {
  await query(
    `UPDATE product_purchases
        SET status = 'canceled', updated_at = now()
      WHERE stripe_subscription_id = $1`,
    [sub.id],
  );
}
