// Official-PDF fill engine ("DocuSign-style" forms).
//
// Some forms are unmodifiable official artifacts (state emergency cards,
// agency forms). The school uploads the fillable PDF as a template
// (portal_form_pdf_templates); field_schema blocks carry `pdf_field` —
// the PDF's own AcroForm field name. After a real submission, this module
// writes the parent's answers onto the actual PDF, stamps the typed
// signature + date onto the signature widget, flattens the result (so it
// can't be edited downstream), stores it on the student's record, and
// emails the completed PDF to the office notification list and to the
// parent as their signed copy.
//
// Fire-and-forget from the submit route's after() — must never throw
// into the submit path; failures are logged and the submission stands.

import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFSignature, StandardFonts, rgb } from 'pdf-lib';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

interface FillOpts {
  schoolId: string;
  formDefinitionId: string;
  submissionId: string;
  studentId: string | null;
  parentId: string;
  familyId: string;
  responses: Record<string, unknown>;
  fieldSchema: Array<Record<string, unknown>>;
  formDisplayName: string;
  notifyEmails: string[];
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function isTruthyAnswer(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'checked';
}

// True when the form has a PDF template. Cheap existence probe so the
// submit route can skip the whole pipeline for regular forms.
export async function formHasPdfTemplate(formDefinitionId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM portal_form_pdf_templates WHERE form_definition_id = $1`,
    [formDefinitionId],
  );
  return rows.length > 0;
}

export async function generateCompletedPdf(opts: FillOpts): Promise<void> {
  const { rows: tplRows } = await query<{ file_bytes: Buffer; file_name: string }>(
    `SELECT file_bytes, file_name FROM portal_form_pdf_templates WHERE form_definition_id = $1 AND school_id = $2`,
    [opts.formDefinitionId, opts.schoolId],
  );
  const tpl = tplRows[0];
  if (!tpl) return;

  const doc = await PDFDocument.load(tpl.file_bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const sigDate = typeof opts.responses.signature_date === 'string' && opts.responses.signature_date
    ? String(opts.responses.signature_date)
    : new Date().toISOString().slice(0, 10);

  for (const block of opts.fieldSchema) {
    const pdfField = typeof block.pdf_field === 'string' ? block.pdf_field : null;
    const key = typeof block.key === 'string' ? block.key : null;
    if (!pdfField || !key) continue;
    const raw = opts.responses[key];

    // Signature → stamp onto the signature widget's rectangle. Typed
    // names render as italic text; drawn signatures (PNG data URLs from
    // the canvas) are embedded as an image scaled to fit. pdf-lib can't
    // produce cryptographic /Sig signatures; a stamped signature + audit
    // trail is the platform's e-sign model, same as native forms.
    if (block.type === 'signature_typed' || block.type === 'signature_drawn') {
      // Draw-capable blocks store the PNG under key_drawn (typed name under
      // the key itself). Prefer the drawing on the signature line; legacy
      // rows may carry the PNG directly under the key.
      const drawnRaw = asText(opts.responses[`${key}_drawn`]).trim();
      const typedRaw = asText(raw).trim();
      const sigValue = drawnRaw.startsWith('data:image/')
        ? drawnRaw
        : typedRaw;
      if (!sigValue) continue;
      try {
        const field = form.getField(pdfField);
        const widgets = (field as PDFSignature).acroField.getWidgets();
        const widget = widgets[0];
        if (!widget) continue;
        const rect = widget.getRectangle();
        const ref = widget.P();
        const page = doc.getPages().find((p) => p.ref === ref) ?? doc.getPages()[doc.getPageCount() - 1];
        if (sigValue.startsWith('data:image/')) {
          // Drawn signature — embed the PNG, contained within the widget.
          const base64 = sigValue.slice(sigValue.indexOf(',') + 1);
          const pngBytes = Buffer.from(base64, 'base64');
          const png = await doc.embedPng(pngBytes);
          const scale = Math.min(rect.width / png.width, rect.height / png.height);
          const w = png.width * scale;
          const h = png.height * scale;
          page.drawImage(png, {
            x: rect.x + (rect.width - w) / 2,
            y: rect.y + (rect.height - h) / 2,
            width: w, height: h,
          });
        } else {
          const size = Math.min(14, Math.max(9, rect.height - 4));
          page.drawText(sigValue, {
            x: rect.x + 2, y: rect.y + Math.max(2, (rect.height - size) / 2),
            size, font: helvOblique, color: rgb(0.1, 0.1, 0.35),
          });
        }
        const typedName = typedRaw && !typedRaw.startsWith('data:image/') ? typedRaw : '';
        page.drawText(`Signed electronically${typedName ? ` by ${typedName}` : ''} ${sigDate}`, {
          x: rect.x + 2, y: Math.max(2, rect.y - 8),
          size: 6, font: helv, color: rgb(0.4, 0.4, 0.4),
        });
      } catch (e) {
        console.warn('[pdf-fill] signature stamp failed:', e instanceof Error ? e.message : String(e));
      }
      continue;
    }

    const text = asText(raw);
    if (text.trim() === '' && raw !== false) continue;
    try {
      const field = form.getField(pdfField);
      if (field instanceof PDFTextField) {
        field.setText(text);
      } else if (field instanceof PDFCheckBox) {
        if (isTruthyAnswer(raw)) field.check(); else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (field.getOptions().includes(text)) field.select(text);
      } else if (field instanceof PDFDropdown) {
        if (field.getOptions().includes(text)) field.select(text);
      }
    } catch (e) {
      // One unmappable field must not sink the document.
      console.warn(`[pdf-fill] field "${pdfField}" failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  try { form.updateFieldAppearances(helv); } catch { /* some PDFs lack DA defaults */ }
  // Flatten — the completed card becomes a plain, uneditable document.
  try { form.flatten(); } catch (e) {
    console.warn('[pdf-fill] flatten failed (keeping fillable copy):', e instanceof Error ? e.message : String(e));
  }
  const outBytes = Buffer.from(await doc.save());

  // Names for storage + email
  const { rows: metaRows } = await query<{ student: string | null; school_name: string; parent_email: string | null }>(
    `SELECT CASE WHEN st.id IS NOT NULL
              THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
              ELSE NULL END AS student,
            sch.name AS school_name,
            p.email AS parent_email
       FROM schools sch
       LEFT JOIN students st ON st.id = $2
       LEFT JOIN parents p ON p.id = $3
      WHERE sch.id = $1`,
    [opts.schoolId, opts.studentId, opts.parentId],
  );
  const meta = metaRows[0];
  const studentName = meta?.student ?? null;
  const dateLabel = new Date().toISOString().slice(0, 10);
  const fileName = `${opts.formDisplayName.replace(/[^\w\- ]+/g, '').slice(0, 60)} - ${(studentName ?? 'family').replace(/[^\w\- ]+/g, '')} - ${dateLabel}.pdf`;

  // Store on the student's record (per-student forms). Teacher-visible:
  // these are exactly the documents teachers need at hand (emergency
  // cards); parent-visible for their own signed copy.
  if (opts.studentId) {
    try {
      await query(
        `INSERT INTO student_documents
           (school_id, student_id, title, category, description,
            file_name, mime_type, size_bytes, file_bytes,
            uploaded_by, visible_to_teacher, visible_to_parent)
         VALUES ($1, $2, $3, 'forms', $4, $5, 'application/pdf', $6, $7, 'portal-form', true, true)`,
        [
          opts.schoolId, opts.studentId,
          `${opts.formDisplayName}${studentName ? ` — ${studentName}` : ''} (signed ${dateLabel})`,
          `Completed automatically from portal submission ${opts.submissionId}`,
          fileName, outBytes.length, outBytes,
        ],
      );
    } catch (e) {
      console.error('[pdf-fill] student_documents insert failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Email the completed PDF: office notification list + the parent's copy.
  const subjectBase = `Completed: ${opts.formDisplayName}${studentName ? ` — ${studentName}` : ''}`;
  const attachment = { filename: fileName, content: outBytes };
  const bodyText = `The completed, signed "${opts.formDisplayName}"${studentName ? ` for ${studentName}` : ''} is attached as a PDF.`;
  const html = `<p style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;">${bodyText}</p>`;
  for (const to of opts.notifyEmails) {
    await sendBrandedEmail({ to, schoolId: opts.schoolId, subject: subjectBase, html, text: bodyText, attachments: [attachment] })
      .catch((e) => console.error('[pdf-fill] office email failed for', to, ':', e));
  }
  if (meta?.parent_email) {
    await sendBrandedEmail({
      to: meta.parent_email, schoolId: opts.schoolId,
      subject: `Your signed copy: ${opts.formDisplayName}${studentName ? ` — ${studentName}` : ''}`,
      html: `<p style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;">Thanks! Your completed, signed copy of &ldquo;${opts.formDisplayName}&rdquo;${studentName ? ` for ${studentName}` : ''} is attached for your records.</p>`,
      text: `Thanks! Your completed, signed copy of "${opts.formDisplayName}"${studentName ? ` for ${studentName}` : ''} is attached for your records.`,
      attachments: [attachment],
    }).catch((e) => console.error('[pdf-fill] parent email failed:', e));
  }
}
