// /kiosk/[schoolId]/pickup — public-ish pickup kiosk for non-parents.
//
// This page is NOT gated by the parent session — it's used by grandma,
// the babysitter, a neighbor with a one-off PIN, etc. Auth is the
// 6-digit PIN that a parent generated in advance + the signature.
//
// Flow:
//   1. Person enters their PIN
//   2. Server validates → returns the family's checked-in students
//   3. Person picks the student, picks a curbside slot, signs
//   4. Submit creates an attendance_event (check_out)

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { resolveCurbsideSlots } from '@/lib/attendance/curbside-slots';
import { KioskClient } from './KioskClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function KioskPickupPage({ params }: { params: Params }) {
  const { schoolId } = await params;
  const { rows: schools } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schools.length === 0) notFound();
  const school = schools[0];

  // Today's checked-in students (so the picker has a list once PIN is verified)
  const { rows: students } = await query<{ id: string; family_id: string; name: string }>(
    `SELECT s.id, s.family_id,
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
  );

  const curbsideSlots = await resolveCurbsideSlots(schoolId);

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col items-center px-4 py-8">
      <header className="w-full max-w-2xl mb-6">
        <div className="text-xs uppercase tracking-wider text-slate-500">Pickup kiosk</div>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">{school.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Authorized pickup people: enter your PIN to sign out a student.
        </p>
      </header>
      <KioskClient
        schoolId={schoolId}
        checkedInStudents={students}
        curbsideSlots={curbsideSlots}
      />
      <p className="mt-8 text-[11px] text-slate-400 text-center max-w-md">
        If you don&rsquo;t have a PIN, ask the parent to generate one from their portal under
        Settings → Authorized Pickup People.
      </p>
    </main>
  );
}
