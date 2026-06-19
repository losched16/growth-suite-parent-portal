// Resolve the value for a PrefillSource against the current parent's
// identity + the selected student + the student's health profile.
// Used by the renderer to populate inputs with sensible defaults.

import type { PrefillSource } from './types';

export interface PrefillContext {
  parent: {
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
  };
  student?: {
    first_name: string;
    last_name: string;
    preferred_name: string | null;
    date_of_birth: string | null;
    // Per-student admission date — pulled from students.metadata.date_of_admission.
    // null when school hasn't set it yet.
    date_of_admission: string | null;
    // Full students.metadata bag. Powers the generic `meta:<key>` prefill
    // source so a form field can pull ANY metadata value (e.g. the
    // DGM enrollment-agreement pre-fill writes clean, form-ready values
    // under `ea_*` keys that the schema reads via `meta:ea_pg1_street`).
    metadata?: Record<string, unknown> | null;
  };
  health?: {
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
  };
  // Active enrollment for the (student, academic year). Loaded by the
  // form page when the student has a row in family_tuition_enrollments.
  // The Tuition Agreement form reads from these so each family sees
  // THEIR contracted amounts pre-filled.
  enrollment?: {
    program_label: string | null;          // tuition_grids.display_name
    plan_label: string | null;             // payment_plans.display_name
    annual_tuition_cents: number | null;   // base grid tuition (before add-ons)
    total_annual_cents: number | null;     // final amount owed
    installment_count: number | null;
    first_due_date: string | null;         // ISO YYYY-MM-DD
    last_due_date: string | null;
    // Line-item breakdown, parsed from family_tuition_enrollments.addons
    // by the form page loader. Each is the dollar magnitude (positive),
    // null when that line doesn't apply to the student.
    extended_care_cents: number | null;
    development_fee_cents: number | null;
    deposit_cents: number | null;          // the paid deposit credit
    sibling_discount_cents: number | null;
    prompt_pay_discount_cents: number | null;  // 3% paid-in-full discount
    scholarship_cents: number | null;
    // Attendance schedule — from students.metadata (set from the
    // enrollment sheet). Surfaced on the tuition contract + DHS form.
    schedule_days: string | null;          // e.g. "M-F Full" / "T/Th"
    arrival_time: string | null;           // e.g. "8:15am"
    departure_time: string | null;         // e.g. "4:30pm"
  };
}

const TZ = 'America/Phoenix';

export function resolvePrefill(source: PrefillSource | undefined, ctx: PrefillContext): string {
  if (!source) return '';
  // Generic metadata passthrough: `meta:<key>` reads students.metadata[key]
  // verbatim. Used by forms whose pre-fill values are computed upstream and
  // stamped into metadata as clean, form-ready strings (option values, ISO
  // dates, etc.) — keeps this resolver free of per-field mapping logic.
  if (source.startsWith('meta:')) {
    const key = source.slice('meta:'.length);
    const v = ctx.student?.metadata?.[key];
    return v == null ? '' : String(v);
  }
  switch (source) {
    case 'parent.first_name': return ctx.parent.first_name ?? '';
    case 'parent.last_name': return ctx.parent.last_name ?? '';
    case 'parent.full_name': return [ctx.parent.first_name, ctx.parent.last_name].filter(Boolean).join(' ');
    case 'parent.email': return ctx.parent.email ?? '';
    case 'parent.phone': return ctx.parent.phone ?? '';
    case 'student.first_name': return ctx.student?.first_name ?? '';
    case 'student.last_name': return ctx.student?.last_name ?? '';
    case 'student.full_name': return ctx.student
      ? [ctx.student.preferred_name || ctx.student.first_name, ctx.student.last_name].filter(Boolean).join(' ')
      : '';
    case 'student.date_of_admission': {
      // Same date-coercion treatment as DOB: node-postgres returns
      // date columns as JS Date objects, not ISO strings.
      const v: unknown = ctx.student?.date_of_admission;
      if (!v) return '';
      if (typeof v === 'string') return v.slice(0, 10);
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    }
    case 'student.date_of_birth': {
      // Postgres `date` columns deserialize to a JS Date by node-postgres,
      // not a string — so we must normalize before slicing. Crashed the
      // form render with `.slice is not a function` when the student had
      // an actual DOB on file. Accept both shapes (Date and ISO string).
      const dob: unknown = ctx.student?.date_of_birth;
      if (!dob) return '';
      if (typeof dob === 'string') return dob.slice(0, 10);
      if (dob instanceof Date) return dob.toISOString().slice(0, 10);
      return String(dob).slice(0, 10);
    }
    case 'student.age': {
      // Whole-years age from the student's DOB, computed at render/submit
      // time. Read-only display so parents see the age on file (set during
      // the application) rather than typing it.
      const dob: unknown = ctx.student?.date_of_birth;
      if (!dob) return '';
      const iso = dob instanceof Date ? dob.toISOString().slice(0, 10) : String(dob).slice(0, 10);
      const d = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(d.getTime())) return '';
      const now = new Date();
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
      return age >= 0 && age < 130 ? String(age) : '';
    }
    case 'health.emergency_contact_name': return ctx.health?.emergency_contact_name ?? '';
    case 'health.emergency_contact_phone': return ctx.health?.emergency_contact_phone ?? '';
    case 'health.emergency_contact_relationship': return ctx.health?.emergency_contact_relationship ?? '';
    case 'health.primary_doctor_name': return ctx.health?.primary_doctor_name ?? '';
    case 'health.primary_doctor_phone': return ctx.health?.primary_doctor_phone ?? '';
    case 'health.preferred_hospital': return ctx.health?.preferred_hospital ?? '';
    case 'health.health_insurance_provider': return ctx.health?.health_insurance_provider ?? '';
    case 'health.health_insurance_policy_number': return ctx.health?.health_insurance_policy_number ?? '';
    case 'health.allergies': return ctx.health?.allergies ?? '';
    case 'health.current_medications': return ctx.health?.current_medications ?? '';
    case 'health.medical_conditions': return ctx.health?.medical_conditions ?? '';
    case 'enrollment.program_label':
      return ctx.enrollment?.program_label ?? '';
    case 'enrollment.plan_label':
      return ctx.enrollment?.plan_label ?? '';
    case 'enrollment.annual_tuition_dollars':
      return ctx.enrollment?.annual_tuition_cents != null
        ? (ctx.enrollment.annual_tuition_cents / 100).toFixed(2)
        : '';
    case 'enrollment.total_annual_dollars':
      return ctx.enrollment?.total_annual_cents != null
        ? (ctx.enrollment.total_annual_cents / 100).toFixed(2)
        : '';
    case 'enrollment.installment_count':
      return ctx.enrollment?.installment_count != null
        ? String(ctx.enrollment.installment_count)
        : '';
    case 'enrollment.installment_dollars': {
      const total = ctx.enrollment?.total_annual_cents;
      const count = ctx.enrollment?.installment_count;
      if (total == null || count == null || count === 0) return '';
      return (total / count / 100).toFixed(2);
    }
    case 'enrollment.first_due_date':
      return ctx.enrollment?.first_due_date ?? '';
    case 'enrollment.last_due_date':
      return ctx.enrollment?.last_due_date ?? '';
    case 'enrollment.base_tuition_dollars':
      return ctx.enrollment?.annual_tuition_cents != null
        ? (ctx.enrollment.annual_tuition_cents / 100).toFixed(2) : '';
    case 'enrollment.extended_care_dollars':
      return ctx.enrollment?.extended_care_cents != null
        ? (ctx.enrollment.extended_care_cents / 100).toFixed(2) : '';
    case 'enrollment.extended_care_monthly_dollars':
      // Annual extended-care fee split across the 10 DHS payment months
      // (July–April), to fill the DHS Agreement's "Per payment" line.
      return ctx.enrollment?.extended_care_cents != null
        ? (ctx.enrollment.extended_care_cents / 10 / 100).toFixed(2) : '';
    case 'enrollment.development_fee_dollars':
      return ctx.enrollment?.development_fee_cents != null
        ? (ctx.enrollment.development_fee_cents / 100).toFixed(2) : '';
    case 'enrollment.deposit_dollars':
      return ctx.enrollment?.deposit_cents != null
        ? (ctx.enrollment.deposit_cents / 100).toFixed(2) : '';
    case 'enrollment.sibling_discount_dollars':
      return ctx.enrollment?.sibling_discount_cents != null
        ? (ctx.enrollment.sibling_discount_cents / 100).toFixed(2) : '';
    case 'enrollment.prompt_pay_discount_dollars':
      return ctx.enrollment?.prompt_pay_discount_cents != null
        ? (ctx.enrollment.prompt_pay_discount_cents / 100).toFixed(2) : '';
    case 'enrollment.scholarship_dollars':
      return ctx.enrollment?.scholarship_cents != null
        ? (ctx.enrollment.scholarship_cents / 100).toFixed(2) : '';
    case 'enrollment.schedule_days':
      return ctx.enrollment?.schedule_days ?? '';
    case 'enrollment.arrival_time':
      return ctx.enrollment?.arrival_time ?? '';
    case 'enrollment.departure_time':
      return ctx.enrollment?.departure_time ?? '';
    case 'today': return todayString();
  }
  // `meta:<key>` sources are handled above the switch; any unrecognized
  // source falls through to an empty string.
  return '';
}

// Conditional-visibility check, shared by the renderer (to hide the field)
// and the submit route (to skip its required-validation). A field with no
// `visible_when` is always visible. Otherwise it's visible only when the
// current value of the referenced field is one of `equals`.
export function isBlockVisible(
  visibleWhen: { field: string; equals: string[] } | undefined | null,
  values: Record<string, unknown>,
): boolean {
  if (!visibleWhen || !visibleWhen.field) return true;
  const cur = values[visibleWhen.field];
  const curStr = cur == null ? '' : String(cur);
  return (visibleWhen.equals ?? []).map(String).includes(curStr);
}

// Today's date (YYYY-MM-DD) in the school's timezone. The single source of
// truth for the `today` prefill AND the server-side stamping of signature /
// submission dates, so a signed date can never be back-dated.
export function todayString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
