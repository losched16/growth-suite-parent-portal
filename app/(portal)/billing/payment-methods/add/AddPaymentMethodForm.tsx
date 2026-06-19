'use client';

// AddPaymentMethodForm — save a card / bank account WITHOUT paying.
//
// Mirrors the invoice PaymentForm, but drives a SetupIntent instead of a
// PaymentIntent (no charge). On confirm, Stripe attaches the method to
// the family's Customer and our webhook persists it + wires it into the
// family's autopay tuition installments.
//
// Flow:
//   1. Parent picks card vs bank.
//   2. POST /api/billing/payment-methods/setup-intent → client_secret.
//   3. Mount Stripe Elements; parent enters details.
//   4. confirmSetup → Stripe redirects to returnTo?added=1 on success.

import { useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import {
  Elements, PaymentElement, useStripe, useElements,
} from '@stripe/react-stripe-js';
import { CreditCard, Landmark, Loader2, ShieldCheck } from 'lucide-react';

let _stripePromise: Promise<StripeJs | null> | null = null;
function stripePromise(connectedAccountId?: string) {
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

type Rail = 'card' | 'us_bank_account';

interface Props {
  cardEnabled: boolean;
  achEnabled: boolean;
  // Where to send the parent after the method saves. Validated/allow-listed
  // server-side before being handed in.
  returnTo: string;
}

export function AddPaymentMethodForm({ cardEnabled, achEnabled, returnTo }: Props) {
  const initialRail: Rail = cardEnabled ? 'card' : achEnabled ? 'us_bank_account' : 'card';
  const [rail, setRail] = useState<Rail>(initialRail);
  const [phase, setPhase] = useState<'pick' | 'submitting' | 'stripe' | 'error'>('pick');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeAcctId, setStripeAcctId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function startSetup() {
    setErr(null);
    setPhase('submitting');
    try {
      const r = await fetch('/api/billing/payment-methods/setup-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rail }),
      });
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

  if (phase === 'stripe' && clientSecret && stripeAcctId) {
    return (
      <Elements
        stripe={stripePromise(stripeAcctId)}
        options={{
          clientSecret,
          appearance: { theme: 'stripe', variables: { colorPrimary: 'var(--brand)' as unknown as string, borderRadius: '6px' } },
        }}
      >
        <SetupInner
          railLabel={rail === 'card' ? 'card' : 'bank account'}
          returnTo={returnTo}
          onBack={() => { setPhase('pick'); setClientSecret(null); }}
        />
      </Elements>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        What would you like to add?
      </h2>

      <div className="grid grid-cols-2 gap-2">
        {cardEnabled ? (
          <RailButton
            active={rail === 'card'}
            onClick={() => setRail('card')}
            icon={<CreditCard className="h-5 w-5" />}
            label="Card"
            hint="Visa · Mastercard · Amex · Discover"
          />
        ) : null}
        {achEnabled ? (
          <RailButton
            active={rail === 'us_bank_account'}
            onClick={() => setRail('us_bank_account')}
            icon={<Landmark className="h-5 w-5" />}
            label="Bank account (ACH)"
            hint="Lower fees · 3–5 business days"
          />
        ) : null}
      </div>

      <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900 flex gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          You won&rsquo;t be charged now. This saves your {rail === 'card' ? 'card' : 'bank account'} so your
          tuition installments draft automatically on each due date — and you&rsquo;ll get a receipt every time.
          You can change or remove it anytime.
        </span>
      </div>

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      <button
        type="button"
        onClick={startSetup}
        disabled={phase === 'submitting'}
        className="w-full rounded-md px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        style={{ background: 'var(--brand)' }}
      >
        {phase === 'submitting' ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : null}
        {phase === 'submitting' ? 'Setting up…' : 'Continue'}
      </button>

      <p className="text-[11px] text-gray-500 text-center">
        Securely processed by Stripe. Your details are never stored on our servers.
      </p>
    </div>
  );
}

function RailButton({ active, onClick, icon, label, hint }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-md border-2 px-3 py-3 transition ${
        active ? 'border-emerald-600 bg-emerald-50' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className={active ? 'text-emerald-700' : 'text-gray-500'}>{icon}</div>
      <div className="text-sm font-semibold text-gray-900">{label}</div>
      <div className="text-[10px] text-gray-500">{hint}</div>
    </button>
  );
}

function SetupInner({ railLabel, returnTo, onBack }: {
  railLabel: string;
  returnTo: string;
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

    // Append added=1 so the destination can show a success banner.
    const sep = returnTo.includes('?') ? '&' : '?';
    const returnUrl = `${window.location.origin}${returnTo}${sep}added=1`;
    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    if (error) {
      setErr(error.message ?? 'Could not save your payment method');
      setSubmitting(false);
    }
    // On success Stripe redirects to returnUrl — code below never runs.
  }

  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Add your {railLabel}</h2>
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
        {submitting ? 'Saving…' : 'Save payment method'}
      </button>
    </form>
  );
}
