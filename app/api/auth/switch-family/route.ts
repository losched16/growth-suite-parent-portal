// Family switcher for split co-parents. One person (one email) can be a
// parent in TWO families at the same school — e.g. Wooster's Chris Reed:
// primary of his own family (Knox) AND co-parent on Crystal Woody's
// (Raice). Every login flow picks ONE parents row (LIMIT 1), so without
// this the second family is unreachable from his account.
//
// GET /api/auth/switch-family?family_id=… — requires a live parent
// session; the target family must have an ACTIVE parents row with the
// SAME email at the SAME school. Re-mints the session for that row and
// bounces to /home. Idempotent; no data changes.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import {
  PARENT_SESSION_COOKIE, PARENT_SESSION_TTL_S,
  mintSession, verifySession, recordSession,
} from '@/lib/auth/session';
import { logEvent } from '@/lib/auth/magic-link';

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const claims = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!claims) {
    const login = request.nextUrl.clone(); login.pathname = '/login'; login.search = '';
    return NextResponse.redirect(login, 303);
  }
  const familyId = request.nextUrl.searchParams.get('family_id')?.trim();
  if (!familyId) return NextResponse.json({ error: 'family_id required' }, { status: 400 });

  const { rows } = await query<{ id: string; school_id: string; family_id: string; email: string }>(
    `SELECT p.id, p.school_id, p.family_id, p.email
       FROM parents p
      WHERE p.family_id = $1
        AND p.school_id = $2
        AND LOWER(p.email) = LOWER($3)
        AND p.status = 'active'
      ORDER BY p.is_primary DESC
      LIMIT 1`,
    [familyId, claims.school_id, claims.email],
  );
  const target = rows[0];
  if (!target) return NextResponse.json({ error: 'not_your_family' }, { status: 403 });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');
  await logEvent({
    school_id: target.school_id, parent_id: target.id, family_id: target.family_id,
    event_type: 'family_switch', email: target.email,
    detail: { from_family_id: claims.family_id }, ip, user_agent: ua,
  });
  await recordSession({ parent_id: target.id, school_id: target.school_id, ip, user_agent: ua });

  const jwt = await mintSession({
    parent_id: target.id, school_id: target.school_id,
    family_id: target.family_id, email: target.email,
  });
  const url = request.nextUrl.clone();
  url.pathname = '/home'; url.search = '';
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: PARENT_SESSION_COOKIE, value: jwt,
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: PARENT_SESSION_TTL_S,
  });
  return response;
}
