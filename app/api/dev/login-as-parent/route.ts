// Dev-only bypass to sign in as any parent without going through the
// magic-link flow. Guarded by TWO conditions: the DEV_AUTH_BYPASS env
// var must be 'true' AND the request must present a bearer matching
// PARENT_SESSION_SECRET (the same secret used to sign session JWTs, so
// nothing new to leak). Production deploys with DEV_AUTH_BYPASS unset
// will return 404 — no surface area for misuse.
//
// Usage:
//   GET /api/dev/login-as-parent?parent_id=<uuid>&token=<PARENT_SESSION_SECRET>
//
// Mints a parent session cookie, then 303 → '/' so the operator lands
// inside the portal as that parent. Useful for screen-sharing demos
// when you don't have Resend configured.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
  mintSession,
  recordSession,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

interface ParentRow {
  id: string;
  school_id: string;
  family_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export async function GET(request: NextRequest) {
  // Two ways to enable this:
  //   1) DEV_AUTH_BYPASS=true + present a `token` matching PARENT_SESSION_SECRET
  //      (original behavior, two layers of protection)
  //   2) PARENT_DEMO_BYPASS=true — one-flag bypass for sales demos.
  //      No token needed; only set the env var for the duration of the
  //      demo, then unset.
  const demoBypass = process.env.PARENT_DEMO_BYPASS === 'true';
  if (!demoBypass && process.env.DEV_AUTH_BYPASS !== 'true') {
    return new NextResponse('not found', { status: 404 });
  }

  if (!demoBypass) {
    const expected = process.env.PARENT_SESSION_SECRET ?? '';
    const presented = request.nextUrl.searchParams.get('token') ?? '';
    if (!expected || !presented || !timingSafeEqual(expected, presented)) {
      return new NextResponse('unauthorized', { status: 401 });
    }
  }

  // Accept either parent_id (UUID, exact) OR email (stable across re-syncs).
  // Family-graph snapshot syncs regenerate parent UUIDs, which breaks
  // demo bookmarks; email survives.
  const parentId = (request.nextUrl.searchParams.get('parent_id') ?? '').trim();
  const email = (request.nextUrl.searchParams.get('email') ?? '').trim().toLowerCase();
  if (!parentId && !email) {
    return new NextResponse('parent_id or email required', { status: 400 });
  }

  const { rows } = await query<ParentRow>(
    parentId
      ? `SELECT id, school_id, family_id, email, first_name, last_name
         FROM parents WHERE id = $1 LIMIT 1`
      : `SELECT id, school_id, family_id, email, first_name, last_name
         FROM parents WHERE LOWER(email) = $1 AND is_primary = true
         ORDER BY created_at DESC LIMIT 1`,
    [parentId || email],
  );
  if (rows.length === 0) return new NextResponse('parent not found', { status: 404 });
  const p = rows[0];

  const jwt = await mintSession({
    parent_id: p.id,
    school_id: p.school_id,
    family_id: p.family_id,
    email: p.email ?? `${p.first_name ?? 'demo'}@dev.local`,
  });

  // Persist a session row so audit-trail looks normal.
  await recordSession({
    parent_id: p.id,
    school_id: p.school_id,
    ip: request.headers.get('x-forwarded-for') ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
  }).catch(() => undefined);

  // Land on the portal home with the cookie set.
  const url = request.nextUrl.clone();
  url.pathname = '/';
  url.search = '';
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: PARENT_SESSION_COOKIE,
    value: jwt,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PARENT_SESSION_TTL_S,
  });
  // eslint-disable-next-line no-console
  console.warn(
    '[DEV_AUTH_BYPASS] minted parent session for',
    p.id,
    `(${p.first_name ?? ''} ${p.last_name ?? ''} - ${p.email ?? 'no email'})`,
    '— MUST NOT appear in production',
  );
  return response;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
