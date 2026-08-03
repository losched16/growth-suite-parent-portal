// POST /api/portal-forms/resend-office-notice
//
// Manual replay of the office notification email for a submission whose
// original notice was lost (e.g. the pre-Aug-2026 fire-and-forget sends
// that died when Vercel froze the instance). Sends to the form's
// CURRENT notify list (or the school fallback) and reports per-
// recipient results.
//
// Auth: no session — the caller proves knowledge of the platform
// secret by sending key = HMAC-SHA256(PARENT_SESSION_SECRET,
// 'resend-office-notice:' + submission_id) hex. Operator tooling only.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendOfficeNotification } from '@/lib/forms/post-submit-effects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function expectedKey(submissionId: string): string | null {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) return null;
  return crypto
    .createHmac('sha256', Buffer.from(raw, 'base64'))
    .update(`resend-office-notice:${submissionId}`)
    .digest('hex');
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const submissionId = typeof body.submission_id === 'string' ? body.submission_id : '';
  const key = typeof body.key === 'string' ? body.key : '';
  const expected = expectedKey(submissionId);
  if (!submissionId || !expected || key.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { rows } = await query<{
    id: string; school_id: string; form_definition_id: string;
    family_id: string | null; parent_id: string | null; student_id: string | null;
    responses: Record<string, unknown>;
    slug: string; display_name: string; category: string | null;
    notify_emails: string[] | null; notifications_enabled: boolean | null;
  }>(
    `SELECT s.id, s.school_id, s.form_definition_id, s.family_id, s.parent_id,
            s.student_id, s.responses,
            d.slug, d.display_name, d.category, d.notify_emails, d.notifications_enabled
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.id = $1`,
    [submissionId],
  );
  const sub = rows[0];
  if (!sub) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  if (sub.notifications_enabled === false) {
    return NextResponse.json({ ok: false, error: 'notifications_disabled_for_form' }, { status: 409 });
  }
  const notifyEmails = sub.notify_emails ?? [];
  if (notifyEmails.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_notify_emails_on_form' }, { status: 409 });
  }

  const result = await sendOfficeNotification({
    submissionId: sub.id,
    schoolId: sub.school_id,
    formId: sub.form_definition_id,
    formSlug: sub.slug,
    formDisplayName: sub.display_name,
    formCategory: sub.category,
    familyId: sub.family_id ?? '',
    parentId: sub.parent_id ?? '',
    studentId: sub.student_id,
    responses: sub.responses ?? {},
    notifyEmails,
    webhookUrls: null,
  });
  return NextResponse.json({ ok: true, ...result });
}
