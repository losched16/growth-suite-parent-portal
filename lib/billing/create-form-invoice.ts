// Helper: given a form submission's evaluated payment lines, create an
// invoice (status=open) on the parent's school, link it back to the
// submission, and return the invoice id.
//
// Used by the portal-forms submit route when a form has
// payment_config.mode === 'required' (or 'optional' with non-empty lines).

import { query, withTransaction } from '@/lib/db';
import type { FormDefinition } from '@/lib/forms/types';
import type { ResolvedLine } from '@/lib/forms/payment-eval';
import { evaluateDiscounts, recordDiscountApplications } from './discounts';

const PLATFORM_FEE_CENTS = parseInt(
  process.env.STRIPE_PLATFORM_FAMILY_SETUP_FEE_CENTS || '2500',
  10,
);

interface CreateOpts {
  schoolId: string;
  familyId: string;
  studentId: string | null;
  submissionId: string;
  formDefinition: FormDefinition;
  lines: ResolvedLine[];
  subtotalCents: number;
  // The display name we'll plug into the invoice's title template.
  studentDisplayName?: string;
  createdByEmail: string;
  // Optional redemption code the parent typed on the submit form.
  redemptionCode?: string;
}

interface CreateResult {
  invoice_id: string;
  invoice_number: string;
  total_cents: number;
}

export async function createInvoiceForFormSubmission(opts: CreateOpts): Promise<CreateResult> {
  if (opts.lines.length === 0) {
    throw new Error('Cannot create an invoice with zero line items');
  }

  // Decide whether this invoice should include the $25 platform family
  // setup fee.
  //   - If the school has `waive_platform_setup_fee = true`, skip
  //     entirely (e.g. DGM is grandfathered onto a flat SaaS fee).
  //   - Else if the form definition explicitly opts in or out → honor it.
  //   - Otherwise auto-decide: include iff this family hasn't paid the
  //     platform setup fee yet.
  let includesSetupFee: boolean;
  const { rows: cfgRows } = await query<{ waive_platform_setup_fee: boolean | null }>(
    `SELECT waive_platform_setup_fee FROM school_payment_config WHERE school_id = $1`,
    [opts.schoolId],
  );
  if (cfgRows[0]?.waive_platform_setup_fee === true) {
    includesSetupFee = false;
  } else {
    const explicit = opts.formDefinition.payment_config?.includes_platform_setup_fee;
    if (typeof explicit === 'boolean') {
      includesSetupFee = explicit;
    } else {
      const { rows } = await query<{ paid_at: string | null }>(
        `SELECT platform_setup_fee_paid_at AS paid_at FROM families WHERE id = $1`,
        [opts.familyId],
      );
      includesSetupFee = !rows[0]?.paid_at;
    }
  }
  const platformFeeCents = includesSetupFee ? PLATFORM_FEE_CENTS : 0;

  // Evaluate any active discounts. Auto-apply policies (sibling, early-
  // bird), the parent's typed code, and any active FA award all fold
  // into the discountResult here. Returned `lines` already have negative
  // amount_cents so we can interleave them with the positive lines.
  const discountResult = await evaluateDiscounts({
    schoolId: opts.schoolId,
    familyId: opts.familyId,
    studentId: opts.studentId,
    lines: opts.lines,
    formSlug: opts.formDefinition.slug,
    redemptionCode: opts.redemptionCode,
  });
  const discountTotal = discountResult.total_cents;
  const totalCents = Math.max(0, opts.subtotalCents - discountTotal) + platformFeeCents;

  // Resolve the invoice title from the configured template
  // (falls back to "Form name").
  const tpl = opts.formDefinition.payment_config?.invoice_title_template
    ?? '{form_name}';
  const title = tpl
    .replace('{form_name}', opts.formDefinition.display_name)
    .replace('{student_name}', opts.studentDisplayName ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  // Compute due_at — defaults to today (parent must pay to submit).
  const dueDays = opts.formDefinition.payment_config?.due_days_from_submission ?? 0;
  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + dueDays);

  // Allocate the next invoice number atomically (same pattern as the
  // admin-side invoice creation route).
  const { rows: configRows } = await query<{ prefix: string; next: number }>(
    `INSERT INTO school_payment_config (school_id) VALUES ($1)
     ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
     RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
    [opts.schoolId],
  );
  const seq = configRows[0].next > 1 ? configRows[0].next - 1 : 1;
  const invoiceNumber = `${configRows[0].prefix}-${String(seq).padStart(6, '0')}`;

  const invoiceId = await withTransaction(async (q) => {
    const insR = await q<{ id: string }>(
      `INSERT INTO invoices
         (school_id, family_id, student_id, invoice_number, title,
          status, subtotal_cents, platform_fee_cents, discount_total_cents,
          total_cents, due_at, issued_at, source, source_ref,
          includes_platform_setup_fee, created_by_email)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10, now(),
               'form_submission', $11::jsonb, $12, $13)
       RETURNING id`,
      [
        opts.schoolId, opts.familyId, opts.studentId,
        invoiceNumber, title || opts.formDefinition.display_name,
        opts.subtotalCents, platformFeeCents, discountTotal, totalCents,
        dueAt.toISOString(),
        JSON.stringify({
          submission_id: opts.submissionId,
          form_definition_id: opts.formDefinition.id,
        }),
        includesSetupFee,
        opts.createdByEmail,
      ],
    );
    const newId = insR.rows[0].id;

    // Positive line items first.
    let pos = 0;
    for (const l of opts.lines) {
      await q(
        `INSERT INTO invoice_line_items
           (invoice_id, position, description, quantity,
            unit_amount_cents, amount_cents, category, student_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId, pos++, l.description, l.quantity,
          l.unit_amount_cents, l.amount_cents,
          l.category ?? null, opts.studentId,
        ],
      );
    }
    // Then discount lines (negative amount_cents).
    for (const d of discountResult.lines) {
      await q(
        `INSERT INTO invoice_line_items
           (invoice_id, position, description, quantity,
            unit_amount_cents, amount_cents, category, student_id)
         VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
        [newId, pos++, d.description, d.amount_cents, d.category, opts.studentId],
      );
    }
    // Audit rows + bump policy redemption_count.
    await recordDiscountApplications(
      opts.schoolId, opts.familyId, newId, discountResult.applications, q,
    );
    return newId;
  });

  // Wire the invoice back onto the submission so the webhook can flip
  // submission status when payment lands.
  await query(
    `UPDATE portal_form_submissions
        SET invoice_id = $1
      WHERE id = $2`,
    [invoiceId, opts.submissionId],
  );

  return {
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    total_cents: totalCents,
  };
}
