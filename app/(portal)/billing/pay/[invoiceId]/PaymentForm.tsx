'use client';

// PaymentForm — the parent-facing payment UX with card / ACH toggle.
//
// Flow:
//   1. Compute the live fee breakdown for the currently-selected rail
//      (card vs ACH). Show a clear total + savings hint.
//   2. When the parent clicks Continue, we POST to
//      /api/billing/create-payment-intent which creates a PaymentIntent
//      on the school's connected account and returns the client_secret.
//   3. Mount Stripe Elements (PaymentElement) with the client_secret.
//      Stripe renders the card input or bank-account flow inline.
//   4. On confirm, Stripe takes over: card processing happens client-
//      side; ACH triggers Financial Connections for instant bank verify.
//   5. On success, Stripe redirects to /billing/pay/{id}?success=1; our
//      webhook (server-side) marks the invoice paid.

import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import {
  Elements, PaymentElement, useStripe, useElements,
} from '@stripe/react-stripe-js';
import { CreditCard, Landmark, Loader2 } from 'lucide-react';
import { computeFees, fmtCents, type FeeConfig, type PaymentRail, type FeeBreakdown } from '@/lib/billing/fee-math';

let _stripePromise: Promise<StripeJs | null> | null = null;

function stripePromise(connectedAccountId?: string) {
  // Stripe.js needs the connected account id passed in so client-side
  // operations route to the right merchant. We re-init when it changes.
  if (!_stripePromise) {
    const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!pk) {
      console.error('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY not set');
      return Promise.resolve(null);
    }
    _stripePromise = loadStripe(pk, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);
  }
  return _stripePromise;
}

interface Props {
  invoiceId: string;
  subtotalCents: number;
  platformFeeCents: number;
  owedCents: number;
  feeConfig: FeeConfig;
  // Path to bounce the parent to after a successful payment (e.g. back
  // to the form they were submitting). Validated server-side against an
  // allow-list before being passed in.
  returnTo: string | null;
  // When set, this is a PUBLIC (no-login) pay session: the form posts
  // to the public payment-intent endpoint with this token instead of
  // the session endpoint. Used by the tokenized /pay/<id> page so a
  // non-family recipient can pay. Public sessions never offer
  // save-for-autopay (a one-off billee has no autopay).
  payToken?: string;
}

export function PaymentForm({
  invoiceId, subtotalCents, platformFeeCents, owedCents, feeConfig, returnTo, payToken,
}: Props) {
  const isPublic = !!payToken;
  // Default rail: prefer card (familiar). Operator can change behavior
  // later by adding a "default_rail" column to school_payment_config.
  const initialRail: PaymentRail =
    feeConfig.cardEnabled ? 'card'
    : feeConfig.achEnabled ? 'us_bank_account'
    : 'card';
  const [rail, setRail] = useState<PaymentRail>(initialRail);

  // Live fee math for both rails (so we can show "save $X" hint).
  const cardBreakdown = useMemo(() => computeFees({
    rail: 'card', subtotal_cents: subtotalCents, platform_fee_cents: platformFeeCents, config: feeConfig,
  }), [subtotalCents, platformFeeCents, feeConfig]);
  const achBreakdown = useMemo(() => computeFees({
    rail: 'us_bank_account', subtotal_cents: subtotalCents, platform_fee_cents: platformFeeCents, config: feeConfig,
  }), [subtotalCents, platformFeeCents, feeConfig]);
  const current = rail === 'card' ? cardBreakdown : achBreakdown;
  const savingsCents = cardBreakdown.total_cents - achBreakdown.total_cents;

  // Phase state
  const [phase, setPhase] = useState<'review' | 'stripe' | 'submitting' | 'error'>('review');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeAcctId, setStripeAcctId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Save the payment method for future autopay charges. Default ON —
  // most parents prefer autopay; opt-out is one click.
  const [saveForFutureUse, setSaveForFutureUse] = useState(true);

  async function continueToPay() {
    setErr(null);
    setPhase('submitting');
    try {
      const r = await fetch(
        isPublic ? '/api/billing/public/create-payment-intent' : '/api/billing/create-payment-intent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isPublic
              ? { invoice_id: invoiceId, rail, pay_token: payToken }
              : { invoice_id: invoiceId, rail, save_for_future_use: saveForFutureUse },
          ),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setClientSecret(data.client_secret);
      setStripeAcctId(data.stripe_account_id);
      setPhase('stripe');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
      setPhase('error');
    }
  }

  // Render the Stripe Elements wrapper once we have a client_secret.
  if (phase === 'stripe' && clientSecret && stripeAcctId) {
    return (
      <Elements
        stripe={stripePromise(stripeAcctId)}
        options={{
          clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: 'var(--brand)' as unknown as string,
              borderRadius: '6px',
            },
          },
        }}
      >
        <StripeCheckout
          railLabel={rail === 'card' ? 'card' : 'bank'}
          totalCents={current.total_cents}
          returnTo={returnTo}
          onBack={() => { setPhase('review'); setClientSecret(null); }}
        />
      </Elements>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        How do you want to pay?
      </h2>

      {/* Toggle */}
      <div className="grid grid-cols-2 gap-2">
        {feeConfig.cardEnabled ? (
          <RailButton
            active={rail === 'card'}
            onClick={() => setRail('card')}
            icon={<CreditCard className="h-5 w-5" />}
            label="Card"
            hint="Visa · Mastercard · Amex · Discover"
          />
        ) : null}
        {feeConfig.achEnabled ? (
          <RailButton
            active={rail === 'us_bank_account'}
            onClick={() => setRail('us_bank_account')}
            icon={<Landmark className="h-5 w-5" />}
            label="Bank account (ACH)"
            hint="3-5 business days"
          />
        ) : null}
      </div>

      {/* Live breakdown */}
      <div className="rounded-md bg-gray-50 border border-gray-200 p-3 space-y-1 text-sm">
        <Row label="Subtotal" value={fmtCents(current.subtotal_cents + current.platform_fee_cents)} />
        {current.passed_fee_cents > 0 ? (
          <Row
            label={feeConfig.processingFeeLabel + (rail === 'card' ? ' (card)' : ' (bank)')}
            value={fmtCents(current.passed_fee_cents)}
          />
        ) : null}
        <div className="border-t border-gray-300 pt-1 mt-1 flex items-baseline justify-between">
          <span className="font-semibold text-gray-900">Total today</span>
          <span className="text-lg font-bold font-mono">{fmtCents(current.total_cents)}</span>
        </div>
        {savingsCents > 0 && rail === 'card' && feeConfig.achEnabled ? (
          <p className="mt-2 text-xs text-emerald-700">
            💡 Pay by bank to save {fmtCents(savingsCents)} on processing fees.
          </p>
        ) : null}
        {savingsCents > 0 && rail === 'us_bank_account' ? (
          <p className="mt-2 text-xs text-emerald-700">
            ✓ You&rsquo;re saving {fmtCents(savingsCents)} vs paying by card.
          </p>
        ) : null}
        {current.passed_fee_cents === 0 ? (
          <p className="mt-2 text-xs text-gray-500">
            The school is covering processing fees, so no fees added to your total.
          </p>
        ) : null}
      </div>

      {/* Save-for-future-autopay opt-in. Hidden for public (no-login)
          payers — a one-off billee has no portal account to autopay. */}
      {!isPublic ? (
        <label className="flex items-start gap-2 text-sm rounded-md border border-gray-200 bg-white p-3">
          <input
            type="checkbox"
            checked={saveForFutureUse}
            onChange={(e) => setSaveForFutureUse(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span>
            <strong className="text-gray-900">Save this payment method for future autopay.</strong>
            <span className="block text-xs text-gray-600 mt-0.5">
              Next time an invoice is due, we&rsquo;ll charge this method automatically. You can
              turn this off later from your <span className="underline">Payment methods</span> page.
            </span>
          </span>
        </label>
      ) : null}

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      <button
        type="button"
        onClick={continueToPay}
        disabled={phase === 'submitting' || owedCents <= 0}
        className="w-full rounded-md px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        style={{ background: 'var(--brand)' }}
      >
        {phase === 'submitting' ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : null}
        {phase === 'submitting' ? 'Setting up…' : `Continue to pay ${fmtCents(current.total_cents)}`}
      </button>

      <p className="text-[11px] text-gray-500 text-center">
        Payments are processed securely by Stripe. Your card details are never stored on our servers.
      </p>
    </div>
  );
}

function RailButton({ active, onClick, icon, label, hint }: {
  active: boolean; onClick: () => void;
  icon: React.ReactNode; label: string; hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-md border-2 px-3 py-3 transition ${
        active
          ? 'border-emerald-600 bg-emerald-50'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className={active ? 'text-emerald-700' : 'text-gray-500'}>{icon}</div>
      <div className="text-sm font-semibold text-gray-900">{label}</div>
      <div className="text-[10px] text-gray-500">{hint}</div>
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-gray-700">{label}</span>
      <span className="font-mono text-gray-900">{value}</span>
    </div>
  );
}

// ─── Inner Stripe Elements component ──────────────────────────────────
function StripeCheckout({ railLabel, totalCents, returnTo, onBack }: {
  railLabel: 'card' | 'bank';
  totalCents: number;
  returnTo: string | null;
  onBack: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setErr(null);

    // Preserve existing query params (notably the public pay `t` token)
    // so the success redirect lands back on a page that still authorizes.
    const sp = new URLSearchParams(window.location.search);
    sp.set('success', '1');
    // Carry the rail through so the success page can tell the parent a BANK
    // payment is still clearing (days) vs a card that's already done — without
    // it, ACH shows "Payment received" and the parent thinks it's instant.
    if (railLabel === 'bank') sp.set('rail', 'ach');
    if (returnTo) sp.set('return_to', returnTo);
    const returnUrl = `${window.location.origin}${window.location.pathname}?${sp.toString()}`;
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    if (error) {
      setErr(error.message ?? 'Payment failed');
      setSubmitting(false);
    }
    // On success Stripe redirects to returnUrl — we never reach this code.
  }

  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          Pay {fmtCents(totalCents)} by {railLabel}
        </h2>
        <button type="button" onClick={onBack} className="text-xs text-gray-500 hover:text-gray-700">
          ← Change
        </button>
      </div>

      <PaymentElement />

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full rounded-md px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        style={{ background: 'var(--brand)' }}
      >
        {submitting ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : null}
        {submitting ? 'Processing…' : `Pay ${fmtCents(totalCents)}`}
      </button>
    </form>
  );
}
