// /attendance — parent's daily attendance landing.
// One card per student with today's status badge and the appropriate
// action button:
//   not_yet      → [Check in]
//   present      → [Check out]
//   checked_out  → "Picked up at HH:MM" (no further action; absent → "Marked absent")
//   absent       → "Marked absent" + [Undo / Check in]
//
// Tapping a button routes to /attendance/check-in/<student_id> or
// /attendance/check-out/<student_id> with the actual signature + form
// flow.

import Link from 'next/link';
import { Settings, UserCheck, LogOut, AlertCircle } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface StudentStatus {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  classroom: string | null;
  status: 'not_yet' | 'present' | 'checked_out' | 'absent' | 'partial';
  first_check_in_at: string | null;
  last_check_out_at: string | null;
  picked_up_by_name: string | null;
  curbside_pickup: boolean | null;
}

// Today in DG's timezone — for the MVP we hardcode America/Phoenix.
// When multi-tenant we'll read schools.timezone.
const TZ = 'America/Phoenix';

export default async function AttendancePage() {
  const id = await requireParent();
  const today = todayInTz(TZ);

  const { rows } = await query<StudentStatus>(
    `SELECT
       s.id, s.first_name, s.last_name, s.preferred_name,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS classroom,
       COALESCE(da.status, 'not_yet') AS status,
       da.first_check_in_at,
       da.last_check_out_at,
       da.picked_up_by_name,
       da.curbside_pickup
     FROM students s
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id AND da.school_id = s.school_id AND da.date = $3::date
     WHERE s.family_id = $1
       AND s.school_id = $2
       AND s.status = 'active'
     ORDER BY s.first_name`,
    [id.parent.family_id, id.parent.school_id, today],
  );

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
            <UserCheck className="h-6 w-6" style={{ color: 'var(--brand)' }} />
            Attendance
          </div>
          <p className="mt-1 text-sm text-gray-600">
            Check your student{rows.length === 1 ? '' : 's'} in for drop-off and out for pick-up.
          </p>
        </div>
        <Link
          href="/settings/pickup-people"
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          <Settings className="h-3.5 w-3.5" /> Manage pickup people
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <div>
            We don&apos;t have any active students on file for your family yet. Contact the
            school office if you think this is a mistake.
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((s) => (
            <StudentCard key={s.id} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StudentCard({ s }: { s: StudentStatus }) {
  const name = s.preferred_name?.trim()
    ? `${s.preferred_name} ${s.last_name}`
    : `${s.first_name} ${s.last_name}`;
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <div className="text-lg font-semibold text-gray-900">{name}</div>
          {s.classroom ? <div className="text-xs text-gray-500">{s.classroom}</div> : null}
        </div>
        <StatusBadge status={s.status} />
      </div>

      {/* Today's timeline */}
      {s.first_check_in_at || s.last_check_out_at ? (
        <div className="mt-2 text-xs text-gray-600 space-y-0.5">
          {s.first_check_in_at ? (
            <div>Checked in at <span className="font-medium">{fmtTime(s.first_check_in_at)}</span></div>
          ) : null}
          {s.last_check_out_at ? (
            <div>
              Picked up at <span className="font-medium">{fmtTime(s.last_check_out_at)}</span>
              {s.picked_up_by_name ? <> by <span className="font-medium">{s.picked_up_by_name}</span></> : null}
              {s.curbside_pickup ? <> · curbside</> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Action button */}
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton status={s.status} studentId={s.id} />
      </div>
    </li>
  );
}

function ActionButton({ status, studentId }: { status: StudentStatus['status']; studentId: string }) {
  if (status === 'not_yet') {
    return (
      <Link
        href={`/attendance/check-in?student_id=${studentId}`}
        className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        style={{ background: 'var(--brand)' }}
      >
        <UserCheck className="h-4 w-4" /> Check in
      </Link>
    );
  }
  if (status === 'present' || status === 'partial') {
    return (
      <Link
        href={`/attendance/check-out?student_id=${studentId}`}
        className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        style={{ background: 'var(--brand)' }}
      >
        <LogOut className="h-4 w-4" /> Check out
      </Link>
    );
  }
  if (status === 'checked_out') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">
        Picked up — done for today
      </span>
    );
  }
  // absent
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-700">
      Marked absent
    </span>
  );
}

function StatusBadge({ status }: { status: StudentStatus['status'] }) {
  const map: Record<StudentStatus['status'], string> = {
    not_yet: 'bg-amber-100 text-amber-800',
    present: 'bg-emerald-100 text-emerald-800',
    checked_out: 'bg-blue-100 text-blue-800',
    absent: 'bg-zinc-200 text-zinc-700',
    partial: 'bg-amber-100 text-amber-800',
  };
  const label: Record<StudentStatus['status'], string> = {
    not_yet: 'Not yet today',
    present: 'Checked in',
    checked_out: 'Picked up',
    absent: 'Absent',
    partial: 'Partial',
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${map[status]}`}>
      {label[status]}
    </span>
  );
}

function todayInTz(tz: string): string {
  // YYYY-MM-DD in the given IANA timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function fmtTime(s: string): string {
  const d = new Date(s);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}
