// POST /api/pay/checkout
//
// Public endpoint — no auth. Anyone can hit this, validate the product
// + amount, get back a Stripe Checkout Session URL, then redirect.
//
// Charges flow through the SCHOOL'S Stripe Connect account
// (`stripeAccount` header). We pre-create a `product_purchases` row in
// pending status so even if the buyer abandons checkout, we know they
// started — useful for funnel analytics + GHL lead tagging.
//
// One-time + donation → Checkout in 'payment' mode.
// Recurring         → Checkout in 'subscription' mode.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { stripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  school_slug: string;
  product_id: string;
  email: string;
  name: string;
  phone?: string | null;
  quantity: number;
  unit_amount_cents: number;  // for donation, this is the chosen amount; quantity always 1
  source_ref?: string | null;
}

interface SchoolRow {
  id: string;
  name: string;
  ghl_location_id: string | null;
}
interface ProductRow {
  id: string;
  school_id: string;
  slug: string;
  name: string;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents: number | null;
  suggested_amounts_cents: number[] | null;
  donation_min_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  max_quantity: number | null;
  available_to: string;
  is_active: boolean;
  available_from: string | null;
  available_until: string | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
}
interface PaymentAccountRow {
  stripe_account_id: string;
  charges_enabled: boolean;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Basic input sanity
  if (!body.school_slug || !body.product_id || !body.email || !body.name) {
    return NextResponse.json({ error: 'missing_required_fields' }, { status: 400 });
  }

  // Resolve school
  const schoolRows = (await query<SchoolRow>(
    `SELECT id, name, ghl_location_id FROM schools
      WHERE ghl_location_id = $1 OR id::text = $1 LIMIT 1`,
    [body.school_slug],
  )).rows;
  if (schoolRows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }
  const school = schoolRows[0];

  // Resolve product, scoped to school
  const productRows = (await query<ProductRow>(
    `SELECT * FROM school_products WHERE id = $1 AND school_id = $2`,
    [body.product_id, school.id],
  )).rows;
  if (productRows.length === 0) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
  }
  const product = productRows[0];

  // Availability re-check (server side, since the page check is best-effort)
  if (!product.is_active) {
    return NextResponse.json({ error: 'product_inactive' }, { status: 410 });
  }
  if (product.available_to === 'parents') {
    return NextResponse.json({ error: 'parents_only' }, { status: 403 });
  }
  const now = new Date();
  if (product.available_from && new Date(product.available_from) > now) {
    return NextResponse.json({ error: 'not_yet_available' }, { status: 403 });
  }
  if (product.available_until && new Date(product.available_until) < now) {
    return NextResponse.json({ error: 'sales_ended' }, { status: 410 });
  }

  // Quantity sanity
  const qty = Math.max(1, Math.floor(body.quantity || 1));
  const maxQty = product.max_quantity ?? 999;
  if (qty > maxQty) {
    return NextResponse.json({ error: 'quantity_exceeds_max', detail: `Max ${maxQty} per purchase.` }, { status: 400 });
  }

  // Amount sanity per product type
  const unit = Math.max(0, Math.floor(body.unit_amount_cents || 0));
  if (product.product_type === 'donation') {
    const min = product.donation_min_cents ?? 100;
    if (unit < min) {
      return NextResponse.json({ error: 'amount_below_min', detail: `Minimum is $${(min/100).toFixed(2)}.` }, { status: 400 });
    }
  } else {
    if (!product.price_cents || unit !== product.price_cents) {
      return NextResponse.json({ error: 'amount_mismatch', detail: 'Price changed — please refresh the page.' }, { status: 409 });
    }
  }
  const totalCents = unit * qty;

  // School's Stripe Connect account
  const paRows = (await query<PaymentAccountRow>(
    `SELECT stripe_account_id, charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [school.id],
  )).rows;
  if (paRows.length === 0 || !paRows[0].stripe_account_id) {
    return NextResponse.json({ error: 'school_not_connected', detail: 'School has not set up payments yet.' }, { status: 503 });
  }
  if (!paRows[0].charges_enabled) {
    return NextResponse.json({ error: 'school_not_charges_enabled', detail: 'School is still completing payment setup.' }, { status: 503 });
  }
  const stripeAccount = paRows[0].stripe_account_id;

  // 1. Insert a pending purchase row so we have an audit trail even if checkout is abandoned
  const purchaseRow = (await query<{ id: string }>(
    `INSERT INTO product_purchases (
       school_id, product_id,
       purchaser_email, purchaser_name, purchaser_phone,
       quantity, unit_amount_cents, total_amount_cents,
       status, source, source_ref,
       ip_address, user_agent
     ) VALUES (
       $1, $2,
       $3, $4, $5,
       $6, $7, $8,
       'pending', 'hosted_link', $9,
       $10, $11
     ) RETURNING id`,
    [
      school.id, product.id,
      body.email.toLowerCase().trim(), body.name.trim(), body.phone ?? null,
      qty, unit, totalCents,
      body.source_ref ?? null,
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      request.headers.get('user-agent') ?? null,
    ],
  )).rows[0];

  // 2. Build the Stripe Checkout Session
  const origin = request.headers.get('origin')
    || `https://${request.headers.get('host') ?? 'growth-suite-parent-portal.vercel.app'}`;
  const successUrl = `${origin}/pay/${body.school_slug}/${product.slug}/thanks?purchase=${purchaseRow.id}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/pay/${body.school_slug}/${product.slug}?canceled=1`;

  const s = stripe();

  try {
    if (product.product_type === 'recurring') {
      // For subscriptions we need a Stripe Price object on the school's
      // connected account. Lazy-create one on first use, then reuse.
      let priceId = product.stripe_price_id;
      if (!priceId) {
        const created = await s.prices.create(
          {
            unit_amount: unit,
            currency: 'usd',
            recurring: { interval: product.recurring_interval ?? 'month' },
            product_data: { name: product.name },
          },
          { stripeAccount },
        );
        priceId = created.id;
        await query(
          `UPDATE school_products SET stripe_price_id = $1, updated_at = now() WHERE id = $2`,
          [priceId, product.id],
        );
      }

      const session = await s.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: qty }],
          customer_email: body.email.toLowerCase().trim(),
          subscription_data: {
            metadata: {
              gs_purchase_id: purchaseRow.id,
              gs_school_id: school.id,
              gs_product_id: product.id,
            },
            description: `${school.name} — ${product.name}`,
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: {
            gs_purchase_id: purchaseRow.id,
            gs_school_id: school.id,
            gs_product_id: product.id,
            gs_source_ref: body.source_ref ?? '',
          },
        },
        { stripeAccount },
      );

      // Record the session id so the webhook can correlate
      await query(
        `UPDATE product_purchases SET stripe_subscription_id = $1, updated_at = now() WHERE id = $2`,
        [session.subscription ? String(session.subscription) : null, purchaseRow.id],
      );

      return NextResponse.json({ ok: true, url: session.url });
    }

    // one_time or donation → 'payment' mode
    const session = await s.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: unit,
              product_data: { name: product.name },
            },
            quantity: qty,
          },
        ],
        customer_email: body.email.toLowerCase().trim(),
        payment_intent_data: {
          description: `${school.name} — ${product.name}`,
          metadata: {
            gs_purchase_id: purchaseRow.id,
            gs_school_id: school.id,
            gs_product_id: product.id,
            gs_source_ref: body.source_ref ?? '',
          },
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          gs_purchase_id: purchaseRow.id,
          gs_school_id: school.id,
          gs_product_id: product.id,
        },
      },
      { stripeAccount },
    );

    await query(
      `UPDATE product_purchases SET stripe_payment_intent_id = $1, updated_at = now() WHERE id = $2`,
      [session.payment_intent ? String(session.payment_intent) : null, purchaseRow.id],
    );

    return NextResponse.json({ ok: true, url: session.url });
  } catch (e) {
    // Mark the purchase failed so it doesn't sit pending forever
    await query(
      `UPDATE product_purchases SET status = 'failed', metadata = metadata || $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), purchaseRow.id],
    );
    return NextResponse.json(
      { error: 'stripe_session_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
