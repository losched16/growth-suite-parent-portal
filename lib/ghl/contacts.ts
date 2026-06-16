import type { GhlClient } from './client';

export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  customFields?: Array<{ id: string; value: unknown }>;
  tags?: string[];
  dateAdded?: string;
  dateUpdated?: string;
}

export interface SearchContactsParams {
  client: GhlClient;
  filters?: Array<Record<string, unknown>>;
  pageLimit?: number;
  // Cursor-style pagination: omitted means start from page 1.
  startAfter?: [number, string];
}

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  // Free-form text shown in the GHL "Source" column. Helps Wooster
  // admins see at a glance where a contact came from (e.g. parent
  // self-invited a co-parent vs. CRM-side manual create).
  source?: string;
}

// Create a new GHL contact. Throws if GHL rejects (e.g. duplicate
// email — GHL enforces email uniqueness per location). Returns the
// new contact's id.
export async function createContact(
  client: GhlClient,
  input: CreateContactInput,
): Promise<string> {
  const body: Record<string, unknown> = {
    locationId: client.locationId,
    firstName: input.firstName,
    lastName: input.lastName,
  };
  if (input.email) body.email = input.email;
  if (input.phone) body.phone = input.phone;
  if (input.source) body.source = input.source;

  const { data } = await client.axios.post<{ contact?: { id?: string } }>(
    '/contacts/',
    body,
  );
  const id = data.contact?.id;
  if (!id) throw new Error('GHL createContact returned no contact.id');
  return id;
}

// Search contacts. Paginates internally up to `maxPages * pageLimit` results.
export async function searchContacts({
  client,
  filters,
  pageLimit = 100,
  maxPages = 50,
}: SearchContactsParams & { maxPages?: number }): Promise<GhlContact[]> {
  const all: GhlContact[] = [];
  let page = 1;
  while (page <= maxPages) {
    const { data } = await client.axios.post<{ contacts?: GhlContact[] }>(
      '/contacts/search',
      {
        locationId: client.locationId,
        pageLimit,
        page,
        ...(filters ? { filters } : {}),
      }
    );
    const contacts = data.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}
