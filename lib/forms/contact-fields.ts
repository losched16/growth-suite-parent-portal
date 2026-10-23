// Contact-record values for form prefill.
//
// A form field connected to a Growth Suite (GHL) contact field pre-fills from
// the family's contact record. Student-level fields are mirrored into
// students.metadata and resolve there; PARENT/FAMILY-level fields (parent_2_*,
// a school's own custom fields) have no student row, so they're read from the
// primary contact's mirrored custom-field values here and used as a fallback by
// resolvePrefill's meta:<key> branch.

import { query } from '@/lib/db';

type SchemaBlock = { prefill?: unknown; ghl_field_key?: unknown };

// Every contact-field key a form's blocks might pull from: the meta:<key>
// prefills plus any builder-connected ghl_field_key.
export function contactFieldKeysFor(schema: ReadonlyArray<unknown>): string[] {
  const keys = new Set<string>();
  for (const raw of Array.isArray(schema) ? schema : []) {
    const b = raw as SchemaBlock;
    if (typeof b.prefill === 'string' && b.prefill.startsWith('meta:') && !b.prefill.startsWith('meta:ea_')) keys.add(b.prefill.slice(5));
    if (typeof b.ghl_field_key === 'string' && b.ghl_field_key) keys.add(b.ghl_field_key);
  }
  return [...keys];
}

// The family's primary-contact custom-field values for the given keys.
// Best-effort: any failure yields {} so a form never fails to render over it.
export async function loadContactFields(
  schoolId: string,
  parentId: string,
  keys: string[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  try {
    const { rows } = await query<{ field_key: string; value: string | null }>(
      `SELECT v.field_key, v.value
         FROM ghl_contact_field_values v
        WHERE v.school_id = $1
          AND v.field_key = ANY($3::text[])
          AND v.ghl_contact_id = (
            SELECT p2.ghl_contact_id FROM parents me
              JOIN parents p2 ON p2.family_id = me.family_id AND p2.status = 'active' AND p2.ghl_contact_id IS NOT NULL
             WHERE me.id = $2
             ORDER BY p2.is_primary DESC, p2.created_at ASC
             LIMIT 1)`,
      [schoolId, parentId, keys],
    );
    const out: Record<string, string> = {};
    for (const r of rows) {
      const v = (r.value ?? '').trim();
      if (v) out[r.field_key] = v;
    }
    return out;
  } catch {
    return {};
  }
}
