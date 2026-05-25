// POST /api/portal-forms/submit — accept a form submission from the parent.
//
// Body: multipart/form-data with field keys matching the definition's
// field_schema. Plus:
//   - form_definition_id (uuid)        — required
//   - student_id (uuid)                — required when definition.per_student
//
// Server flow:
//   1) Resolve session → parent/family/school
//   2) Load definition; validate ownership (school_id)
//   3) Build `responses` JSON from multipart fields (text + checkboxes
//      + multi-checkbox arrays + signature data URLs + signed_at timestamps)
//   4) Stream file uploads to portal_form_submission_files (bytea)
//   5) Insert portal_form_submissions row
//   6) Best-effort GHL writeback (per-field, optionally per-student
//      slot pattern) — runs after the DB insert; errors are logged on
//      the row but don't fail the submission.
//   7) Optionally update student_health_profiles when the form schema
//      writes to health.* prefill slots (so subsequent trip forms
//      pre-fill from updated values).
//
// Returns: { id: <submission uuid>, slug: <form slug> }

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import type { FormFieldBlock, FormDefinition, FormPaymentConfig } from '@/lib/forms/types';
import { evaluatePayment } from '@/lib/forms/payment-eval';
import { createInvoiceForFormSubmission } from '@/lib/billing/create-form-invoice';
import { createEnrollmentInvoices } from '@/lib/billing/create-enrollment-invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CURRENT_YEAR = '2025-26';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

interface DefRow {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  per_student: boolean;
  field_schema: FormFieldBlock[];
  ghl_writeback: GhlWritebackEntry[];
  fee_amount: string | null;
  one_submission_per_year: boolean;
  resubmission_allowed: boolean;
  payment_config: FormPaymentConfig | null;
  allow_addendum: boolean;
  // Migrations 040 + 042 — post-submit behavior
  confirmation_message: string | null;
  confirmation_redirect_url: string | null;
  notify_emails: string[] | null;
  webhook_urls: string[] | null;
}

interface GhlWritebackEntry {
  field_key: string;                  // form field key
  ghl_field_key: string;              // target custom field key
  per_student?: boolean;              // if true → "student_<N>_<key>" slot
}

// student.metadata field-keys we sync to from the health.* prefill slots
const HEALTH_PROFILE_FIELDS = new Set([
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relationship',
  'primary_doctor_name',
  'primary_doctor_phone',
  'preferred_hospital',
  'health_insurance_provider',
  'health_insurance_policy_number',
  'allergies',
  'current_medications',
  'medical_conditions',
]);

export async function POST(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const formDefId = String(fd.get('form_definition_id') ?? '').trim();
  if (!formDefId) {
    return NextResponse.json({ error: 'missing_form_definition_id' }, { status: 400 });
  }

  // ── Addendum markers (set by the FormRenderer when the parent
  //    chose "Update specific fields" instead of a full submission).
  //    We validate them against the DB later to prevent tampering.
  const isAddendum = fd.get('__addendum') === '1';
  const parentSubmissionIdRaw = String(fd.get('__parent_submission_id') ?? '').trim();
  const addendumFieldsRaw = String(fd.get('__addendum_fields') ?? '').trim();
  const addendumFields = isAddendum
    ? addendumFieldsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // 1. Load definition (scoped to parent's school)
  const defs = (await query<DefRow>(
    `SELECT id, slug, display_name, category, per_student, field_schema,
            ghl_writeback, fee_amount, one_submission_per_year, resubmission_allowed,
            payment_config, allow_addendum,
            confirmation_message, confirmation_redirect_url, notify_emails, webhook_urls
     FROM portal_form_definitions
     WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [formDefId, session.school_id],
  )).rows;
  const def = defs[0];
  if (!def) return NextResponse.json({ error: 'form_not_found' }, { status: 404 });

  // 2. Resolve student (per_student forms)
  let studentId: string | null = null;
  if (def.per_student) {
    const raw = String(fd.get('student_id') ?? '').trim();
    if (!raw) return NextResponse.json({ error: 'missing_student_id' }, { status: 400 });
    const sRows = (await query<{ id: string }>(
      `SELECT id FROM students WHERE id = $1 AND family_id = $2 AND status = 'active'`,
      [raw, session.family_id],
    )).rows;
    if (sRows.length === 0) {
      return NextResponse.json({ error: 'student_not_in_family' }, { status: 403 });
    }
    studentId = sRows[0].id;
  }

  // 3. Lock-out check: one_submission_per_year + !resubmission_allowed.
  //    If a submitted row already exists for (family, def, year[, student]) → reject.
  if (def.one_submission_per_year && !def.resubmission_allowed) {
    const existing = (await query<{ id: string }>(
      `SELECT id FROM portal_form_submissions
       WHERE family_id = $1 AND form_definition_id = $2 AND academic_year = $3
         AND status IN ('submitted', 'paid', 'pending_payment')
         AND ($4::uuid IS NULL OR student_id = $4)
       LIMIT 1`,
      [session.family_id, def.id, CURRENT_YEAR, studentId],
    )).rows;
    // The "already submitted this year" check doesn't apply when the
    // parent is filing an addendum — that's the whole point.
    if (existing.length > 0 && !isAddendum) {
      return NextResponse.json(
        { error: 'already_submitted', detail: 'A submission already exists for this year.' },
        { status: 409 },
      );
    }
  }

  // 3b. Validate the addendum markers if this is an addendum submission.
  //     We re-check parent_submission_id against the DB so a tampered
  //     client can't reference somebody else's submission.
  let validParentSubmissionId: string | null = null;
  if (isAddendum) {
    if (!def.allow_addendum) {
      return NextResponse.json(
        { error: 'addendum_not_allowed', detail: 'This form does not support addendums.' },
        { status: 400 },
      );
    }
    if (!parentSubmissionIdRaw) {
      return NextResponse.json({ error: 'missing_parent_submission_id' }, { status: 400 });
    }
    if (addendumFields.length === 0) {
      return NextResponse.json({ error: 'no_addendum_fields' }, { status: 400 });
    }
    // Confirm the parent submission exists, belongs to this family, and
    // is the same form definition (and same student, if per-student).
    const { rows: pRows } = await query<{ id: string }>(
      `SELECT id FROM portal_form_submissions
        WHERE id = $1
          AND family_id = $2
          AND form_definition_id = $3
          AND ($4::uuid IS NULL OR student_id = $4)
          AND is_addendum = false
        LIMIT 1`,
      [parentSubmissionIdRaw, session.family_id, def.id, studentId],
    );
    if (pRows.length === 0) {
      return NextResponse.json(
        { error: 'parent_submission_not_found', detail: 'The submission you\'re updating doesn\'t belong to your family.' },
        { status: 403 },
      );
    }
    // Restrict addendum_fields to keys that actually exist in the
    // current field_schema — strip anything else.
    const schemaKeys = new Set(
      def.field_schema
        .filter((b): b is FormFieldBlock & { key: string } => 'key' in b)
        .map((b) => b.key),
    );
    const filtered = addendumFields.filter((k) => schemaKeys.has(k));
    if (filtered.length === 0) {
      return NextResponse.json(
        { error: 'no_valid_addendum_fields', detail: 'None of the listed fields match this form.' },
        { status: 400 },
      );
    }
    // Replace addendumFields with the filtered list in-place.
    addendumFields.length = 0;
    addendumFields.push(...filtered);
    validParentSubmissionId = parentSubmissionIdRaw;
  }

  // 4. Build responses JSON from multipart fields.
  //    We iterate the definition's schema so we capture exactly the
  //    fields the form declared (and nothing extra a malicious client
  //    might inject). For addendums, we only iterate the picked subset
  //    PLUS signatures (re-signed for audit).
  const responses: Record<string, unknown> = {};
  const fileFields: Array<{ key: string; file: File; displayName: string }> = [];
  const validationErrors: string[] = [];

  const addendumKeySet = isAddendum ? new Set(addendumFields) : null;

  for (const block of def.field_schema) {
    if (!('key' in block)) continue;
    // Skip non-picked fields when in addendum mode. Signatures stay so
    // we capture a fresh sig on the addendum row.
    if (addendumKeySet
      && !addendumKeySet.has(block.key)
      && block.type !== 'signature_drawn'
      && block.type !== 'signature_typed') {
      continue;
    }
    const key = block.key;

    switch (block.type) {
      case 'multi_checkbox': {
        const values = fd.getAll(`${key}[]`).map((v) => String(v));
        if (block.required && values.length === 0) validationErrors.push(`${block.label} is required`);
        responses[key] = values;
        break;
      }
      case 'student_applicability': {
        // Same wire format as multi_checkbox — array of student UUIDs
        // (or the special "all" sentinel). Stored as-is in jsonb so
        // downstream consumers can reason about "does this EC apply to
        // student X?" without joining additional tables.
        const values = fd.getAll(`${key}[]`).map((v) => String(v));
        if (block.required && values.length === 0) {
          validationErrors.push(`${block.label} is required`);
        }
        responses[key] = values;
        break;
      }
      case 'checkbox': {
        const v = fd.get(key);
        const checked = v !== null && String(v) !== '';
        if (block.required && !checked) validationErrors.push(`${block.label} is required`);
        responses[key] = checked;
        break;
      }
      case 'file_upload': {
        const v = fd.get(key);
        if (v instanceof File && v.size > 0) {
          if (v.size > (block.max_size_mb ? block.max_size_mb * 1024 * 1024 : MAX_FILE_BYTES)) {
            validationErrors.push(`${block.label}: file too large`);
          } else {
            fileFields.push({ key, file: v, displayName: block.label });
          }
        } else if (block.required) {
          validationErrors.push(`${block.label} is required`);
        }
        break;
      }
      case 'signature_typed': {
        const v = String(fd.get(key) ?? '').trim();
        const signedAt = String(fd.get(`${key}_signed_at`) ?? '').trim();
        if (block.required && !v) validationErrors.push(`${block.label} is required`);
        responses[key] = v;
        if (signedAt) responses[`${key}_signed_at`] = signedAt;
        break;
      }
      case 'signature_drawn': {
        const v = String(fd.get(key) ?? '').trim();
        if (block.required && !v.startsWith('data:image/')) {
          validationErrors.push(`${block.label} is required`);
        }
        responses[key] = v;
        break;
      }
      case 'number': {
        const raw = String(fd.get(key) ?? '').trim();
        if (raw === '') {
          if (block.required) validationErrors.push(`${block.label} is required`);
          responses[key] = '';
        } else {
          const n = Number(raw);
          if (Number.isNaN(n)) validationErrors.push(`${block.label} must be a number`);
          else responses[key] = n;
        }
        break;
      }
      case 'pricing_select': {
        const raw = String(fd.get(key) ?? '').trim();
        if (block.required && !raw) validationErrors.push(`${block.label} is required`);
        // Reject anything not in the published options list.
        if (raw && !block.options.some((o) => o.value === raw)) {
          validationErrors.push(`${block.label}: invalid choice`);
        }
        responses[key] = raw;
        break;
      }
      case 'multi_pricing': {
        const values = fd.getAll(`${key}[]`).map((v) => String(v));
        if (block.required && values.length === 0) {
          validationErrors.push(`${block.label} is required`);
        }
        // Strip any values not in the published options list.
        const allowed = new Set(block.options.map((o) => o.value));
        responses[key] = values.filter((v) => allowed.has(v));
        break;
      }
      case 'quantity_pricing': {
        const raw = String(fd.get(key) ?? '').trim();
        const n = raw === '' ? 0 : parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0) {
          validationErrors.push(`${block.label}: invalid quantity`);
          responses[key] = 0;
        } else {
          if (typeof block.min === 'number' && n < block.min) {
            validationErrors.push(`${block.label}: minimum is ${block.min}`);
          }
          if (typeof block.max === 'number' && n > block.max) {
            validationErrors.push(`${block.label}: maximum is ${block.max}`);
          }
          if (block.required && n <= 0) {
            validationErrors.push(`${block.label} is required`);
          }
          responses[key] = n;
        }
        break;
      }
      case 'tuition_calculator': {
        const raw = String(fd.get(key) ?? '').trim();
        if (!raw) {
          if (block.required) validationErrors.push(`${block.label} is required`);
          responses[key] = null;
        } else {
          try {
            const parsed = JSON.parse(raw);
            // Re-verify the chosen grid against the DB so a tampered
            // client can't invent a tuition amount.
            const verified = await verifyTuitionCalcSelection(session.school_id, session.family_id, parsed);
            if (!verified) {
              validationErrors.push(`${block.label}: invalid selection`);
              responses[key] = null;
            } else {
              responses[key] = verified;
            }
          } catch {
            validationErrors.push(`${block.label}: could not parse selection`);
            responses[key] = null;
          }
        }
        break;
      }
      default: {
        // text/email/tel/url/textarea/date/select/radio — plain string
        const raw = String(fd.get(key) ?? '').trim();
        if (block.required && !raw) validationErrors.push(`${block.label} is required`);
        // Apply max_length for text-like fields
        const maxLen = 'max_length' in block && typeof block.max_length === 'number' ? block.max_length : undefined;
        responses[key] = maxLen ? raw.slice(0, maxLen) : raw;
        break;
      }
    }
  }

  if (validationErrors.length > 0) {
    return NextResponse.json({ error: 'validation_failed', detail: validationErrors }, { status: 400 });
  }

  // 4b. If the form declares a payment_config, evaluate the lines now
  //     so we know whether an invoice is needed (and whether we should
  //     mark the submission pending_payment).
  const formDefForEval: FormDefinition = {
    id: def.id,
    slug: def.slug,
    display_name: def.display_name,
    description: null,
    category: def.category,
    per_student: def.per_student,
    required_for: null,
    field_schema: def.field_schema,
    fee_amount: def.fee_amount ? Number(def.fee_amount) : null,
    one_submission_per_year: def.one_submission_per_year,
    resubmission_allowed: def.resubmission_allowed,
    needs_review: false,
    payment_config: def.payment_config,
    allow_addendum: def.allow_addendum,
  };
  const paymentEval = def.payment_config
    ? evaluatePayment(formDefForEval, responses)
    : null;
  const paymentRequired = def.payment_config?.mode === 'required'
    && paymentEval !== null
    && paymentEval.subtotal_cents > 0;
  // If the form requires payment but the lines came out empty,
  // reject — the parent didn't make a paid selection.
  if (def.payment_config?.mode === 'required' && (!paymentEval || paymentEval.subtotal_cents <= 0)) {
    return NextResponse.json(
      { error: 'no_paid_selection', detail: 'This form requires a paid selection.' },
      { status: 400 },
    );
  }

  // 5. Insert submission row.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;
  // pending_payment when either the legacy fee_amount applies OR the
  // new payment_config requires upfront payment.
  const status = (def.fee_amount && Number(def.fee_amount) > 0) || paymentRequired
    ? 'pending_payment'
    : 'submitted';

  const { rows: insRows } = await query<{ id: string }>(
    `INSERT INTO portal_form_submissions
       (school_id, form_definition_id, family_id, parent_id, student_id,
        academic_year, responses, status, fee_amount_charged, ip_address, user_agent,
        is_addendum, parent_submission_id, addendum_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      session.school_id, def.id, session.family_id, session.parent_id, studentId,
      CURRENT_YEAR, JSON.stringify(responses), status,
      def.fee_amount ? Number(def.fee_amount) : null,
      ip, userAgent,
      isAddendum, validParentSubmissionId,
      isAddendum && addendumFields.length > 0 ? addendumFields : null,
    ],
  );
  const submissionId = insRows[0].id;

  // If this submission came in via an operator invite, mark the invite
  // consumed so it can't be re-used. Best-effort — never blocks submit.
  const inviteIdRaw = String(fd.get('__invite_id') ?? '').trim();
  if (inviteIdRaw) {
    await query(
      `UPDATE enrollment_invites
          SET consumed_at = now(),
              consumed_submission_id = $1
        WHERE id = $2
          AND school_id = $3
          AND family_id = $4
          AND consumed_at IS NULL`,
      [submissionId, inviteIdRaw, session.school_id, session.family_id],
    ).catch((e) => console.error('[submit] invite consume failed:', e));
  }

  // 6. Persist file uploads
  for (const f of fileFields) {
    const buf = Buffer.from(await f.file.arrayBuffer());
    await query(
      `INSERT INTO portal_form_submission_files
         (submission_id, school_id, field_key, display_name, original_filename,
          mime_type, size_bytes, contents, uploaded_by_parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        submissionId, session.school_id, f.key, f.displayName,
        f.file.name, f.file.type, buf.length, buf, session.parent_id,
      ],
    );
  }

  // 7. Audit log
  await query(
    `INSERT INTO parent_portal_audit_log
       (school_id, parent_id, family_id, event_type, detail)
     VALUES ($1, $2, $3, 'submit_form', $4::jsonb)`,
    [
      session.school_id, session.parent_id, session.family_id,
      JSON.stringify({
        submission_id: submissionId,
        form_definition_id: def.id,
        form_slug: def.slug,
        student_id: studentId,
        files: fileFields.length,
      }),
    ],
  ).catch(() => undefined);

  // 7b. Auto-resolve migration flags this submission addresses.
  //
  // missing_submission_for_student: resolves when the family has a new
  //   submission for (this form, this student).
  // possible_student_data_collision: same — a fresh submission supersedes
  //   the collision concern.
  // student_attribution_unknown: same — fresh submission has correct
  //   attribution.
  // The emergency_contacts_per_student_review flag is handled by its
  // own dedicated widget; we don't auto-resolve it here unless the
  // re-submitted form happens to be the emergency-medical with an EC
  // for this student.
  if (studentId) {
    await query(
      `UPDATE portal_migration_flags
         SET status = 'resolved',
             resolved_at = now(),
             resolved_by_parent_id = $4,
             resolution_note = 'auto-resolved on re-submission'
       WHERE school_id = $1
         AND family_id = $2
         AND form_definition_id = $3
         AND student_id = $5
         AND status = 'pending'
         AND flag_kind IN (
           'missing_submission_for_student',
           'possible_student_data_collision',
           'student_attribution_unknown'
         )`,
      [session.school_id, session.family_id, def.id, session.parent_id, studentId],
    ).catch((e) => console.error('[submit] flag auto-resolve failed:', e));
  } else {
    // Family-level form re-submission: resolve family-level flags
    // attached to this form.
    await query(
      `UPDATE portal_migration_flags
         SET status = 'resolved',
             resolved_at = now(),
             resolved_by_parent_id = $4,
             resolution_note = 'auto-resolved on re-submission'
       WHERE school_id = $1
         AND family_id = $2
         AND form_definition_id = $3
         AND student_id IS NULL
         AND status = 'pending'
         AND flag_kind IN (
           'possible_student_data_collision',
           'student_attribution_unknown'
         )`,
      [session.school_id, session.family_id, def.id, session.parent_id],
    ).catch((e) => console.error('[submit] family flag auto-resolve failed:', e));
  }

  // 8. Sync health profile — any responses keyed by health profile field
  //    names should be persisted to student_health_profiles so future
  //    trip forms prefill from the latest values. Only applies to
  //    per-student forms with a resolved student_id.
  if (studentId) {
    const healthUpdate: Record<string, string> = {};
    for (const block of def.field_schema) {
      if (!('key' in block)) continue;
      if (HEALTH_PROFILE_FIELDS.has(block.key) && typeof responses[block.key] === 'string') {
        healthUpdate[block.key] = String(responses[block.key]);
      }
    }
    if (Object.keys(healthUpdate).length > 0) {
      await upsertHealthProfile(session.school_id, studentId, session.parent_id, healthUpdate)
        .catch((e) => console.error('[portal-forms/submit] health profile upsert failed:', e));
    }
  }

  // 9. Best-effort GHL writeback. Fire-and-forget so the parent gets a
  //    fast response even if GHL is slow. Errors recorded on the row.
  if ((def.ghl_writeback?.length ?? 0) > 0) {
    pushSubmissionToGhl(submissionId, {
      schoolId: session.school_id,
      parentId: session.parent_id,
      familyId: session.family_id,
      studentId,
      writeback: def.ghl_writeback,
      responses,
    }).catch((err) => {
      console.error('[portal-forms/submit] GHL writeback crashed for', submissionId, ':', err);
    });
  }

  // 10. Payment-required forms: create the invoice now and return its
  //      id so the client can redirect to /billing/pay/{id}. The
  //      submission already sits in pending_payment; the Stripe webhook
  //      flips it to 'paid' (and the form's "submitted" status) when
  //      the parent finishes paying.
  let redirectInvoiceId: string | null = null;
  if (paymentRequired && paymentEval && paymentEval.lines.length > 0) {
    try {
      // Best-effort: resolve a student display name for the title template.
      let studentDisplayName: string | undefined;
      if (studentId) {
        const { rows: sRows } = await query<{ name: string }>(
          `SELECT COALESCE(NULLIF(preferred_name, ''), first_name) || ' ' || last_name AS name
             FROM students WHERE id = $1`,
          [studentId],
        );
        studentDisplayName = sRows[0]?.name;
      }
      const redemptionCode = String(fd.get('__redemption_code') ?? '').trim();

      // If the form has a `payment_plan` field response, this is an
      // enrollment-style form. Split into: enrollment-fee invoice (due
      // now) + N installment invoices (per the chosen plan).
      const rawPlan = String(responses.payment_plan ?? '').trim();
      const isEnrollmentFlow =
        rawPlan === 'monthly' || rawPlan === 'semi_annual' || rawPlan === 'annual';

      if (isEnrollmentFlow) {
        const startDateRaw = String(responses.enrollment_start_date ?? '').trim();
        const created = await createEnrollmentInvoices({
          schoolId: session.school_id,
          familyId: session.family_id,
          studentId,
          submissionId,
          formDefinition: formDefForEval,
          lines: paymentEval.lines,
          subtotalCents: paymentEval.subtotal_cents,
          paymentPlan: rawPlan as 'monthly' | 'semi_annual' | 'annual',
          enrollmentStartDate: startDateRaw || null,
          studentDisplayName,
          createdByEmail: 'form-submission@growthsuite.local',
          redemptionCode: redemptionCode || undefined,
        });
        // Send the parent first to the enrollment-fee invoice (due now).
        redirectInvoiceId = created.enrollment_fee_invoice_id
          ?? created.installment_invoice_ids[0]
          ?? null;
      } else {
        const created = await createInvoiceForFormSubmission({
          schoolId: session.school_id,
          familyId: session.family_id,
          studentId,
          submissionId,
          formDefinition: formDefForEval,
          lines: paymentEval.lines,
          subtotalCents: paymentEval.subtotal_cents,
          studentDisplayName,
          createdByEmail: 'form-submission@growthsuite.local',
          redemptionCode: redemptionCode || undefined,
        });
        redirectInvoiceId = created.invoice_id;
      }
    } catch (err) {
      console.error('[portal-forms/submit] invoice creation failed:', err);
      // Surface a non-fatal warning to the client — the submission is
      // saved but the redirect won't happen. Operator can manually
      // create the invoice.
      return NextResponse.json({
        id: submissionId,
        slug: def.slug,
        warning: 'submission_saved_but_invoice_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 11. PDF receipt email for enrollment submissions. Fire-and-forget —
  //     never blocks the parent's redirect.
  if (paymentRequired) {
    sendEnrollmentReceiptEmail(submissionId, session.school_id).catch((e) => {
      console.error('[portal-forms/submit] receipt email failed:', e);
    });
  }

  // 12. Admin notification when the parent updated their info. Fires
  //     when any pg1_* field on the submission differs from what's on
  //     file in the `parents` table (or if pg2_* info was provided).
  //     For DGM, this email goes to admissions so they can update TC.
  if (Object.keys(responses).some((k) => k.startsWith('pg1_') || k.startsWith('pg2_'))) {
    import('@/lib/billing/admin-change-notification').then((m) =>
      m.notifyAdminOfParentChanges({
        schoolId: session.school_id,
        submissionId,
        parentId: session.parent_id,
        responses,
        formDisplayName: def.display_name,
      })
    ).catch((e) => console.error('[portal-forms/submit] admin notify failed:', e));
  }

  // 13. Configurable post-submit effects (migrations 040 + 042):
  //     - Office notification email → notify_emails
  //     - Webhook fan-out → webhook_urls
  // Both are fire-and-forget; they NEVER block the parent's redirect.
  import('@/lib/forms/post-submit-effects').then((m) =>
    m.firePostSubmitEffects({
      submissionId,
      schoolId: session.school_id,
      formId: def.id,
      formSlug: def.slug,
      formDisplayName: def.display_name,
      formCategory: def.category,
      familyId: session.family_id,
      parentId: session.parent_id,
      studentId,
      responses,
      notifyEmails: def.notify_emails ?? null,
      webhookUrls: def.webhook_urls ?? null,
    })
  ).catch((e) => console.error('[portal-forms/submit] post-submit effects scheduling failed:', e));

  return NextResponse.json({
    id: submissionId,
    slug: def.slug,
    redirect_to_invoice_id: redirectInvoiceId,
    confirmation_message: def.confirmation_message,
    confirmation_redirect_url: def.confirmation_redirect_url,
  });
}

// Best-effort: build the enrollment-receipt PDF + email it to every
// active parent on the family. Lives in this file (not its own helper)
// so the lazy-import of pdf-lib stays on the cold path.
async function sendEnrollmentReceiptEmail(submissionId: string, schoolId: string): Promise<void> {
  const { generateEnrollmentReceiptPdf } = await import('@/lib/billing/enrollment-receipt-pdf');
  const { sendBrandedEmail } = await import('@/lib/email');

  const pdfBuffer = await generateEnrollmentReceiptPdf({ submissionId, schoolId });

  // Resolve parents to email + the form/school names for the subject.
  const { rows: meta } = await query<{
    family_id: string;
    school_name: string;
    form_name: string;
    student_name: string | null;
  }>(
    `SELECT s.family_id, sch.name AS school_name, d.display_name AS form_name,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_name
       FROM portal_form_submissions s
       JOIN schools sch ON sch.id = s.school_id
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       LEFT JOIN students st ON st.id = s.student_id
      WHERE s.id = $1`,
    [submissionId],
  );
  if (meta.length === 0) return;
  const m = meta[0];

  const { rows: parents } = await query<{ email: string }>(
    `SELECT email FROM parents
      WHERE family_id = $1 AND school_id = $2 AND status = 'active' AND email IS NOT NULL`,
    [m.family_id, schoolId],
  );
  if (parents.length === 0) return;

  const subject = `Enrollment confirmation: ${m.form_name}${m.student_name ? ` (${m.student_name})` : ''}`;
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px;">${escape(m.form_name)} received</h2>
  <p style="margin: 0 0 16px; font-size: 14px;">
    Thanks${m.student_name ? ` for enrolling ${escape(m.student_name)}` : ''} at ${escape(m.school_name)}!
    Your itemized enrollment receipt is attached as a PDF.
  </p>
  <p style="margin: 16px 0; font-size: 13px; color: #6b7280;">
    Your enrollment fee invoice is in your parent portal. Once paid, the rest of your tuition
    installments will be billed automatically per your chosen payment plan.
  </p>
</body></html>`.trim();
  const text = `${m.form_name} received

Thanks${m.student_name ? ` for enrolling ${m.student_name}` : ''} at ${m.school_name}.
Your itemized enrollment receipt is attached as a PDF.

Your enrollment fee invoice is in your parent portal. Once paid, the rest of your tuition
installments will be billed automatically per your chosen payment plan.`;

  for (const p of parents) {
    await sendBrandedEmail({
      to: p.email,
      schoolId,
      subject,
      html,
      text,
      attachments: [
        {
          filename: `enrollment-receipt-${submissionId.slice(0, 8)}.pdf`,
          content: pdfBuffer,
        },
      ],
    }).catch((e) => console.error('[receipt-email] send failed for', p.email, ':', e));
  }
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}

// ─── Helper: verify a TuitionCalculator selection against the DB ──────
// The client posts a JSON payload describing what it computed. We
// re-derive the canonical values from tuition_grids + payment_plans so
// a tampered client can't invent prices.
interface TuitionCalcPayload {
  tuition_grid_id?: unknown;
  plan_slug?: unknown;
  addons?: unknown;
}
interface VerifiedTuitionCalc {
  tuition_grid_id: string;
  display_name: string;
  annual_tuition_cents: number;
  plan_slug: string | null;
  plan_label: string | null;
  plan_discount_bp: number;
  addons: Array<{ key: string; label: string; amount_cents: number; paid?: boolean }>;
  total_cents: number;
}
async function verifyTuitionCalcSelection(
  schoolId: string,
  familyId: string,
  raw: TuitionCalcPayload | null | undefined,
): Promise<VerifiedTuitionCalc | null> {
  if (!raw || typeof raw !== 'object') return null;
  const gridId = typeof raw.tuition_grid_id === 'string' ? raw.tuition_grid_id : null;
  if (!gridId) return null;
  const { rows: gRows } = await query<{
    id: string;
    display_name: string;
    annual_tuition_cents: number;
    addons: Array<{ key: string; label: string; amount_cents: number; required?: boolean }> | null;
  }>(
    `SELECT id, display_name, annual_tuition_cents, addons
       FROM tuition_grids
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [gridId, schoolId],
  );
  const g = gRows[0];
  if (!g) return null;

  // Resolve plan (optional)
  let planSlug: string | null = null;
  let planLabel: string | null = null;
  let planDiscountBp = 0;
  if (typeof raw.plan_slug === 'string' && raw.plan_slug) {
    const { rows: pRows } = await query<{ slug: string; display_name: string; discount_basis_points: number }>(
      `SELECT slug, display_name, discount_basis_points FROM payment_plans
        WHERE school_id = $1 AND slug = $2 AND is_active = true`,
      [schoolId, raw.plan_slug],
    );
    if (pRows[0]) {
      planSlug = pRows[0].slug;
      planLabel = pRows[0].display_name;
      planDiscountBp = pRows[0].discount_basis_points;
    }
  }

  // Resolve checked addons by intersecting with the grid's published addons.
  const availableAddons = Array.isArray(g.addons) ? g.addons : [];
  const requestedKeys = new Set<string>();
  if (Array.isArray(raw.addons)) {
    for (const a of raw.addons) {
      if (a && typeof a === 'object' && typeof (a as { key?: unknown }).key === 'string') {
        requestedKeys.add((a as { key: string }).key);
      }
    }
  }
  // Always include required addons even if the client tried to omit them.
  for (const a of availableAddons) {
    if (a.required) requestedKeys.add(a.key);
  }

  // Re-derive paid status from the DB instead of trusting the client.
  // The client renders "Already paid" badges based on the same query
  // result the /api/billing/tuition-grids endpoint returns — but we
  // can't let a tampered client invent a paid status to get a credit.
  const { rows: paidRows } = await query<{ category: string }>(
    `SELECT DISTINCT li.category
       FROM invoices i
       JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE i.school_id = $1 AND i.family_id = $2
        AND i.status = 'paid' AND li.category IS NOT NULL
        AND li.amount_cents > 0
        AND i.paid_at > now() - interval '12 months'`,
    [schoolId, familyId],
  );
  const paidCats = new Set(paidRows.map((r) => r.category));

  const checkedAddons = availableAddons
    .filter((a) => requestedKeys.has(a.key))
    .map((a) => ({
      key: a.key,
      label: a.label,
      amount_cents: a.amount_cents,
      paid: paidCats.has(a.key) || undefined,
    }));

  const discounted = g.annual_tuition_cents
    - Math.round(g.annual_tuition_cents * planDiscountBp / 10000);
  // Paid addons don't count toward what the family owes right now.
  const addonTotal = checkedAddons
    .filter((a) => !a.paid)
    .reduce((s, a) => s + a.amount_cents, 0);
  const totalCents = discounted + addonTotal;

  return {
    tuition_grid_id: g.id,
    display_name: g.display_name,
    annual_tuition_cents: g.annual_tuition_cents,
    plan_slug: planSlug,
    plan_label: planLabel,
    plan_discount_bp: planDiscountBp,
    addons: checkedAddons,
    total_cents: totalCents,
  };
}

async function upsertHealthProfile(
  schoolId: string,
  studentId: string,
  parentId: string,
  fields: Record<string, string>,
): Promise<void> {
  // Build the COALESCE pattern so we don't overwrite existing values
  // with empty strings (parent might have edited some fields, left
  // others blank).
  const cols = Object.keys(fields);
  const vals = cols.map((k) => fields[k] || null);

  // Generate "col = COALESCE(NULLIF($N, ''), col)" pairs
  // and "(col, ...) values ($N, ...)" for the insert.
  const placeholders = cols.map((_, i) => `$${i + 4}`).join(', ');
  const setPairs = cols.map((c, i) => `${c} = COALESCE(NULLIF($${i + 4}, ''), ${c})`).join(', ');

  await query(
    `INSERT INTO student_health_profiles
       (school_id, student_id, reviewed_by_parent_id, reviewed_at, ${cols.join(', ')})
     VALUES ($1, $2, $3, now(), ${placeholders})
     ON CONFLICT (school_id, student_id) DO UPDATE SET
       reviewed_by_parent_id = EXCLUDED.reviewed_by_parent_id,
       reviewed_at = now(),
       ${setPairs}`,
    [schoolId, studentId, parentId, ...vals],
  );
}

interface PushGhlOpts {
  schoolId: string;
  parentId: string;
  familyId: string;
  studentId: string | null;
  writeback: GhlWritebackEntry[];
  responses: Record<string, unknown>;
}

async function pushSubmissionToGhl(submissionId: string, opts: PushGhlOpts): Promise<void> {
  try {
    const { loadGhlClient } = await import('@/lib/ghl/client');
    const { updateContactCustomFields } = await import('@/lib/ghl/writes');

    // Resolve the parent's GHL contact_id (fall back to family primary).
    const { rows: pRows } = await query<{ ghl_contact_id: string | null }>(
      `SELECT ghl_contact_id FROM parents WHERE id = $1`, [opts.parentId],
    );
    let contactId = pRows[0]?.ghl_contact_id ?? null;
    if (!contactId) {
      const { rows: priRows } = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents
         WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL
         LIMIT 1`,
        [opts.familyId],
      );
      contactId = priRows[0]?.ghl_contact_id ?? null;
    }
    if (!contactId) {
      throw new Error('No GHL contact id for parent or family primary');
    }

    // Determine the per-student slot index (1..N).
    //   1. Prefer the student's stored slot (students.metadata.slot).
    //      This is what Wooster's GHL data uses — assigned in operator-
    //      original add order.
    //   2. Fall back to alphabetical row_number (DG-era pattern) so
    //      schools without an explicit slot keep working.
    let slotIndex: number | null = null;
    if (opts.studentId) {
      const { rows: stRows } = await query<{ slot: string | null }>(
        `SELECT metadata->>'slot' AS slot FROM students WHERE id = $1`,
        [opts.studentId],
      );
      const fromMeta = stRows[0]?.slot;
      if (fromMeta) {
        const n = parseInt(fromMeta, 10);
        if (Number.isFinite(n) && n >= 1) slotIndex = n;
      }
      if (slotIndex === null) {
        const { rows: sRows } = await query<{ id: string; rn: number }>(
          `SELECT id, ROW_NUMBER() OVER (ORDER BY first_name, last_name, id) AS rn
           FROM students
           WHERE family_id = (SELECT family_id FROM students WHERE id = $1)
             AND status = 'active'`,
          [opts.studentId],
        );
        const row = sRows.find((r) => r.id === opts.studentId);
        if (row) slotIndex = Number(row.rn);
      }
    }

    // Build the GHL field key for each writeback entry. Two patterns
    // are supported for per_student forms:
    //
    //   (a) `{slot}` placeholder in ghl_field_key, e.g.
    //         `form_enrollment_agreement_s{slot}`
    //       → substitutes the slot number where the placeholder is.
    //       This matches Wooster's naming convention (`*_s1`, `*_s2`).
    //
    //   (b) No placeholder → prefixes the key with `student_N_`, e.g.
    //         `cafe_worker_permission` → `student_2_cafe_worker_permission`
    //       Matches DG's per-student slot pattern.
    const byKey: Record<string, string> = {};
    for (const wb of opts.writeback) {
      const raw = opts.responses[wb.field_key];
      const v = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw);
      let ghlKey: string;
      if (wb.per_student && slotIndex) {
        if (wb.ghl_field_key.includes('{slot}')) {
          ghlKey = wb.ghl_field_key.replace(/\{slot\}/g, String(slotIndex));
        } else {
          ghlKey = `student_${slotIndex}_${wb.ghl_field_key}`;
        }
      } else {
        ghlKey = wb.ghl_field_key;
      }
      byKey[ghlKey] = v;
    }
    if (Object.keys(byKey).length === 0) {
      await query(
        `UPDATE portal_form_submissions SET ghl_synced_at = now(), ghl_sync_error = NULL WHERE id = $1`,
        [submissionId],
      );
      return;
    }

    const client = await loadGhlClient(opts.schoolId);
    const result = await updateContactCustomFields(client, contactId, byKey);

    await query(
      `UPDATE portal_form_submissions
         SET ghl_synced_at = now(),
             ghl_sync_error = $1
       WHERE id = $2`,
      [
        result.skipped.length > 0 ? `skipped keys: ${result.skipped.join(', ')}` : null,
        submissionId,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[portal-forms/submit] GHL writeback failed for', submissionId, ':', msg);
    await query(
      `UPDATE portal_form_submissions SET ghl_sync_error = $1 WHERE id = $2`,
      [msg.slice(0, 500), submissionId],
    ).catch(() => undefined);
  }
}
