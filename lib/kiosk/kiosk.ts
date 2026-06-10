// Shared helpers for the unified check-in/out kiosk.
//
// The kiosk URL accepts EITHER the school uuid or the GHL location id
// (the location id is what every other DGM embed link uses, so handing
// the school one consistent identifier beats explaining uuids).
//
// The kiosk token is a short-lived JWT minted after a successful PIN
// match. It carries who the person is so the event endpoint doesn't
// re-verify the PIN; 10-minute expiry bounds how long an abandoned
// kiosk screen stays actionable.

import { SignJWT, jwtVerify } from 'jose';
import { query } from '@/lib/db';

export interface KioskSchool {
  id: string;
  name: string;
}

export async function resolveKioskSchool(idOrLocation: string): Promise<KioskSchool | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrLocation);
  const { rows } = await query<KioskSchool>(
    isUuid
      ? `SELECT id, name FROM schools WHERE id = $1`
      : `SELECT id, name FROM schools WHERE ghl_location_id = $1`,
    [idOrLocation],
  );
  return rows[0] ?? null;
}

export interface KioskClaims {
  kind: 'kiosk';
  school_id: string;
  person_type: 'parent' | 'pickup_person';
  person_id: string;
  person_name: string;
  family_id: string;
}

const KIOSK_TOKEN_TTL_S = 10 * 60;

function secret(): Uint8Array {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) throw new Error('PARENT_SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

export async function mintKioskToken(claims: Omit<KioskClaims, 'kind'>): Promise<string> {
  return new SignJWT({ ...claims, kind: 'kiosk' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${KIOSK_TOKEN_TTL_S}s`)
    .sign(secret());
}

export async function verifyKioskToken(token: string | undefined | null): Promise<KioskClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if ((payload as { kind?: string }).kind !== 'kiosk') return null;
    return payload as unknown as KioskClaims;
  } catch {
    return null;
  }
}
