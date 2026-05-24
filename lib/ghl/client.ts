import axios, { AxiosInstance } from 'axios';
import { decrypt } from '@/lib/crypto';
import { query } from '@/lib/db';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
export const GHL_DEFAULT_VERSION = '2021-07-28';

type SchoolRow = {
  id: string;
  name: string;
  ghl_location_id: string;
  ghl_pit_encrypted: Buffer;
  ghl_pit_iv: Buffer;
  ghl_pit_tag: Buffer;
};

export async function loadSchool(schoolId: string): Promise<SchoolRow | null> {
  const { rows } = await query<SchoolRow>(
    `SELECT id, name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE id = $1`,
    [schoolId]
  );
  return rows[0] ?? null;
}

export async function loadSchoolByLocationId(locationId: string): Promise<SchoolRow | null> {
  const { rows } = await query<SchoolRow>(
    `SELECT id, name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
     FROM schools WHERE ghl_location_id = $1`,
    [locationId]
  );
  return rows[0] ?? null;
}

export type GhlClient = {
  axios: AxiosInstance;
  locationId: string;
  schoolId: string;
};

export function createGhlClient(school: SchoolRow): GhlClient {
  const pit = decrypt(school.ghl_pit_encrypted, school.ghl_pit_iv, school.ghl_pit_tag);
  const instance = axios.create({
    baseURL: GHL_BASE_URL,
    headers: {
      Authorization: `Bearer ${pit}`,
      Version: GHL_DEFAULT_VERSION,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  return { axios: instance, locationId: school.ghl_location_id, schoolId: school.id };
}

export async function loadGhlClient(schoolId: string): Promise<GhlClient> {
  const school = await loadSchool(schoolId);
  if (!school) throw new Error(`School ${schoolId} not found`);
  return createGhlClient(school);
}
