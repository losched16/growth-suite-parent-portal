// POST /api/apply/start — a visitor asks to begin an application. We email a
// one-time link to the address given; nothing is created until they open it.
// Always answers the same way, so it can't be used to probe which emails exist.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { logEvent } from '@/lib/auth/magic-link';
import { portalBaseForSchool } from '@/lib/portal-base';
import {
  isEmail, loadOpenApplyBySlug, loadApplyBranding, mintApplyToken,
} from '@/lib/apply/open-applications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const slug = String(fd.get('school') ?? '').trim();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const first = String(fd.get('first_name') ?? '').trim().slice(0, 80);
  const last = String(fd.get('last_name') ?? '').trim().slice(0, 80);
  const phone = String(fd.get('phone') ?? '').trim().slice(0, 32);

  const cfg = slug ? await loadOpenApplyBySlug(slug) : null;
  const back = (q: Record<string, string>) => {
    const u = request.nextUrl.clone();
    u.pathname = `/apply/${cfg?.slug ?? slug}`;
    u.search = '';
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return NextResponse.redirect(u, 303);
  };
  if (!cfg) return NextResponse.redirect(new URL('/login', request.url), 303);
  if (!first || !last || !isEmail(email)) return back({ err: 'invalid', ...(email ? { email } : {}) });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  // Cap emails per address so the form can't be used to mail-bomb someone.
  let recentCount = 0;
  try {
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM parent_portal_audit_log
        WHERE event_type = 'apply_start' AND school_id = $1
          AND lower(detail->>'email') = $2 AND created_at > now() - interval '1 hour'`,
      [cfg.schoolId, email],
    );
    recentCount = Number(rows[0]?.n ?? 0);
  } catch { /* table shape differs — fail open on the count only */ }

  if (recentCount < 3) {
    try {
      const token = await mintApplyToken({ school_id: cfg.schoolId, email, first, last, phone });
      const base = await portalBaseForSchool(cfg.schoolId, request.nextUrl.origin);
      const url = `${base}/apply/verify?t=${encodeURIComponent(token)}`;
      const b = await loadApplyBranding(cfg.schoolId, cfg.schoolName);
      const subject = `Start your ${b.display_name} application`;
      const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:480px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 16px;font-size:18px;">Start your application to ${esc(b.display_name)}</h2>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;">Hi ${esc(first)}, confirm your email to create your account and begin the application. The link is good for 24 hours.</p>
<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;background:${esc(b.primary_color)};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Confirm email &amp; continue</a></p>
<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Or copy this link:<br><span style="word-break:break-all;font-family:monospace;">${url}</span></p>
<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;"><p style="margin:0;font-size:12px;color:#6b7280;">If you did not ask to apply, you can ignore this email.</p></body></html>`;
      const text = `Start your application to ${b.display_name}\n\nConfirm your email to create your account (link good for 24 hours):\n${url}\n\nIf you did not ask to apply, ignore this email.`;
      await sendBrandedEmail({ to: email, schoolId: cfg.schoolId, subject, html, text });
    } catch (e) {
      console.error('[apply/start] send failed:', e instanceof Error ? e.message : e);
    }
    await logEvent({
      event_type: 'apply_start', email, school_id: cfg.schoolId, ip,
      user_agent: request.headers.get('user-agent'),
    });
  }
  return back({ sent: '1', email });
}
