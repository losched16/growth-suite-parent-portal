// POST /api/portal-forms/cosign/resend — re-send the co-sign request email
// for an awaiting submission. Parent-authed: the logged-in parent must own
// the submission (same family). Lets Parent 1 re-trigger the email to Parent
// 2 if it didn't arrive, without waiting on the office.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(request: NextRequest, q: { msg?: string; err?: string }): NextResponse {
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const origin = `${proto}://${host}`;
  let dest = '/forms-v2/history';
  const ref = request.headers.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === origin) dest = u.pathname; // come back to wherever they clicked
    } catch { /* ignore */ }
  }
  const url = new URL(dest, origin);
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); } catch { return NextResponse.json({ error: 'invalid_body' }, { status: 400 }); }
  const submissionId = String(fd.get('submission_id') ?? '').trim();
  if (!submissionId) return back(request, { err: 'cosign_resend_failed' });

  const { rows } = await query<{
    id: string; school_id: string; parent_id: string | null; student_id: string | null;
    cosign_email: string | null; cosign_name: string | null; cosign_token: string | null;
    cosign_status: string | null; display_name: string;
  }>(
    `SELECT s.id, s.school_id, s.parent_id, s.student_id, s.cosign_email, s.cosign_name,
            s.cosign_token, s.cosign_status, d.display_name
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.id = $1 AND s.family_id = $2
      LIMIT 1`,
    [submissionId, session.family_id],
  );
  const sub = rows[0];
  if (!sub || sub.cosign_status !== 'awaiting' || !sub.cosign_email || !sub.cosign_token) {
    return back(request, { err: 'cosign_resend_failed' });
  }

  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const cosignUrl = `${proto}://${host}/cosign/${sub.cosign_token}`;
  try {
    const m = await import('@/lib/forms/cosign-email');
    await m.sendCoSignRequestEmail({
      schoolId: sub.school_id,
      to: sub.cosign_email,
      cosignerName: sub.cosign_name ?? '',
      submitterParentId: sub.parent_id ?? '',
      studentId: sub.student_id,
      formDisplayName: sub.display_name,
      cosignUrl,
    });
    await query(`UPDATE portal_form_submissions SET cosign_sent_at = now() WHERE id = $1`, [sub.id]);
  } catch (e) {
    console.error('[portal-forms/cosign/resend] failed:', e);
    return back(request, { err: 'cosign_resend_failed' });
  }
  return back(request, { msg: 'cosign_resent' });
}
