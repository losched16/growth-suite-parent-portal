'use client';

// Client component for picking a payment plan + adjusting add-ons.
// Renders a card per plan option with live per-installment math.
// On submit, POSTs to the enrollment update endpoint which:
//   1. Saves plan + addon selections to family_tuition_enrollments
//   2. Generates the installment schedule
//   3. Redirects parent to /billing/payment-methods to save a card

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

interface PlanOption {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  installment_count: number;
  discount_basis_points: number;
  schedule_template: { kind?: string; months?: string[] };
}

interface Addon {
  key: string;
  label: string;
  amount_cents: number;
  selected?: boolean;
}

interface SchoolConfig {
  late_fee_amount_cents: number;
  late_fee_grace_days: number;
  monthly_plan_admin_fee_bp: number;
  annual_plan_discount_bp: number;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Compute the total + per-installment for a given plan + addon selection.
// Mirrors the server-side calculation (server is source of truth, but
// we recompute here for live display so the parent sees the math change
// as they pick options).
function compute(
  baseCents: number,
  selectedAddonCents: number,
  plan: PlanOption,
  schoolConfig: SchoolConfig | undefined,
): { totalCents: number; perInstallmentCents: number; adjustment: number; adjustmentLabel: string | null } {
  const subtotal = baseCents + selectedAddonCents;
  let adjustmentBp = plan.discount_basis_points;  // positive = discount, negative = upcharge
  let adjustmentLabel: string | null = null;

  // School-level overrides (per agreement)
  if (schoolConfig) {
    if (plan.installment_count === 1 && schoolConfig.annual_plan_discount_bp > 0) {
      adjustmentBp = schoolConfig.annual_plan_discount_bp;
      adjustmentLabel = `Annual discount (-${(schoolConfig.annual_plan_discount_bp / 100).toFixed(0)}%)`;
    } else if (plan.installment_count > 2 && schoolConfig.monthly_plan_admin_fee_bp > 0) {
      // For monthly plans the school admin fee is added on top
      adjustmentBp = -schoolConfig.monthly_plan_admin_fee_bp;
      adjustmentLabel = `Monthly admin fee (+${(schoolConfig.monthly_plan_admin_fee_bp / 100).toFixed(0)}%)`;
    }
  } else if (plan.discount_basis_points > 0) {
    adjustmentLabel = `Plan discount (-${(plan.discount_basis_points / 100).toFixed(0)}%)`;
  }

  // Apply: positive = discount (multiply by 1 - bp/10000), negative = upcharge
  const adjustment = Math.round((subtotal * adjustmentBp) / 10000);
  const totalCents = subtotal - adjustment;  // discount reduces, upcharge (negative adj) increases
  const perInstallmentCents = plan.installment_count > 0
    ? Math.round(totalCents / plan.installment_count)
    : totalCents;

  return { totalCents, perInstallmentCents, adjustment, adjustmentLabel };
}

export function TuitionPlanPicker({
  enrollmentId,
  planOptions,
  availableAddons,
  baseTuitionCents,
  schoolConfig,
}: {
  enrollmentId: string;
  planOptions: PlanOption[];
  availableAddons: Addon[];
  baseTuitionCents: number;
  schoolConfig: SchoolConfig | undefined;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  // Initialize addon selection state from incoming `selected` flags
  // (default to true if not explicitly false, so school-default-selected
  // addons start selected).
  const [addonSelections, setAddonSelections] = useState<Record<string, boolean>>(
    Object.fromEntries(availableAddons.map((a) => [a.key, a.selected !== false])),
  );

  const selectedAddonCents = availableAddons
    .filter((a) => addonSelections[a.key])
    .reduce((sum, a) => sum + a.amount_cents, 0);

  async function commit() {
    if (!selectedPlanId) {
      setErr('Pick a payment plan above.');
      return;
    }
    setErr(null);
    startTransition(async () => {
      try {
        const r = await fetch(`/api/tuition/enrollment/${enrollmentId}/select-plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payment_plan_id: selectedPlanId,
            addon_selections: addonSelections,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || (body as { error?: string }).error || `HTTP ${r.status}`);
        }
        // After plan locks in, parent goes to save a payment method
        router.push('/billing/payment-methods?next_step=tuition');
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not save plan selection.');
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Add-ons toggle */}
      {availableAddons.length > 0 ? (
        <div className="rounded-md border border-gray-200 bg-gray-50/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-1">
            Add-ons
          </div>
          <div className="space-y-1">
            {availableAddons.map((a) => (
              <label key={a.key} className="flex items-center justify-between gap-2 text-sm cursor-pointer">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addonSelections[a.key] ?? false}
                    onChange={(e) => setAddonSelections((prev) => ({ ...prev, [a.key]: e.target.checked }))}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  {a.label}
                </span>
                <span className="tabular-nums text-gray-700">{fmtCents(a.amount_cents)}/yr</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {/* Plan cards */}
      <div>
        <div className="text-sm font-medium text-gray-800 mb-2">Pick your payment plan</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {planOptions.map((plan) => {
            const { totalCents, perInstallmentCents, adjustment, adjustmentLabel } = compute(
              baseTuitionCents,
              selectedAddonCents,
              plan,
              schoolConfig,
            );
            const selected = selectedPlanId === plan.id;
            return (
              <button
                key={plan.id}
                type="button"
                onClick={() => setSelectedPlanId(plan.id)}
                className={`text-left rounded-lg border-2 p-3 ${
                  selected
                    ? 'border-emerald-600 bg-emerald-50'
                    : 'border-gray-200 bg-white hover:border-emerald-300 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold text-gray-900 text-sm">{plan.display_name}</div>
                  {selected ? <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" /> : null}
                </div>
                <div className="mt-2">
                  <div className="text-lg font-semibold text-gray-900 tabular-nums">
                    {fmtCents(perInstallmentCents)}
                  </div>
                  <div className="text-[11px] text-gray-600">
                    {plan.installment_count === 1
                      ? 'one payment'
                      : `× ${plan.installment_count} ${plan.installment_count === 2 ? 'payments' : 'monthly payments'}`}
                  </div>
                </div>
                <div className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-600">
                  {adjustmentLabel ? (
                    <div className={adjustment > 0 ? 'text-emerald-700' : 'text-amber-700'}>
                      {adjustmentLabel}: {adjustment > 0 ? '−' : '+'}
                      {fmtCents(Math.abs(adjustment))}
                    </div>
                  ) : null}
                  <div className="text-gray-700">
                    Total: <span className="font-semibold tabular-nums">{fmtCents(totalCents)}</span>
                  </div>
                </div>
                {plan.description ? (
                  <div className="mt-2 text-[11px] text-gray-500 line-clamp-2">{plan.description}</div>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Schedule preview */}
      {selectedPlanId ? (
        <div className="rounded-md border border-blue-200 bg-blue-50/40 px-3 py-2 text-xs text-blue-900 flex items-start gap-2">
          <Calendar className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Next: save a payment method and confirm. We&rsquo;ll auto-bill on each scheduled date —
            the first charge will appear on your saved card per the school&rsquo;s billing schedule
            (typically July 1 for fall start).
          </div>
        </div>
      ) : null}

      {/* Errors */}
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {err}
        </div>
      ) : null}

      {/* Submit */}
      <div className="flex items-center gap-2 border-t border-gray-100 pt-3">
        <button
          type="button"
          onClick={commit}
          disabled={busy || !selectedPlanId}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {busy ? 'Saving…' : 'Lock in this plan'}
        </button>
        <p className="text-[11px] text-gray-500">
          You can change plans later (small fee may apply). Your school can also make changes for you.
        </p>
      </div>
    </div>
  );
}
