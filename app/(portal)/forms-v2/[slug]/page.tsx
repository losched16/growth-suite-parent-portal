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
  payment_config: FormPaymentConfig | null;
  allow_addendum: boolean;
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
            resubmission_allowed, needs_review, is_active, payment_config,
            allow_addendum
     FROM portal_form_definitions
     WHERE school_id = $1 AND slug = $2`,
    [id.parent.school_id, slug],
  )).rows;
  const def = defRows[0];
  if (!def || !def.is_active) notFound();

  // 2) Load students + their health profiles (for per-student forms).
  const students = await loadStudentsForFamily(id.parent.family_id);

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
              This form is per-student, but no students are on file for your family.
              Please contact the school office.
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
              }))}
              parent={parentCtx}
              currentParentId={id.parent.id}
              healthByStudentId={healthByStudentId}
              existingByStudentId={existingByStudentId}
              familyExisting={familyExisting}
              flagsByStudentId={flagsByStudentId}
              familyFlags={familyFlags}
              familyEmergencyContact={familyEmergencyContact}
              inviteContext={inviteContext}
            />
          )}
        </>
      )}
    </div>
  );
}
