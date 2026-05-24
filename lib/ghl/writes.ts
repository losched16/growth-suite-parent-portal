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
}

const SCHEMA_TTL_MS = 60_000;
const _schemaCache = new Map<string, { at: number; map: Map<string, string> }>();

async function loadFieldSchemaCached(client: GhlClient): Promise<Map<string, string>> {
  const cached = _schemaCache.get(client.locationId);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.map;

  const { data } = await client.axios.get<{ customFields?: CustomFieldDef[] }>(
    `/locations/${client.locationId}/customFields`,
  );
  const map = new Map<string, string>();
  for (const f of data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const normalized = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    map.set(normalized, f.id);
  }
  _schemaCache.set(client.locationId, { at: Date.now(), map });
  return map;
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
  const schema = await loadFieldSchemaCached(client);
  const customFields: Array<{ id: string; field_value: string }> = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(byKey)) {
    const id = schema.get(key);
    if (!id) {
      skipped.push(key);
      continue;
    }
    customFields.push({ id, field_value: value });
  }
  if (customFields.length === 0) return { updated: 0, skipped };

  await client.axios.put(`/contacts/${contactId}`, { customFields });
  return { updated: customFields.length, skipped };
}
