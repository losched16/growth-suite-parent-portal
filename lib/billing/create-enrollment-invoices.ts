// Form-submission flow for enrollment-style forms that include a
// payment_plan field. Splits the all-in-one invoice into:
//
//   1) An IMMEDIATE invoice for the Enrollment Fee only (due_at = now)
//   2) A family_tuition_enrollments row that anchors the annual plan
//   3) N installment invoices for tuition + addons, due per the plan's
//      schedule (10 monthly / 2 semi-annual / 1 annual)
//
// Plan modifiers (+3% Monthly admin / -5% Annual discount) are baked
// into the per-installment amount so each invoice is billed in full
// with the right total.
//
// Used by the portal-forms submit route when the form definition has a
// `payment_plan` field in its responses. Falls back to the regular
// single-invoice helper otherwise.

import { query, withTransaction } from '@/lib/db';
import type { FormDefinition } from '@/lib/forms/types';
import type { ResolvedLine } from '@/lib/forms/payment-eval';
import { evaluateDiscounts, recordDiscountApplications } from './discounts';

interface CreateOpts {
  schoolId: string;
  familyId: string;
  studentId: string | null;
  submissionId: string;
  formDefinition: FormDefinition;
  lines: ResolvedLine[];               // already evaluated by payment-eval
  subtotalCents: number;
  paymentPlan: 'monthly' | 'semi_annual' | 'annual';
  enrollmentStartDate?: string | null; // ISO 'YYYY-MM-DD'
  studentDisplayName?: string;
  createdByEmail: string;
  redemptionCode?: string;
}

interface CreateResult {
  enrollment_id: string;
  enrollment_fee_invoice_id: string | null;
  installment_invoice_ids: string[];
  total_due_now_cents: number;
  total_annual_committed_cents: number;
}

const ACADEMIC_YEAR = '2026-27';

// Categories that get billed UPFRONT on the immediate invoice (not
// spread across the plan). Everything else goes into installments.
const DUE_NOW_CATEGORIES = new Set([
  'enrollment_fee',
  'platform_fee',
]);

// Categories that contribute to the annual billable amount that gets
// split across installments. Modifiers (admin_fee, plan_discount) are
// included so their effect is reflected per-installment.
const INSTALLMENT_CATEGORIES = new Set([
  'tuition',
  'extended_day',
  'lunch',
  'tuition_addon',
  'admin_fee',
  'plan_discount',
]);

export async function createEnrollmentInvoices(opts: CreateOpts): Promise<CreateResult> {
  // ── Partition the lines ────────────────────────────────────────────
  const dueNowLines = opts.lines.filter((l) => l.category && DUE_NOW_CATEGORIES.has(l.category));
  const installmentLines = opts.lines.filter((l) => l.category && INSTALLMENT_CATEGORIES.has(l.category));

  const dueNowSubtotal = dueNowLines.reduce((s, l) => s + l.amount_cents, 0);
  const annualTotal = installmentLines.reduce((s, l) => s + l.amount_cents, 0);

  // Resolve a synthetic "tuition grid" + "payment plan" pair to link
  // the enrollment to. DGM and other schools don't formally have
  // tuition_grids rows that mirror their enrollment forms, so we use
  // school_payment_config columns. For Phase 3 we just store enough on
  // the enrollment row to reconstruct intent — we don't require the
  // grid/plan tables.
  //
  // We still need IDs for the enrollment FK, so we use the existing
  // entries if they're there, else create stub rows.
  const planSlug = opts.paymentPlan === 'monthly' ? 'monthly-10'
                 : opts.paymentPlan === 'semi_annual' ? 'semi-annual-2'
                 : 'annual-1';
  const installmentCount = opts.paymentPlan === 'monthly' ? 10
                         : opts.paymentPlan === 'semi_annual' ? 2 : 1;
  const schedule = opts.paymentPlan === 'monthly'
    ? { kind: 'monthly', months: ['08','09','10','11','12','01','02','03','04','05'] }
    : opts.paymentPlan === 'semi_annual'
      ? { kind: 'semiannual', months: ['08','01'] }
      : { kind: 'single' };

  // Stub grid + plan rows (idempotent, one per school)
  const { rows: gridRows } = await query<{ id: string }>(
    `INSERT INTO tuition_grids
       (school_id, academic_year, program, grade_level, display_name,
        annual_tuition_cents, addons, is_active, position)
     VALUES ($1, $2, 'Enrollment Form', NULL, 'Enrollment Form (form-driven)', 0, '[]'::jsonb, true, 99)
     ON CONFLICT (school_id, academic_year, program, grade_level)
     DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id`,
    [opts.schoolId, ACADEMIC_YEAR],
  );
  const stubGridId = gridRows[0].id;

  const { rows: planRows } = await query<{ id: string }>(
    `INSERT INTO payment_plans
       (school_id, slug, display_name, description, installment_count,
        discount_basis_points, schedule_template, is_active, position)
     VALUES ($1, $2, $3, 'Auto-created from enrollment form', $4, 0, $5::jsonb, true, 50)
     ON CONFLICT (school_id, slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       installment_count = EXCLUDED.installment_count,
       schedule_template = EXCLUDED.schedule_template,
       updated_at = now()
     RETURNING id`,
    [
      opts.schoolId, planSlug,
      planSlug === 'monthly-10'    ? 'Monthly (10 payments, +3% Admin Fee)'
      : planSlug === 'semi-annual-2' ? 'Semi-Annual (2 payments)'
      :                                'Annual (1 payment, 5% discount)',
      installmentCount,
      JSON.stringify(schedule),
    ],
  );
  const stubPlanId = planRows[0].id;

  // School-chosen first-payment date (set by the admin at enrollment)
  // anchors the whole schedule; falls back to the parent's start date,
  // then the academic-year default. Also load the autopay-default flag.
  const { rows: cfgRows } = await query<{ autopay_default_on: boolean }>(
    `SELECT COALESCE(autopay_default_on, true) AS autopay_default_on
       FROM school_payment_config WHERE school_id = $1`,
    [opts.schoolId],
  );
  const autopayOn = cfgRows[0]?.autopay_default_on ?? true;
  const { rows: existingEnr } = await query<{ first_due_date: string | null }>(
    `SELECT to_char(first_due_date, 'YYYY-MM-DD') AS first_due_date
       FROM family_tuition_enrollments
      WHERE school_id = $1 AND family_id = $2
        AND student_id IS NOT DISTINCT FROM $3 AND academic_year = $4
      LIMIT 1`,
    [opts.schoolId, opts.familyId, opts.studentId, ACADEMIC_YEAR],
  );
  const firstDueAnchor = existingEnr[0]?.first_due_date ?? null;

  // ── Compute due dates for each installment ─────────────────────────
  const dueDates = computeDueDates(
    opts.paymentPlan, ACADEMIC_YEAR, opts.enrollmentStartDate ?? null, firstDueAnchor,
  );

  // ── Build per-installment line splits ──────────────────────────────
  // Strategy: pro-rate each installment line by its share of the annual
  // total. Round each portion; put the remainder on the LAST installment.
  const installmentAmounts: number[] = Array.from({ length: installmentCount }, (_, i) => {
    const base = Math.floor(annualTotal / installmentCount);
    const remainder = i === installmentCount - 1
      ? annualTotal - base * installmentCount
      : 0;
    return base + remainder;
  });

  const initialStatus: 'open' | 'draft' = 'open';

  // ── Generate everything in one transaction ────────────────────────
  const result = await withTransaction(async (q) => {
    // Upsert the enrollment row
    const enrIns = await q<{ id: string }>(
      `INSERT INTO family_tuition_enrollments
         (school_id, family_id, student_id, academic_year,
          tuition_grid_id, payment_plan_id,
          annual_tuition_cents, plan_discount_basis_points, addons,
          total_annual_cents, installment_count, schedule,
          status, internal_note, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, '[]'::jsonb, $8, $9, $10::jsonb,
               'active', $11, $12)
       ON CONFLICT (school_id, family_id, student_id, academic_year)
       DO UPDATE SET
         tuition_grid_id = EXCLUDED.tuition_grid_id,
         payment_plan_id = EXCLUDED.payment_plan_id,
         annual_tuition_cents = EXCLUDED.annual_tuition_cents,
         total_annual_cents = EXCLUDED.total_annual_cents,
         installment_count = EXCLUDED.installment_count,
         schedule = EXCLUDED.schedule,
         status = 'active',
         internal_note = COALESCE(EXCLUDED.internal_note, family_tuition_enrollments.internal_note),
         updated_at = now()
       RETURNING id`,
      [
        opts.schoolId, opts.familyId, opts.studentId, ACADEMIC_YEAR,
        stubGridId, stubPlanId,
        annualTotal, annualTotal, installmentCount,
        JSON.stringify(schedule),
        `Form-driven enrollment from submission ${opts.submissionId}`,
        opts.createdByEmail,
      ],
    );
    const enrollmentId = enrIns.rows[0].id;

    // Clear any old auto-generated invoices for this enrollment that
    // weren't paid yet (re-submission keeps paid history).
    await q(
      `DELETE FROM invoices
        WHERE source = 'tuition_plan'
          AND source_ref->>'enrollment_id' = $1
          AND status IN ('draft', 'open')`,
      [enrollmentId],
    );

    // 1) Enrollment-fee-due-now invoice (if any)
    let enrollmentFeeInvoiceId: string | null = null;
    if (dueNowSubtotal > 0 && dueNowLines.length > 0) {
      const num = await allocateInvoiceNumber(q, opts.schoolId);
      const { rows: inv } = await q<{ id: string }>(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, due_at, issued_at, source, source_ref,
            includes_platform_setup_fee, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $8, now(), now(),
                 'form_submission', $9::jsonb, false, $10)
         RETURNING id`,
        [
          opts.schoolId, opts.familyId, opts.studentId,
          num,
          `Enrollment Fee — ${opts.studentDisplayName ?? 'Student'} (${ACADEMIC_YEAR})`,
          'Non-refundable enrollment fee. Due upfront before tuition installments begin.',
          initialStatus,
          dueNowSubtotal,
          JSON.stringify({
            submission_id: opts.submissionId,
            form_definition_id: opts.formDefinition.id,
            enrollment_id: enrollmentId,
            kind: 'enrollment_fee',
          }),
          opts.createdByEmail,
        ],
      );
      enrollmentFeeInvoiceId = inv[0].id;
      let pos = 0;
      for (const l of dueNowLines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [enrollmentFeeInvoiceId, pos++, l.description, l.quantity, l.unit_amount_cents, l.amount_cents, l.category, opts.studentId],
        );
      }
    }

    // 2) Installment invoices (per the plan's schedule)
    const installmentInvoiceIds: string[] = [];
    for (let i = 0; i < installmentCount; i++) {
      const installmentNumber = i + 1;
      const installmentCents = installmentAmounts[i];
      const dueDate = dueDates[i];

      // Pro-rate each installment LINE so the per-installment lines sum
      // to the installment amount and the categories are visible to the
      // parent on the invoice detail page.
      const lines = prorateInstallmentLines(installmentLines, installmentCents, annualTotal);

      // Run discount evaluation against THIS installment's lines (so
      // sibling/auto discounts apply to each invoice, not just the first).
      const discountResult = await evaluateDiscounts({
        schoolId: opts.schoolId,
        familyId: opts.familyId,
        studentId: opts.studentId,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: 1,
          unit_amount_cents: l.amount_cents,
          amount_cents: l.amount_cents,
          category: l.category,
        })),
        formSlug: opts.formDefinition.slug,
        redemptionCode: opts.redemptionCode,
      });

      // Precedence: when sibling discount applies to this installment,
      // strip any plan_discount line (per DGM's "one or the other" rule).
      const siblingApplies = discountResult.applications.length > 0;
      const linesToInsert = siblingApplies
        ? lines.filter((l) => l.category !== 'plan_discount')
        : lines;
      const subtotalAfterFilter = linesToInsert.reduce((s, l) => s + l.amount_cents, 0);
      const discountTotal = discountResult.total_cents;
      const totalCents = Math.max(0, subtotalAfterFilter - discountTotal);

      const num = await allocateInvoiceNumber(q, opts.schoolId);
      const { rows: inv } = await q<{ id: string }>(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, due_at, issued_at, source, source_ref,
            includes_platform_setup_fee, created_by_email,
            autopay_enabled, autopay_charge_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $11,
                 'tuition_plan', $12::jsonb, false, $13, $14, $11::date)
         RETURNING id`,
        [
          opts.schoolId, opts.familyId, opts.studentId,
          num,
          `Tuition — Installment ${installmentNumber}/${installmentCount} — ${opts.studentDisplayName ?? 'Student'}`,
          `${planLabel(opts.paymentPlan)} · ${ACADEMIC_YEAR}`,
          initialStatus,
          subtotalAfterFilter,
          discountTotal,
          totalCents,
          dueDate.toISOString(),
          JSON.stringify({
            submission_id: opts.submissionId,
            form_definition_id: opts.formDefinition.id,
            enrollment_id: enrollmentId,
            installment_number: installmentNumber,
            payment_plan: opts.paymentPlan,
          }),
          opts.createdByEmail,
          autopayOn,
        ],
      );
      const invoiceId = inv[0].id;
      installmentInvoiceIds.push(invoiceId);

      let pos = 0;
      for (const l of linesToInsert) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invoiceId, pos++, l.description, l.amount_cents, l.category, opts.studentId],
        );
      }
      for (const d of discountResult.lines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invoiceId, pos++, d.description, d.amount_cents, d.category, opts.studentId],
        );
      }
      await recordDiscountApplications(
        opts.schoolId, opts.familyId, invoiceId, discountResult.applications, q,
      );
    }

    await q(
      `UPDATE family_tuition_enrollments
          SET installments_generated_at = now(), updated_at = now()
        WHERE id = $1`,
      [enrollmentId],
    );

    // Tag the submission with the enrollment-fee invoice (the one the
    // parent will pay first). When the parent finishes that payment,
    // the webhook flips the submission to 'paid'.
    if (enrollmentFeeInvoiceId) {
      await q(
        `UPDATE portal_form_submissions SET invoice_id = $1 WHERE id = $2`,
        [enrollmentFeeInvoiceId, opts.submissionId],
      );
    }

    return { enrollmentId, enrollmentFeeInvoiceId, installmentInvoiceIds };
  });

  return {
    enrollment_id: result.enrollmentId,
    enrollment_fee_invoice_id: result.enrollmentFeeInvoiceId,
    installment_invoice_ids: result.installmentInvoiceIds,
    total_due_now_cents: dueNowSubtotal,
    total_annual_committed_cents: annualTotal,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function planLabel(p: 'monthly' | 'semi_annual' | 'annual'): string {
  if (p === 'monthly') return 'Monthly Payment Plan (10 installments)';
  if (p === 'semi_annual') return 'Semi-Annual Payment Plan (2 installments)';
  return 'Annual Payment Plan (1 installment)';
}

async function allocateInvoiceNumber(
  q: typeof query,
  schoolId: string,
): Promise<string> {
  const { rows } = await q<{ prefix: string; next: number }>(
    `INSERT INTO school_payment_config (school_id) VALUES ($1)
     ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
     RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
    [schoolId],
  );
  const seq = rows[0].next > 1 ? rows[0].next - 1 : 1;
  return `${rows[0].prefix}-${String(seq).padStart(6, '0')}`;
}

function prorateInstallmentLines(
  annualLines: ResolvedLine[],
  installmentTotal: number,
  annualTotal: number,
): Array<{ description: string; amount_cents: number; category: string }> {
  if (annualTotal === 0) return [];
  const out: Array<{ description: string; amount_cents: number; category: string }> = [];
  let allocated = 0;
  for (let i = 0; i < annualLines.length; i++) {
    const a = annualLines[i];
    let portion = Math.round(installmentTotal * a.amount_cents / annualTotal);
    allocated += portion;
    // Push any rounding remainder onto the last line.
    if (i === annualLines.length - 1) {
      portion += installmentTotal - allocated;
      allocated = installmentTotal;
    }
    if (portion === 0) continue;
    out.push({
      description: a.description,
      amount_cents: portion,
      category: a.category ?? 'tuition',
    });
  }
  return out;
}

function computeDueDates(
  plan: 'monthly' | 'semi_annual' | 'annual',
  academicYear: string,
  enrollmentStart: string | null,
  firstDueAnchor: string | null = null,
): Date[] {
  const [startYearStr] = academicYear.split('-');
  const startYear = parseInt(startYearStr, 10);

  // School-chosen first-due date wins: anchor the schedule to it.
  // monthly = +1 month each, semi-annual = +6 months each, annual = the
  // date itself. Day-of-month clamped to each month's length.
  const anchorMatch = firstDueAnchor && /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstDueAnchor);
  if (anchorMatch) {
    const ay = +anchorMatch[1], am = +anchorMatch[2] - 1, ad = +anchorMatch[3];
    const at = (monthsOut: number) => {
      const tgtY = ay + Math.floor((am + monthsOut) / 12);
      const tgtM = (am + monthsOut) % 12;
      const lastDay = new Date(Date.UTC(tgtY, tgtM + 1, 0)).getUTCDate();
      return new Date(Date.UTC(tgtY, tgtM, Math.min(ad, lastDay), 12, 0, 0));
    };
    const count = plan === 'monthly' ? 10 : plan === 'semi_annual' ? 2 : 1;
    const step = plan === 'semi_annual' ? 6 : 1;
    return Array.from({ length: count }, (_, i) => at(i * step));
  }

  if (plan === 'annual') {
    // Due July 1 of the start year, or before late start date.
    const julyFirst = new Date(Date.UTC(startYear, 6, 1, 12));
    if (enrollmentStart) {
      const ed = new Date(enrollmentStart);
      if (Number.isFinite(ed.getTime()) && ed < julyFirst) return [ed];
      if (Number.isFinite(ed.getTime()) && ed > julyFirst) return [ed]; // late enrollee — due on enrollment day
    }
    return [julyFirst];
  }

  if (plan === 'semi_annual') {
    // Jul 1 + Dec 1 of the start year.
    return [
      new Date(Date.UTC(startYear, 6, 1, 12)),
      new Date(Date.UTC(startYear, 11, 1, 12)),
    ];
  }

  // Monthly: 10 installments. Each bill is due the 1st of the month
  // BEFORE the month being billed (Aug tuition due July 1 → through
  // May tuition due April 1).
  // Months in order: July → April. Map to year (Jul-Dec = startYear,
  // Jan-Apr = startYear+1).
  const months: Array<[number, number]> = [
    [6, startYear],     // Jul 1 — bills Aug
    [7, startYear],     // Aug 1 — bills Sep
    [8, startYear],     // Sep 1 — bills Oct
    [9, startYear],     // Oct 1 — bills Nov
    [10, startYear],    // Nov 1 — bills Dec
    [11, startYear],    // Dec 1 — bills Jan
    [0, startYear + 1], // Jan 1 — bills Feb
    [1, startYear + 1], // Feb 1 — bills Mar
    [2, startYear + 1], // Mar 1 — bills Apr
    [3, startYear + 1], // Apr 1 — bills May
  ];
  return months.map(([m, y]) => new Date(Date.UTC(y, m, 1, 12)));
}
