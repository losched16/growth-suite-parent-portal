'use client';

// PaymentMethodGate — embedded card-on-file step for the enrollment form.
//
// Saves a payment method via a SetupIntent (NO charge), inline, so the parent
// never leaves the form. Unlike the standalone AddPaymentMethodForm (which
// uses a return_url redirect), this uses confirmSetup({ redirect: 'if_required' })
// so a normal card resolves in place and just flips the submit gate on. Only
// cards that genuinely require 3-D Secure will redirect — and they come back
// to the same URL with ?pm_added=1, which the form treats as "card on file".
//
// The submit gate keys off the CLIENT confirm result (onSaved), not the
// payment_method.attached webhook — so a misconfigured webhook can never trap
// a parent who has successfully saved a card.

import { useState } from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import {
  Elements, PaymentElement, useStripe, useElements,
} from '@stripe/react-stripe-js';
import { CreditCard, Landmark, Loader2, ShieldCheck, CheckCircle2 } from 'lucide-react';

let _stripePromise: Promise<StripeJs | null> | null = null;
function stripePromise(connectedAccountId?: string) {
  if (!_stripePromise) {
    const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!pk) { console.error('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY not set'); return Promise.resolve(null); }
    _stripePromise = loadStripe(pk, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);
  }
  return _stripePromise;
}

type Rail = 'card' | 'us_bank_account';

export function PaymentMethodGate({
  hasMethodOnFile, cardEnabled, achEnabled, onSaved,
}: {
  hasMethodOnFile: boolean;
  cardEnabled: boolean;
  achEnabled: boolean;
  onSaved: () => void;
}) {
  const [saved, setSaved] = useState(hasMethodOnFile);
  const [rail, setRail] = useState<Rail>(cardEnabled ? 'card' : 'us_bank_account');
  const [phase, setPhase] = useState<'pick' | 'submitting' | 'stripe' | 'error'>('pick');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [acctId, setAcctId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (saved) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 flex items-center gap-2 text-sm text-emerald-900">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>Payment method on file — you&rsquo;re all set to submit. <span className="text-emerald-700">No charge today.</span></span>
      </div>
    );
  }

  async function start() {
    setErr(null); setPhase('submitting');
    try {
      const r = await fetch('/api/billing/payment-methods/setup-intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rail }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || j.error || `HTTP ${r.status}`); }
      const d = await r.json();
      setClientSecret(d.client_secret); setAcctId(d.stripe_account_id); setPhase('stripe');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong'); setPhase('error');
    }
  }

  function markSaved() { setSaved(true); onSaved(); }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        Payment method required to submit
      </div>
      <div className="rounded-md bg-white border border-amber-200 p-2.5 text-xs text-gray-700 flex gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-emerald-600" />
        <span>
          We save your payment method to automatically pay the schedule above on each due date.{' '}
          <strong>You are not charged today.</strong> You can change or remove it anytime.
        </span>
      </div>

      {phase === 'stripe' && clientSecret && acctId ? (
        <Elements
          stripe={stripePromise(acctId)}
          options={{ clientSecret, appearance: { theme: 'stripe', variables: { borderRadius: '6px' } } }}
        >
          <GateInner onSaved={markSaved} onBack={() => { setPhase('pick'); setClientSecret(null); }} />
        </Elements>
      ) : (
        <>
          {cardEnabled && achEnabled ? (
            <div className="grid grid-cols-2 gap-2">
              <RailBtn active={rail === 'card'} onClick={() => setRail('card')} icon={<CreditCard className="h-4 w-4" />} label="Card" />
              <RailBtn active={rail === 'us_bank_account'} onClick={() => setRail('us_bank_account')} icon={<Landmark className="h-4 w-4" />} label="Bank (ACH)" />
            </div>
          ) : null}
          {err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{err}</div> : null}
          <button
            type="button"
            onClick={start}
            disabled={phase === 'submitting'}
            className="w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--brand)' }}
          >
            {phase === 'submitting' ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : null}
            {phase === 'submitting' ? 'Setting up…' : 'Add payment method'}
          </button>
        </>
      )}
    </div>
  );
}

function RailBtn({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded-md border-2 px-3 py-2 text-sm font-medium ${
        active ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-gray-200 bg-white text-gray-700'
      }`}
    >
      {icon}{label}
    </button>
  );
}

function GateInner({ onSaved, onBack }: { onSaved: () => void; onBack: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true); setErr(null);
    // Stay on the form. Only methods that NEED a redirect (3-D Secure, ACH
    // micro-deposits) navigate away; they return here with ?pm_added=1.
    const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const returnUrl = `${base}${window.location.search ? '&' : '?'}pm_added=1`;
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: returnUrl },
    });
    if (error) { setErr(error.message ?? 'Could not save your payment method'); setSubmitting(false); return; }
    if (setupIntent && (setupIntent.status === 'succeeded' || setupIntent.status === 'processing')) {
      onSaved(); return;
    }
    // Otherwise the browser is mid-redirect (3-D Secure) — leave it be.
    setSubmitting(false);
  }

  return (
    <div className="space-y-3">
      <PaymentElement />
      {err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{err}</div> : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!stripe || submitting}
          className="rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--brand)' }}
        >
          {submitting ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : null}
          {submitting ? 'Saving…' : 'Save payment method (no charge)'}
        </button>
        <button type="button" onClick={onBack} className="text-xs text-gray-500 hover:text-gray-700">← Change</button>
      </div>
    </div>
  );
}
