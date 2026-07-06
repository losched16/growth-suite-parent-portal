// Resolve the value for a PrefillSource against the current parent's
// identity + the selected student + the student's health profile.
// Used by the renderer to populate inputs with sensible defaults.

import type { PrefillSource, VisibleWhen, VisibilityCondition } from './types';

export interface PrefillContext {
  parent: {
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
  };
  // The family's guardians, GHL-synced from the parent contacts. Guardian 1
  // is the primary parent, guardian 2 the co-parent. Used to derive the
  // enrollment-agreement ea_pg1_*/ea_pg2_* prefills live from GHL when a
  // brand-new family has no frozen ea_* snapshot yet.
  guardians?: {
    primary?: { first_name: string; last_name: string; email: string | null; phone: string | null; relationship?: string | null } | null;
    secondary?: { first_name: string; last_name: string; email: string | null; phone: string | null; relationship?: string | null } | null;
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
    semi_annual_discount_cents: number | null; // 2% semi-annual discount
    scholarship_cents: number | null;
    // Attendance schedule — from students.metadata (set from the
    // enrollment sheet). Surfaced on the tuition contract + DHS form.
    schedule_days: string | null;          // e.g. "M-F Full" / "T/Th"
    arrival_time: string | null;           // e.g. "8:15am"
    departure_time: string | null;         // e.g. "4:30pm"
  };
}

const TZ = 'America/Phoenix';

// Live-GHL fallback for the enrollment-agreement `ea_*` snapshot keys. The
// original bulk import froze a clean `ea_*` snapshot into each student's
// metadata; brand-new families never get that snapshot, so their forms used
// to render blank. This derives each ea_* value from data we already hold
// live from GHL — the family's parents (guardian 1 = primary, 2 = co-parent)
// and the student's GHL-synced metadata base keys (program_tuition,
// grade_level, … mirrored from the contact's student_<slot>_* fields) — so
// GHL stays the single source for every new family with zero per-family prep.
function deriveEaFallback(eaKey: string, ctx: PrefillContext): string {
  const g1 = ctx.guardians?.primary ?? null;
  const g2 = ctx.guardians?.secondary ?? null;
  const md = ctx.student?.metadata ?? {};
  const m = (k: string): string => { const v = md[k]; return v == null ? '' : String(v).trim(); };
  switch (eaKey) {
    case 'ea_pg1_first_name':   return g1?.first_name ?? '';
    case 'ea_pg1_last_name':    return g1?.last_name ?? '';
    case 'ea_pg1_relationship': return g1?.relationship ?? '';
    case 'ea_pg2_relationship': return g2?.relationship ?? '';
    case 'ea_pg1_home_email':   return g1?.email ?? '';
    case 'ea_pg1_home_phone':
    case 'ea_pg1_mobile_phone': return g1?.phone ?? '';
    case 'ea_pg2_first_name':   return g2?.first_name ?? '';
    case 'ea_pg2_last_name':    return g2?.last_name ?? '';
    // Combined P2 full name — used to prefill the co-sign "full legal name"
    // field so the co-signing parent's name auto-fills from the contact
    // (Parent 1 doesn't re-type it) when LDMA is joint.
    case 'ea_pg2_full_name':    return g2 ? [g2.first_name, g2.last_name].filter(Boolean).join(' ').trim() : '';
    case 'ea_pg2_home_email':   return g2?.email ?? '';
    case 'ea_pg2_home_phone':
    case 'ea_pg2_mobile_phone': return g2?.phone ?? '';
    case 'ea_pg1_street': return m('street') || m('student_street');
    case 'ea_pg1_city':   return m('city')   || m('student_city');
    case 'ea_pg1_state':  return m('state')  || m('student_state');
    case 'ea_pg1_zip':    return m('zip')    || m('student_zip');
    // Pre-check the "add a second parent/guardian" box when the family
    // actually has a co-parent synced from GHL, so the (already-prefilled)
    // Parent/Guardian 2 section reads as included rather than blank-and-off.
    case 'ea_pg2_present': return g2 ? '1' : '';
    // Parent/Guardian 2 shares the family/contact address (one address per
    // GHL contact). Prefill it like pg1 so the 2nd guardian fills in "as
    // well"; the parent can edit it if the co-parent lives elsewhere.
    case 'ea_pg2_street': return g2 ? (m('street') || m('student_street')) : '';
    case 'ea_pg2_city':   return g2 ? (m('city')   || m('student_city'))   : '';
    case 'ea_pg2_state':  return g2 ? (m('state')  || m('student_state'))  : '';
    case 'ea_pg2_zip':    return g2 ? (m('zip')    || m('student_zip'))    : '';
  }
  // Generic: ea_<base> → the GHL-synced metadata base key (drop the ea_).
  const base = eaKey.slice(3);
  const direct = m(base);
  if (direct) return direct;
  if (base === 'enrollment_start_date') return m('current_year_enrollment_start_date');
  if (base === 'ldma') return m('legal_authority');
  return '';
}

export function resolvePrefill(source: PrefillSource | undefined, ctx: PrefillContext): string {
  if (!source) return '';
  // Generic metadata passthrough: `meta:<key>` reads students.metadata[key]
  // verbatim. Used by forms whose pre-fill values are computed upstream and
  // stamped into metadata as clean, form-ready strings (option values, ISO
  // dates, etc.) — keeps this resolver free of per-field mapping logic.
  if (source.startsWith('meta:')) {
    const key = source.slice('meta:'.length);
    const raw = ctx.student?.metadata?.[key];
    let v = raw == null ? '' : String(raw);
    // The frozen ea_* snapshot wins when present. When it's empty (a brand-new
    // family that came straight from their GHL contact, with no import
    // snapshot), fall back to the live GHL-synced data so the form still
    // prefills — keeping GHL the single source of truth.
    if (v.trim() === '' && key.startsWith('ea_')) v = deriveEaFallback(key, ctx);
    // Normalize ISO datetimes (e.g. GHL DATE fields synced as
    // "2026-08-03T00:00:00.000Z") to YYYY-MM-DD so <input type="date"> prefills
    // instead of rendering blank. Only touches ISO-datetime-shaped strings.
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) v = v.slice(0, 10);
    return v;
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
    case 'enrollment.semi_annual_discount_dollars':
      return ctx.enrollment?.semi_annual_discount_cents != null
        ? (ctx.enrollment.semi_annual_discount_cents / 100).toFixed(2) : '';
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

// Evaluate one condition: the current value of `field` is one of `equals`.
// An empty/unselected reference field never matches (same as the legacy
// single-condition behavior — this is exactly the old body).
function matchCondition(cond: VisibilityCondition, values: Record<string, unknown>): boolean {
  if (!cond.field) return true;
  const cur = values[cond.field];
  const curStr = cur == null ? '' : String(cur);
  return (cond.equals ?? []).map(String).includes(curStr);
}

// Conditional-visibility check, shared by the renderer (to hide the field)
// and the submit route (to skip its required-validation). A field with no
// `visible_when` is always visible. Handles both shapes:
//   - legacy single `{ field, equals }` — one controlling field.
//   - multi `{ match, conditions }` — ALL (AND) or ANY (OR) of the conditions.
// The legacy path is byte-for-byte the previous logic, so existing forms are
// unaffected.
export function isBlockVisible(
  visibleWhen: VisibleWhen | undefined | null,
  values: Record<string, unknown>,
): boolean {
  if (!visibleWhen) return true;
  if ('conditions' in visibleWhen) {
    const all = Array.isArray(visibleWhen.conditions) ? visibleWhen.conditions : [];
    const conds = all.filter((c) => c && c.field);
    if (conds.length === 0) return true;
    const results = conds.map((c) => matchCondition(c, values));
    return visibleWhen.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  }
  return matchCondition(visibleWhen, values);
}

// Today's date (YYYY-MM-DD) in the school's timezone. The single source of
// truth for the `today` prefill AND the server-side stamping of signature /
// submission dates, so a signed date can never be back-dated.
export function todayString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
