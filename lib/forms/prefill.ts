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
}

const TZ = 'America/Phoenix';

export function resolvePrefill(source: PrefillSource | undefined, ctx: PrefillContext): string {
  if (!source) return '';
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
    case 'today': return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}
