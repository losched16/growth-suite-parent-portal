// POST /api/kiosk/{schoolId}/verify — unified kiosk PIN check.
//
// Body: { pin }
// Matches the PIN against BOTH parents and pickup_persons in this
// school (parents first — they're the more common kiosk user). On
// match, returns a 10-minute kiosk token + the students this person
// may check in/out, with each student's current state and eligible
// pickup-time waves.
//
// Rate limit: shares pickup_pin_attempts with the legacy pickup kiosk
// — max 10 failed attempts per IP per 10 minutes, school-wide.
//
// Lookup strategy: O(1) via pin_lookup (HMAC digest) for rows written
// after migration 050; legacy pickup_persons rows (pin set before the
// column existed) fall back to a scrypt loop. The matched row's scrypt
// hash is always verified before trusting the lookup hit.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyPin, pinLookup } from '@/lib/attendance/pickup-pin';
import { resolveKioskSchool, mintKioskToken } from '@/lib/kiosk/kiosk';
import { eligiblePickupTimes } from '@/lib/attendance/pickup-times';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ schoolId: string }>;

const RATE_LIMIT_WINDOW_MIN = 10;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const TZ = 'America/Phoenix';

interface MatchedPerson {
  person_type: 'parent' | 'pickup_person';
  person_id: string;
  person_name: string;
  family_id: string;
  // pickup persons may be scoped to specific students; empty = all.
  authorized_student_ids: string[];
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId: rawSchoolId } = await params;
  const school = await resolveKioskSchool(rawSchoolId);
  if (!school) return NextResponse.json({ error: 'school_not_found' }, { status: 404 });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent') ?? null;

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
        { error: 'rate_limited', detail: `Too many failed attempts. Try again in ${RATE_LIMIT_WINDOW_MIN} minutes.` },
        { status: 429 },
      );
    }
  }

  let body: { pin?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!/^\d{4,8}$/.test(pin)) {
    return NextResponse.json({ error: 'invalid_pin_format' }, { status: 400 });
  }

  const lookup = pinLookup(school.id, pin);
  let match: MatchedPerson | null = null;

  // 1. Parents via indexed lookup.
  const { rows: parentHits } = await query<{
    id: string; first_name: string; last_name: string; family_id: string; pin_hash: string;
  }>(
    `SELECT id, first_name, last_name, family_id, pin_hash
       FROM parents
      WHERE school_id = $1 AND pin_lookup = $2 AND status = 'active' AND pin_hash IS NOT NULL`,
    [school.id, lookup],
  );
  for (const p of parentHits) {
    if (await verifyPin(pin, p.pin_hash)) {
      match = {
        person_type: 'parent',
        person_id: p.id,
        person_name: `${p.first_name} ${p.last_name}`.trim(),
        family_id: p.family_id,
        authorized_student_ids: [],
      };
      break;
    }
  }

  // 2. Pickup persons via indexed lookup.
  if (!match) {
    const { rows: ppHits } = await query<{
      id: string; name: string; family_id: string; pin_hash: string; pin_expires_at: string | null;
      authorized_student_ids: string[];
    }>(
      `SELECT pp.id, pp.name, pp.family_id, pp.pin_hash, pp.pin_expires_at,
              COALESCE(ARRAY(SELECT student_id::text FROM pickup_person_students pps
                              WHERE pps.pickup_person_id = pp.id), ARRAY[]::text[]) AS authorized_student_ids
         FROM pickup_persons pp
        WHERE pp.school_id = $1 AND pp.pin_lookup = $2 AND pp.active = true AND pp.pin_hash IS NOT NULL`,
      [school.id, lookup],
    );
    for (const c of ppHits) {
      if (c.pin_expires_at && new Date(c.pin_expires_at) < new Date()) continue;
      if (await verifyPin(pin, c.pin_hash)) {
        match = {
          person_type: 'pickup_person', person_id: c.id, person_name: c.name,
          family_id: c.family_id, authorized_student_ids: c.authorized_student_ids,
        };
        break;
      }
    }
  }

  // 3. Legacy pickup persons (PIN set before pin_lookup existed).
  if (!match) {
    const { rows: legacy } = await query<{
      id: string; name: string; family_id: string; pin_hash: string; pin_expires_at: string | null;
      authorized_student_ids: string[];
    }>(
      `SELECT pp.id, pp.name, pp.family_id, pp.pin_hash, pp.pin_expires_at,
              COALESCE(ARRAY(SELECT student_id::text FROM pickup_person_students pps
                              WHERE pps.pickup_person_id = pp.id), ARRAY[]::text[]) AS authorized_student_ids
         FROM pickup_persons pp
        WHERE pp.school_id = $1 AND pp.pin_lookup IS NULL AND pp.active = true AND pp.pin_hash IS NOT NULL`,
      [school.id],
    );
    for (const c of legacy) {
      if (c.pin_expires_at && new Date(c.pin_expires_at) < new Date()) continue;
      if (await verifyPin(pin, c.pin_hash)) {
        match = {
          person_type: 'pickup_person', person_id: c.id, person_name: c.name,
          family_id: c.family_id, authorized_student_ids: c.authorized_student_ids,
        };
        // Backfill the lookup so next time this is an indexed hit.
        await query(`UPDATE pickup_persons SET pin_lookup = $1 WHERE id = $2`, [lookup, c.id])
          .catch(() => undefined);
        break;
      }
    }
  }

  // Audit + rate-limit record (success or failure).
  await query(
    `INSERT INTO pickup_pin_attempts
       (school_id, pickup_person_id, parent_id, pin_prefix, succeeded, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      school.id,
      match?.person_type === 'pickup_person' ? match.person_id : null,
      match?.person_type === 'parent' ? match.person_id : null,
      pin.slice(0, 2), !!match, ip, userAgent,
    ],
  ).catch(() => undefined);

  if (!match) {
    return NextResponse.json({ error: 'pin_not_recognized', detail: 'PIN not recognized. Check with the parent who set it up.' }, { status: 401 });
  }

  // Students this person can act on: the family's active students,
  // optionally narrowed by per-student authorization (pickup persons).
  const { rows: students } = await query<{
    id: string; name: string; program: string | null;
    att_status: string | null; last_check_out_at: string | null;
  }>(
    `SELECT s.id,
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name,
            s.metadata->>'program' AS program,
            da.status AS att_status,
            da.last_check_out_at
       FROM students s
       LEFT JOIN daily_attendance da
              ON da.school_id = s.school_id AND da.student_id = s.id
             AND da.date = (now() AT TIME ZONE '${TZ}')::date
      WHERE s.family_id = $1 AND s.school_id = $2 AND s.status = 'active'
      ORDER BY s.date_of_birth NULLS LAST`,
    [match.family_id, school.id],
  );

  const allowed = match.authorized_student_ids.length > 0
    ? students.filter((s) => match!.authorized_student_ids.includes(s.id))
    : students;

  const token = await mintKioskToken({
    school_id: school.id,
    person_type: match.person_type,
    person_id: match.person_id,
    person_name: match.person_name,
    family_id: match.family_id,
  });

  return NextResponse.json({
    ok: true,
    token,
    person_name: match.person_name,
    person_type: match.person_type,
    students: allowed.map((s) => {
      const checkedIn = (s.att_status === 'present' || s.att_status === 'partial') && !s.last_check_out_at;
      return {
        id: s.id,
        name: s.name,
        program: s.program,
        checked_in: checkedIn,
        pickup_times: eligiblePickupTimes(s.program),
      };
    }),
  });
}
