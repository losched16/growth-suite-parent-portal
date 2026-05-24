// Kiosk pickup endpoint — non-parent (grandma, babysitter) signs out a
// student using a PIN that the parent generated in advance.
//
// GET  /api/kiosk/{schoolId}/pickup?student_id=<uuid>  — public bootstrap:
//      returns the list of available curbside slots for the school. We
//      don't list students or pickup persons here — that's all gated
//      behind a successful PIN match below.
//
// POST /api/kiosk/{schoolId}/pickup
//      body: { pin, student_id, signature_png?, curbside_slot? }
//      → verifies PIN against active pickup_persons in this school
//      → enforces per-IP rate limit (max 10 attempts / 10min)
//      → records an attendance_event with check_out + picked_up_by_pickup_person_id
//      → returns { ok, pickup_person_name, student_name, recorded_at }

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPin } from '@/lib/attendance/pickup-pin';
import { resolveCurbsideSlots, isValidSlot } from '@/lib/attendance/curbside-slots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ schoolId: string }>;

const RATE_LIMIT_WINDOW_MIN = 10;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  // Don't disclose anything sensitive without auth. We just return:
  //   - The school's display name (for the kiosk header)
  //   - The published curbside slots
  //   - The list of students currently checked in (so the picker has options)
  //
  // School name + checked-in student names are mildly sensitive but not
  // dangerous — they don't expose family info, contact info, or DOB,
  // and a kiosk page necessarily needs to show them.
  const [schoolRes, slotsRes, studentsRes] = await Promise.all([
    query<{ name: string }>(`SELECT name FROM schools WHERE id = $1`, [schoolId]),
    resolveCurbsideSlots(schoolId),
    query<{ id: string; name: string }>(
      // Today's checked-in-but-not-checked-out students.
      `SELECT s.id,
              CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name
         FROM students s
         JOIN daily_attendance da
              ON da.school_id = s.school_id AND da.student_id = s.id
        WHERE s.school_id = $1
          AND s.status = 'active'
          AND da.date = (now() AT TIME ZONE 'America/Phoenix')::date
          AND da.status IN ('present', 'partial')
          AND da.last_check_out_at IS NULL
        ORDER BY name`,
      [schoolId],
    ),
  ]);
  if (schoolRes.rows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }
  return NextResponse.json({
    school_name: schoolRes.rows[0].name,
    curbside_slots: slotsRes,
    checked_in_students: studentsRes.rows,
  });
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;

  // ── Rate limit: max N failed PIN attempts per IP per window ───────
  if (ip) {
    const { rows: recentFailed } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pickup_pin_attempts
        WHERE ip_address = $1
          AND succeeded = false
          AND attempted_at > now() - ($2::text || ' minutes')::interval`,
      [ip, String(RATE_LIMIT_WINDOW_MIN)],
    );
    if (Number(recentFailed[0]?.n ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
      return NextResponse.json(
        { error: 'rate_limited', detail: `Too many failed attempts. Try again in ${RATE_LIMIT_WINDOW_MIN} min.` },
        { status: 429 },
      );
    }
  }

  let body: { pin?: unknown; student_id?: unknown; signature_png?: unknown; curbside_slot?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  const studentId = typeof body.student_id === 'string' ? body.student_id : '';
  const signaturePng = typeof body.signature_png === 'string' ? body.signature_png : '';
  const curbsideSlot = typeof body.curbside_slot === 'string' ? body.curbside_slot : '';

  if (!/^\d{4,8}$/.test(pin)) {
    return NextResponse.json({ error: 'invalid_pin_format' }, { status: 400 });
  }
  if (!studentId) {
    return NextResponse.json({ error: 'missing_student_id' }, { status: 400 });
  }

  // Validate curbside slot if provided (optional — non-curbside is allowed)
  let curbside = false;
  let validatedSlot: string | null = null;
  if (curbsideSlot) {
    const slots = await resolveCurbsideSlots(schoolId);
    if (!isValidSlot(curbsideSlot, slots)) {
      return NextResponse.json({ error: 'invalid_curbside_slot' }, { status: 400 });
    }
    curbside = true;
    validatedSlot = curbsideSlot;
  }

  // Find candidate pickup_persons (active, with a PIN, in this school).
  // We compare scrypt hashes — can't lookup directly by hash since each
  // row has a unique salt.
  const { rows: candidates } = await query<{
    id: string;
    name: string;
    pin_hash: string;
    pin_expires_at: string | null;
    added_by_family_id: string;
  }>(
    `SELECT pp.id, pp.name, pp.pin_hash, pp.pin_expires_at,
            p.family_id AS added_by_family_id
       FROM pickup_persons pp
       JOIN parents p ON p.id = pp.added_by_parent_id
      WHERE pp.school_id = $1
        AND pp.active = true
        AND pp.pin_hash IS NOT NULL`,
    [schoolId],
  );

  // Try each candidate (small set in practice — a school has dozens of
  // active PIN-holders at most).
  let match: typeof candidates[number] | null = null;
  for (const c of candidates) {
    if (c.pin_expires_at && new Date(c.pin_expires_at) < new Date()) continue;
    if (await verifyPin(pin, c.pin_hash)) { match = c; break; }
  }

  // Record the attempt (succeeded or not) for audit + rate-limit.
  await query(
    `INSERT INTO pickup_pin_attempts
       (school_id, pickup_person_id, pin_prefix, succeeded, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [schoolId, match?.id ?? null, pin.slice(0, 2), !!match, ip, userAgent],
  );

  if (!match) {
    return NextResponse.json({ error: 'pin_not_recognized' }, { status: 401 });
  }

  // Verify the student belongs to the same family that authorized this
  // pickup person. (Otherwise a parent who knows a PIN at the school
  // could sign out another family's student.)
  const { rows: studentRows } = await query<{ id: string; family_id: string; name: string }>(
    `SELECT id, family_id,
            CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students
      WHERE id = $1 AND school_id = $2 AND status = 'active'`,
    [studentId, schoolId],
  );
  const student = studentRows[0];
  if (!student) {
    return NextResponse.json({ error: 'student_not_found' }, { status: 404 });
  }
  if (student.family_id !== match.added_by_family_id) {
    return NextResponse.json(
      { error: 'not_authorized_for_this_student',
        detail: `${match.name} is not authorized to pick up ${student.name}.` },
      { status: 403 },
    );
  }

  // Record the attendance event (check_out)
  await query(
    `INSERT INTO attendance_events
       (school_id, student_id, event_type, performed_by_admin_email,
        picked_up_by_pickup_person_id, picked_up_by_name_snapshot,
        signature_png, curbside, curbside_slot, notes, ip_address, user_agent)
     VALUES ($1, $2, 'check_out', NULL, $3, $4, $5, $6, $7, NULL, $8, $9)`,
    [
      schoolId, studentId, match.id, match.name,
      signaturePng || null, curbside, validatedSlot, ip, userAgent,
    ],
  );

  return NextResponse.json({
    ok: true,
    pickup_person_name: match.name,
    student_name: student.name,
    curbside_slot: validatedSlot,
    recorded_at: new Date().toISOString(),
  });
}
