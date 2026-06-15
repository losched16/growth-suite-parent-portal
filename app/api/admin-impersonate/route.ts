// GET /api/admin-impersonate?token=<signed-token>&next=<path>
//
// Admin impersonation entry point. The dashboards UI mints a 5-minute
// HMAC-signed token referencing a specific parent_id, and links to
// this route. We verify the token, look up the parent, mint a real
// parent session, and redirect to /home (or wherever `next` says).
//
// Auth model: the SIGNED TOKEN is the only credential. Anyone with a
// valid token can sign in as that parent. The token is generated on
// the dashboards side, which gates token issuance on the operator/
// school session, so the security boundary is "do you have admin
// access to the dashboards." Tokens expire in 5 min, so a forwarded
// URL stops working quickly.
//
// Audit: every successful impersonation logs a `parent_auth_events`
// row with event_type='admin_impersonate' so we can trace who got
// signed in as whom.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
  mintSession,
  recordSession,
} from '@/lib/auth/session';
import { verifyViewAsParentToken } from '@/lib/auth/view-as-parent-token';
import { logEvent } from '@/lib/auth/magic-link';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ParentRow {
  id: string;
  school_id: string;
  family_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const nextPath = (request.nextUrl.searchParams.get('next') ?? '/home').trim() || '/home';

  const payload = verifyViewAsParentToken(token);
  if (!payload) {
    return new NextResponse(
      'This impersonation link is expired or invalid. Generate a fresh one from the dashboards.',
      { status: 401, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  // Resolve the parent and confirm school_id matches what's signed in.
  const { rows } = await query<ParentRow>(
    `SELECT id, school_id, family_id, email, first_name, last_name, status
       FROM parents
      WHERE id = $1`,
    [payload.parent_id],
  );
  const parent = rows[0];
  if (!parent) {
    return new NextResponse('Parent not found.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  if (parent.school_id !== payload.school_id) {
    // Defense in depth — if someone tampered with the signed payload
    // such that parent_id and school_id don't agree, refuse the sign-in.
    return new NextResponse('School mismatch.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
  if (parent.status !== 'active') {
    return new NextResponse(`Parent is ${parent.status} — cannot impersonate.`, {
      status: 403, headers: { 'Content-Type': 'text/plain' },
    });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent') ?? null;

  const jwt = await mintSession({
    parent_id: parent.id,
    school_id: parent.school_id,
    family_id: parent.family_id,
    email: parent.email ?? `${parent.first_name ?? 'parent'}@impersonated.local`,
  });
  await recordSession({ parent_id: parent.id, school_id: parent.school_id, ip, user_agent: ua }).catch(() => undefined);

  await logEvent({
    event_type: 'admin_impersonate',
    email: parent.email ?? '',
    school_id: parent.school_id,
    parent_id: parent.id,
    family_id: parent.family_id,
    ip, user_agent: ua,
  }).catch(() => undefined);

  // Sanitize `next` to a relative path on this host only — no open
  // redirects.
  const safeNext = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/home';
  const url = request.nextUrl.clone();
  url.pathname = safeNext;
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
  return response;
}
