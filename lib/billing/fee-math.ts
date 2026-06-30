// Single source of truth for processing-fee math. Used by:
//   - The server when creating a PaymentIntent (final amount to charge)
//   - The client UI for live "If you pay by card you'll owe $X" display
//
// All amounts are INTEGER cents.

export type PaymentRail = 'card' | 'us_bank_account';

export interface FeeConfig {
  passCardFee: boolean;
  passAchFee: boolean;
  cardEnabled: boolean;
  achEnabled: boolean;
  processingFeeLabel: string;
}

export interface FeeBreakdown {
  rail: PaymentRail;
  subtotal_cents: number;          // line items
  platform_fee_cents: number;      // $25 Growth Suite setup fee, only on first plan-setup invoice
  passed_fee_cents: number;        // processing fee shown to parent (0 if school absorbs)
  total_cents: number;             // what the parent pays
  // For display + reporting only — the actual fee Stripe charges the
  // SCHOOL on the destination amount. Schools see this in their Stripe
  // dashboard. Parents never see this number directly.
  estimated_stripe_fee_cents: number;
}

// Stripe US fee schedule (correct as of 2026-05). When Stripe changes
// these we update here in one place.
//   Card: 2.9% + $0.30
//   ACH:  0.8% capped at $5.00
const CARD_PCT = 0.029;
const CARD_FLAT_CENTS = 30;
const ACH_PCT = 0.008;
const ACH_CAP_CENTS = 500;

// Gross-up formula: if we want the school to NET `base` and the parent
// to pay all fees, parent has to pay slightly more so that after Stripe
// takes its cut, `base` lands in the school's account.
//   parent_pays = (base + flat) / (1 - pct)
function grossUpCard(baseCents: number): number {
  if (baseCents <= 0) return 0;
  return Math.ceil((baseCents + CARD_FLAT_CENTS) / (1 - CARD_PCT));
}

function grossUpAch(baseCents: number): number {
  if (baseCents <= 0) return 0;
  // ACH is percentage-only (no flat) but capped, so the gross-up is
  // bounded. Solve iteratively for simplicity — cap kicks in fast.
  const naive = Math.ceil(baseCents / (1 - ACH_PCT));
  const naiveFee = Math.min(Math.ceil(naive * ACH_PCT), ACH_CAP_CENTS);
  if (naiveFee >= ACH_CAP_CENTS) return baseCents + ACH_CAP_CENTS;
  return naive;
}

function stripeFeeFor(rail: PaymentRail, parentPaysCents: number): number {
  if (rail === 'card') {
    return Math.ceil(parentPaysCents * CARD_PCT) + CARD_FLAT_CENTS;
  }
  return Math.min(Math.ceil(parentPaysCents * ACH_PCT), ACH_CAP_CENTS);
}

export function computeFees(input: {
  rail: PaymentRail;
  subtotal_cents: number;
  platform_fee_cents: number;
  config: FeeConfig;
}): FeeBreakdown {
  const { rail, subtotal_cents, platform_fee_cents, config } = input;
  const baseToCover = subtotal_cents + platform_fee_cents;

  // Is the school passing this rail's fee to the parent?
  const passThisRail = rail === 'card' ? config.passCardFee : config.passAchFee;

  let totalCents: number;
  let passedFee: number;

  if (passThisRail) {
    // Parent covers fee. Gross-up so school nets `baseToCover` exactly.
    totalCents = rail === 'card' ? grossUpCard(baseToCover) : grossUpAch(baseToCover);
    passedFee = totalCents - baseToCover;
  } else {
    // School absorbs fee. Parent pays the base.
    totalCents = baseToCover;
    passedFee = 0;
  }

  return {
    rail,
    subtotal_cents,
    platform_fee_cents,
    passed_fee_cents: passedFee,
    total_cents: totalCents,
    estimated_stripe_fee_cents: stripeFeeFor(rail, totalCents),
  };
}

export function fmtCents(cents: number): string {
  // Thousands separators + currency formatting, e.g. 1625000 -> "$16,250.00".
  // (Previously "$16250.00" — no comma, which looked unpolished on forms.)
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
