// POST /api/auth/password-reset/request — "Forgot password?".
//
// Issues a single-use, 60-minute reset token and emails the link via the
// school's branded sender. Anti-enumeration: the redirect is identical
// whether or not the email matched. Host-scoped like every other auth
// lookup — on a school's custom domain only that school's parent row can
// receive a reset link.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { schoolIdForHost } from '@/lib/branding';
import { sendBrandedEmail } from '@/lib/email';
import { logEvent } from '@/lib/auth/magic-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_TTL_MIN = 60;

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  // Neutral response regardless of outcome. Requests from the dedicated
  // /forgot-password page land back there with the sent state.
  const fromForgot = String(fd.get('from') ?? '') === 'forgot';
  const url = request.nextUrl.clone();
  url.search = '';
  if (fromForgot) {
    url.pathname = '/forgot-password';
    url.searchParams.set('sent', '1');
  } else {
    url.pathname = '/login';
    if (email) {
      url.searchParams.set('email', email.slice(0, 120));
      url.searchParams.set('msg', 'reset_sent');
    }
  }
  const done = NextResponse.redirect(url, 303);
  if (!email) return done;

  try {
    const hostSchoolId = await schoolIdForHost(
      request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
    );
    // Reset applies to accounts that HAVE a password. First-time parents go
    // through the normal create-password flow instead.
    const { rows } = await query<{
      id: string; school_id: string; family_id: string;
      school_name: string; support_email: string | null;
    }>(
      `SELECT p.id, p.school_id, p.family_id, s.name AS school_name, b.support_email
         FROM parents p
         JOIN schools s ON s.id = p.school_id
         LEFT JOIN school_branding b ON b.school_id = p.school_id
        WHERE LOWER(p.email) = $1 AND p.status = 'active' AND p.password_hash IS NOT NULL
          AND ($2::uuid IS NULL OR p.school_id = $2::uuid)
        ORDER BY p.created_at ASC
        LIMIT 1`,
      [email, hostSchoolId],
    );
    const parent = rows[0];
    if (!parent) {
      await logEvent({ event_type: 'password_reset_request_unknown', email, ip, user_agent: ua });
      return done;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    await query(
      `INSERT INTO parent_password_reset_tokens
         (token, parent_id, school_id, email, expires_at, request_ip)
       VALUES ($1, $2, $3, $4, now() + interval '${TOKEN_TTL_MIN} minutes', $5)`,
      [token, parent.id, parent.school_id, email, ip],
    );

    const origin = `${request.headers.get('x-forwarded-proto') ?? 'https'}://${request.headers.get('x-forwarded-host') ?? request.headers.get('host')}`;
    const { portalBaseForSchool } = await import('@/lib/portal-base');
    const resetBase = await portalBaseForSchool(parent.school_id, origin);
    const resetUrl = `${resetBase}/reset-password/${encodeURIComponent(token)}`;
    const support = parent.support_email
      ? `If you didn't request this, ignore the email or contact ${parent.support_email}.`
      : `If you didn't request this, you can ignore the email.`;
    await sendBrandedEmail({
      to: email,
      schoolId: parent.school_id,
      subject: `Reset your password for ${parent.school_name}`,
      html: `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 480px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px; font-size: 18px;">Reset your ${escapeHtml(parent.school_name)} Family Portal password</h2>
  <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5;">
    Click the button below to choose a new password. The link expires in ${TOKEN_TTL_MIN} minutes and works only once.
  </p>
  <p style="margin: 24px 0;">
    <a href="${resetUrl}" style="display:inline-block; background:#047857; color:white; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;">Choose a new password</a>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    Or copy this link into your browser:<br>
    <span style="word-break: break-all; font-family: monospace;">${resetUrl}</span>
  </p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #6b7280;">${escapeHtml(support)}</p>
</body></html>`.trim(),
      text: `Reset your ${parent.school_name} Family Portal password

Open this link to choose a new password. It expires in ${TOKEN_TTL_MIN} minutes and works only once.

${resetUrl}

${support}`,
    });
    await logEvent({
      event_type: 'password_reset_requested', email,
      school_id: parent.school_id, parent_id: parent.id, family_id: parent.family_id,
      ip, user_agent: ua,
    });
  } catch (e) {
    console.error('[password-reset/request] failed:', e instanceof Error ? e.message : String(e));
  }
  return done;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;');
}
