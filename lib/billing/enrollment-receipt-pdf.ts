// Generates a PDF receipt for an enrollment submission. Itemizes:
//   - Student + family info
//   - Selected tuition + addons (annual amounts)
//   - Enrollment fee (with date-bracket label)
//   - Plan modifier (+3% Monthly admin / -5% Annual discount)
//   - Sibling/auto discounts applied
//   - Payment plan + due dates
//   - Total due today (enrollment fee) + total annual committed
//   - Signed-by + signed-at
//
// Returns the PDF as a Buffer for emailing as an attachment.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { query } from '@/lib/db';

interface ReceiptLineItem {
  description: string;
  amount_cents: number;
  category: string | null;
}

interface ReceiptArgs {
  submissionId: string;
  schoolId: string;
}

export async function generateEnrollmentReceiptPdf(args: ReceiptArgs): Promise<Buffer> {
  // ── Pull everything we need in one batch ─────────────────────────
  const { rows: subRows } = await query<{
    id: string;
    family_id: string;
    student_id: string | null;
    parent_id: string;
    responses: Record<string, unknown>;
    submitted_at: string;
    form_display_name: string;
    school_name: string;
    family_display_name: string | null;
    parent_first: string;
    parent_last: string;
    parent_email: string | null;
    student_name: string | null;
    student_dob: string | null;
  }>(
    `SELECT s.id, s.family_id, s.student_id, s.parent_id, s.responses, s.submitted_at,
            d.display_name AS form_display_name,
            sch.name AS school_name,
            f.display_name AS family_display_name,
            p.first_name AS parent_first, p.last_name AS parent_last, p.email AS parent_email,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_name,
            st.date_of_birth AS student_dob
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       JOIN schools sch ON sch.id = s.school_id
       JOIN families f ON f.id = s.family_id
       JOIN parents p ON p.id = s.parent_id
       LEFT JOIN students st ON st.id = s.student_id
      WHERE s.id = $1 AND s.school_id = $2`,
    [args.submissionId, args.schoolId],
  );
  if (subRows.length === 0) {
    throw new Error('Submission not found');
  }
  const sub = subRows[0];

  // Pull the enrollment-fee invoice (the immediate one) + installment invoices
  const { rows: invoiceRows } = await query<{
    id: string;
    invoice_number: string;
    title: string;
    subtotal_cents: number;
    discount_total_cents: number;
    total_cents: number;
    due_at: string;
    source_ref: { kind?: string; installment_number?: number; enrollment_id?: string } | null;
  }>(
    `SELECT id, invoice_number, title, subtotal_cents, discount_total_cents, total_cents,
            due_at, source_ref
       FROM invoices
      WHERE school_id = $1
        AND source_ref->>'submission_id' = $2
      ORDER BY (source_ref->>'kind' = 'enrollment_fee') DESC,
               (source_ref->>'installment_number')::int NULLS FIRST`,
    [args.schoolId, args.submissionId],
  );
  const enrollmentFeeInv = invoiceRows.find((i) => i.source_ref?.kind === 'enrollment_fee');
  const installments = invoiceRows.filter((i) => i.source_ref?.installment_number != null);

  // Line items for the enrollment-fee invoice
  let enrollmentFeeLines: ReceiptLineItem[] = [];
  if (enrollmentFeeInv) {
    const { rows: liRows } = await query<ReceiptLineItem>(
      `SELECT description, amount_cents, category
         FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
      [enrollmentFeeInv.id],
    );
    enrollmentFeeLines = liRows;
  }

  // ── Build the PDF ────────────────────────────────────────────────
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const MARGIN_X = 50;
  let y = 750;
  const COLOR_TEXT = rgb(0.07, 0.09, 0.15);
  const COLOR_MUTED = rgb(0.42, 0.45, 0.5);
  const COLOR_BRAND = rgb(0.02, 0.47, 0.34); // emerald-700

  function line(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 11;
    const font = opts.bold ? helvBold : helv;
    page.drawText(text, {
      x: MARGIN_X + (opts.indent ?? 0),
      y,
      size,
      font,
      color: opts.color ?? COLOR_TEXT,
    });
    y -= size + 4;
  }
  function row(left: string, right: string, opts: { bold?: boolean; muted?: boolean } = {}) {
    const font = opts.bold ? helvBold : helv;
    const color = opts.muted ? COLOR_MUTED : COLOR_TEXT;
    page.drawText(left, { x: MARGIN_X, y, size: 11, font, color });
    const w = font.widthOfTextAtSize(right, 11);
    page.drawText(right, { x: 612 - MARGIN_X - w, y, size: 11, font, color });
    y -= 16;
  }
  function divider() {
    page.drawLine({
      start: { x: MARGIN_X, y: y + 4 },
      end:   { x: 612 - MARGIN_X, y: y + 4 },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.88),
    });
    y -= 8;
  }
  function gap(n = 8) { y -= n; }

  // Header
  page.drawText('Enrollment Receipt', { x: MARGIN_X, y, size: 22, font: helvBold, color: COLOR_BRAND });
  y -= 28;
  page.drawText(sub.school_name, { x: MARGIN_X, y, size: 12, font: helv, color: COLOR_MUTED });
  y -= 18;
  page.drawText(sub.form_display_name, { x: MARGIN_X, y, size: 12, font: helv, color: COLOR_MUTED });
  y -= 24;

  // Parent + student block
  const familyLabel = sub.family_display_name || `${sub.parent_first} ${sub.parent_last}`;
  row('Family', familyLabel);
  if (sub.student_name) row('Student', sub.student_name);
  if (sub.student_dob) row('Date of birth', new Date(sub.student_dob).toLocaleDateString());
  row('Signed by', `${sub.parent_first} ${sub.parent_last}`);
  row('Submitted', new Date(sub.submitted_at).toLocaleString());
  if (sub.responses && typeof sub.responses.enrollment_start_date === 'string') {
    row('Enrollment start date', sub.responses.enrollment_start_date);
  }
  gap();
  divider();
  gap();

  // Due-now section
  line('Due now', { size: 14, bold: true, color: COLOR_BRAND });
  gap(4);
  if (enrollmentFeeLines.length > 0) {
    for (const l of enrollmentFeeLines) {
      const isNegative = l.amount_cents < 0;
      row(
        l.description,
        `${isNegative ? '−' : ''}$${(Math.abs(l.amount_cents) / 100).toFixed(2)}`,
        { muted: isNegative },
      );
    }
    if (enrollmentFeeInv) {
      gap(2);
      row('Total due now', `$${(enrollmentFeeInv.total_cents / 100).toFixed(2)}`, { bold: true });
      row('Invoice #', enrollmentFeeInv.invoice_number, { muted: true });
    }
  } else {
    row('(no enrollment fee on this submission)', '', { muted: true });
  }
  gap();
  divider();
  gap();

  // Installment plan section
  if (installments.length > 0) {
    line('Tuition payment plan', { size: 14, bold: true, color: COLOR_BRAND });
    gap(4);
    line(`${installments.length} installment${installments.length === 1 ? '' : 's'}`, { color: COLOR_MUTED, size: 10 });
    gap(2);
    let planAnnualTotal = 0;
    for (const inv of installments) {
      const due = new Date(inv.due_at);
      planAnnualTotal += inv.total_cents;
      row(
        `#${inv.source_ref?.installment_number ?? '?'} — due ${due.toLocaleDateString()}`,
        `$${(inv.total_cents / 100).toFixed(2)}`,
        { muted: false },
      );
      page.drawText(inv.invoice_number, {
        x: MARGIN_X + 12,
        y: y + 6,
        size: 8,
        font: helv,
        color: COLOR_MUTED,
      });
      y -= 4;
    }
    gap(2);
    row('Total annual commitment', `$${(planAnnualTotal / 100).toFixed(2)}`, { bold: true });
    gap();
    divider();
    gap();
  }

  // Footer disclaimer
  page.drawText('This receipt is a courtesy summary. Detailed invoices live in your parent portal.', {
    x: MARGIN_X, y, size: 9, font: helv, color: COLOR_MUTED,
  });
  y -= 12;
  page.drawText(`Generated ${new Date().toLocaleString()}`, {
    x: MARGIN_X, y, size: 8, font: helv, color: COLOR_MUTED,
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
