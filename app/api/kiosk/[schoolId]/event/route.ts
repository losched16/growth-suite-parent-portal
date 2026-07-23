// POST /api/kiosk/{schoolId}/event — record kiosk check-ins/outs.
//
// Body: {
//   token,                      // from /verify, 10-min JWT
//   actions: [{
//     student_id,
//     action: 'check_in' | 'check_out',
//     pickup_time?,             // required for check_in: 14:30|15:15|15:30
//     curbside?, curbside_slot? // optional, check_in intent flag
//   }]
// }
//
// The PIN was the identity proof at /verify — no signature here. Every
// event row carries source='kiosk' + performed_by_* attribution so the
// audit trail says exactly who tapped the screen. Check-outs also set
// picked_up_by_* (same person — they're physically present).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { resolveKioskSchool, verifyKioskToken } from '@/lib/kiosk/kiosk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ schoolId: string }>;

const VALID_PICKUP_TIMES = new Set(['14:30', '15:15', '15:30']);
const MAX_ACTIONS = 8; // a family realistically has ≤8 kids on campus

interface ActionInput {
  student_id?: unknown;
  action?: unknown;
  pickup_time?: unknown;
  curbside?: unknown;
  curbside_slot?: unknown;
  notes?: unknown;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId: rawSchoolId } = await params;
  const school = await resolveKioskSchool(rawSchoolId);
  if (!school) return NextResponse.json({ error: 'school_not_found' }, { status: 404 });

  let body: { token?: unknown; actions?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const claims = await verifyKioskToken(typeof body.token === 'string' ? body.token : null);
  if (!claims || claims.school_id !== school.id) {
    return NextResponse.json({ error: 'session_expired', detail: 'Your kiosk session expired — enter your PIN again.' }, { status: 401 });
  }

  const rawActions = Array.isArray(body.actions) ? (body.actions as ActionInput[]) : [];
  if (rawActions.length === 0 || rawActions.length > MAX_ACTIONS) {
    return NextResponse.json({ error: 'invalid_actions' }, { status: 400 });
  }

  // Scope: every student must belong to the token's family. Pickup
  // persons may additionally be narrowed to specific students.
  const { rows: familyStudents } = await query<{ id: string; name: string }>(
    `SELECT id, CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students
      WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
    [claims.family_id, school.id],
  );
  const familyIds = new Map(familyStudents.map((s) => [s.id, s.name]));

  let authorizedIds: Set<string> | null = null;
  if (claims.person_type === 'pickup_person') {
    const { rows } = await query<{ student_id: string }>(
      `SELECT student_id::text FROM pickup_person_students WHERE pickup_person_id = $1`,
      [claims.person_id],
    );
    if (rows.length > 0) authorizedIds = new Set(rows.map((r) => r.student_id));
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const ua = request.headers.get('user-agent') ?? null;

  const recorded: Array<{ student_id: string; student_name: string; action: string }> = [];
  for (const a of rawActions) {
    const studentId = typeof a.student_id === 'string' ? a.student_id : '';
    const action = a.action === 'check_in' || a.action === 'check_out' ? a.action : null;
    if (!studentId || !action) {
      return NextResponse.json({ error: 'invalid_action_shape' }, { status: 400 });
    }
    const studentName = familyIds.get(studentId);
    if (!studentName) {
      return NextResponse.json({ error: 'student_not_in_family' }, { status: 403 });
    }
    if (authorizedIds && !authorizedIds.has(studentId)) {
      return NextResponse.json({
        error: 'not_authorized_for_student',
        detail: `${claims.person_name} is not authorized for ${studentName}.`,
      }, { status: 403 });
    }

    const pickupTime = typeof a.pickup_time === 'string' && VALID_PICKUP_TIMES.has(a.pickup_time)
      ? a.pickup_time : null;
    if (action === 'check_in' && !pickupTime) {
      return NextResponse.json({ error: 'pickup_time_required', detail: `Pick a pickup time for ${studentName}.` }, { status: 400 });
    }
    // Choosing a curbside time IS the opt-in (checkbox kept for
    // back-compat with cached kiosk clients).
    const curbsideSlot = typeof a.curbside_slot === 'string'
      ? a.curbside_slot.trim().slice(0, 16) || null : null;
    const curbside = a.curbside === true || curbsideSlot !== null;
    const kioskNotes = typeof a.notes === 'string' ? a.notes.trim().slice(0, 500) || null : null;

    const isParent = claims.person_type === 'parent';
    await query(
      `INSERT INTO attendance_events (
         school_id, student_id, event_type,
         performed_by_parent_id, performed_by_pickup_person_id, performed_by_name_snapshot,
         picked_up_by_parent_id, picked_up_by_pickup_person_id, picked_up_by_name_snapshot,
         curbside, curbside_slot, pickup_time, notes,
         source, ip_address, user_agent
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'kiosk', $14, $15)`,
      [
        school.id, studentId, action,
        isParent ? claims.person_id : null,
        isParent ? null : claims.person_id,
        claims.person_name,
        action === 'check_out' && isParent ? claims.person_id : null,
        action === 'check_out' && !isParent ? claims.person_id : null,
        action === 'check_out' ? claims.person_name : null,
        curbside, curbsideSlot,
        action === 'check_in' ? pickupTime : null,
        kioskNotes,
        ip, ua,
      ],
    );
    recorded.push({ student_id: studentId, student_name: studentName, action });
  }

  return NextResponse.json({ ok: true, recorded, by: claims.person_name });
}
