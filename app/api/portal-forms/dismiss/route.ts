// POST /api/portal-forms/dismiss — parent dismisses a form from the
// home "Parent Forms" banner ("not interested in golf"). Family-wide:
// one parent dismissing silences it for the household. The form stays
// available on the Forms page; office trackers are unaffected.
//
// Office-pushed forms (live enrollment_invite) cannot be dismissed —
// a push means the office needs THIS family to fill it out.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readSessionFresh } from '@/lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await readSessionFresh();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData().catch(() => null);
  const formId = String(fd?.get('form_definition_id') ?? '').trim();
  if (!/^[0-9a-f-]{36}$/.test(formId)) {
    return NextResponse.json({ error: 'invalid_form_id' }, { status: 400 });
  }

  const { rows } = await query<{ pushed: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM enrollment_invites i
         WHERE i.form_definition_id = d.id AND i.family_id = $1
           AND i.consumed_at IS NULL AND i.expires_at > now()
     ) AS pushed
     FROM portal_form_definitions d
     WHERE d.id = $2 AND d.school_id = $3`,
    [session.family_id, formId, session.school_id],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'form_not_found' }, { status: 404 });
  if (rows[0].pushed) return NextResponse.json({ error: 'pushed_forms_cannot_be_dismissed' }, { status: 400 });

  await query(
    `INSERT INTO portal_form_dismissals (school_id, family_id, parent_id, form_definition_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (family_id, form_definition_id) DO NOTHING`,
    [session.school_id, session.family_id, session.parent_id, formId],
  );
  return NextResponse.redirect(new URL('/home', request.url), 303);
}
