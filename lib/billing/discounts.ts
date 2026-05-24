// Discount-evaluation engine.
//
// Called at invoice creation time. Given an invoice's school + family +
// student + the resolved line items, return a list of discount lines
// that should be appended (as negative-amount invoice_line_items) plus
// audit rows for discount_applications.
//
// Three discount kinds:
//   - auto       : silently applied if conditions match
//   - code       : only applied if the parent entered the matching code
//   - financial_aid : applied for the FA-awarded family, against tuition
//
// All amounts in INTEGER cents.

import { query } from '@/lib/db';
import type { ResolvedLine } from '@/lib/forms/payment-eval';
import type { QueryResult, QueryResultRow } from 'pg';

// Matches the shape of both `query` (top-level) and the `q` passed into
// withTransaction(). Generic so callers don't lose row typing.
type Q = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

export interface DiscountInput {
  schoolId: string;
  familyId: string;
  studentId: string | null;
  // The line items already resolved for this invoice (positive cents).
  lines: ResolvedLine[];
  // Optional context for auto-apply conditions.
  formSlug?: string;
  // Code the parent typed in at checkout (case-insensitive).
  redemptionCode?: string;
  // For tax/reporting category filtering.
  invoicedAt?: Date;
}

export interface DiscountResultLine {
  policy_id: string;
  description: string;
  // Negative cents — the discount itself, ready to insert as an invoice
  // line item with negative amount_cents.
  amount_cents: number;
  category: string;
}

export interface DiscountResult {
  lines: DiscountResultLine[];
  total_cents: number;        // sum of |amount_cents|, positive
  applications: Array<{
    policy_id: string;
    amount_cents: number;     // positive cents withheld for the audit row
  }>;
}

interface DiscountPolicyRow {
  id: string;
  kind: 'auto' | 'code' | 'financial_aid';
  display_name: string;
  percentage_basis_points: number;
  amount_cents: number;
  max_discount_cents: number | null;
  applies_to_categories: string[];
  conditions: Record<string, unknown>;
  redemption_code: string | null;
  max_total_redemptions: number | null;
  max_redemptions_per_family: number;
  redemption_count: number;
  fa_application_id: string | null;
  active_from: string | null;
  active_until: string | null;
}

export async function evaluateDiscounts(input: DiscountInput): Promise<DiscountResult> {
  // Load every active policy for the school. We filter in JS — the
  // number of active policies per school is small (single-digit to low
  // double-digit), so a single SELECT keeps the code simple.
  const now = input.invoicedAt ?? new Date();
  const { rows: policies } = await query<DiscountPolicyRow>(
    `SELECT id, kind, display_name, percentage_basis_points, amount_cents,
            max_discount_cents, applies_to_categories, conditions,
            redemption_code, max_total_redemptions, max_redemptions_per_family,
            redemption_count, fa_application_id, active_from, active_until
       FROM discount_policies
      WHERE school_id = $1
        AND is_active = true
        AND (active_from IS NULL OR active_from <= $2)
        AND (active_until IS NULL OR active_until >= $2)`,
    [input.schoolId, now.toISOString()],
  );

  const outLines: DiscountResultLine[] = [];
  const applications: DiscountResult['applications'] = [];
  const enteredCode = (input.redemptionCode ?? '').trim().toLowerCase();

  for (const p of policies) {
    // ----- gate by kind ---------------------------------------------------
    if (p.kind === 'code') {
      if (!enteredCode || (p.redemption_code ?? '').toLowerCase() !== enteredCode) {
        continue; // parent didn't enter this code
      }
      // Total-redemptions cap
      if (p.max_total_redemptions != null && p.redemption_count >= p.max_total_redemptions) {
        continue;
      }
      // Per-family cap — count past applications.
      const { rows: famUsed } = await query<{ used: string }>(
        `SELECT COUNT(*)::text AS used FROM discount_applications
          WHERE discount_policy_id = $1 AND family_id = $2`,
        [p.id, input.familyId],
      );
      if (Number(famUsed[0]?.used ?? 0) >= p.max_redemptions_per_family) {
        continue;
      }
    } else if (p.kind === 'financial_aid') {
      // Only applies to families with a decided FA award.
      if (!p.fa_application_id) continue;
      const { rows: faRows } = await query<{ family_id: string; status: string; recommended_award: string | null }>(
        `SELECT family_id, status, recommended_award FROM fa_applications WHERE id = $1`,
        [p.fa_application_id],
      );
      const fa = faRows[0];
      if (!fa || fa.family_id !== input.familyId || fa.status !== 'decided') continue;
      // The FA award cap implicitly limits how much we can discount —
      // honored via max_discount_cents below.
    } else if (p.kind === 'auto') {
      const ok = await evaluateAutoConditions(p.conditions, {
        schoolId: input.schoolId,
        familyId: input.familyId,
        studentId: input.studentId,
        formSlug: input.formSlug,
      });
      if (!ok) continue;
    }

    // ----- compute discount amount ---------------------------------------
    // Match against applies_to_categories (empty = all lines).
    const matched = p.applies_to_categories.length === 0
      ? input.lines
      : input.lines.filter((l) => l.category && p.applies_to_categories.includes(l.category));
    const matchedSubtotal = matched.reduce((s, l) => s + l.amount_cents, 0);
    if (matchedSubtotal <= 0) continue;

    let amount = p.amount_cents;
    if (p.percentage_basis_points > 0) {
      amount = Math.round(matchedSubtotal * p.percentage_basis_points / 10000);
    }
    // Cap at the matched subtotal (no negative invoices).
    amount = Math.min(amount, matchedSubtotal);
    // Apply max-discount cap.
    if (p.max_discount_cents != null) amount = Math.min(amount, p.max_discount_cents);
    if (amount <= 0) continue;

    outLines.push({
      policy_id: p.id,
      description: p.display_name,
      amount_cents: -amount,
      category: p.kind === 'financial_aid' ? 'financial_aid' : 'discount',
    });
    applications.push({ policy_id: p.id, amount_cents: amount });
  }

  return {
    lines: outLines,
    total_cents: applications.reduce((s, a) => s + a.amount_cents, 0),
    applications,
  };
}

// Persist the audit rows + bump the policy's redemption_count.
// Called inside the same transaction as the invoice insert.
export async function recordDiscountApplications(
  schoolId: string,
  familyId: string,
  invoiceId: string,
  applications: DiscountResult['applications'],
  q: Q,
): Promise<void> {
  for (const a of applications) {
    await q(
      `INSERT INTO discount_applications
         (school_id, invoice_id, discount_policy_id, family_id, amount_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invoice_id, discount_policy_id) DO NOTHING`,
      [schoolId, invoiceId, a.policy_id, familyId, a.amount_cents],
    );
    await q(
      `UPDATE discount_policies
          SET redemption_count = redemption_count + 1,
              updated_at = now()
        WHERE id = $1`,
      [a.policy_id],
    );
  }
}

// ─── Auto-apply condition matcher ────────────────────────────────────
// Supported keys (any combination — all must match):
//   - min_children_enrolled: number    family must have ≥ N active students
//   - match_form_slug: string          only when the invoice came from
//                                      this form's submission
//   - submitted_before: ISO date       early-bird window cutoff
//
// Unknown keys cause the policy to fail-closed (skip). Keeps mistyped
// JSON from silently applying a discount. Adding a new condition?
// 1) Add it to the `known` set; 2) add a branch below.
async function evaluateAutoConditions(
  conditions: Record<string, unknown>,
  ctx: { schoolId: string; familyId: string; studentId: string | null; formSlug?: string },
): Promise<boolean> {
  const known = new Set(['min_children_enrolled', 'match_form_slug', 'submitted_before']);
  for (const k of Object.keys(conditions)) {
    if (!known.has(k)) {
      console.warn('[discounts] unknown condition key, skipping policy:', k);
      return false;
    }
  }

  if (typeof conditions.min_children_enrolled === 'number') {
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM students
        WHERE family_id = $1 AND status = 'active'`,
      [ctx.familyId],
    );
    if (Number(rows[0]?.n ?? 0) < conditions.min_children_enrolled) return false;
  }

  if (typeof conditions.match_form_slug === 'string') {
    if (ctx.formSlug !== conditions.match_form_slug) return false;
  }

  if (typeof conditions.submitted_before === 'string') {
    const cutoff = new Date(conditions.submitted_before);
    if (Number.isFinite(cutoff.getTime()) && Date.now() > cutoff.getTime()) return false;
  }

  return true;
}
