// POST /api/auth/password-signin — email + password sign-in.
//
// Looks up the active parent by lowered-email, verifies the scrypt
// password hash. On success, mints + sets the session cookie and
// 303-redirects to /home. On failure, redirects back to /login with
// an err param. We don't leak which step failed (email vs password).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { schoolIdForHost } from '@/lib/branding';
import { verifyPassword } from '@/lib/auth/password';
import { logEvent } from '@/lib/auth/magic-link';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
  mintSession,
  recordSession,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const password = String(fd.get('password') ?? '');

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  if (!email || !password) return fail(request, email, 'wrong_password');

  // On a school-owned custom host, only that school's parent row may sign
  // in here — an email that exists at two schools must not resolve to the
  // other school's row just because it has a password.
  const hostSchoolId = await schoolIdForHost(
    request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
  );
  const { rows } = await query<{
    id: string; school_id: string; family_id: string; email: string;
    password_hash: string | null;
  }>(
    `SELECT id, school_id, family_id, email, password_hash
       FROM parents
      WHERE LOWER(email) = $1 AND status = 'active'
        AND ($2::uuid IS NULL OR school_id = $2::uuid)
      ORDER BY (password_hash IS NOT NULL) DESC, created_at ASC
      LIMIT 1`,
    [email, hostSchoolId],
  );
  const parent = rows[0];
  if (!parent) {
    await logEvent({ event_type: 'login_fail', email, detail: { reason: 'unknown_email' }, ip, user_agent: ua });
    return fail(request, email, 'wrong_password');
  }
  if (!parent.password_hash) {
    // Email exists but no password set — push them through the set
    // flow rather than failing. The /login page already shows the
    // set-password form when has_password is false.
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('email', email);
    return NextResponse.redirect(url, 303);
  }

  const ok = await verifyPassword(password, parent.password_hash);
  if (!ok) {
    await logEvent({ event_type: 'login_fail', email, school_id: parent.school_id, parent_id: parent.id, detail: { reason: 'wrong_password' }, ip, user_agent: ua });
    return fail(request, email, 'wrong_password');
  }

  await logEvent({
    event_type: 'login_success',
    email,
    school_id: parent.school_id,
    parent_id: parent.id,
    family_id: parent.family_id,
    ip, user_agent: ua,
  });
  await recordSession({ parent_id: parent.id, school_id: parent.school_id, ip, user_agent: ua });

  const jwt = await mintSession({
    parent_id: parent.id,
    school_id: parent.school_id,
    family_id: parent.family_id,
    email: parent.email,
  });

  const url = request.nextUrl.clone();
  url.pathname = '/home';
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

function fail(request: NextRequest, email: string, code: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (email) url.searchParams.set('email', email);
  url.searchParams.set('err', code);
  return NextResponse.redirect(url, 303);
}
