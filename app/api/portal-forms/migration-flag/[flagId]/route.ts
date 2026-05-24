// POST /api/portal-forms/migration-flag/{flagId}
//
// Resolves a migration flag raised by the legacy importer. The body
// describes how the parent wants to resolve it. Currently supports two
// flag kinds:
//
//   1) emergency_contacts_per_student_review
//      Body: { action: 'same_as_family' | 'different', emergency_contact?: {
//        name: string, phone: string, relationship: string,
//      } }
//      Side-effect: writes the chosen emergency contact (name/phone/
//      relationship) into the student's student_health_profiles row.
//
//   2) any other flag kind
//      Body: { action: 'dismiss' }
//      Side-effect: just marks the flag as resolved without changing
//      any other data.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ flagId: string }>;

interface FlagRow {
  id: string;
  school_id: string;
  family_id: string;
  student_id: string | null;
  flag_kind: string;
  status: string;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { flagId } = await params;

  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: {
    action?: string;
    emergency_contact?: { name?: string; phone?: string; relationship?: string };
    note?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // 1) Load the flag + verify ownership.
  const { rows: flagRows } = await query<FlagRow>(
    `SELECT id, school_id, family_id, student_id, flag_kind, status
     FROM portal_migration_flags WHERE id = $1`,
    [flagId],
  );
  const flag = flagRows[0];
  if (!flag) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (flag.school_id !== session.school_id || flag.family_id !== session.family_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (flag.status !== 'pending') {
    return NextResponse.json({ error: 'already_resolved' }, { status: 409 });
  }

  // 2) Handle by kind.
  if (flag.flag_kind === 'emergency_contacts_per_student_review') {
    if (!flag.student_id) {
      return NextResponse.json({ error: 'flag_has_no_student' }, { status: 400 });
    }
    const action = body.action;
    if (action !== 'same_as_family' && action !== 'different') {
      return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
    }

    let name = '', phone = '', relationship = '';

    if (action === 'same_as_family') {
      // Read family-level contacts off the most recent emergency-medical
      // submission's responses JSONB and copy contact #1 into the student
      // profile.
      const { rows: famSubs } = await query<{ responses: Record<string, unknown> }>(
        `SELECT s.responses
         FROM portal_form_submissions s
         JOIN portal_form_definitions d ON d.id = s.form_definition_id
         WHERE s.family_id = $1 AND s.school_id = $2 AND d.slug = 'emergency-medical'
         ORDER BY s.submitted_at DESC LIMIT 1`,
        [flag.family_id, flag.school_id],
      );
      const responses = famSubs[0]?.responses ?? {};
      name = String(responses.ec1_name ?? '').slice(0, 200);
      phone = String(responses.ec1_phone ?? '').slice(0, 100);
      relationship = String(responses.ec1_relationship ?? '').slice(0, 100);
      if (!name && !phone) {
        return NextResponse.json({ error: 'no_family_emergency_contact_on_file' }, { status: 400 });
      }
    } else {
      const ec = body.emergency_contact ?? {};
      name = String(ec.name ?? '').trim().slice(0, 200);
      phone = String(ec.phone ?? '').trim().slice(0, 100);
      relationship = String(ec.relationship ?? '').trim().slice(0, 100);
      if (!name && !phone) {
        return NextResponse.json({ error: 'name_or_phone_required' }, { status: 400 });
      }
    }

    // Upsert student_health_profiles for this student.
    await query(
      `INSERT INTO student_health_profiles
         (school_id, student_id, emergency_contact_name, emergency_contact_phone,
          emergency_contact_relationship, reviewed_by_parent_id, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (school_id, student_id) DO UPDATE SET
         emergency_contact_name = EXCLUDED.emergency_contact_name,
         emergency_contact_phone = EXCLUDED.emergency_contact_phone,
         emergency_contact_relationship = EXCLUDED.emergency_contact_relationship,
         reviewed_by_parent_id = EXCLUDED.reviewed_by_parent_id,
         reviewed_at = now(),
         updated_at = now()`,
      [flag.school_id, flag.student_id, name, phone, relationship, session.parent_id],
    );
  }

  // 3) Mark the flag resolved.
  await query(
    `UPDATE portal_migration_flags
       SET status = 'resolved',
           resolved_at = now(),
           resolved_by_parent_id = $1,
           resolution_note = $2
     WHERE id = $3`,
    [session.parent_id, body.note ?? null, flagId],
  );

  // 4) Audit
  await query(
    `INSERT INTO parent_portal_audit_log
       (school_id, parent_id, family_id, event_type, detail)
     VALUES ($1, $2, $3, 'resolve_migration_flag', $4::jsonb)`,
    [
      session.school_id, session.parent_id, session.family_id,
      JSON.stringify({
        flag_id: flagId, flag_kind: flag.flag_kind,
        student_id: flag.student_id, action: body.action,
      }),
    ],
  ).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
