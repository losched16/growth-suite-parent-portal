// Parent session JWT — signed with PARENT_SESSION_SECRET, stored in an
// HttpOnly SameSite=Lax cookie. 30-day TTL by default (shorter than
// staff sessions because parents log in less often and sessions are
// device-bound; magic-link relogin is one tap so 30 days is fine).

import { SignJWT, jwtVerify } from 'jose';
import { query } from '@/lib/db';

export const PARENT_SESSION_COOKIE = 'gspp_parent_session';
export const PARENT_SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days

export interface ParentClaims {
  parent_id: string;
  school_id: string;
  family_id: string;
  email: string;
}

function secret(): Uint8Array {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) throw new Error('PARENT_SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

export async function mintSession(claims: ParentClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PARENT_SESSION_TTL_S}s`)
    .sign(secret());
}

export async function verifySession(token: string | undefined | null): Promise<ParentClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    return payload as unknown as ParentClaims;
  } catch {
    return null;
  }
}

// Audit-log persistence for the session itself. Best-effort.
export async function recordSession(opts: {
  parent_id: string;
  school_id: string;
  ip: string | null;
  user_agent: string | null;
}): Promise<void> {
  try {
    const expires = new Date(Date.now() + PARENT_SESSION_TTL_S * 1000).toISOString();
    await query(
      `INSERT INTO parent_sessions (parent_id, school_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [opts.parent_id, opts.school_id, expires, opts.ip, opts.user_agent],
    );
  } catch {
    // swallow
  }
}
