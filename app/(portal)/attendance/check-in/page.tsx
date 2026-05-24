// /attendance/check-in?student_id=... — drop-off flow.
// Two things: confirm which student you're dropping, and sign.

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { SignatureCanvasField } from '../_signature-canvas';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ student_id?: string; err?: string }>;

interface StudentRow {
  id: string;
  family_id: string;
  school_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
}

export default async function CheckInPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;
  const studentId = sp.student_id ?? '';
  if (!studentId) redirect('/attendance');

  const { rows } = await query<StudentRow>(
    `SELECT id, family_id, school_id, first_name, last_name, preferred_name
     FROM students WHERE id = $1`,
    [studentId],
  );
  if (rows.length === 0) notFound();
  const s = rows[0];
  if (s.family_id !== id.parent.family_id || s.school_id !== id.parent.school_id) notFound();

  const displayName = s.preferred_name?.trim()
    ? `${s.preferred_name} ${s.last_name}`
    : `${s.first_name} ${s.last_name}`;

  return (
    <div className="space-y-4">
      <Link href="/attendance" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-3 w-3" /> Back
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Check in {displayName}</h1>
        <p className="mt-1 text-sm text-gray-600">
          Confirm by signing below. We&apos;ll record the time as your drop-off.
        </p>
      </header>

      {sp.err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
      ) : null}

      <form
        action="/api/attendance/event"
        method="POST"
        className="space-y-4 rounded-lg border border-gray-200 bg-white p-4"
      >
        <input type="hidden" name="student_id" value={s.id} />
        <input type="hidden" name="event_type" value="check_in" />

        {/* Notes — optional. Saved on the event row and visible to staff. */}
        <label className="block">
          <span className="text-sm font-medium text-gray-800">Notes for school staff (optional)</span>
          <span className="block text-[11px] text-gray-500 mt-0.5">
            Anything the teacher should know — late breakfast, slept poorly, new medication, etc.
          </span>
          <textarea
            name="notes"
            rows={2}
            maxLength={500}
            placeholder="e.g. Didn't sleep well last night — please go easy on her this morning."
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
          />
        </label>

        {/* Curbside pickup intent. Flagged in the morning so teachers can
            see at a glance who's curbside before dismissal. The slot
            number is what the parent gets given when they pull up — they
            type it here so the teacher can match. */}
        <fieldset className="rounded-md border border-violet-200 bg-violet-50/30 p-3 space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="curbside"
              value="1"
              className="mt-0.5 h-4 w-4 rounded border-violet-300"
            />
            <span>
              <strong>Curbside pickup today</strong>
              <span className="block text-[11px] text-gray-600 mt-0.5">
                Check if you&apos;ll be picking up at the curb (no walking in). Teachers will get the heads-up.
              </span>
            </span>
          </label>
          <label className="block ml-6">
            <span className="text-[11px] uppercase tracking-wide text-gray-600">Slot # (optional)</span>
            <input
              type="text"
              name="curbside_slot"
              maxLength={16}
              placeholder="e.g. 3"
              className="mt-0.5 block w-32 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-200"
            />
            <span className="block text-[10px] text-gray-500 mt-0.5">
              If your school assigns parking slots, enter yours so the teacher can walk your student out to the right car.
            </span>
          </label>
        </fieldset>

        <SignatureCanvasField
          label={`Sign to confirm drop-off for ${displayName}`}
          brandColor="#047857"
        />

        <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
          <button
            type="submit"
            className="rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            style={{ background: 'var(--brand)' }}
          >
            Confirm drop-off
          </button>
          <Link href="/attendance" className="text-xs text-gray-500 hover:text-gray-700">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
