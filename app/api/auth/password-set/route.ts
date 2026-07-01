// POST /api/auth/password-set — first-time password creation for a
// parent. Email matches a parent record with no password set yet?
// Hash the new password, store it, sign them in. Anything else fails
// gracefully without disclosing what's wrong.
//
// Validation:
//   - password >= 8 chars
//   - password === password_confirm
//   - email matches an active parent row
//   - that parent has password_hash IS NULL (one-shot setup; can't
//     overwrite an existing password via this endpoint — reset flow
//     is operator-driven for now)

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
import { ghlWritebackPasswordSetAt } from '@/lib/auth/writeback-password-set';
import { portalProvisioningAllowed } from '@/lib/auth/portal-provisioning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const password = String(fd.get('password') ?? '');
  const confirm = String(fd.get('password_confirm') ?? '');

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  if (!email) return back(request, email, 'unknown_email');
  if (password.length < MIN_PASSWORD_LENGTH) return back(request, email, 'weak_password');
  if (password !== confirm) return back(request, email, 'mismatch');

  // Find an active parent for this email that DOESN'T have a password
  // yet. Filtering out parents with existing passwords here keeps this
  // endpoint safe to expose — the only thing it can do is initialize
  // a never-used account.
  const { rows } = await query<{
    id: string; school_id: string; family_id: string;
  }>(
    `SELECT id, school_id, family_id
       FROM parents
      WHERE LOWER(email) = $1 AND status = 'active' AND password_hash IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [email],
  );
  const parent = rows[0];
  if (!parent) {
    // Either the email doesn't exist OR they already have a password.
    // We don't disclose which — push them back to /login (sign-in mode
    // if they already have one, or an explicit "unknown email" if not).
    const { rows: existsRows } = await query<{ has_password: boolean }>(
      `SELECT (password_hash IS NOT NULL) AS has_password
         FROM parents WHERE LOWER(email) = $1 AND status = 'active'
        ORDER BY (password_hash IS NOT NULL) DESC LIMIT 1`,
      [email],
    );
    if (existsRows[0]?.has_password === true) {
      // Already has a password → kick to sign-in
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      url.searchParams.set('email', email);
      return NextResponse.redirect(url, 303);
    }
    return back(request, email, 'unknown_email');
  }

  // Portal-provisioning gate (opted-in schools): a first-time password can only
  // be created when the family's contact is in the admissions "Pending" stage.
  // Enforced server-side so it can't be bypassed by POSTing directly. Sign-in
  // for an already-provisioned account is never gated (access persists).
  if (!(await portalProvisioningAllowed(parent.school_id, parent.family_id))) {
    return back(request, email, 'not_eligible');
  }

  const hash = await hashPassword(password);
  await query(
    `UPDATE parents
        SET password_hash = $1,
            password_set_at = now(),
            updated_at = now()
      WHERE id = $2`,
    [hash, parent.id],
  );

  await logEvent({
    event_type: 'password_set',
    email,
    school_id: parent.school_id,
    parent_id: parent.id,
    family_id: parent.family_id,
    ip, user_agent: ua,
  });
  await recordSession({ parent_id: parent.id, school_id: parent.school_id, ip, user_agent: ua });

  // Fire-and-forget GHL writeback: stamp portal_password_set_at on the
  // contact so the welcome-email workflow's smart-list filter can
  // narrow them out of the next reminder send. Never blocks the
  // redirect — if GHL is down or the field doesn't exist, we still
  // log them in normally.
  void ghlWritebackPasswordSetAt(parent.id);

  const jwt = await mintSession({
    parent_id: parent.id,
    school_id: parent.school_id,
    family_id: parent.family_id,
    email,
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

function back(request: NextRequest, email: string, err: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (email) url.searchParams.set('email', email);
  url.searchParams.set('err', err);
  return NextResponse.redirect(url, 303);
}
