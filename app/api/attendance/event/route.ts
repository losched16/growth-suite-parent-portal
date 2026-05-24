// POST /api/attendance/event — write a single check_in / check_out
// event for one student. Append-only — never updates.
//
// Form fields:
//   student_id           uuid (required)
//   event_type           'check_in' | 'check_out' (required)
//   signature_png        data: URL of the captured signature (required)
//   curbside             '1' if curbside (optional; valid on either event type)
//   curbside_slot        text — parking-spot number (optional, sanitized to ≤16 chars)
//   picked_up_by         'me' | 'parent:<uuid>' | 'pickup:<uuid>'  (check_out only)
//
// Scope checks:
//   - student must belong to the parent's family (family_id match)
//   - 'parent:<uuid>' must be in the same family
//   - 'pickup:<uuid>' must be visible via the family-visibility query
//
// Side effects:
//   - row inserted into attendance_events
//   - daily_attendance row recomputed by the trigger we installed in
//     migration 012 (no extra app-side work needed)
//
// Future: kick off a background GHL sync of per-parent + per-student-slot
// custom fields. Punted on for the MVP per phase 5 of the brief.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface StudentRow {
  id: string;
  family_id: string;
  school_id: string;
  first_name: string;
  last_name: string;
}

interface ParentRow {
  id: string;
  first_name: string;
  last_name: string;
}

interface PickupRow {
  id: string;
  name: string;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const studentId = String(fd.get('student_id') ?? '').trim();
  const eventType = String(fd.get('event_type') ?? '').trim();
  const signaturePng = String(fd.get('signature_png') ?? '').trim();
  const curbside = fd.get('curbside') === '1';
  // Parking slot tag — typed in by the parent during morning drop-off
  // (or at check-out). Stored as-is, capped at 16 chars to keep the
  // staff dashboard readable. Only persisted when curbside=true.
  const curbsideSlotRaw = String(fd.get('curbside_slot') ?? '').trim().slice(0, 16);
  const curbsideSlot = curbside && curbsideSlotRaw ? curbsideSlotRaw : null;
  const pickedUpByRaw = String(fd.get('picked_up_by') ?? '').trim();
  // Optional free-form note attached to the event. Capped at 500 chars
  // server-side regardless of what the client sends.
  const notes = String(fd.get('notes') ?? '').trim().slice(0, 500) || null;

  if (!studentId || !['check_in', 'check_out'].includes(eventType)) {
    return errBack(request, 'Invalid request.');
  }
  if (!signaturePng || !signaturePng.startsWith('data:image/')) {
    return errBack(request, 'Please sign before submitting.');
  }

  // Scope: student must belong to parent's family
  const { rows: students } = await query<StudentRow>(
    `SELECT id, family_id, school_id, first_name, last_name FROM students WHERE id = $1`,
    [studentId],
  );
  if (students.length === 0) return errBack(request, 'Student not found.');
  const s = students[0];
  if (s.family_id !== session.family_id || s.school_id !== session.school_id) {
    return new NextResponse('forbidden', { status: 403 });
  }

  // Resolve picked_up_by
  let pickedUpByParentId: string | null = null;
  let pickedUpByPickupPersonId: string | null = null;
  let pickedUpByName: string | null = null;
  if (eventType === 'check_out') {
    if (!pickedUpByRaw) return errBack(request, 'Pick who is picking up.');
    if (pickedUpByRaw === 'me') {
      pickedUpByParentId = session.parent_id;
      const { rows } = await query<ParentRow>(
        `SELECT id, first_name, last_name FROM parents WHERE id = $1`,
        [session.parent_id],
      );
      const p = rows[0];
      pickedUpByName = p ? `${p.first_name} ${p.last_name}`.trim() : 'parent';
    } else if (pickedUpByRaw.startsWith('parent:')) {
      const otherId = pickedUpByRaw.slice('parent:'.length);
      const { rows } = await query<ParentRow & { family_id: string }>(
        `SELECT id, first_name, last_name, family_id FROM parents WHERE id = $1`,
        [otherId],
      );
      if (rows.length === 0 || rows[0].family_id !== session.family_id) {
        return new NextResponse('forbidden', { status: 403 });
      }
      pickedUpByParentId = rows[0].id;
      pickedUpByName = `${rows[0].first_name} ${rows[0].last_name}`.trim();
    } else if (pickedUpByRaw.startsWith('pickup:')) {
      const pickupId = pickedUpByRaw.slice('pickup:'.length);
      // Visibility: same-family via added_by_parent.family_id
      const { rows } = await query<PickupRow & { family_id: string }>(
        `SELECT pp.id, pp.name, p.family_id
         FROM pickup_persons pp
         JOIN parents p ON p.id = pp.added_by_parent_id
         WHERE pp.id = $1 AND pp.active = true`,
        [pickupId],
      );
      if (rows.length === 0 || rows[0].family_id !== session.family_id) {
        return new NextResponse('forbidden', { status: 403 });
      }
      pickedUpByPickupPersonId = rows[0].id;
      pickedUpByName = rows[0].name;
    } else {
      return errBack(request, 'Invalid pickup selection.');
    }
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent');

  await query(
    `INSERT INTO attendance_events (
       school_id, student_id, event_type,
       performed_by_parent_id, picked_up_by_parent_id, picked_up_by_pickup_person_id,
       picked_up_by_name_snapshot,
       signature_png, curbside, curbside_slot,
       notes,
       ip_address, user_agent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      s.school_id, s.id, eventType,
      session.parent_id, pickedUpByParentId, pickedUpByPickupPersonId,
      pickedUpByName,
      signaturePng, curbside, curbsideSlot,
      notes,
      ip, ua,
    ],
  );

  return NextResponse.redirect(new URL('/attendance', request.url), 303);
}

function errBack(request: NextRequest, msg: string): NextResponse {
  const ref = request.headers.get('referer') ?? '/attendance';
  const u = new URL(ref);
  u.searchParams.set('err', msg);
  return NextResponse.redirect(u, 303);
}
