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

import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadSchoolSettings } from '@/lib/school-settings';
import type { FormFieldBlock, FormDefinition, FormPaymentConfig } from '@/lib/forms/types';
import { resolvePrefill, applyPrefillMap, todayString, isBlockVisible, hasPrefillConditions, resolveConditionPrefillValues, type PrefillContext } from '@/lib/forms/prefill';
import {
  studentMatchesAppliesTo,
  type FormAppliesTo,
  type AppliesToContext,
} from '@/lib/forms/applies-to';
import { evaluatePayment } from '@/lib/forms/payment-eval';
import { createInvoiceForFormSubmission } from '@/lib/billing/create-form-invoice';
import { diffResponses, capDiff } from '@/lib/forms/response-diff';
import { createEnrollmentInvoices } from '@/lib/billing/create-enrollment-invoices';
import crypto from 'node:crypto';
import {
  isCoSignRequired,
  COSIGNER_NAME_FIELD,
  COSIGNER_EMAIL_FIELD,
} from '@/lib/forms/cosign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Academic year comes from the school's settings (schools.settings.academic_year).
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
  // Migration 060 — master on/off for the notify_emails fan-out without
  // wiping the list. NULL/true = send notifications, false = mute.
  notifications_enabled: boolean | null;
  webhook_urls: string[] | null;
  // Migration 048 — per-student visibility rule.
  applies_to: FormAppliesTo | null;
}

interface GhlWritebackEntry {
  field_key: string;                  // form field key
  ghl_field_key: string;              // target custom field key
  per_student?: boolean;              // if true → "student_<N>_<key>" slot
  // Write the selected option's PRICE (whole dollars, e.g. "2100" / "0")
  // instead of the option value — pairs a pricing choice with its cost field
  // on the contact (organic_lunch choice → organic_lunch fee, etc.).
  write_amount?: boolean;
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
            confirmation_message, confirmation_redirect_url,
            notify_emails, notifications_enabled, webhook_urls,
            applies_to
     FROM portal_form_definitions
     WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [formDefId, session.school_id],
  )).rows;
  const def = defs[0];
  if (!def) return NextResponse.json({ error: 'form_not_found' }, { status: 404 });

  // Academic year stamped on this submission — per-school setting, not a
  // platform constant.
  const CURRENT_YEAR = (await loadSchoolSettings(session.school_id)).academic_year;

  // 2. Resolve student (per_student forms)
  let studentId: string | null = null;
  if (def.per_student) {
    const raw = String(fd.get('student_id') ?? '').trim();
    if (!raw) return NextResponse.json({ error: 'missing_student_id' }, { status: 400 });
    const sRows = (await query<{ id: string; metadata: Record<string, unknown> | null }>(
      `SELECT id, metadata FROM students
        WHERE id = $1 AND family_id = $2 AND status = 'active'`,
      [raw, session.family_id],
    )).rows;
    if (sRows.length === 0) {
      return NextResponse.json({ error: 'student_not_in_family' }, { status: 403 });
    }
    studentId = sRows[0].id;

    // 2a. Server-side applies_to check. The hub + form page already
    //     hide forms whose rule excludes a given student, but a parent
    //     with a direct URL could still POST against this endpoint
    //     directly — so we re-validate here. Fetches the same enrollment
    //     facts the page used (grid name + addon keys) once.
    if (def.applies_to) {
      const { rows: enr } = await query<{
        tuition_grid_name: string | null;
        addons: Array<{ key?: string }> | null;
      }>(
        `SELECT g.display_name AS tuition_grid_name, fte.addons
           FROM family_tuition_enrollments fte
           LEFT JOIN tuition_grids g ON g.id = fte.tuition_grid_id
          WHERE fte.school_id = $1 AND fte.student_id = $2 AND fte.status = 'active'
          ORDER BY fte.updated_at DESC LIMIT 1`,
        [session.school_id, studentId],
      );
      const addons = Array.isArray(enr[0]?.addons) ? enr[0]!.addons : [];
      const { rows: tg } = await query<{ tag: string }>(
        `SELECT DISTINCT t.tag FROM ghl_contact_tags t
           JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
          WHERE t.school_id = $1 AND p.family_id = $2 AND p.is_primary = true`,
        [session.school_id, session.family_id],
      );
      const ctx: AppliesToContext = {
        studentId,
        metadata: (sRows[0].metadata ?? {}) as Record<string, unknown>,
        tuitionGridName: enr[0]?.tuition_grid_name ?? null,
        enrollmentAddonKeys: addons.map((a) => a?.key).filter((k): k is string => typeof k === 'string'),
        tags: tg.map((r) => r.tag).filter(Boolean),
      };
      if (!studentMatchesAppliesTo(ctx, def.applies_to)) {
        return NextResponse.json(
          { error: 'form_not_applicable_to_student',
            detail: 'This form is not configured for this student. Contact the school office if you think this is wrong.' },
          { status: 403 },
        );
      }
    }
  }

  // 2b. Family-level tag gate for non-per-student forms (per-student forms
  //     are validated above). Enforces applies_to.tag_match against a direct
  //     POST for a family-level form.
  if (!def.per_student && def.applies_to?.tag_match?.length) {
    const { rows: tg } = await query<{ tag: string }>(
      `SELECT DISTINCT t.tag FROM ghl_contact_tags t
         JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
        WHERE t.school_id = $1 AND p.family_id = $2 AND p.is_primary = true`,
      [session.school_id, session.family_id],
    );
    const have = new Set(tg.map((r) => r.tag.toLowerCase()));
    if (!def.applies_to.tag_match.some((t) => have.has(t.toLowerCase()))) {
      return NextResponse.json(
        { error: 'form_not_applicable_to_student',
          detail: 'This form is not available to your family. Contact the school office if you think this is wrong.' },
        { status: 403 },
      );
    }
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

  // Snapshot of submitted values — used to evaluate conditional visibility
  // (visible_when) so a field the client correctly hid is skipped here too
  // (never validated, never required, never stored).
  const fdValues: Record<string, unknown> = Object.fromEntries(
    [...fd.keys()].map((k) => [k, fd.get(k)]),
  );

  // Catalog/prefill-sourced visible_when facts, resolved from the family's data
  // so a `source:'prefill'` condition is evaluated the same server-side as in
  // the renderer (a field the client hid stays skipped here too). Only built
  // when the form actually uses catalog conditions.
  let condPrefill: Record<string, string> = {};
  if (hasPrefillConditions(def.field_schema)) {
    const condCtx = await buildPrefillContextForSubmit(session.parent_id, studentId, session.school_id);
    condPrefill = resolveConditionPrefillValues(def.field_schema, condCtx);
  }
  const visValues = { ...fdValues, ...condPrefill };

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
    // Conditional visibility — hidden fields weren't submitted, so don't
    // validate, require, or store them.
    if (!isBlockVisible(('visible_when' in block ? block.visible_when : undefined), visValues)) continue;
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
        // BOTH parts are the signature: typed legal name (stored under the
        // block key, so every view shows it as "the signature") AND the
        // drawn signature (PNG data URL under key_drawn). When required,
        // neither alone passes. Legacy submissions that stored a PNG under
        // the block key itself still render everywhere.
        const v = String(fd.get(key) ?? '').trim();
        const drawn = String(fd.get(`${key}_drawn`) ?? '').trim();
        const signedAt = String(fd.get(`${key}_signed_at`) ?? '').trim();
        if (block.required) {
          if (!v) validationErrors.push(`${block.label}: typed legal name is required`);
          if (!drawn.startsWith('data:image/')) validationErrors.push(`${block.label}: drawn signature is required`);
        }
        responses[key] = v;
        if (drawn.startsWith('data:image/')) responses[`${key}_drawn`] = drawn;
        if (signedAt) responses[`${key}_signed_at`] = signedAt;
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

  // ── Existing-family guardrail ────────────────────────────────────────
  // A returning/imported family already has a tuition plan. For them the
  // agreement is strictly REVIEW-AND-SIGN: we must NOT recalculate or
  // create any billing, because createEnrollmentInvoices upserts the plan
  // and deletes unpaid invoices — that would clobber their reconciled
  // amounts. The calculator + billing run ONLY for a brand-new family
  // (no active plan yet). This is the hard guardrail that keeps every
  // imported family untouched.
  // Demo/test students (metadata.is_demo) are NEVER treated as existing, so a
  // test family always runs the new-family calculator + billing and can
  // re-test plans repeatedly (each submit replaces their draft plan).
  let isExistingFamily = false;
  if (studentId) {
    const { rows: planRows } = await query<{ id: string }>(
      `SELECT fte.id FROM family_tuition_enrollments fte
         JOIN students s ON s.id = fte.student_id
        WHERE fte.school_id = $1 AND fte.student_id = $2 AND fte.status = 'active'
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
        LIMIT 1`,
      [session.school_id, studentId],
    );
    isExistingFamily = planRows.length > 0;
  }
  // Billing live? In dry-run (billing_active not true) a new-family
  // submission creates a DRAFT plan + invoices and does NOT force payment,
  // so admins can test the calculation end-to-end without a charge.
  const { rows: baRows } = await query<{ billing_active: boolean | null }>(
    `SELECT billing_active FROM school_payment_config WHERE school_id = $1`,
    [session.school_id],
  );
  const billingActive = baRows[0]?.billing_active === true;

  // 4a. Server-side override for readOnly fields. Any block flagged
  //     `readOnly: true` MUST have its response value come from the
  //     server-resolved prefill — never trust the client, because a
  //     parent could remove `readOnly` in DevTools and submit a
  //     different tuition amount. We re-resolve the prefill from fresh
  //     DB rows and overwrite `responses[key]` for those blocks.
  const readOnlyKeys = def.field_schema
    .filter((b): b is FormFieldBlock & { key: string; readOnly?: boolean; prefill?: string } =>
      'key' in b && 'readOnly' in b && b.readOnly === true)
    .map((b) => b.key);
  // `lock_if_prefilled` fields are locked ONLY when we have a value, so they
  // need the truth re-applied too — but ONLY when the prefill resolves to
  // something (existing families). When it's empty the field rendered
  // editable (new families) and we must keep the parent's typed selection.
  const hasLockIfPrefilled = def.field_schema.some(
    (b) => 'key' in b
      && (b as { lock_if_prefilled?: boolean }).lock_if_prefilled === true
      && !!(b as { prefill?: string }).prefill,
  );
  // Only re-resolve locked fields for EXISTING families (whose fields the
  // form renders read-only/pre-filled). For a brand-new family the same
  // fields render editable with no prefill, so overriding here would wipe
  // their typed selections — skip it.
  if ((readOnlyKeys.length > 0 && isExistingFamily) || hasLockIfPrefilled) {
    const ctx = await buildPrefillContextForSubmit(session.parent_id, studentId, session.school_id);
    for (const block of def.field_schema) {
      if (!('key' in block) || !('prefill' in block) || !block.prefill) continue;
      const isReadOnly = 'readOnly' in block && block.readOnly === true;
      const isLockIfPrefilled = (block as { lock_if_prefilled?: boolean }).lock_if_prefilled === true;
      // prefill_map must be applied here exactly as the renderer applies it,
      // or the re-resolved "truth" reverts to the source vocabulary (e.g.
      // the raw GHL grade code instead of the mapped program bucket).
      const map = (block as { prefill_map?: Record<string, string> }).prefill_map;
      // readOnly → always re-apply (existing families only).
      // lock_if_prefilled → re-apply ONLY when the truth is non-empty (it was
      //   locked); a blank truth means the parent filled it in — keep theirs.
      if (isReadOnly && isExistingFamily) {
        responses[block.key] = applyPrefillMap(resolvePrefill(block.prefill, ctx), map);
      } else if (isLockIfPrefilled) {
        const truth = applyPrefillMap(resolvePrefill(block.prefill, ctx), map);
        if (truth && String(truth).trim()) responses[block.key] = truth;
      }
    }
  }

  // 4a-bis. Signature / submission dates (prefill: "today") are ALWAYS
  //     stamped to the server's date for EVERY family — new or existing,
  //     no matter what the client posts. A signed date can never be back-
  //     dated or forward-dated. Runs unconditionally (the block above is
  //     gated on existing families and skips new ones).
  {
    const today = todayString();
    for (const block of def.field_schema) {
      if (!('key' in block)) continue;
      if ((block as { prefill?: string }).prefill === 'today') {
        responses[block.key] = today;
      }
    }
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
    // Not relevant to payment evaluation (this object is only used for
    // computing payment lines); submission-lock logic keys off `def` directly.
    allow_multiple_submissions: false,
  };
  // Existing families never bill (review-and-sign), so skip the whole
  // payment path for them even when the form carries a payment_config.
  // `display_only` forms never bill anyone — the payment_config is for the
  // schedule DISPLAY only; the form submits like a normal form.
  const paymentEval = (def.payment_config && !isExistingFamily && def.payment_config.display_only !== true)
    ? evaluatePayment(formDefForEval, responses)
    : null;
  // Force payment only for a NEW family when billing is live. In dry-run we
  // still build their plan, but as drafts and without a forced charge.
  const paymentRequired = !isExistingFamily
    && billingActive
    && def.payment_config?.mode === 'required'
    && paymentEval !== null
    && paymentEval.subtotal_cents > 0;
  // Require a paid selection only for a new family (existing ones are
  // review-only; their amounts are already on file). display_only forms
  // never require payment.
  if (!isExistingFamily && def.payment_config?.mode === 'required'
      && def.payment_config?.display_only !== true
      && (!paymentEval || paymentEval.subtotal_cents <= 0)) {
    return NextResponse.json(
      { error: 'no_paid_selection', detail: 'This form requires a paid selection.' },
      { status: 400 },
    );
  }
  // Build the new family's plan + invoices when they've made a paid
  // selection — regardless of dry-run vs live. createEnrollmentInvoices
  // emits DRAFT invoices in dry-run (no charge); go-live promotes them.
  const createNewFamilyBilling = !isExistingFamily
    && !!def.payment_config
    && paymentEval !== null
    && paymentEval.lines.length > 0
    && paymentEval.subtotal_cents > 0;

  // 5. Periodic-review diff. For forms like Emergency Contact that the
  // parent re-submits every 6 months, compute exactly which fields
  // changed against the most recent prior submission and stash the diff
  // alongside the responses. The office notification email uses this to
  // surface "Updated fields: p1_cell, ec2_phone" without staff having to
  // manually compare submissions.
  //
  // Skipped when this is an addendum (addendums are their own animal —
  // they already track which fields are part of the addendum via
  // addendum_fields).
  const reviewMode = String((responses as Record<string, unknown>).review_mode ?? '').trim();
  if (!isAddendum && reviewMode && reviewMode !== 'first_submission') {
    const { rows: priorRows } = await query<{ id: string; responses: Record<string, unknown> }>(
      `SELECT id, responses
         FROM portal_form_submissions
        WHERE school_id = $1
          AND form_definition_id = $2
          AND family_id = $3
          AND ${studentId ? 'student_id = $4' : 'student_id IS NULL'}
          AND status IN ('submitted', 'paid')
          AND voided_at IS NULL
          AND (is_addendum IS NULL OR is_addendum = false)
        ORDER BY submitted_at DESC
        LIMIT 1`,
      studentId
        ? [session.school_id, def.id, session.family_id, studentId]
        : [session.school_id, def.id, session.family_id],
    );
    const prior = priorRows[0];
    if (prior) {
      const diff = diffResponses(prior.responses, responses);
      // Mark this as a periodic re-review and persist the prior link +
      // diff inside the responses jsonb. Underscore prefix keeps them out
      // of the office-notification body table iteration which filters
      // `__`-prefixed keys.
      (responses as Record<string, unknown>)._is_periodic_review = true;
      (responses as Record<string, unknown>)._prior_submission_id = prior.id;
      if (diff && Object.keys(diff).length > 0) {
        (responses as Record<string, unknown>)._review_diff = capDiff(diff);
      } else {
        // 'no_changes' or schema drift — record an empty diff so the email
        // template can confidently say "Periodic confirmation — no changes."
        (responses as Record<string, unknown>)._review_diff = {};
      }
    }
  }

  // 5b. Amendment diff. When a parent AMENDS a previously-signed form
  // (addendum mode), compute the before→after for exactly the fields they
  // chose to amend, against the parent submission. We stash it under
  // `_`-prefixed markers (same convention as the periodic-review diff) so:
  //   • the office-notification email renders a "Previous → New" table and
  //     an "AMENDED" subject, and
  //   • the dashboard submissions inbox can show the same diff inline
  //     without re-joining the parent row.
  // The parent's fresh signature on this addendum row is the attestation
  // (their initials) that they made these specific changes.
  if (isAddendum && validParentSubmissionId) {
    const { rows: parentRows } = await query<{ responses: Record<string, unknown> }>(
      `SELECT responses FROM portal_form_submissions WHERE id = $1`,
      [validParentSubmissionId],
    );
    const parentResp = parentRows[0]?.responses ?? {};
    // Restrict the comparison to the amended fields only. Signatures (which
    // always re-render and therefore always "change") and untouched fields
    // are intentionally excluded so the diff shows just what the parent changed.
    const oldSubset: Record<string, unknown> = {};
    const newSubset: Record<string, unknown> = {};
    for (const k of addendumFields) {
      oldSubset[k] = (parentResp as Record<string, unknown>)[k];
      newSubset[k] = (responses as Record<string, unknown>)[k];
    }
    const diff = diffResponses(oldSubset, newSubset);
    (responses as Record<string, unknown>)._is_amendment = true;
    (responses as Record<string, unknown>)._amended_from_submission_id = validParentSubmissionId;
    if (diff && Object.keys(diff).length > 0) {
      (responses as Record<string, unknown>)._amendment_diff = capDiff(diff);
    }
  }

  // 6. Insert submission row.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;
  // pending_payment when either the legacy fee_amount applies OR the
  // new payment_config requires upfront payment.
  const status = (def.fee_amount && Number(def.fee_amount) > 0) || paymentRequired
    ? 'pending_payment'
    : 'submitted';

  // ── Co-sign (DocuSign-style counter-signature). When the agreement's
  //    LDMA answer says the guardians share JOINT legal authority, Parent 1's
  //    submission is saved but NOT fully executed: we mint a token, mark the
  //    row 'awaiting', and email Parent 2 a link to add their signature. The
  //    school-office notification + completion effects are deferred until the
  //    co-signer signs. Addenda don't re-trigger routing.
  const coSignRequired = !isAddendum && isCoSignRequired(responses);
  // The co-signer is the family's second guardian (Parent 2). The form no
  // longer collects it manually — when joint LDMA needs a counter-signature it
  // goes to the Parent 2 already on the contact, by default. We still honor a
  // form-provided value first (legacy forms that kept the cosigner fields).
  let cosignEmail = String(responses[COSIGNER_EMAIL_FIELD] ?? '').trim().toLowerCase();
  let cosignName = String(responses[COSIGNER_NAME_FIELD] ?? '').trim();
  if (coSignRequired && !cosignEmail) {
    const { rows: p2 } = await query<{ email: string | null; first_name: string | null; last_name: string | null }>(
      `SELECT email, first_name, last_name FROM parents
        WHERE family_id = $1 AND is_primary = false AND status = 'active'
          AND NULLIF(btrim(email), '') IS NOT NULL
        ORDER BY created_at ASC LIMIT 1`,
      [session.family_id],
    );
    if (p2[0]?.email) {
      cosignEmail = p2[0].email.trim().toLowerCase();
      cosignName = [p2[0].first_name, p2[0].last_name].filter(Boolean).join(' ').trim();
    }
  }
  const cosignToken = (coSignRequired && cosignEmail)
    ? crypto.randomBytes(24).toString('base64url')
    : null;
  const cosignStatus = cosignToken ? 'awaiting' : null;
  const deferForCosign = cosignStatus === 'awaiting';

  const { rows: insRows } = await query<{ id: string }>(
    `INSERT INTO portal_form_submissions
       (school_id, form_definition_id, family_id, parent_id, student_id,
        academic_year, responses, status, fee_amount_charged, ip_address, user_agent,
        is_addendum, parent_submission_id, addendum_fields,
        cosign_status, cosign_email, cosign_name, cosign_token, cosign_sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, ${cosignStatus ? 'now()' : 'NULL'})
     RETURNING id`,
    [
      session.school_id, def.id, session.family_id, session.parent_id, studentId,
      CURRENT_YEAR, JSON.stringify(responses), status,
      def.fee_amount ? Number(def.fee_amount) : null,
      ip, userAgent,
      isAddendum, validParentSubmissionId,
      isAddendum && addendumFields.length > 0 ? addendumFields : null,
      cosignStatus, cosignStatus ? cosignEmail : null, cosignStatus ? cosignName : null, cosignToken,
    ],
  );
  const submissionId = insRows[0].id;

  // Send the co-sign request email to Parent 2. AWAITED (not fire-and-forget)
  // so the serverless function can't be frozen before the email actually
  // goes out — this is THE critical email of the flow. The link points at the
  // same host the parent used (custom domain or vercel) so Parent 2 lands on
  // the same branded portal. A failure is logged but never blocks the submit
  // (the office can resend from the awaiting state).
  if (deferForCosign) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
    const { portalBaseForSchool } = await import('@/lib/portal-base');
    const cosignBase = await portalBaseForSchool(session.school_id, `${proto}://${host}`);
    const cosignUrl = `${cosignBase}/cosign/${cosignToken}`;
    try {
      const m = await import('@/lib/forms/cosign-email');
      await m.sendCoSignRequestEmail({
        schoolId: session.school_id,
        to: cosignEmail,
        cosignerName: cosignName,
        submitterParentId: session.parent_id,
        studentId,
        formDisplayName: def.display_name,
        cosignUrl,
      });
    } catch (e) {
      console.error('[portal-forms/submit] cosign request email failed:', e);
    }

    // Interim office notice: the first signature is in and a counter-signature
    // was requested, so the office knows it's "awaiting" (the full "fully
    // signed" notification fires from the co-sign route once Parent 2 signs).
    if (def.notifications_enabled !== false && def.notify_emails && def.notify_emails.length > 0) {
      try {
        const pe = await import('@/lib/forms/post-submit-effects');
        await pe.sendCoSignAwaitingNotice({
          schoolId: session.school_id,
          notifyEmails: def.notify_emails,
          formDisplayName: def.display_name,
          familyId: session.family_id,
          submitterParentId: session.parent_id,
          studentId,
          cosignerName: cosignName,
          cosignerEmail: cosignEmail,
        });
      } catch (e) {
        console.error('[portal-forms/submit] cosign awaiting office notice failed:', e);
      }
    }
  }

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
  //    Sources merged: (a) the form's explicit ghl_writeback config, plus
  //    (b) any field CONNECTED to a Growth Suite field in the v2 builder
  //    (block.ghl_field_key) — so a builder-connected field saves its answer
  //    back onto the contact automatically, no separate config.
  const schemaWriteback = (Array.isArray(def.field_schema) ? def.field_schema : [])
    .map((b) => b as { key?: unknown; ghl_field_key?: unknown })
    .filter((b) => typeof b.ghl_field_key === 'string' && b.ghl_field_key
      && typeof b.key === 'string' && b.key)
    .map((b) => ({ field_key: String(b.key), ghl_field_key: String(b.ghl_field_key) }));
  const explicit = def.ghl_writeback ?? [];
  const seenWb = new Set(explicit.map((w) => w.field_key));
  const allWriteback = [...explicit, ...schemaWriteback.filter((w) => !seenWb.has(w.field_key))];
  if (allWriteback.length > 0) {
    // after(): scheduled post-response work the runtime is REQUIRED to finish.
    // A bare fire-and-forget promise gets frozen when the serverless function
    // returns — which silently dropped every GHL writeback (ghl_synced_at
    // stayed NULL with no error). The parent still gets a fast redirect; the
    // contact update completes right after.
    after(() =>
      pushSubmissionToGhl(submissionId, {
        schoolId: session.school_id,
        parentId: session.parent_id,
        familyId: session.family_id,
        studentId,
        writeback: allWriteback,
        fieldSchema: def.field_schema,
        responses,
      }).catch((err) => {
        console.error('[portal-forms/submit] GHL writeback crashed for', submissionId, ':', err);
      }),
    );
  }

  // 9b. Official-PDF forms: write the answers onto the school's uploaded
  //     PDF template (state emergency cards etc.), stamp the typed
  //     signature, store the completed card on the student's record, and
  //     email office + parent. Cheap probe first — regular forms skip.
  after(async () => {
    try {
      const { formHasPdfTemplate, generateCompletedPdf } = await import('@/lib/forms/fill-pdf-template');
      if (!(await formHasPdfTemplate(def.id))) return;
      await generateCompletedPdf({
        schoolId: session.school_id,
        formDefinitionId: def.id,
        submissionId,
        studentId,
        parentId: session.parent_id,
        familyId: session.family_id,
        responses,
        fieldSchema: (def.field_schema ?? []) as unknown as Array<Record<string, unknown>>,
        formDisplayName: def.display_name,
        notifyEmails: def.notifications_enabled !== false ? (def.notify_emails ?? []) : [],
      });
    } catch (err) {
      console.error('[portal-forms/submit] PDF fill crashed for', submissionId, ':', err);
    }
  });

  // 10. Payment-required forms: create the invoice now and return its
  //      id so the client can redirect to /billing/pay/{id}. The
  //      submission already sits in pending_payment; the Stripe webhook
  //      flips it to 'paid' (and the form's "submitted" status) when
  //      the parent finishes paying.
  let redirectInvoiceId: string | null = null;
  if (createNewFamilyBilling && paymentEval) {
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

      // Don't bill the enrollment fee again if this student already paid it
      // (FACTS ledger import, or a paid Growth Suite enrollment-fee invoice).
      // Drop the enrollment_fee line + reduce the subtotal so no fee invoice
      // is generated — matches the "Paid" status shown on the schedule.
      let billingLines = paymentEval.lines;
      let billingSubtotal = paymentEval.subtotal_cents;
      if (studentId) {
        const { rows: paidRows } = await query<{ paid: boolean }>(
          `SELECT (
             EXISTS (SELECT 1 FROM facts_account_ledger
                      WHERE school_id = $1 AND student_id = $2
                        AND account = 'Enrollment Fee' AND payments_cents > 0)
             OR EXISTS (SELECT 1 FROM invoices
                      WHERE school_id = $1 AND student_id = $2 AND source = 'enrollment_fee'
                        AND (status = 'paid' OR amount_paid_cents > 0))
           ) AS paid`,
          [session.school_id, studentId],
        );
        if (paidRows[0]?.paid) {
          const feeCents = paymentEval.lines
            .filter((l) => l.category === 'enrollment_fee')
            .reduce((s, l) => s + l.amount_cents, 0);
          billingLines = paymentEval.lines.filter((l) => l.category !== 'enrollment_fee');
          billingSubtotal = paymentEval.subtotal_cents - feeCents;
        }
      }

      if (isEnrollmentFlow) {
        const startDateRaw = String(responses.enrollment_start_date ?? '').trim();
        const created = await createEnrollmentInvoices({
          schoolId: session.school_id,
          familyId: session.family_id,
          studentId,
          submissionId,
          formDefinition: formDefForEval,
          lines: billingLines,
          subtotalCents: billingSubtotal,
          paymentPlan: rawPlan as 'monthly' | 'semi_annual' | 'annual',
          enrollmentStartDate: startDateRaw || null,
          studentDisplayName,
          createdByEmail: 'form-submission@growthsuite.local',
          redemptionCode: redemptionCode || undefined,
        });
        // Only push the parent to a payment screen when billing is LIVE.
        // In dry-run the plan + invoices are drafts — the admin reviews
        // them on the Tuition Plans page; no charge, no redirect.
        redirectInvoiceId = billingActive
          ? (created.enrollment_fee_invoice_id ?? created.installment_invoice_ids[0] ?? null)
          : null;
      } else {
        const created = await createInvoiceForFormSubmission({
          schoolId: session.school_id,
          familyId: session.family_id,
          studentId,
          submissionId,
          formDefinition: formDefForEval,
          lines: billingLines,
          subtotalCents: billingSubtotal,
          studentDisplayName,
          createdByEmail: 'form-submission@growthsuite.local',
          redemptionCode: redemptionCode || undefined,
        });
        redirectInvoiceId = billingActive ? created.invoice_id : null;
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
  //
  // DEFERRED for co-sign: when a second guardian still has to sign, the
  // agreement isn't fully executed yet — so we hold the office notification
  // and completion-tag effects until the co-signer signs (fired from the
  // co-sign API instead). Otherwise the office would be pinged "complete"
  // before it actually is.
  if (!deferForCosign) {
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
        // Mute when notifications_enabled is explicitly false — preserves
        // the notify_emails list for later re-enable without re-typing.
        notifyEmails: def.notifications_enabled === false ? null : (def.notify_emails ?? null),
        webhookUrls: def.webhook_urls ?? null,
      })
    ).catch((e) => console.error('[portal-forms/submit] post-submit effects scheduling failed:', e));

    // 14. If this submission brings the family to 100% completion, write
    //     the school's configured "forms completed" tag to every active
    //     parent's GHL contact. Wooster uses this to power their
    //     "forms completed - 26/27" segmentation. Opt-in per school via
    //     school_branding.completion_tag — empty → no-op. Fire-and-forget,
    //     idempotent on the GHL side, never blocks the parent's redirect.
    import('@/lib/forms/completion-tag').then((m) =>
      m.maybeApplyCompletionTag({
        schoolId: session.school_id,
        familyId: session.family_id,
      })
    ).catch((e) => console.error('[portal-forms/submit] completion-tag effect failed:', e));
  }

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
    confirmation_message: string | null;
    grade: string | null;
    student_id: string | null;
  }>(
    `SELECT s.family_id, sch.name AS school_name, d.display_name AS form_name,
            d.confirmation_message,
            st.metadata->>'grade_level' AS grade,
            st.metadata->>'student_id' AS student_id,
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

  // "Next steps" = the school's authored confirmation_message when present
  // (for DGM this is the FACTS payment-setup instructions). Falls back to the
  // generic in-app billing language for schools that bill through Growth Suite.
  const facts = m.confirmation_message?.trim() || '';
  const fallbackBilling = 'Your enrollment fee invoice is in your parent portal. Once paid, the rest of your tuition installments will be billed automatically per your chosen payment plan.';
  // Grade + Student ID — the FACTS instructions reference "your child's grade
  // and student ID, listed below", so surface them right in the email.
  const idRowsHtml = [
    m.student_name ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Student</td><td style="padding:2px 0;font-weight:600;">${escape(m.student_name)}</td></tr>` : '',
    m.grade ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Grade</td><td style="padding:2px 0;font-weight:600;">${escape(m.grade)}</td></tr>` : '',
    m.student_id ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Student ID</td><td style="padding:2px 0;font-weight:600;font-family:monospace;">${escape(m.student_id)}</td></tr>` : '',
  ].join('');
  const idRowsText = [
    m.student_name ? `Student: ${m.student_name}` : '',
    m.grade ? `Grade: ${m.grade}` : '',
    m.student_id ? `Student ID: ${m.student_id}` : '',
  ].filter(Boolean).join('\n');

  const nextStepsHtml = facts
    ? `<div style="margin:16px 0;padding:14px 16px;border-radius:8px;background:#ecfdf5;border:1px solid #a7f3d0;">
         <div style="font-weight:600;font-size:13px;color:#065f46;margin-bottom:6px;">Next step — set up tuition payments</div>
         <div style="font-size:13px;color:#065f46;white-space:pre-wrap;">${linkify(escape(facts))}</div>
         ${idRowsHtml ? `<table style="font-size:13px;margin-top:10px;border-collapse:collapse;">${idRowsHtml}</table>` : ''}
       </div>`
    : `<p style="margin:16px 0;font-size:13px;color:#6b7280;">${fallbackBilling}</p>`;
  const nextStepsText = facts
    ? `Next step — set up tuition payments\n\n${facts}${idRowsText ? `\n\n${idRowsText}` : ''}`
    : fallbackBilling;

  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px;">${escape(m.form_name)} received</h2>
  <p style="margin: 0 0 16px; font-size: 14px;">
    Thanks${m.student_name ? ` for enrolling ${escape(m.student_name)}` : ''} at ${escape(m.school_name)}!
    Your itemized enrollment receipt is attached as a PDF.
  </p>
  ${nextStepsHtml}
</body></html>`.trim();
  const text = `${m.form_name} received

Thanks${m.student_name ? ` for enrolling ${m.student_name}` : ''} at ${m.school_name}.
Your itemized enrollment receipt is attached as a PDF.

${nextStepsText}`;

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

// Wrap bare http(s) URLs (in ALREADY-escaped text) in clickable anchors, so the
// FACTS links in the school's confirmation_message are tappable in the email.
function linkify(escapedHtml: string): string {
  return escapedHtml.replace(/(https?:\/\/[^\s<]+)/g, (u) =>
    `<a href="${u}" style="color:#047857;">${u}</a>`);
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
  // The form's field_schema — used by write_amount entries to look up the
  // selected pricing option's amount_cents.
  fieldSchema?: FormFieldBlock[];
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
    //   1. Prefer the student's stored slot — `slot` (Wooster) or `ghl_slot`
    //      (DGM + snapshot-sync schools). This is the GHL slot the student's
    //      fields actually live under (student_<slot>_*), so writeback lands
    //      on the right child.
    //   2. Fall back to alphabetical row_number (DG-era pattern) so schools
    //      without an explicit slot keep working.
    let slotIndex: number | null = null;
    if (opts.studentId) {
      const { rows: stRows } = await query<{ slot: string | null }>(
        `SELECT COALESCE(metadata->>'slot', metadata->>'ghl_slot') AS slot FROM students WHERE id = $1`,
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
      let v = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw);
      // write_amount: push the selected pricing option's PRICE (whole dollars)
      // instead of the option label — e.g. choosing "Organic Lunch $2,100 —
      // Vegetarian" writes "2100" to the paired cost field ("0" for declines,
      // so the contact's fee updates when a parent opts out).
      if (wb.write_amount) {
        if (v.trim() === '') continue; // no selection → leave the fee alone
        const block = (opts.fieldSchema ?? []).find(
          (b) => 'key' in b && b.key === wb.field_key && 'options' in b && Array.isArray(b.options),
        ) as { options?: Array<{ value: string; amount_cents?: number }> } | undefined;
        const opt = block?.options?.find((o) => o.value === v);
        if (!opt) continue; // unknown selection → don't guess a price
        v = String(Math.round((opt.amount_cents ?? 0) / 100));
      }
      // Skip blanks — GHL's update overwrites, so writing an empty value would
      // CLEAR whatever the contact already has. We only push values the parent
      // actually provided, so an untouched optional field (or a partial
      // amendment that changes just one thing) never wipes existing data.
      if (v.trim() === '') continue;
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

// Build the same PrefillContext the form page constructs, but
// server-side from the current session. Used by the submit handler to
// re-derive the "truth" value for any readOnly field, so a tampered
// client can't write a different tuition amount / payment plan / etc.
async function buildPrefillContextForSubmit(
  parentId: string,
  studentId: string | null,
  schoolId: string,
): Promise<PrefillContext> {
  // Parent
  const { rows: pRows } = await query<{
    first_name: string; last_name: string; email: string | null; phone: string | null;
  }>(
    `SELECT first_name, last_name, email, phone FROM parents WHERE id = $1 LIMIT 1`,
    [parentId],
  );
  const p = pRows[0] ?? { first_name: '', last_name: '', email: null, phone: null };

  const ctx: PrefillContext = {
    parent: {
      first_name: p.first_name ?? '',
      last_name: p.last_name ?? '',
      email: p.email,
      phone: p.phone,
    },
  };

  if (!studentId) return ctx;

  // Student
  const { rows: sRows } = await query<{
    first_name: string; last_name: string;
    preferred_name: string | null; date_of_birth: string | Date | null;
    date_of_admission: string | Date | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT first_name, last_name,
            metadata->>'preferred_name' AS preferred_name,
            (metadata->>'birth_date')::date AS date_of_birth,
            (metadata->>'date_of_admission')::date AS date_of_admission,
            metadata
       FROM students WHERE id = $1 LIMIT 1`,
    [studentId],
  );
  const s = sRows[0];
  if (s) {
    ctx.student = {
      first_name: s.first_name ?? '',
      last_name: s.last_name ?? '',
      preferred_name: s.preferred_name,
      date_of_birth: s.date_of_birth instanceof Date ? s.date_of_birth.toISOString().slice(0, 10) : s.date_of_birth,
      date_of_admission: s.date_of_admission instanceof Date ? s.date_of_admission.toISOString().slice(0, 10) : s.date_of_admission,
      // Powers `meta:<key>` prefill sources when re-resolving readOnly fields.
      metadata: s.metadata ?? null,
    };
  }

  // Health profile
  const { rows: hRows } = await query<{
    emergency_contact_name: string | null; emergency_contact_phone: string | null;
    emergency_contact_relationship: string | null; primary_doctor_name: string | null;
    primary_doctor_phone: string | null; preferred_hospital: string | null;
    health_insurance_provider: string | null; health_insurance_policy_number: string | null;
    allergies: string | null; current_medications: string | null; medical_conditions: string | null;
  }>(
    `SELECT emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
            primary_doctor_name, primary_doctor_phone, preferred_hospital,
            health_insurance_provider, health_insurance_policy_number,
            allergies, current_medications, medical_conditions
       FROM student_health_profiles WHERE student_id = $1 AND school_id = $2 LIMIT 1`,
    [studentId, schoolId],
  );
  if (hRows[0]) ctx.health = hRows[0];

  // Enrollment + plan dates. Mirrors the math in page.tsx so server-side
  // resolution matches what the parent saw in the renderer (including
  // the anchor-month fix for July-start schools).
  const { rows: eRows } = await query<{
    program_label: string | null; plan_label: string | null;
    annual_tuition_cents: number; total_annual_cents: number; installment_count: number;
    first_due_month_day: string | null;
    schedule: { kind?: string; months?: string[] } | null;
    academic_year: string;
    addons: Array<{ key?: string; amount_cents?: number }> | null;
    schedule_days: string | null;
    arrival_time: string | null;
    departure_time: string | null;
  }>(
    `SELECT g.display_name AS program_label,
            pp.display_name AS plan_label,
            fte.annual_tuition_cents, fte.total_annual_cents, fte.installment_count,
            pp.first_due_month_day, fte.schedule, fte.academic_year,
            fte.addons,
            s.metadata->>'schedule_days'  AS schedule_days,
            s.metadata->>'arrival_time'   AS arrival_time,
            s.metadata->>'departure_time' AS departure_time
       FROM family_tuition_enrollments fte
       JOIN tuition_grids g ON g.id = fte.tuition_grid_id
       JOIN payment_plans pp ON pp.id = fte.payment_plan_id
       JOIN students s ON s.id = fte.student_id
      WHERE fte.school_id = $1 AND fte.student_id = $2 AND fte.status = 'active'
      ORDER BY fte.updated_at DESC LIMIT 1`,
    [schoolId, studentId],
  );
  if (eRows[0]) {
    const e = eRows[0];
    const [startYearStr] = e.academic_year.split('-');
    const startYear = parseInt(startYearStr, 10);
    const anchorMonth = e.first_due_month_day ? parseInt(e.first_due_month_day.split('-')[0], 10) : NaN;
    const startMonth = Number.isFinite(anchorMonth) ? anchorMonth : 8;
    const day = e.first_due_month_day ? parseInt(e.first_due_month_day.split('-')[1] ?? '15', 10) : 15;
    const months = (e.schedule?.months && e.schedule.months.length > 0)
      ? e.schedule.months
      : (e.first_due_month_day ? [e.first_due_month_day.split('-')[0]] : ['07']);
    const yearOf = (m: number) => m >= startMonth ? startYear : startYear + 1;
    const dates = months.map((mm) => {
      const m = parseInt(mm, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) return null;
      const last = new Date(Date.UTC(yearOf(m), m, 0)).getUTCDate();
      return new Date(Date.UTC(yearOf(m), m - 1, Math.min(day, last)));
    }).filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime());
    const ad = Array.isArray(e.addons) ? e.addons : [];
    const cents = (key: string) => {
      const hit = ad.find((a) => a?.key === key);
      return hit && typeof hit.amount_cents === 'number' ? Math.abs(hit.amount_cents) : null;
    };
    ctx.enrollment = {
      program_label: e.program_label,
      plan_label: e.plan_label,
      annual_tuition_cents: e.annual_tuition_cents,
      total_annual_cents: e.total_annual_cents,
      installment_count: e.installment_count,
      first_due_date: dates[0]?.toISOString().slice(0, 10) ?? null,
      last_due_date: dates[dates.length - 1]?.toISOString().slice(0, 10) ?? null,
      extended_care_cents: cents('extended_care'),
      development_fee_cents: cents('development_fee'),
      deposit_cents: cents('deposit'),
      sibling_discount_cents: cents('sibling_discount'),
      prompt_pay_discount_cents: cents('prompt_pay_discount'),
      semi_annual_discount_cents: cents('semi_annual_discount'),
      scholarship_cents: cents('scholarship'),
      schedule_days: e.schedule_days,
      arrival_time: e.arrival_time,
      departure_time: e.departure_time,
    };
  }

  return ctx;
}
