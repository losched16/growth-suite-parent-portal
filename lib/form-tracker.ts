// Form completion tracker for the parent portal.
//
// For each `school_forms` row:
//   - if per_student=false → read the configured field key once on the
//     family's primary contact (parent 1)
//   - if per_student=true  → read student_<base> for each student in the
//     family, using the slot stored in students.metadata.ghl_slot
//
// A form is "complete" if the field has any non-empty value. Most schools
// use DATE fields that get set on submission, so this works without
// schema-specific logic.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { studentFieldKey } from '@/lib/sync/desert-garden-config';

export interface SchoolFormRow {
  id: string;
  school_id: string;
  display_name: string;
  description: string | null;
  completion_field_key: string;
  fill_out_url: string | null;
  per_student: boolean;
  position: number;
}

export interface FormStatus {
  form: SchoolFormRow;
  // For per_student=false → single status. For per_student=true → one per student.
  per_student_statuses: Array<{
    student_id: string;
    student_name: string;
    completed: boolean;
    completed_value: string | null; // raw value (often a date string)
  }>;
  family_status: { completed: boolean; completed_value: string | null } | null;
  // Roll-up
  is_complete: boolean;
}

export interface FormsTrackerResult {
  forms: FormStatus[];
  // Counts across all forms
  total: number;
  completed: number;
  pct_complete: number;
}

interface FieldDef {
  id: string;
  fieldKey?: string;
  key?: string;
}

interface ContactRow {
  id: string;
  customFields?: Array<{ id: string; value: unknown }>;
}

export async function loadFormsForFamily(opts: {
  schoolId: string;
  familyId: string;
  parentId: string;
}): Promise<FormsTrackerResult> {
  // 1. Load form definitions
  const { rows: formRows } = await query<SchoolFormRow>(
    `SELECT id, school_id, display_name, description, completion_field_key,
            fill_out_url, per_student, position
     FROM school_forms
     WHERE school_id = $1 AND is_active = true
     ORDER BY position, display_name`,
    [opts.schoolId],
  );

  if (formRows.length === 0) {
    return { forms: [], total: 0, completed: 0, pct_complete: 0 };
  }

  // 2. Look up the family's primary parent (for family-level forms)
  const { rows: primaryRows } = await query<{
    parent_id: string; ghl_contact_id: string | null;
    parent_first_name: string; parent_last_name: string;
  }>(
    `SELECT id AS parent_id, ghl_contact_id,
            first_name AS parent_first_name, last_name AS parent_last_name
     FROM parents
     WHERE family_id = $1 AND is_primary = true AND status = 'active'
     LIMIT 1`,
    [opts.familyId],
  );
  const primary = primaryRows[0];

  // 3. Load students for per-student forms
  const { rows: studentRows } = await query<{
    id: string; first_name: string; last_name: string; preferred_name: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, first_name, last_name, preferred_name, metadata
     FROM students WHERE family_id = $1 AND status = 'active'
     ORDER BY first_name`,
    [opts.familyId],
  );

  // 4. We need to read GHL custom field values. The cheapest way is to
  // fetch the primary contact ONCE (it has all family + per-student
  // fields). The students table also stores ghl_contact_id in metadata —
  // for DG it's the same contact id (one-contact-per-family model).
  // Group by ghl_contact_id and fetch each contact at most once.
  const contactIds = new Set<string>();
  if (primary?.ghl_contact_id) contactIds.add(primary.ghl_contact_id);
  for (const s of studentRows) {
    const cid = s.metadata?.ghl_contact_id;
    if (typeof cid === 'string') contactIds.add(cid);
  }

  if (contactIds.size === 0) {
    // No GHL link — return empty statuses (everything shows as incomplete)
    return buildEmptyResult(formRows, studentRows);
  }

  // Load fieldKey → fieldId map (one shot)
  const client = await loadGhlClient(opts.schoolId);
  const fieldSchemaResp = await client.axios.get<{ customFields?: FieldDef[] }>(
    `/locations/${client.locationId}/customFields`,
  );
  const fieldKeyToId = new Map<string, string>();
  for (const f of fieldSchemaResp.data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const norm = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    fieldKeyToId.set(norm, f.id);
  }

  // Fetch each contact's custom fields. Indexed by contactId → (fieldId → value)
  const contactValues = new Map<string, Map<string, string>>();
  for (const cid of contactIds) {
    try {
      const { data } = await client.axios.get<{ contact: ContactRow }>(`/contacts/${cid}`);
      const m = new Map<string, string>();
      for (const cf of data.contact.customFields ?? []) {
        const v = cf.value;
        if (v === null || v === undefined) continue;
        const s = Array.isArray(v) ? v.join(', ') : String(v);
        if (s && s.trim()) m.set(cf.id, s.trim());
      }
      contactValues.set(cid, m);
    } catch (err) {
      console.warn('[form-tracker] failed to fetch contact', cid, err instanceof Error ? err.message : err);
    }
  }

  function readValue(contactId: string, fieldKey: string): string | null {
    const fieldId = fieldKeyToId.get(fieldKey);
    if (!fieldId) return null;
    return contactValues.get(contactId)?.get(fieldId) ?? null;
  }

  // 5. Walk forms, compute statuses
  const formStatuses: FormStatus[] = [];
  for (const form of formRows) {
    if (form.per_student) {
      const statuses: FormStatus['per_student_statuses'] = [];
      for (const s of studentRows) {
        const slot = typeof s.metadata.ghl_slot === 'number'
          ? s.metadata.ghl_slot
          : Number(s.metadata.ghl_slot ?? 1) || 1;
        const cid = typeof s.metadata.ghl_contact_id === 'string'
          ? s.metadata.ghl_contact_id
          : primary?.ghl_contact_id ?? null;
        const key = studentFieldKey(slot, form.completion_field_key);
        const val = cid ? readValue(cid, key) : null;
        statuses.push({
          student_id: s.id,
          student_name: s.preferred_name || s.first_name,
          completed: !!val,
          completed_value: val,
        });
      }
      const allDone = statuses.every((st) => st.completed);
      formStatuses.push({
        form,
        per_student_statuses: statuses,
        family_status: null,
        is_complete: allDone && statuses.length > 0,
      });
    } else {
      const cid = primary?.ghl_contact_id ?? null;
      const val = cid ? readValue(cid, form.completion_field_key) : null;
      formStatuses.push({
        form,
        per_student_statuses: [],
        family_status: { completed: !!val, completed_value: val },
        is_complete: !!val,
      });
    }
  }

  const completed = formStatuses.filter((f) => f.is_complete).length;
  const total = formStatuses.length;

  return {
    forms: formStatuses,
    total,
    completed,
    pct_complete: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

function buildEmptyResult(
  formRows: SchoolFormRow[],
  studentRows: Array<{
    id: string; first_name: string; last_name: string; preferred_name: string | null;
    metadata: Record<string, unknown>;
  }>,
): FormsTrackerResult {
  return {
    forms: formRows.map((form) => ({
      form,
      per_student_statuses: form.per_student
        ? studentRows.map((s) => ({
            student_id: s.id,
            student_name: s.preferred_name || s.first_name,
            completed: false,
            completed_value: null,
          }))
        : [],
      family_status: form.per_student ? null : { completed: false, completed_value: null },
      is_complete: false,
    })),
    total: formRows.length,
    completed: 0,
    pct_complete: 0,
  };
}
