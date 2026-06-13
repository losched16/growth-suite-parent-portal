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
import { sendPaymentEventToGhl } from '@/lib/billing/ghl-receipt';
import { writebackProductPurchaseToGhl } from '@/lib/ghl/product-writeback';
import { chargeAutopayInvoice } from '@/lib/billing/autopay-charge';
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

  // Pre-insert the log row in 'received' state so even if processing
  // throws, we have a record of receipt. Resolves school_id by joining
  // event.account to payment_accounts.stripe_account_id (NULL if no
  // match — typically only on the FIRST account.updated for a fresh
  // OAuth connect, before payment_accounts has been touched).
  const stripeAccountId = event.account ?? null;
  let resolvedSchoolId: string | null = null;
  if (stripeAccountId) {
    const r = await query<{ id: string }>(
      `SELECT school_id AS id FROM payment_accounts WHERE stripe_account_id = $1`,
      [stripeAccountId],
    ).catch(() => null);
    resolvedSchoolId = r?.rows[0]?.id ?? null;
  }
  await query(
    `INSERT INTO stripe_webhook_log
       (event_id, event_type, payload, school_id, stripe_account_id,
        livemode, status, stripe_created_at, received_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'received', to_timestamp($7), now())
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.id, event.type, JSON.stringify(event.data.object),
      resolvedSchoolId, stripeAccountId,
      event.livemode, event.created,
    ],
  ).catch((e) => console.error('[stripe/webhook] log insert failed:', e));

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;

      // Scale gap #4 — disconnect handler. Fires when a school
      // revokes our platform's access from their Stripe dashboard.
      // We mark the payment_accounts row as disconnected so the
      // autopay cron skips it and the Stripe pill on the Payments
      // hub goes back to "not connected." Future invoices will
      // generate but charges will fail until the school re-connects.
      case 'account.application.deauthorized':
        if (stripeAccountId) {
          await query(
            `UPDATE payment_accounts
                SET charges_enabled = false,
                    payouts_enabled = false,
                    requirements_currently_due = '["disconnected_by_school"]'::jsonb,
                    last_synced_at = now(),
                    updated_at = now()
              WHERE stripe_account_id = $1`,
            [stripeAccountId],
          );
          // Also pause billing for that school so we don't generate
          // invoices we can't charge. Operator can flip back to live
          // after reconnecting Stripe.
          if (resolvedSchoolId) {
            await query(
              `UPDATE school_payment_config
                  SET billing_active = false, updated_at = now()
                WHERE school_id = $1`,
              [resolvedSchoolId],
            );
          }
        }
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

    // Mark as processed (status flips from 'received' → 'processed').
    await query(
      `UPDATE stripe_webhook_log
          SET status = 'processed', processed_at = now()
        WHERE event_id = $1`,
      [event.id],
    ).catch(() => undefined);

    return NextResponse.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe/webhook] handler error:', msg);
    // Mark as failed in the log so the admin viewer can surface it.
    await query(
      `UPDATE stripe_webhook_log
          SET status = 'failed',
              processed_at = now(),
              error_message = $2
        WHERE event_id = $1`,
      [event.id, msg.slice(0, 2000)],
    ).catch(() => undefined);
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

  // Receipt — best-effort, never throws into the webhook ack. Two
  // independent channels, each self-skips if unconfigured: GHL workflow
  // webhook (school owns the template) and Resend email (fallback).
  await sendPaymentEventToGhl(pi.id, { event: 'payment.succeeded' }).catch(() => undefined);
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
  // Failure notice to the parent — best-effort. GHL webhook + Resend
  // fallback, same dual-channel posture as the success path.
  await sendPaymentEventToGhl(pi.id, { event: 'payment.failed', failureReason: lastError?.message ?? null }).catch(() => undefined);
  await sendPaymentFailureEmail(pi.id, lastError?.message ?? null).catch(() => undefined);

  // Scale gap #3 — also notify the school's admin. When autopay fails
  // for a parent, the office finds out today only via the parent calling.
  // Push an email to the school's support address with the invoice +
  // family + failure reason so they can pre-empt the call.
  await notifySchoolOfFailedPayment(pi, lastError?.message ?? null)
    .catch((e) => console.error('[stripe/webhook] school failure notify failed:', e));
}

// Find the invoice this PI was charging, look up the school's notify
// address, send a short alert. Best-effort — never throws.
async function notifySchoolOfFailedPayment(
  pi: Stripe.PaymentIntent,
  errorMessage: string | null,
): Promise<void> {
  const { rows } = await query<{
    invoice_number: string;
    invoice_id: string;
    family_label: string;
    parent_email: string | null;
    school_name: string;
    school_id: string;
    notify_email: string | null;
    amount_cents: number;
  }>(
    `SELECT i.invoice_number, i.id AS invoice_id, i.total_cents AS amount_cents,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed family)') AS family_label,
            p.email AS parent_email,
            s.name AS school_name, s.id AS school_id,
            COALESCE(b.support_email, 'mchadmin@mediachildrenshouse.com') AS notify_email
       FROM invoices i
       JOIN schools s ON s.id = i.school_id
       LEFT JOIN families f ON f.id = i.family_id
       LEFT JOIN parents p ON p.id = i.autopay_payment_method_id::text::uuid OR p.family_id = i.family_id
       LEFT JOIN school_branding b ON b.school_id = s.id
      WHERE i.stripe_payment_intent_id = $1 OR i.id::text = $1
      LIMIT 1`,
    [pi.id],
  ).catch(() => ({ rows: [] }));
  const meta = rows[0];
  if (!meta || !meta.notify_email) return;

  const { sendBrandedEmail } = await import('@/lib/email');
  const dollars = `$${(meta.amount_cents / 100).toFixed(2)}`;
  const subject = `Autopay failed — ${meta.family_label} — ${meta.invoice_number}`;
  const text = `Autopay failed for ${meta.family_label} at ${meta.school_name}.

Invoice: ${meta.invoice_number}
Amount: ${dollars}
Failure reason: ${errorMessage ?? 'unknown'}
Parent email: ${meta.parent_email ?? '(none on file)'}

The parent has been notified separately. You may want to:
- Verify their card on file is still valid
- Reach out if the failure suggests insufficient funds
- Manually charge a different payment method if needed
`;
  const html = `<p>Autopay failed for <strong>${escapeHtml(meta.family_label)}</strong> at <strong>${escapeHtml(meta.school_name)}</strong>.</p>
<ul>
  <li>Invoice: <code>${escapeHtml(meta.invoice_number)}</code></li>
  <li>Amount: <strong>${dollars}</strong></li>
  <li>Failure reason: ${escapeHtml(errorMessage ?? 'unknown')}</li>
  <li>Parent email: ${meta.parent_email ? `<a href="mailto:${escapeHtml(meta.parent_email)}">${escapeHtml(meta.parent_email)}</a>` : '<em>none on file</em>'}</li>
</ul>
<p>The parent has been notified separately. You may want to verify their payment method or reach out about the failure.</p>`;

  await sendBrandedEmail({
    to: meta.notify_email,
    schoolId: meta.school_id,
    subject,
    html,
    text,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  const { rows: pmIns } = await query<{ id: string }>(
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
       updated_at = now()
     RETURNING id`,
    [
      m.school_id, m.family_id, pm.id, pm.customer,
      pm.type, brand, last4, expMonth, expYear,
      shouldBeDefault,
    ],
  );

  // Autopay-by-default: the moment a family saves a card, wire it into
  // their open autopay tuition installments that don't yet have a
  // method — so the schedule drafts automatically and the school never
  // hand-sends a tuition invoice.
  const methodRowId = pmIns[0]?.id;
  if (methodRowId) {
    await query(
      `UPDATE invoices
          SET autopay_payment_method_id = $1, updated_at = now()
        WHERE school_id = $2 AND family_id = $3
          AND status IN ('open', 'partially_paid')
          AND autopay_enabled = true
          AND autopay_payment_method_id IS NULL`,
      [methodRowId, m.school_id, m.family_id],
    );

    // Charge anything already due right now (e.g. a late enrollee whose
    // first installment is past its draft date). Gated on billing_active;
    // skip invoices with a payment already in flight or succeeded so we
    // never double-charge the card the parent just used.
    const { rows: dueNow } = await query<{ id: string }>(
      `SELECT i.id
         FROM invoices i
         JOIN school_payment_config spc ON spc.school_id = i.school_id
        WHERE i.school_id = $1 AND i.family_id = $2
          AND i.status IN ('open', 'partially_paid')
          AND i.autopay_enabled = true
          AND i.autopay_payment_method_id = $3
          AND COALESCE(spc.billing_active, false) = true
          AND COALESCE(i.autopay_charge_on, i.due_at::date) <= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM payments p
             WHERE p.invoice_id = i.id AND p.status IN ('pending', 'processing', 'succeeded')
          )
        ORDER BY i.due_at ASC
        LIMIT 25`,
      [m.school_id, m.family_id, methodRowId],
    );
    for (const d of dueNow) {
      try {
        await chargeAutopayInvoice(d.id);
      } catch (e) {
        console.warn('[stripe/webhook] autopay-on-attach charge failed for', d.id, e instanceof Error ? e.message : String(e));
      }
    }
  }
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

  // Check if this purchase has already been processed (we get one
  // payment_intent.succeeded per actual charge — for one-time this is
  // exactly once, for subscriptions this fires on every billing cycle).
  // We only want to fire the GHL writeback on the FIRST success.
  const wasAlreadySucceeded = await query<{ status: string }>(
    `SELECT status FROM product_purchases WHERE id = $1`,
    [purchaseId],
  ).then((r) => r.rows[0]?.status === 'succeeded');

  await query(
    `UPDATE product_purchases
        SET status = 'succeeded',
            stripe_payment_intent_id = $1,
            stripe_charge_id = $2,
            updated_at = now()
      WHERE id = $3 AND status != 'succeeded'`,
    [pi.id, charge?.id ?? null, purchaseId],
  );

  // Fire GHL writeback on first success only (subsequent subscription
  // cycles don't need to re-stamp). Best-effort — log but don't throw.
  if (!wasAlreadySucceeded) {
    try {
      const result = await writebackProductPurchaseToGhl(purchaseId);
      if (!result.ok) {
        console.warn('[product-purchase] GHL writeback skipped:', result.reason);
      }
    } catch (e) {
      console.error('[product-purchase] GHL writeback error:', e instanceof Error ? e.message : String(e));
      // Don't re-throw — purchase already succeeded, GHL is best-effort
    }
  }
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
