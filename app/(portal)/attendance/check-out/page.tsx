// /attendance/check-out?student_id=... — pick-up flow.
// Two things: who is picking up + sign.
// "Who is picking up" pre-selects Myself; other options are the
// other parent(s) in the family and the family's authorized pickup
// persons (active only).
//
// Curbside is intentionally NOT settable here — DGM (and most schools)
// need to KNOW about curbside in the morning so they can prep the
// dismissal line. The morning check-in form is where it gets set;
// here we just SHOW the parent what they picked at drop-off so they
// know the office already has the heads-up.

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Car } from 'lucide-react';
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

interface OtherParentRow {
  id: string;
  first_name: string;
  last_name: string;
}

interface PickupPersonRow {
  id: string;
  name: string;
  relationship: string;
}

export default async function CheckOutPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;
  const studentId = sp.student_id ?? '';
  if (!studentId) redirect('/attendance');

  const { rows: students } = await query<StudentRow>(
    `SELECT id, family_id, school_id, first_name, last_name, preferred_name
     FROM students WHERE id = $1`,
    [studentId],
  );
  if (students.length === 0) notFound();
  const s = students[0];
  if (s.family_id !== id.parent.family_id || s.school_id !== id.parent.school_id) notFound();

  const displayName = s.preferred_name?.trim()
    ? `${s.preferred_name} ${s.last_name}`
    : `${s.first_name} ${s.last_name}`;

  // Other parents in the family
  const { rows: otherParents } = await query<OtherParentRow>(
    `SELECT id, first_name, last_name FROM parents
     WHERE family_id = $1 AND id <> $2 AND status = 'active'
     ORDER BY is_primary DESC, first_name`,
    [id.parent.family_id, id.parent.id],
  );

  // Authorized pickup persons visible to this family
  const { rows: pickup } = await query<PickupPersonRow>(
    `SELECT pp.id, pp.name, pp.relationship
     FROM pickup_persons pp
     JOIN parents p ON p.id = pp.added_by_parent_id
     WHERE pp.school_id = $1
       AND p.family_id = (SELECT family_id FROM parents WHERE id = $2)
       AND pp.active = true
     ORDER BY pp.name`,
    [id.parent.school_id, id.parent.id],
  );

  // Today's morning check-in event for this student — used to show
  // a read-only "curbside today" indicator on the check-out page.
  // Looks at the most recent check_in within the school's local-day
  // boundary so cross-timezone parents see the right one.
  const { rows: morningRows } = await query<{ curbside: boolean; curbside_slot: string | null }>(
    `SELECT curbside, curbside_slot
       FROM attendance_events
      WHERE student_id = $1
        AND event_type = 'check_in'
        AND (performed_at AT TIME ZONE 'America/Phoenix')::date
              = (now() AT TIME ZONE 'America/Phoenix')::date
      ORDER BY performed_at DESC LIMIT 1`,
    [s.id],
  );
  const morningCurbside = morningRows[0]?.curbside === true;
  const morningSlot = morningRows[0]?.curbside_slot ?? null;

  return (
    <div className="space-y-4">
      <Link href="/attendance" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-3 w-3" /> Back
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Check out {displayName}</h1>
        <p className="mt-1 text-sm text-gray-600">
          Who is picking up today? Pick one and sign.
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
        <input type="hidden" name="event_type" value="check_out" />

        {/* Who is picking up */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-800">Who is picking up?</legend>
          <PickerRow
            value={`me`}
            label={`Myself (${id.parent.first_name})`}
            defaultChecked
          />
          {otherParents.map((p) => (
            <PickerRow
              key={p.id}
              value={`parent:${p.id}`}
              label={`${p.first_name} ${p.last_name}`}
              hint="Other parent"
            />
          ))}
          {pickup.map((p) => (
            <PickerRow
              key={p.id}
              value={`pickup:${p.id}`}
              label={p.name}
              hint={p.relationship}
            />
          ))}
          {otherParents.length + pickup.length === 0 ? (
            <p className="text-[11px] text-gray-500 ml-1">
              You can add other authorized pickup people in <Link href="/settings/pickup-people" className="underline">Settings</Link>.
            </p>
          ) : null}
        </fieldset>

        {/* Curbside (read-only — set at morning check-in so the school
            can prep the dismissal line). We show the parent what they
            already picked at drop-off so they know the front desk
            already has it. The checkbox below is purely cosmetic — the
            actual curbside flag on this check-out event stays false;
            the morning check_in row is the source of truth in queries. */}
        {morningCurbside ? (
          <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-900 flex items-start gap-2">
            <Car className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <strong>Curbside today{morningSlot ? ` — slot ${morningSlot}` : ''}</strong>
              <div className="text-[11px] mt-0.5 text-violet-800">
                You picked this at drop-off this morning, so the school is already prepping for curbside dismissal. To change, talk to the front desk.
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Need curbside dismissal? Curbside is set at <strong>morning check-in</strong> so the school can prep the dismissal line ahead of time. Call the front desk if today&rsquo;s plan changed.
          </div>
        )}

        {/* Notes — optional. Use for "running late", "needs to go home with
            sibling today", med-given timing, mood, etc. Saved on the
            event row and visible to school staff. */}
        <label className="block">
          <span className="text-sm font-medium text-gray-800">Notes for school staff (optional)</span>
          <span className="block text-[11px] text-gray-500 mt-0.5">
            Anything the front desk should know — e.g. mood today, allergy update, who to expect tomorrow.
          </span>
          <textarea
            name="notes"
            rows={2}
            maxLength={500}
            placeholder="e.g. Sleeping a bit rough, please give a quiet morning if you can. Grandpa is picking up tomorrow."
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
          />
        </label>

        {/* Signature */}
        <SignatureCanvasField
          label={`Sign to confirm pick-up for ${displayName}`}
          brandColor="#047857"
        />

        <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
          <button
            type="submit"
            className="rounded-md px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            style={{ background: 'var(--brand)' }}
          >
            Confirm pick-up
          </button>
          <Link href="/attendance" className="text-xs text-gray-500 hover:text-gray-700">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function PickerRow({
  value,
  label,
  hint,
  defaultChecked,
}: {
  value: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
      <input
        type="radio"
        name="picked_up_by"
        value={value}
        defaultChecked={defaultChecked}
        required
        className="h-4 w-4 text-emerald-600 border-gray-300 focus:ring-emerald-500"
      />
      <span className="flex-1">
        <span className="text-gray-900 font-medium">{label}</span>
        {hint ? <span className="ml-2 text-[11px] text-gray-500">— {hint}</span> : null}
      </span>
    </label>
  );
}
