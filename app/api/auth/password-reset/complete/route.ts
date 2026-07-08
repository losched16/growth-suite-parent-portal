// POST /api/auth/password-reset/complete — set the new password from a
// valid reset token, revoke every existing session for the parent (a
// reset means "lock out whoever else might be signed in"), and sign the
// parent straight in.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
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
  const token = String(fd.get('token') ?? '').trim();
  const password = String(fd.get('password') ?? '');
  const confirm = String(fd.get('password_confirm') ?? '');
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  const back = (err: string) => {
    const url = request.nextUrl.clone();
    url.pathname = token ? `/reset-password/${token}` : '/login';
    url.search = '';
    url.searchParams.set('err', err);
    return NextResponse.redirect(url, 303);
  };

  if (!token) return back('invalid');
  if (password.length < MIN_PASSWORD_LENGTH) return back('weak_password');
  if (password !== confirm) return back('mismatch');

  // Consume the token atomically — a second submit with the same token fails.
  const { rows } = await query<{ parent_id: string; school_id: string; email: string }>(
    `UPDATE parent_password_reset_tokens
        SET consumed_at = now()
      WHERE token = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING parent_id, school_id, email`,
    [token],
  );
  const t = rows[0];
  if (!t) return back('invalid');

  const { rows: pRows } = await query<{ id: string; school_id: string; family_id: string }>(
    `SELECT id, school_id, family_id FROM parents WHERE id = $1 AND status = 'active'`,
    [t.parent_id],
  );
  const parent = pRows[0];
  if (!parent) return back('invalid');

  const hash = await hashPassword(password);
  await query(
    `UPDATE parents SET password_hash = $1, password_set_at = now(), updated_at = now() WHERE id = $2`,
    [hash, parent.id],
  );
  // A password reset invalidates every existing session for this account.
  await query(
    `UPDATE parent_sessions SET revoked_at = now()
      WHERE parent_id = $1 AND revoked_at IS NULL`,
    [parent.id],
  );
  await logEvent({
    event_type: 'password_reset_completed', email: t.email,
    school_id: parent.school_id, parent_id: parent.id, family_id: parent.family_id,
    ip, user_agent: ua,
  });
  await recordSession({ parent_id: parent.id, school_id: parent.school_id, ip, user_agent: ua });

  const jwt = await mintSession({
    parent_id: parent.id,
    school_id: parent.school_id,
    family_id: parent.family_id,
    email: t.email,
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
