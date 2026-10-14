// Targeted GHL write helpers for the parent portal.
//   updateContactStandardFields — write firstName/lastName/phone/email
//   updateContactCustomFields   — write specific custom field values by fieldKey
//
// Both use the same encrypted PIT loaded via createGhlClient. Custom field
// IDs are looked up via /locations/{id}/customFields per request (cached
// in-memory for 60s to avoid a roundtrip per write).

import type { GhlClient } from './client';

interface CustomFieldDef {
  id: string;
  name?: string;
  fieldKey?: string;
  key?: string;
  dataType?: string;
  picklistOptions?: Array<{ id?: string } | string>;
}

const SCHEMA_TTL_MS = 60_000;
const _schemaCache = new Map<string, { at: number; map: Map<string, string>; listOption: Map<string, string> }>();

async function loadFieldDefsCached(client: GhlClient) {
  const cached = _schemaCache.get(client.locationId);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached;

  const { data } = await client.axios.get<{ customFields?: CustomFieldDef[] }>(
    `/locations/${client.locationId}/customFields`,
  );
  const map = new Map<string, string>();
  // TEXTBOX_LIST field id → the option id its value must be keyed by.
  const listOption = new Map<string, string>();
  for (const f of data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const normalized = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    map.set(normalized, f.id);
    if (f.dataType === 'TEXTBOX_LIST') {
      const first = (f.picklistOptions ?? []).find((o): o is { id: string } => typeof o === 'object' && !!o?.id);
      if (first) listOption.set(f.id, first.id);
    }
  }
  const entry = { at: Date.now(), map, listOption };
  _schemaCache.set(client.locationId, entry);
  return entry;
}

async function loadFieldSchemaCached(client: GhlClient): Promise<Map<string, string>> {
  return (await loadFieldDefsCached(client)).map;
}

// Old-form leftovers like "Cell (Primary)-3307499567, Home-, Work-": drop the
// empty "Label-" segments, and the label too when a single number remains.
function tidyListText(value: string): string {
  const parts = value.split(',').map((p) => p.trim()).filter((p) => p && !/^[A-Za-z ()]+-\s*$/.test(p));
  if (parts.length === 1) return parts[0].replace(/^Cell \(Primary\)\s*-?\s*/i, '').trim();
  return parts.join(', ');
}

// Public accessor for the fieldKey → field-id map (same 60s cache).
// Used by callers that need to READ a contact's current values by key —
// e.g. the new-application writeback locating the first empty
// student_<N>_first_name slot before writing.
export async function loadFieldKeyIdMap(client: GhlClient): Promise<Map<string, string>> {
  return loadFieldSchemaCached(client);
}

export interface StandardContactUpdate {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export async function updateContactStandardFields(
  client: GhlClient,
  contactId: string,
  fields: StandardContactUpdate,
): Promise<void> {
  // Strip undefined keys so we don't blank out fields the parent didn't touch.
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') body[k] = v;
  }
  if (Object.keys(body).length === 0) return;
  await client.axios.put(`/contacts/${contactId}`, body);
}

// Update a contact's custom field values by GHL fieldKey
// (e.g. { 'student_allergy': 'peanut, tree nuts', 'student_iep': 'No' }).
// Looks up the field IDs from the location's customFields catalog.
// Skips any keys that don't exist in the location (best-effort, logs).
export async function updateContactCustomFields(
  client: GhlClient,
  contactId: string,
  byKey: Record<string, string>,
): Promise<{ updated: number; skipped: string[] }> {
  const { map: schema, listOption } = await loadFieldDefsCached(client);
  const customFields: Array<{ id: string; field_value: string | Record<string, string> }> = [];
  const skipped: string[] = [];
  // TEXTBOX_LIST fields (e.g. Wooster's "Emergency Contact #N Phone Numbers")
  // accept a plain string with a 200 and silently keep the old value. They
  // need { <optionId>: text }, and that MERGES — entries under stale option
  // ids (left by an older form) survive unless sent as "" — so read the
  // contact's current keys first and blank the strays.
  let current: Map<string, Record<string, unknown>> | null = null;
  for (const [key, value] of Object.entries(byKey)) {
    const id = schema.get(key);
    if (!id) {
      skipped.push(key);
      continue;
    }
    const optionId = listOption.get(id);
    if (!optionId) {
      customFields.push({ id, field_value: value });
      continue;
    }
    if (!current) {
      current = new Map();
      try {
        const { data } = await client.axios.get<{ contact?: { customFields?: Array<{ id: string; value: unknown }> } }>(
          `/contacts/${contactId}`,
        );
        for (const cf of data.contact?.customFields ?? []) {
          if (cf.value && typeof cf.value === 'object' && !Array.isArray(cf.value)) {
            current.set(cf.id, cf.value as Record<string, unknown>);
          }
        }
      } catch {
        // Without the current keys we can still write the value; strays stay.
      }
    }
    const obj: Record<string, string> = {};
    for (const stale of Object.keys(current.get(id) ?? {})) if (stale !== optionId) obj[stale] = '';
    obj[optionId] = tidyListText(value);
    customFields.push({ id, field_value: obj });
  }
  if (customFields.length === 0) return { updated: 0, skipped };

  await client.axios.put(`/contacts/${contactId}`, { customFields });
  return { updated: customFields.length, skipped };
}
