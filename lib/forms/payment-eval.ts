// Resolve a form's payment_config + responses + field_schema into a
// concrete set of invoice line items.
//
// Used by:
//   - The client FormRenderer to show a live running total
//   - The server submit route to materialize the invoice line items
//
// All amounts are INTEGER cents.

import type {
  FormDefinition,
  FormFieldBlock,
  PaymentLineRule,
  PricingSelectField,
  MultiPricingField,
  QuantityPricingField,
} from './types';

export interface ResolvedLine {
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  category?: string;
}

export interface PaymentEvalResult {
  lines: ResolvedLine[];
  subtotal_cents: number;
}

// In the tuition-calculator field, the "selected plan" is stored as
// JSON in responses: { tuition_grid_id, annual_tuition_cents,
// plan_slug, plan_discount_bp, addons: [{key, label, amount_cents, paid?}],
// total_cents }
//
// `paid: true` addons represent items the family has already paid for
// (e.g. an enrollment deposit collected at contract signing). We still
// surface them in the line items so the parent can SEE the credit, but
// we offset each with a negative "credit" line so the math nets to 0.
interface TuitionCalcValue {
  display_name?: string;
  annual_tuition_cents?: number;
  plan_label?: string;
  plan_discount_bp?: number;
  addons?: Array<{ label: string; amount_cents: number; paid?: boolean }>;
  total_cents?: number;
}

function findField(schema: FormFieldBlock[], key: string): FormFieldBlock | null {
  return schema.find((b) => 'key' in b && b.key === key) ?? null;
}

function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.length) return [v];
  return [];
}

function asInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Returns the proration multiplier (0–1) given a parent's chosen
// enrollment start date, the academic-year anchor, and total months in
// the year. Per DGM's rule: tuition is billed for the entire month
// during which the child starts school, regardless of start date.
//
// Example: anchor 2026-08-01, total 10 months, start 2026-10-15
//   → months_remaining = 8 (Oct + Nov + ... + May) → multiplier 0.8
function computeProrationMultiplier(
  startDateStr: string,
  anchorDateStr: string,
  totalMonths: number,
): number {
  if (totalMonths <= 0) return 1;
  const start = new Date(startDateStr);
  const anchor = new Date(anchorDateStr);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(anchor.getTime())) return 1;
  if (start <= anchor) return 1;
  // Year-month index from anchor: how many months past the anchor we are.
  const monthsPast =
    (start.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (start.getUTCMonth() - anchor.getUTCMonth());
  const remaining = totalMonths - monthsPast;
  if (remaining <= 0) return 0;
  if (remaining >= totalMonths) return 1;
  return remaining / totalMonths;
}

function applyProrate(
  amount: number,
  prorate: { reference_field: string; anchor_date: string; total_months: number } | undefined,
  responses: Record<string, unknown>,
): number {
  if (!prorate) return amount;
  const raw = responses[prorate.reference_field];
  if (typeof raw !== 'string' || !raw) return amount;
  const mult = computeProrationMultiplier(raw, prorate.anchor_date, prorate.total_months);
  return Math.round(amount * mult);
}

export function evaluatePayment(
  def: FormDefinition,
  responses: Record<string, unknown>,
): PaymentEvalResult {
  const lines: ResolvedLine[] = [];
  if (!def.payment_config) return { lines, subtotal_cents: 0 };

  for (const rule of def.payment_config.lines) {
    const resolved = resolveLineRule(rule, def, responses);
    for (const l of resolved) lines.push(l);
  }

  // ── Second pass: payment-plan modifiers ─────────────────────────────
  // For DGM: a Monthly plan adds +3% admin fee on tuition; an Annual
  // plan applies a -5% discount on tuition. We compute these AFTER the
  // initial lines exist, so we can derive a percentage of them.
  for (const rule of def.payment_config.lines) {
    if (rule.kind !== 'payment_plan_modifier') continue;
    const choice = asString(responses[rule.field_key]);
    if (!choice) continue;
    const mod = rule.modifiers[choice];
    if (!mod) continue;
    // Sum the affected categories from the lines we've already built.
    const affected = lines
      .filter((l) =>
        l.category != null &&
        mod.applies_to_categories.includes(l.category) &&
        // Don't apply against negative or zero lines (avoids modifying
        // existing discount/credit rows by accident).
        l.amount_cents > 0,
      )
      .reduce((s, l) => s + l.amount_cents, 0);
    if (affected <= 0) continue;
    const amount = Math.round(affected * mod.pct_basis_points / 10000);
    if (amount === 0) continue;
    lines.push({
      description: mod.label,
      quantity: 1,
      unit_amount_cents: amount,
      amount_cents: amount,
      category: mod.category ?? 'plan_modifier',
    });
  }

  const subtotal_cents = lines.reduce((acc, l) => acc + l.amount_cents, 0);
  return { lines, subtotal_cents };
}

function resolveLineRule(
  rule: PaymentLineRule,
  def: FormDefinition,
  responses: Record<string, unknown>,
): ResolvedLine[] {
  if (rule.kind === 'fixed') {
    return [{
      description: rule.label,
      quantity: 1,
      unit_amount_cents: rule.amount_cents,
      amount_cents: rule.amount_cents,
      category: rule.category,
    }];
  }

  if (rule.kind === 'pricing_select') {
    const field = findField(def.field_schema, rule.field_key) as PricingSelectField | null;
    if (!field || field.type !== 'pricing_select') return [];
    const chosen = asString(responses[rule.field_key]);
    const opt = field.options.find((o) => o.value === chosen);
    if (!opt) return [];
    const amount = applyProrate(opt.amount_cents, rule.prorate, responses);
    const baseLabel = rule.label_template
      ? rule.label_template.replace('{label}', opt.label)
      : opt.label;
    const label = rule.prorate && amount !== opt.amount_cents
      ? `${baseLabel} (prorated)`
      : baseLabel;
    return [{
      description: label,
      quantity: 1,
      unit_amount_cents: amount,
      amount_cents: amount,
      category: rule.category,
    }];
  }

  if (rule.kind === 'multi_pricing') {
    const field = findField(def.field_schema, rule.field_key) as MultiPricingField | null;
    if (!field || field.type !== 'multi_pricing') return [];
    const chosen = new Set(asArray(responses[rule.field_key]));
    const out: ResolvedLine[] = [];
    for (const opt of field.options) {
      if (chosen.has(opt.value)) {
        const amount = applyProrate(opt.amount_cents, rule.prorate, responses);
        out.push({
          description: rule.prorate && amount !== opt.amount_cents
            ? `${opt.label} (prorated)`
            : opt.label,
          quantity: 1,
          unit_amount_cents: amount,
          amount_cents: amount,
          category: rule.category,
        });
      }
    }
    return out;
  }

  if (rule.kind === 'quantity_pricing') {
    const field = findField(def.field_schema, rule.field_key) as QuantityPricingField | null;
    if (!field || field.type !== 'quantity_pricing') return [];
    const qty = asInt(responses[rule.field_key], 0);
    if (qty <= 0) return [];
    const label = rule.label ?? `${field.unit_label} × ${qty}`;
    return [{
      description: label,
      quantity: qty,
      unit_amount_cents: field.unit_amount_cents,
      amount_cents: qty * field.unit_amount_cents,
      category: rule.category,
    }];
  }

  if (rule.kind === 'tuition_calculator') {
    const raw = responses[rule.field_key];
    let calc: TuitionCalcValue | null = null;
    if (typeof raw === 'string' && raw.startsWith('{')) {
      try { calc = JSON.parse(raw); } catch { /* ignore */ }
    } else if (typeof raw === 'object' && raw !== null) {
      calc = raw as TuitionCalcValue;
    }
    if (!calc || !calc.total_cents) return [];

    // Single line for the plan-adjusted tuition + one per addon.
    const out: ResolvedLine[] = [];
    const baseLabel = calc.plan_label
      ? `${calc.display_name ?? 'Tuition'} (${calc.plan_label})`
      : (calc.display_name ?? 'Tuition');
    const baseAmount = calc.annual_tuition_cents ?? 0;
    const discountBp = calc.plan_discount_bp ?? 0;
    const discounted = baseAmount - Math.round(baseAmount * discountBp / 10000);
    out.push({
      description: baseLabel,
      quantity: 1,
      unit_amount_cents: discounted,
      amount_cents: discounted,
      category: rule.category ?? 'tuition',
    });
    for (const a of calc.addons ?? []) {
      // Positive line for every addon — paid or not — so the parent
      // sees the full breakdown.
      out.push({
        description: a.label,
        quantity: 1,
        unit_amount_cents: a.amount_cents,
        amount_cents: a.amount_cents,
        category: rule.category ?? 'tuition',
      });
      // For addons already paid (e.g. enrollment deposit collected at
      // contract signing), emit a matching negative credit line so the
      // net contribution to subtotal is zero. The parent can clearly
      // see "Deposit $250 / Less: deposit credit -$250" rather than
      // wondering why the deposit silently disappeared.
      if (a.paid) {
        out.push({
          description: `${a.label} — credit (already paid)`,
          quantity: 1,
          unit_amount_cents: -a.amount_cents,
          amount_cents: -a.amount_cents,
          category: 'paid_credit',
        });
      }
    }
    return out;
  }

  if (rule.kind === 'date_based_fee') {
    // Use the form-evaluation date (now) to pick the early/late label
    // and amount. The server re-evaluates at submit time so a tampered
    // client can't backdate themselves to the cheaper bracket.
    const today = new Date();
    const cutoff = new Date(`${rule.cutoff_date}T23:59:59`);
    const isBefore = today <= cutoff;
    const amount = isBefore ? rule.before_cents : rule.after_cents;
    const label = isBefore ? rule.label_before_cutoff : rule.label_after_cutoff;
    if (amount <= 0) return [];
    return [{
      description: label,
      quantity: 1,
      unit_amount_cents: amount,
      amount_cents: amount,
      category: rule.category,
    }];
  }

  // payment_plan_modifier — handled in a SECOND pass below, after the
  // initial line evaluation, because it computes a percentage of the
  // other lines.
  if (rule.kind === 'payment_plan_modifier') {
    return [];
  }

  return [];
}
