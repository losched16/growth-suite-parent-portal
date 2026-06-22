// /forms-v2/[slug] — render a single form for the logged-in parent.
//
// Loads the form definition for the parent's school, the family's
// students (for per-student forms), each student's health profile row,
// any existing submissions (native + legacy_imported), and any pending
// migration flags raised by the legacy importer.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { loadStudentsForFamily } from '@/lib/family-data';
import { query } from '@/lib/db';
import type { FormDefinition, FormFieldBlock } from '@/lib/forms/types';
import type { PrefillContext } from '@/lib/forms/prefill';
import type { FormPaymentConfig } from '@/lib/forms/types';
import {
  studentMatchesAppliesTo,
  type FormAppliesTo,
  type AppliesToContext,
} from '@/lib/forms/applies-to';
import { FormRenderer, type ExistingSubmission, type MigrationFlag } from './FormRenderer';

export const dynamic = 'force-dynamic';

interface FormDefRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  required_for: string | null;
  field_schema: FormFieldBlock[];
  fee_amount: string | null;
  one_submission_per_year: boolean;
  resubmission_allowed: boolean;
  needs_review: boolean;
  is_active: boolean;
  audience: string | null;
  payment_config: FormPaymentConfig | null;
  allow_addendum: boolean;
  applies_to: FormAppliesTo | null;
}

interface HealthRow {
  student_id: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  primary_doctor_name: string | null;
  primary_doctor_phone: string | null;
  preferred_hospital: string | null;
  health_insurance_provider: string | null;
  health_insurance_policy_number: string | null;
  allergies: string | null;
  current_medications: string | null;
  medical_conditions: string | null;
}

interface SubmissionRow {
  id: string;
  student_id: string | null;
  status: string;
  submitted_at: string;
  legacy_source: string | null;
}

interface FlagRow {
  id: string;
  student_id: string | null;
  flag_kind: string;
  flag_message: string;
  payload: Record<string, unknown>;
  status: string;
}

const CURRENT_YEAR_FALLBACK = '2025-26';

type PageParams = Promise<{ slug: string }>;
type PageSearchParams = Promise<{ invite?: string }>;

export default async function FormPage({
  params, searchParams,
}: { params: PageParams; searchParams: PageSearchParams }) {
  const { slug } = await params;
  const sp = await searchParams;
  const id = await requireParent();

  // 1) Load the form definition for this school+slug.
  const defRows = (await query<FormDefRow>(
    `SELECT id, slug, display_name, description, category, per_student,
            required_for, field_schema, fee_amount, one_submission_per_year,
            resubmission_allowed, needs_review, is_active, audience, payment_config,
            allow_addendum, applies_to
     FROM portal_form_definitions
     WHERE school_id = $1 AND slug = $2`,
    [id.parent.school_id, slug],
  )).rows;
  const def = defRows[0];
  // Staff-facing forms (supply/labor/incident requests) are never accessible
  // to parents — block direct-URL access too, not just the list.
  if (!def || !def.is_active || def.audience === 'staff') notFound();

  // 2) Load students + their health profiles (for per-student forms).
  // For per-student forms with an applies_to rule, restrict the picker
  // to students who actually match (e.g. K-only forms hide siblings in
  // Primary). Fetched here once and used in both the FormRenderer and
  // the "no applicable students" guard below.
  const allStudents = await loadStudentsForFamily(id.parent.family_id);
  let students = allStudents;
  if (def.per_student && def.applies_to) {
    const sIds = allStudents.map((s) => s.id);
    const enrolMap = new Map<string, { tuitionGridName: string | null; addonKeys: string[] }>();
    if (sIds.length > 0) {
      const { rows: er } = await query<{
        student_id: string; tuition_grid_name: string | null;
        addons: Array<{ key?: string }> | null;
      }>(
        `SELECT fte.student_id, g.display_name AS tuition_grid_name, fte.addons
           FROM family_tuition_enrollments fte
           LEFT JOIN tuition_grids g ON g.id = fte.tuition_grid_id
          WHERE fte.school_id = $1 AND fte.student_id = ANY($2::uuid[])
            AND fte.status = 'active'`,
        [id.parent.school_id, sIds],
      );
      for (const r of er) {
        const ad = Array.isArray(r.addons) ? r.addons : [];
        enrolMap.set(r.student_id, {
          tuitionGridName: r.tuition_grid_name,
          addonKeys: ad.map((a) => a?.key).filter((k): k is string => typeof k === 'string'),
        });
      }
    }
    students = allStudents.filter((s) => {
      const en = enrolMap.get(s.id);
      const ctx: AppliesToContext = {
        studentId: s.id,
        metadata: (s.metadata ?? {}) as Record<string, unknown>,
        tuitionGridName: en?.tuitionGridName ?? null,
        enrollmentAddonKeys: en?.addonKeys ?? [],
      };
      return studentMatchesAppliesTo(ctx, def.applies_to);
    });
  }

  const healthByStudentId: Record<string, PrefillContext['health']> = {};
  if (def.per_student && students.length > 0) {
    const sIds = students.map((s) => s.id);
    const hRows = (await query<HealthRow>(
      `SELECT student_id, emergency_contact_name, emergency_contact_phone,
              emergency_contact_relationship, primary_doctor_name,
              primary_doctor_phone, preferred_hospital,
              health_insurance_provider, health_insurance_policy_number,
              allergies, current_medications, medical_conditions
       FROM student_health_profiles
       WHERE school_id = $1 AND student_id = ANY($2::uuid[])`,
      [id.parent.school_id, sIds],
    )).rows;
    for (const h of hRows) {
      healthByStudentId[h.student_id] = {
        emergency_contact_name: h.emergency_contact_name,
        emergency_contact_phone: h.emergency_contact_phone,
        emergency_contact_relationship: h.emergency_contact_relationship,
        primary_doctor_name: h.primary_doctor_name,
        primary_doctor_phone: h.primary_doctor_phone,
        preferred_hospital: h.preferred_hospital,
        health_insurance_provider: h.health_insurance_provider,
        health_insurance_policy_number: h.health_insurance_policy_number,
        allergies: h.allergies,
        current_medications: h.current_medications,
        medical_conditions: h.medical_conditions,
      };
    }
  }

  // 2b) Load each student's active tuition enrollment so the Tuition
  // Agreement form (and any future form using enrollment.* prefills)
  // can pre-fill the contracted amount, plan name, installment count,
  // and schedule dates without the parent doing math. Per-student
  // because each kid can be on a different program/plan.
  const enrollmentByStudentId: Record<string, PrefillContext['enrollment']> = {};
  if (def.per_student && students.length > 0) {
    const sIds = students.map((s) => s.id);
    const eRows = (await query<{
      student_id: string;
      program_label: string | null;
      plan_label: string | null;
      annual_tuition_cents: number;
      total_annual_cents: number;
      installment_count: number;
      first_due_month_day: string | null;
      schedule: { kind?: string; months?: string[] } | null;
      academic_year: string;
      addons: Array<{ key?: string; amount_cents?: number }> | null;
      schedule_days: string | null;
      arrival_time: string | null;
      departure_time: string | null;
    }>(
      `SELECT fte.student_id,
              g.display_name AS program_label,
              pp.display_name AS plan_label,
              fte.annual_tuition_cents,
              fte.total_annual_cents,
              fte.installment_count,
              pp.first_due_month_day,
              fte.schedule,
              fte.academic_year,
              fte.addons,
              s.metadata->>'schedule_days'   AS schedule_days,
              s.metadata->>'arrival_time'    AS arrival_time,
              s.metadata->>'departure_time'  AS departure_time
         FROM family_tuition_enrollments fte
         JOIN tuition_grids g    ON g.id  = fte.tuition_grid_id
         JOIN payment_plans pp   ON pp.id = fte.payment_plan_id
         JOIN students s         ON s.id  = fte.student_id
        WHERE fte.school_id = $1
          AND fte.student_id = ANY($2::uuid[])
          AND fte.status = 'active'`,
      [id.parent.school_id, sIds],
    )).rows;

    // Derive first/last due dates from the plan's schedule template +
    // academic year. Matches the same logic the tuition-plan-generator
    // uses when materializing invoices, so prefills line up with what
    // the parent actually sees on /billing/plan.
    const derivedueDates = (yr: string, monthDay: string | null, monthsTpl: string[] | undefined) => {
      const [startYearStr] = yr.split('-');
      const startYear = parseInt(startYearStr, 10);
      if (!Number.isFinite(startYear)) return { first: null, last: null };
      // Honor the plan's anchor month as the academic-year boundary
      // (matches tuition-plan-generator.computeDueDates). Without this
      // a July-starting school like MCH would push the first month
      // forward a year.
      const anchorMonth = monthDay ? parseInt(monthDay.split('-')[0], 10) : NaN;
      const startMonth = Number.isFinite(anchorMonth) ? anchorMonth : 8;
      const yearOf = (m: number) => m >= startMonth ? startYear : startYear + 1;
      const day = monthDay ? parseInt(monthDay.split('-')[1] ?? '15', 10) : 15;
      const months = (monthsTpl && monthsTpl.length > 0)
        ? monthsTpl
        : (monthDay ? [monthDay.split('-')[0]] : ['07']);
      const dates = months.map((mm) => {
        const m = parseInt(mm, 10);
        if (!Number.isFinite(m) || m < 1 || m > 12) return null;
        const last = new Date(Date.UTC(yearOf(m), m, 0)).getUTCDate();
        return new Date(Date.UTC(yearOf(m), m - 1, Math.min(day, last)));
      }).filter((d): d is Date => d != null);
      if (dates.length === 0) return { first: null, last: null };
      dates.sort((a, b) => a.getTime() - b.getTime());
      return {
        first: dates[0].toISOString().slice(0, 10),
        last: dates[dates.length - 1].toISOString().slice(0, 10),
      };
    };

    for (const e of eRows) {
      const { first, last } = derivedueDates(e.academic_year, e.first_due_month_day, e.schedule?.months);
      // Pull the per-line breakdown out of the addons array (written by
      // recompute-mch-tuition.mjs). Credits (deposit / sibling discount /
      // scholarship) are stored as NEGATIVE amounts — surface their
      // magnitude so the contract can label them "− $X" itself.
      const ad = Array.isArray(e.addons) ? e.addons : [];
      const cents = (key: string) => {
        const hit = ad.find((a) => a?.key === key);
        return hit && typeof hit.amount_cents === 'number' ? Math.abs(hit.amount_cents) : null;
      };
      enrollmentByStudentId[e.student_id] = {
        program_label: e.program_label,
        plan_label: e.plan_label,
        annual_tuition_cents: e.annual_tuition_cents,
        total_annual_cents: e.total_annual_cents,
        installment_count: e.installment_count,
        first_due_date: first,
        last_due_date: last,
        extended_care_cents: cents('extended_care'),
        development_fee_cents: cents('development_fee'),
        deposit_cents: cents('deposit'),
        sibling_discount_cents: cents('sibling_discount'),
        prompt_pay_discount_cents: cents('prompt_pay_discount'),
        scholarship_cents: cents('scholarship'),
        schedule_days: e.schedule_days,
        arrival_time: e.arrival_time,
        departure_time: e.departure_time,
      };
    }
  }

  // 3) Existing submissions across native + legacy status.
  //    Year is intentionally not filtered here — legacy submissions came
  //    in with their own year stamp and we still want to count them as
  //    "complete" for the parent. Resubmission rules govern whether the
  //    parent can update them. We also pull the responses jsonb so the
  //    renderer can pre-fill fields when the parent clicks Update.
  const subs = (await query<SubmissionRow & {
    responses: Record<string, unknown>;
    is_addendum: boolean;
    parent_submission_id: string | null;
    addendum_fields: string[] | null;
    submitter_parent_id: string | null;
    submitter_first_name: string | null;
    submitter_last_name: string | null;
  }>(
    // Join to parents so we can identify "the OTHER parent submitted
    // this" and warn the current viewer before they overwrite. The
    // submitter_parent_id is the parent_id stamped on the submission
    // at submit time.
    `SELECT s.id, s.student_id, s.status, s.submitted_at, s.legacy_source,
            s.responses, s.is_addendum, s.parent_submission_id, s.addendum_fields,
            s.parent_id AS submitter_parent_id,
            p.first_name AS submitter_first_name,
            p.last_name AS submitter_last_name
       FROM portal_form_submissions s
       LEFT JOIN parents p ON p.id = s.parent_id
      WHERE s.family_id = $1 AND s.form_definition_id = $2
        AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
      ORDER BY s.submitted_at DESC`,
    [id.parent.family_id, def.id],
  )).rows;

  // 4) Open migration flags for this family + form.
  const flagRows = (await query<FlagRow>(
    `SELECT id, student_id, flag_kind, flag_message, payload, status
     FROM portal_migration_flags
     WHERE school_id = $1 AND family_id = $2
       AND (form_definition_id = $3 OR form_definition_id IS NULL)
       AND status = 'pending'`,
    [id.parent.school_id, id.parent.family_id, def.id],
  )).rows;

  // 4b) Family-level emergency contacts from the most-recent emergency-medical
  //     submission. Used by the 1-tap "Same for this child" widget. Always
  //     load it — the flag and widget can appear on any form, not just
  //     per-student ones.
  let familyEmergencyContact: { name: string; phone: string; relationship: string } | null = null;
  const { rows: famSubs } = await query<{ responses: Record<string, unknown> }>(
    `SELECT s.responses
     FROM portal_form_submissions s
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     WHERE s.family_id = $1 AND s.school_id = $2 AND d.slug = 'emergency-medical'
     ORDER BY s.submitted_at DESC LIMIT 1`,
    [id.parent.family_id, id.parent.school_id],
  );
  const ferow = famSubs[0]?.responses;
  if (ferow && (ferow.ec1_name || ferow.ec1_phone)) {
    familyEmergencyContact = {
      name: String(ferow.ec1_name ?? '').trim(),
      phone: String(ferow.ec1_phone ?? '').trim(),
      relationship: String(ferow.ec1_relationship ?? '').trim(),
    };
  }

  // Group submissions by per-student bucket (or family-level).
  // Include the responses jsonb on each one so the renderer can pre-fill
  // form fields from the most recent submission when the parent clicks
  // "Update my answers".
  const submissionsByStudentId = new Map<string | '_family', ExistingSubmission[]>();
  for (const s of subs) {
    const k = s.student_id ?? '_family';
    if (!submissionsByStudentId.has(k)) submissionsByStudentId.set(k, []);
    submissionsByStudentId.get(k)!.push({
      id: s.id,
      submitted_at: s.submitted_at,
      status: s.status as ExistingSubmission['status'],
      is_legacy: !!s.legacy_source,
      responses: s.responses ?? {},
      is_addendum: !!s.is_addendum,
      parent_submission_id: s.parent_submission_id,
      addendum_fields: s.addendum_fields,
      submitter_parent_id: s.submitter_parent_id,
      submitter_name: [s.submitter_first_name, s.submitter_last_name]
        .filter(Boolean).join(' ').trim() || null,
    });
  }

  const existingByStudentId: Record<string, ExistingSubmission[]> = {};
  for (const [k, v] of submissionsByStudentId.entries()) {
    if (k === '_family') continue;
    existingByStudentId[k as string] = v;
  }
  const familyExisting = submissionsByStudentId.get('_family') ?? [];

  // Flags split into per-student and family-level
  const flagsByStudentId: Record<string, MigrationFlag[]> = {};
  const familyFlags: MigrationFlag[] = [];
  for (const f of flagRows) {
    const obj: MigrationFlag = {
      id: f.id,
      kind: f.flag_kind,
      message: f.flag_message,
      payload: f.payload,
    };
    if (f.student_id) {
      if (!flagsByStudentId[f.student_id]) flagsByStudentId[f.student_id] = [];
      flagsByStudentId[f.student_id].push(obj);
    } else {
      familyFlags.push(obj);
    }
  }

  // "All done" lockout only applies when one-per-year is on AND resubmission
  // is NOT allowed. Wooster forms have resubmission_allowed=true, so this
  // path won't lock anyone out — they always get the option to update.
  const allDone =
    def.one_submission_per_year && !def.resubmission_allowed && (
      def.per_student
        ? students.length > 0 && students.every((s) =>
            (existingByStudentId[s.id] ?? []).some((sub) => !sub.is_legacy))
        : familyExisting.some((sub) => !sub.is_legacy)
    );

  // 4c) Look up an operator-initiated invite if a token is present.
  //     If valid, surface the pre-fill values + lock the form to the
  //     targeted student (per-student forms) + remember the invite id
  //     so submit can mark it consumed.
  let inviteContext: { id: string; prefill: Record<string, string>; studentId: string | null } | null = null;
  if (sp.invite) {
    const { rows: invRows } = await query<{
      id: string;
      form_definition_id: string;
      family_id: string;
      student_id: string | null;
      prefill: Record<string, unknown> | null;
      consumed_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, form_definition_id, family_id, student_id, prefill,
              consumed_at, expires_at
         FROM enrollment_invites
        WHERE token = $1`,
      [sp.invite],
    );
    const inv = invRows[0];
    if (inv
        && inv.form_definition_id === def.id
        && inv.family_id === id.parent.family_id
        && !inv.consumed_at
        && new Date(inv.expires_at) > new Date()) {
      // Coerce prefill values to strings.
      const prefill: Record<string, string> = {};
      for (const [k, v] of Object.entries(inv.prefill ?? {})) {
        if (v == null) continue;
        prefill[k] = String(v);
      }
      inviteContext = { id: inv.id, prefill, studentId: inv.student_id };
    }
  }

  // 4d) Which of this family's students already have a tuition plan? Those
  //     are existing/imported families → the agreement is review-and-sign
  //     (locked, no billing). Students WITHOUT a plan are brand-new families
  //     → editable form + live calculator + billing on submit. Plus whether
  //     billing is live (drives charge vs. draft for new families).
  const existingPlanStudentIds: string[] = [];
  if (students.length > 0) {
    const sIds = students.map((s) => s.id);
    // Demo/test students (metadata.is_demo) are NEVER treated as existing —
    // so a test family always gets the editable calculator and can re-test
    // different payment plans over and over (each submit replaces their
    // draft plan). Real/imported families are protected as before.
    const { rows: planRows } = await query<{ student_id: string }>(
      `SELECT DISTINCT fte.student_id
         FROM family_tuition_enrollments fte
         JOIN students s ON s.id = fte.student_id
        WHERE fte.school_id = $1 AND fte.student_id = ANY($2::uuid[])
          AND fte.status = 'active'
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'`,
      [id.parent.school_id, sIds],
    );
    for (const r of planRows) existingPlanStudentIds.push(r.student_id);
  }
  const { rows: baRows } = await query<{ billing_active: boolean | null; card_enabled: boolean | null; ach_enabled: boolean | null }>(
    `SELECT billing_active, card_enabled, ach_enabled FROM school_payment_config WHERE school_id = $1`,
    [id.parent.school_id],
  );
  const billingActive = baRows[0]?.billing_active === true;
  const cardEnabled = baRows[0]?.card_enabled !== false;
  const achEnabled = baRows[0]?.ach_enabled !== false;

  // Does the family already have a saved payment method? Seeds the enrollment
  // form's card-on-file gate so returning parents aren't asked to re-enter;
  // new families have none and save one inline before they can submit.
  const { rows: pmRows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payment_methods
      WHERE school_id = $1 AND family_id = $2 AND active = true`,
    [id.parent.school_id, id.parent.family_id],
  );
  const hasPaymentMethodOnFile = (pmRows[0]?.n ?? 0) > 0;

  // Which of the family's students have ALREADY paid the enrollment fee?
  // Two sources of truth:
  //   1. FACTS ledger import — the "Enrollment Fee" account with a payment
  //      (covers current families who paid before go-live).
  //   2. A paid enrollment-fee invoice in Growth Suite (covers everyone who
  //      pays through the portal going forward).
  // The schedule reads this so paid families see "Paid" instead of a charge.
  const { rows: feePaidRows } = await query<{ student_id: string }>(
    `SELECT DISTINCT al.student_id
       FROM facts_account_ledger al
       JOIN students s ON s.id = al.student_id AND s.family_id = $2
      WHERE al.school_id = $1 AND al.account = 'Enrollment Fee' AND al.payments_cents > 0
     UNION
     SELECT DISTINCT i.student_id
       FROM invoices i
      WHERE i.school_id = $1 AND i.family_id = $2 AND i.source = 'enrollment_fee'
        AND i.student_id IS NOT NULL
        AND (i.status = 'paid' OR i.amount_paid_cents > 0)`,
    [id.parent.school_id, id.parent.family_id],
  );
  const enrollmentFeePaidStudentIds = feePaidRows.map((r) => r.student_id);

  // 5) Build definition object for the renderer (typed).
  const definition: FormDefinition = {
    id: def.id,
    slug: def.slug,
    display_name: def.display_name,
    description: def.description,
    category: def.category,
    per_student: def.per_student,
    required_for: def.required_for,
    field_schema: def.field_schema,
    fee_amount: def.fee_amount ? Number(def.fee_amount) : null,
    one_submission_per_year: def.one_submission_per_year,
    resubmission_allowed: def.resubmission_allowed,
    needs_review: def.needs_review,
    payment_config: def.payment_config,
    allow_addendum: def.allow_addendum,
  };

  const parentCtx: PrefillContext['parent'] = {
    first_name: id.parent.first_name,
    last_name: id.parent.last_name,
    email: id.parent.email ?? null,
    phone: id.parent.phone ?? null,
  };

  // Family guardians (GHL-synced) for live form prefill. Guardian 1 = the
  // primary parent, guardian 2 = the co-parent. Powers the enrollment
  // agreement's ea_pg1_*/ea_pg2_* prefills straight from the GHL contact for
  // brand-new families that have no frozen ea_* snapshot yet — so GHL is the
  // single source and no per-family prep is ever needed.
  const { rows: guardianRows } = await query<{
    first_name: string; last_name: string; email: string | null; phone: string | null; is_primary: boolean;
  }>(
    `SELECT first_name, last_name, email, phone, is_primary
       FROM parents WHERE family_id = $1 AND status = 'active'
       ORDER BY is_primary DESC, created_at ASC`,
    [id.parent.family_id],
  );
  const primaryGuardian = guardianRows.find((g) => g.is_primary) ?? guardianRows[0] ?? null;
  const secondaryGuardian = guardianRows.find((g) => g !== primaryGuardian) ?? null;
  const guardians: PrefillContext['guardians'] = {
    primary: primaryGuardian
      ? { first_name: primaryGuardian.first_name, last_name: primaryGuardian.last_name, email: primaryGuardian.email, phone: primaryGuardian.phone }
      : null,
    secondary: secondaryGuardian
      ? { first_name: secondaryGuardian.first_name, last_name: secondaryGuardian.last_name, email: secondaryGuardian.email, phone: secondaryGuardian.phone }
      : null,
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <Link
          href="/forms-v2"
          className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="h-3 w-3" /> Back to forms
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">{def.display_name}</h1>
        {def.description ? (
          <p className="mt-1 text-sm text-gray-600 whitespace-pre-wrap">{def.description}</p>
        ) : null}
        {def.needs_review ? (
          <p className="mt-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
            Draft — pending school review. Some fields may change.
          </p>
        ) : null}
      </header>

      {allDone ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-emerald-900">
                You&apos;ve completed this form for the {CURRENT_YEAR_FALLBACK} year.
              </h2>
              <p className="mt-1 text-xs text-emerald-800">
                {def.per_student
                  ? 'A submission is on file for every student in your family.'
                  : 'Your family submission is on file.'}{' '}
                If you need to make changes, please contact the school office.
              </p>
              <div className="mt-3">
                <Link
                  href="/forms-v2/history"
                  className="inline-flex items-center gap-1 rounded-md bg-white border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                >
                  View submission history
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {def.per_student && students.length === 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              {allStudents.length > 0 && def.applies_to ? (
                <>
                  This form doesn&apos;t apply to anyone in your family right now —
                  the school has it set up for a specific group of students. You
                  can safely skip it. If you think this is a mistake, please
                  contact the office.
                </>
              ) : (
                <>
                  This form is per-student, but no students are on file for your
                  family. Please contact the school office.
                </>
              )}
            </div>
          ) : (
            <FormRenderer
              definition={definition}
              students={students.map((s) => ({
                id: s.id,
                first_name: s.first_name,
                last_name: s.last_name,
                preferred_name: s.preferred_name,
                date_of_birth: s.date_of_birth,
                // Per-student admission date — set by school staff via
                // the admin UI, lives in metadata. Pulled into the
                // prefillCtx so DHS Agreement (+ Summer Camp DHS) can
                // prefill the "Date of child's admission" line.
                date_of_admission: (s.metadata?.date_of_admission as string | null) ?? null,
                // Full metadata bag — powers `meta:<key>` prefill sources
                // (e.g. the DGM enrollment agreement's pre-filled fields).
                metadata: (s.metadata ?? null) as Record<string, unknown> | null,
              }))}
              parent={parentCtx}
              guardians={guardians}
              currentParentId={id.parent.id}
              enrollmentByStudentId={enrollmentByStudentId}
              healthByStudentId={healthByStudentId}
              existingByStudentId={existingByStudentId}
              familyExisting={familyExisting}
              flagsByStudentId={flagsByStudentId}
              familyFlags={familyFlags}
              familyEmergencyContact={familyEmergencyContact}
              inviteContext={inviteContext}
              existingPlanStudentIds={existingPlanStudentIds}
              billingActive={billingActive}
              hasPaymentMethodOnFile={hasPaymentMethodOnFile}
              cardEnabled={cardEnabled}
              achEnabled={achEnabled}
              enrollmentFeePaidStudentIds={enrollmentFeePaidStudentIds}
            />
          )}
        </>
      )}
    </div>
  );
}
