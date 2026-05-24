// Stripe API client for the parent portal.
//
// Used for: PaymentIntents (with destination=school connected account +
// application_fee_amount routing $25 to the platform), Stripe Elements,
// Financial Connections, and webhook signature verification.
//
// Env vars:
//   STRIPE_SECRET_KEY            sk_test_... (or sk_live_...)
//   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  pk_test_... (or pk_live_...) — frontend
//   STRIPE_WEBHOOK_SECRET        whsec_... (set after webhook is registered)
//   STRIPE_PLATFORM_FAMILY_SETUP_FEE_CENTS  default 2500 — one-time per family

import Stripe from 'stripe';

let _stripe: Stripe | undefined;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is required');
  _stripe = new Stripe(key, {
    apiVersion: '2026-04-22.dahlia',
    typescript: true,
  });
  return _stripe;
}

export function familySetupFeeCents(): number {
  const raw = process.env.STRIPE_PLATFORM_FAMILY_SETUP_FEE_CENTS;
  if (!raw) return 2500;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}
