'use client';

// Buyer-facing payment form for the hosted payment page. Collects name
// + email + (qty or amount), then POSTs to /api/pay/checkout which
// creates a Stripe Checkout Session on the school's connected account
// and redirects the buyer to Stripe's hosted checkout.
//
// The split is intentional: we don't do Stripe Elements here. Checkout
// is hosted by Stripe → maximum security, minimum compliance surface.

import { useState, useTransition } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

interface ProductLite {
  id: string;
  slug: string;
  name: string;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents: number | null;
  suggested_amounts_cents: number[] | null;
  donation_min_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  max_quantity: number | null;
  per_student: boolean;
}

export function PaymentForm({
  schoolName, product, schoolSlug, defaults, sourceRef,
}: {
  schoolName: string;
  product: ProductLite;
  schoolSlug: string;
  defaults: { email: string; name: string; quantity: number; amount: number | null };
  sourceRef: string | null;
}) {
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(defaults.quantity);
  // Donation-only state: selected suggested amount or custom amount in DOLLARS
  const [donationChoice, setDonationChoice] = useState<number | 'custom' | null>(
    defaults.amount ? 'custom' : null,
  );
  const [customAmount, setCustomAmount] = useState<string>(
    defaults.amount ? String(defaults.amount) : '',
  );

  const maxQty = product.max_quantity ?? 99;

  function computeAmountCents(): number | null {
    if (product.product_type === 'donation') {
      if (donationChoice === null) return null;
      if (donationChoice === 'custom') {
        const n = parseFloat(customAmount);
        if (!Number.isFinite(n) || n <= 0) return null;
        return Math.round(n * 100);
      }
      return donationChoice;
    }
    return (product.price_cents ?? 0) * quantity;
  }

  const totalCents = computeAmountCents();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);

    // Validate
    const email = String(fd.get('email') ?? '').trim();
    const name  = String(fd.get('name') ?? '').trim();
    if (!email || !email.includes('@')) {
      setErr('Please enter a valid email address.');
      return;
    }
    if (!name) {
      setErr('Please enter your name.');
      return;
    }

    let unitAmountCents: number;
    if (product.product_type === 'donation') {
      const total = computeAmountCents();
      if (total == null || total <= 0) {
        setErr('Please pick or enter a donation amount.');
        return;
      }
      const min = product.donation_min_cents ?? 100;
      if (total < min) {
        setErr(`Minimum donation is $${(min / 100).toFixed(2)}.`);
        return;
      }
      unitAmountCents = total;
    } else {
      unitAmountCents = product.price_cents ?? 0;
    }

    startTransition(async () => {
      try {
        const r = await fetch('/api/pay/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            school_slug: schoolSlug,
            product_id: product.id,
            email,
            name,
            phone: String(fd.get('phone') ?? '').trim() || null,
            quantity: product.product_type === 'donation' ? 1 : quantity,
            unit_amount_cents: unitAmountCents,
            source_ref: sourceRef,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || (body as { error?: string }).error || `HTTP ${r.status}`);
        }
        const body = (await r.json()) as { url?: string };
        if (!body.url) throw new Error('No checkout URL returned.');
        // Redirect to Stripe Checkout
        window.location.href = body.url;
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not start checkout.');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 sm:p-6">
      {/* Donation flow */}
      {product.product_type === 'donation' ? (
        <div className="space-y-3">
          <div className="text-sm font-medium text-gray-800">Pick an amount</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(product.suggested_amounts_cents ?? []).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setDonationChoice(c)}
                className={`rounded-md border-2 px-3 py-3 text-base font-semibold ${
                  donationChoice === c
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50'
                }`}
              >
                ${(c / 100).toFixed(0)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setDonationChoice('custom')}
              className={`rounded-md border-2 px-3 py-3 text-sm font-medium ${
                donationChoice === 'custom'
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              Other
            </button>
          </div>
          {donationChoice === 'custom' ? (
            <div className="flex items-center gap-1">
              <span className="text-gray-500">$</span>
              <input
                type="number"
                step="0.01"
                min={product.donation_min_cents ? (product.donation_min_cents / 100).toFixed(2) : '1'}
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                className="w-full max-w-[10rem] rounded-md border border-gray-300 bg-white px-3 py-2 text-base focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
                autoFocus
              />
              {product.donation_min_cents ? (
                <span className="text-[11px] text-gray-500 ml-2">
                  min ${(product.donation_min_cents / 100).toFixed(2)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Quantity selector for one-time/recurring (if max > 1) */}
      {product.product_type !== 'donation' && (product.max_quantity ?? 1) > 1 ? (
        <div>
          <label className="text-sm font-medium text-gray-800">Quantity</label>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              className="rounded-md border border-gray-300 bg-white w-9 h-9 text-lg"
            >−</button>
            <input
              type="number"
              min={1}
              max={maxQty}
              value={quantity}
              onChange={(e) => setQuantity(Math.min(maxQty, Math.max(1, Number(e.target.value) || 1)))}
              className="w-20 rounded-md border border-gray-300 bg-white px-3 py-2 text-base text-center"
            />
            <button
              type="button"
              onClick={() => setQuantity(Math.min(maxQty, quantity + 1))}
              className="rounded-md border border-gray-300 bg-white w-9 h-9 text-lg"
            >+</button>
            <span className="text-[11px] text-gray-500 ml-2">max {maxQty}</span>
          </div>
        </div>
      ) : null}

      {/* Buyer info */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-800">Your name <span className="text-rose-600">*</span></span>
          <input
            name="name"
            type="text"
            required
            defaultValue={defaults.name}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-800">Email <span className="text-rose-600">*</span></span>
          <input
            name="email"
            type="email"
            required
            defaultValue={defaults.email}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-medium text-gray-800">Phone (optional)</span>
        <input
          name="phone"
          type="tel"
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
        />
      </label>

      {/* Error */}
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {err}
        </div>
      ) : null}

      {/* Total + Submit */}
      <div className="border-t border-gray-100 pt-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-base text-gray-900">
          <span className="text-gray-500 text-sm">Total: </span>
          <span className="font-semibold">
            {totalCents == null
              ? '—'
              : `$${(totalCents / 100).toFixed(2)}`}
          </span>
          {product.product_type === 'recurring' && product.recurring_interval ? (
            <span className="ml-1 text-xs text-gray-500">
              /{product.recurring_interval}
              {product.recurring_installment_count
                ? ` × ${product.recurring_installment_count}`
                : ''}
            </span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={busy || totalCents == null || totalCents <= 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? 'Starting checkout…' : `Pay ${schoolName}`}
        </button>
      </div>
    </form>
  );
}
