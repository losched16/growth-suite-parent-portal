// GET /api/auth/verify?token=xxx — single-use magic-link consumer.
// On success: sets gspp_parent_session cookie, 303 → /home.
// On failure: 303 → /login?err=invalid_or_expired

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { consumeToken, logEvent } from '@/lib/auth/magic-link';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
  mintSession,
  recordSession,
} from '@/lib/auth/session';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
  const ua = request.headers.get('user-agent');

  if (!token) return redirectFail(request);

  const result = await consumeToken(token);
  if (!result) {
    await logEvent({ event_type: 'login_fail', detail: { reason: 'token_invalid_or_expired' }, ip, user_agent: ua });
    return redirectFail(request);
  }

  await logEvent({
    event_type: 'login_success',
    email: result.email,
    school_id: result.school_id,
    parent_id: result.parent_id,
    family_id: result.family_id,
    ip,
    user_agent: ua,
  });
  await recordSession({
    parent_id: result.parent_id,
    school_id: result.school_id,
    ip,
    user_agent: ua,
  });

  const jwt = await mintSession({
    parent_id: result.parent_id,
    school_id: result.school_id,
    family_id: result.family_id,
    email: result.email,
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
    sameSite: 'lax', // top-level navigation, not iframe
    path: '/',
    maxAge: PARENT_SESSION_TTL_S,
  });
  return response;
}

function redirectFail(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('err', 'invalid_or_expired');
  return NextResponse.redirect(url, 303);
}
