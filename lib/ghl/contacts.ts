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
