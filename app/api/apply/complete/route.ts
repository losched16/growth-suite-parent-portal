// POST /api/apply/complete — the visitor opened their emailed link and chose a
// password. Creates (or links) the account, ties it to their CRM contact, signs
// them in and sends them to the application.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { logEvent } from '@/lib/auth/magic-link';
import {
  PARENT_SESSION_COOKIE, PARENT_SESSION_TTL_S, mintSession, recordSession,
} from '@/lib/auth/session';
import { ghlWritebackPasswordSetAt } from '@/lib/auth/writeback-password-set';
import {
  loadOpenApplyBySchool, provisionApplicant, verifyApplyToken,
} from '@/lib/apply/open-applications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const token = String(fd.get('t') ?? '');
  const password = String(fd.get('password') ?? '');
  const confirm = String(fd.get('password_confirm') ?? '');

  const redirect = (path: string, q: Record<string, string> = {}) => {
    const u = request.nextUrl.clone();
    u.pathname = path; u.search = '';
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return NextResponse.redirect(u, 303);
  };

  const claims = await verifyApplyToken(token);
  if (!claims) return redirect('/login');
  const cfg = await loadOpenApplyBySchool(claims.school_id);
  if (!cfg) return redirect('/login');

  const retry = (err: string) => redirect('/apply/verify', { t: token, err });
  if (password.length < MIN_PASSWORD_LENGTH) return retry('weak_password');
  if (password !== confirm) return retry('mismatch');

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  const res = await provisionApplicant(cfg, claims, password);
  if (res.kind === 'has_password') return redirect('/login', { email: claims.email });

  await logEvent({
    event_type: res.kind === 'created' ? 'apply_account_created' : 'password_set',
    email: res.email, school_id: cfg.schoolId, parent_id: res.parentId, family_id: res.familyId,
    ip, user_agent: ua,
  });
  await recordSession({ parent_id: res.parentId, school_id: cfg.schoolId, ip, user_agent: ua });
  void ghlWritebackPasswordSetAt(res.parentId);

  const jwt = await mintSession({
    parent_id: res.parentId, school_id: cfg.schoolId, family_id: res.familyId, email: res.email,
  });
  const response = redirect(`/forms-v2/${cfg.formSlug}`);
  response.cookies.set({
    name: PARENT_SESSION_COOKIE, value: jwt, httpOnly: true, secure: true,
    sameSite: 'lax', path: '/', maxAge: PARENT_SESSION_TTL_S,
  });
  return response;
}
