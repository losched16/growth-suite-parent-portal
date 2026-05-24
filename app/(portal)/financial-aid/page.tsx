// /financial-aid — list of this family's FA applications (one per year)
// + entry point to apply for the current year.

import Link from 'next/link';
import { HandCoins, FileText } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface AppRow {
  id: string;
  academic_year: string;
  status: string;
  submitted_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  updated_at: string;
  total_requested: string;
  total_awarded: string | null;
  student_count: number;
  students_summary: string;
}

const DEFAULT_YEAR = '2025-26';

export default async function FinancialAidPage() {
  const id = await requireParent();

  const { rows: apps } = await query<AppRow>(
    `SELECT
       a.id, a.academic_year, a.status,
       a.submitted_at, a.decided_at, a.decision_note, a.updated_at,
       COALESCE(SUM(c.requested_aid), 0)::text AS total_requested,
       SUM(c.recommended_award)::text AS total_awarded,
       COUNT(c.id)::int AS student_count,
       STRING_AGG(s.first_name || ' ' || s.last_name, ', ' ORDER BY s.first_name) AS students_summary
     FROM fa_applications a
     LEFT JOIN fa_application_students c ON c.application_id = a.id
     LEFT JOIN students s ON s.id = c.student_id
     WHERE a.school_id = $1 AND a.family_id = $2 AND a.status <> 'draft'
     GROUP BY a.id
     ORDER BY a.submitted_at DESC NULLS LAST, a.updated_at DESC`,
    [id.parent.school_id, id.parent.family_id],
  );

  const currentYearApp = apps.find((a) => a.academic_year === DEFAULT_YEAR);

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
          <HandCoins className="h-6 w-6" style={{ color: 'var(--brand)' }} />
          Financial Aid
        </div>
        <p className="mt-1 text-sm text-gray-600">
          One application per family per school year covers all your enrolled students.
          Apply once, list each student inside, and the school will respond with a recommended award per student.
        </p>
      </header>

      {/* Current-year CTA */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">{DEFAULT_YEAR} school year</h2>
        {currentYearApp ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-700">
              Your application is <StatusBadge status={currentYearApp.status} />
            </span>
            <Link
              href={`/financial-aid/apply?year=${DEFAULT_YEAR}`}
              className="text-xs text-emerald-700 hover:underline"
            >
              {currentYearApp.status === 'decided' || currentYearApp.status === 'withdrawn'
                ? 'View application →'
                : 'Edit application →'}
            </Link>
          </div>
        ) : (
          <Link
            href={`/financial-aid/apply?year=${DEFAULT_YEAR}`}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            style={{ background: 'var(--brand)' }}
          >
            Start your {DEFAULT_YEAR} application
          </Link>
        )}
        <p className="mt-2 text-[11px] text-gray-500">
          One application covers every student in your household attending the school.
        </p>
      </div>

      {/* Application history */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-900">Your applications</h2>
        {apps.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            No applications submitted yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {apps.map((a) => (
              <ApplicationCard key={a.id} app={a} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ApplicationCard({ app: a }: { app: AppRow }) {
  const requested = Number(a.total_requested ?? 0);
  const award = a.total_awarded === null ? null : Number(a.total_awarded);
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium text-gray-900">School Year {a.academic_year}</div>
          <div className="mt-0.5 text-[11px] text-gray-500">
            {a.student_count} student{a.student_count === 1 ? '' : 's'}: {a.students_summary || '—'}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500">
            {a.submitted_at ? `Submitted ${fmtDate(a.submitted_at)}` : `Last updated ${fmtDate(a.updated_at)}`}
          </div>
        </div>
        <StatusBadge status={a.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Total requested" value={requested > 0 ? fmtMoney(requested) : '—'} />
        <Stat
          label="Total awarded"
          value={award !== null ? fmtMoney(award) : 'Pending'}
          color={award !== null ? '#047857' : undefined}
        />
        <Stat label="Status" value={a.status} />
        <Stat label="Decided" value={a.decided_at ? fmtDate(a.decided_at) : '—'} />
      </div>
      {a.decision_note ? (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <div className="font-semibold flex items-center gap-1"><FileText className="h-3 w-3" /> Note from the school</div>
          <p className="mt-1 whitespace-pre-wrap">{a.decision_note}</p>
        </div>
      ) : null}
    </li>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm font-medium tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'submitted'   ? 'bg-amber-100 text-amber-800' :
    status === 'reviewing'   ? 'bg-blue-100 text-blue-800' :
    status === 'decided'     ? 'bg-emerald-100 text-emerald-800' :
    status === 'withdrawn'   ? 'bg-zinc-200 text-zinc-700' :
                                'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

function fmtDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
