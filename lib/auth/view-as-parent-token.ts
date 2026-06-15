// Mirror of the dashboards-side helper. Verifies a "view as parent"
// signed token before we mint a real parent session for the admin.
//
// Same secret (VIEW_AS_PARENT_SECRET or EMBED_TOKEN_SECRET) — must
// match across both deployments. Token TTL is 5 minutes, set on the
// dashboards side at mint time.

import crypto from 'node:crypto';

function secret(): Buffer {
  const raw = process.env.VIEW_AS_PARENT_SECRET ?? process.env.EMBED_TOKEN_SECRET;
  if (!raw) throw new Error('VIEW_AS_PARENT_SECRET or EMBED_TOKEN_SECRET env var required');
  return Buffer.from(raw, 'base64');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export interface ViewAsParentPayload {
  parent_id: string;
  school_id: string;
  exp: number;
}

export function verifyViewAsParentToken(token: string | null | undefined): ViewAsParentPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const givenSig = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = sign(encoded);
  } catch {
    return null;
  }
  const a = Buffer.from(givenSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload: ViewAsParentPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.parent_id !== 'string' || typeof payload.school_id !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
