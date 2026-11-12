// Best-effort pre-fill for form fields nobody wired up.
//
// A form built in the builder should open with whatever we already know about
// the child and family, without the school having to connect every field by
// hand. For a field with no prefill, no contact-field connection and no
// no_auto_prefill flag, this reads the field's label and, when it clearly asks
// for something we hold, returns the matching prefill source. Anything
// ambiguous returns null (the field stays blank): a wrong guess is worse than
// an empty box, so the rules are deliberately narrow.
//
//   - child fields (name, date of birth, program, allergies, doctor, insurance)
//     are only inferred on PER-STUDENT forms, where one child is in view;
//   - parent fields (first/last name, email, phone) only when the label says
//     "parent" or "guardian", and never for the second parent;
//   - prior school / sibling / pickup-person style labels are skipped.
//
// The value is a starting point: the field stays editable unless the school
// locked it, and a school can opt a field out with no_auto_prefill: true.

import type { PrefillSource } from './types';

interface InferBlock {
  key?: string;
  label?: string;
  type?: string;
  prefill?: unknown;
  ghl_field_key?: unknown;
  no_auto_prefill?: unknown;
}

const TEXTY = new Set(['text', 'textarea', 'email', 'tel', 'date', 'number']);
const CHOICE = new Set(['select', 'radio']);

const norm = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[_\-/]+/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function inferPrefill(b: InferBlock, perStudent: boolean): PrefillSource | string | null {
  if (!b.key || !b.type) return null;
  if (b.prefill || b.ghl_field_key || b.no_auto_prefill === true) return null;
  const texty = TEXTY.has(b.type);
  const choice = CHOICE.has(b.type);
  if (!texty && !choice) return null;

  const label = norm(b.label);
  if (!label) return null;
  const t = label + ' ' + norm(b.key);
  // Labels about someone or something else.
  const other = /\b(prior|previous|former|sibling|brother|sister|registrar|fax|attorney|lawyer|witness|reference|referred|recommend|employer|spouse|partner|other parent|second parent|parent 2|guardian 2|parent two)\b/.test(t);

  if (perStudent && !other) {
    if (texty) {
      // The label must START with student/child (or be "name of the student"), so
      // "person responsible for child last name" and "name of child care center" are left alone.
      if ((/^(the )?(student|child)'?s? (full )?name\b/.test(label) || /^name of (the )?(student|child)$/.test(label))
        && !/\b(first|last|middle|family)\b/.test(label)) return 'student.full_name';
      if (/^(the )?(student|child)'?s? first name\b/.test(label)) return 'student.first_name';
      if (/^(the )?(student|child)'?s? (last|family) name\b/.test(label)) return 'student.last_name';
      if (/\b(date of birth|birth ?date|dob)\b/.test(label) && !/\b(parent|guardian|mother|father)\b/.test(label)) return 'student.date_of_birth';
      if (/\ballerg/.test(label)) return 'health.allergies';
      if (/\bcurrent medications?\b/.test(label)) return 'health.current_medications';
      if (/\bmedical conditions?\b/.test(label)) return 'health.medical_conditions';
      if (/\b(carrier|insurance provider|insurance company)\b/.test(label)) return 'health.health_insurance_provider';
      if (/\b(policy|group) (number|no|id)\b/.test(label)) return 'health.health_insurance_policy_number';
      if (/\b(doctor|physician|pediatrician)'?s? name\b|\bname of (the )?(doctor|physician|pediatrician)\b/.test(label)) return 'health.primary_doctor_name';
      if (/\b(doctor|physician|pediatrician)'?s? (phone|telephone)\b/.test(label)) return 'health.primary_doctor_phone';
    }
    // "Program": a text box, or a dropdown whose options are the school's program names.
    if ((texty || choice) && /^((the )?(student|child)'?s? |current |enrolled |2026 27 )?program( name| placement)?$/.test(label)) {
      return 'meta:program_name';
    }
  }

  // Parent (primary guardian) details: only when the label names the parent.
  if (texty && /\b(parent|guardian)\b/.test(label) && !other && !/\bemergency\b|\bname\b.*\b(phone|e ?mail)\b/.test(label)) {
    if (/\bfirst name\b/.test(label)) return 'meta:ea_pg1_first_name';
    if (/\blast name\b|\bsurname\b/.test(label)) return 'meta:ea_pg1_last_name';
    if (/\be ?mail\b/.test(label)) return 'meta:ea_pg1_home_email';
    if (/\b(phone|mobile|cell)\b/.test(label)) return 'meta:ea_pg1_mobile_phone';
  }
  return null;
}
