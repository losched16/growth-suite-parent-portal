// POST /api/portal-forms/cosign — Parent 2 adds their counter-signature.
//
// No login: the bearer credential is the cosign_token emailed to the
// co-signer. We look up the awaiting submission for that token, record the
// typed signature (+ timestamp + IP) into both dedicated columns and the
// responses JSON, flip the row to 'signed', and fire the deferred
// completion effects (office notification, completion tag, "fully signed"
// email to Parent 1). Idempotent: a second POST with the same token no-ops
// because the row is no longer 'awaiting'.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { COSIGNER_SIGNATURE_FIELD, COSIGNER_SIGNED_AT_FIELD } from '@/lib/forms/cosign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pageRedirect(request: NextRequest, token: string, err?: string): NextResponse {
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const url = new URL(`${proto}://${host}/cosign/${encodeURIComponent(token)}`);
  if (err) url.searchParams.set('err', err);
  return NextResponse.redirect(url, 303);
}

interface SubRow {
  id: string;
  school_id: string;
  form_definition_id: string;
  family_id: string | null;
  parent_id: string | null;
  student_id: string | null;
  responses: Record<string, unknown> | null;
}

export async function POST(request: NextRequest) {
  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const token = String(fd.get('token') ?? '').trim();
  const signature = String(fd.get('signature') ?? '').trim();
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 400 });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const { rows } = await query<SubRow>(
    `SELECT id, school_id, form_definition_id, family_id, parent_id, student_id, responses
       FROM portal_form_submissions
      WHERE cosign_token = $1 AND cosign_status = 'awaiting'
        AND status <> 'voided'
      LIMIT 1`,
    [token],
  );
  const sub = rows[0];
  // No awaiting row → already signed, voided, or bad token. Bounce to the
  // page, which renders the appropriate "already signed / invalid" state.
  if (!sub) return pageRedirect(request, token, 'invalid');
  if (!signature) return pageRedirect(request, token, 'missing_signature');

  const nowIso = new Date().toISOString();
  const responses: Record<string, unknown> = { ...(sub.responses ?? {}) };
  responses[COSIGNER_SIGNATURE_FIELD] = signature;
  responses[COSIGNER_SIGNED_AT_FIELD] = nowIso;

  // Guard against a double-submit race: the WHERE clause re-checks 'awaiting'.
  const upd = await query<{ id: string }>(
    `UPDATE portal_form_submissions
        SET cosign_status = 'signed',
            cosign_signed_at = now(),
            cosign_signature = $2,
            cosign_ip = $3,
            responses = $4::jsonb,
            updated_at = now()
      WHERE id = $1 AND cosign_status = 'awaiting'
      RETURNING id`,
    [sub.id, signature, ip, JSON.stringify(responses)],
  );
  if (upd.rows.length === 0) return pageRedirect(request, token); // lost the race — already signed

  // Now fully executed → fire the effects we deferred at Parent 1's submit.
  const { rows: defRows } = await query<{
    slug: string; display_name: string; category: string | null;
    notify_emails: string[] | null; notifications_enabled: boolean | null;
    webhook_urls: string[] | null;
  }>(
    `SELECT slug, display_name, category, notify_emails, notifications_enabled, webhook_urls
       FROM portal_form_definitions WHERE id = $1`,
    [sub.form_definition_id],
  );
  const def = defRows[0];
  if (def) {
    import('@/lib/forms/post-submit-effects').then((m) =>
      m.firePostSubmitEffects({
        submissionId: sub.id,
        schoolId: sub.school_id,
        formId: sub.form_definition_id,
        formSlug: def.slug,
        formDisplayName: def.display_name,
        formCategory: def.category,
        familyId: sub.family_id ?? '',
        parentId: sub.parent_id ?? '',
        studentId: sub.student_id,
        responses,
        notifyEmails: def.notifications_enabled === false ? null : (def.notify_emails ?? null),
        webhookUrls: def.webhook_urls ?? null,
        // Frame the office email as "fully signed by both guardians" — this is
        // the completion notice the office is waiting on after the awaiting one.
        coSignComplete: true,
      })
    ).catch((e) => console.error('[portal-forms/cosign] post-submit effects failed:', e));

    if (sub.family_id) {
      import('@/lib/forms/completion-tag').then((m) =>
        m.maybeApplyCompletionTag({ schoolId: sub.school_id, familyId: sub.family_id! })
      ).catch((e) => console.error('[portal-forms/cosign] completion-tag failed:', e));
    }
  }

  // Tell Parent 1 it's fully executed. Awaited so it reliably sends before
  // the function is frozen (this is a low-volume, one-time action).
  try {
    const m = await import('@/lib/forms/cosign-email');
    await m.notifyCoSignComplete({ schoolId: sub.school_id, submissionId: sub.id });
  } catch (e) {
    console.error('[portal-forms/cosign] completion notify failed:', e);
  }

  return pageRedirect(request, token);
}
