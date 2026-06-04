// /settings/pickup-people — family's authorized pickup list.
// Same shape as the onboarding screen (Name + Relationship + optional
// phone). Any parent in the family can add / edit / deactivate any
// entry. Deactivation flips active=false; the row is preserved so
// event history that references it stays intact.
//
// Per-student authorization: each pickup person can be scoped to
// specific students in the family. Empty junction = authorized for
// every student. UI surfaces the kids as checkboxes when adding +
// editing; display row lists the authorized children inline.

import Link from 'next/link';
import { ArrowLeft, UserPlus } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { SetPinControl } from './SetPinControl';
import { EditAuthorizedStudents } from './EditAuthorizedStudents';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ err?: string; msg?: string; new_pin?: string; pin_for?: string }>;

interface StudentLite { id: string; first_name: string; last_name: string; preferred_name: string | null }

interface PickupPersonRow {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
  added_by_first_name: string;
  added_by_last_name: string;
  added_by_self: boolean;
  pin_set_at: string | null;
  pin_expires_at: string | null;
  is_temporary: boolean;
  authorized_student_ids: string[]; // empty array means "all kids in family"
}

export default async function PickupPeoplePage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const sp = await searchParams;

  const { rows } = await query<PickupPersonRow>(
    `SELECT
       pp.id, pp.name, pp.relationship, pp.phone, pp.notes, pp.active,
       p.first_name AS added_by_first_name, p.last_name AS added_by_last_name,
       (pp.added_by_parent_id = $2) AS added_by_self,
       pp.pin_set_at, pp.pin_expires_at, pp.is_temporary,
       COALESCE(
         ARRAY(SELECT student_id::text FROM pickup_person_students pps WHERE pps.pickup_person_id = pp.id),
         ARRAY[]::text[]
       ) AS authorized_student_ids
     FROM pickup_persons pp
     JOIN parents p ON p.id = pp.added_by_parent_id
     WHERE pp.school_id = $1
       AND p.family_id = (SELECT family_id FROM parents WHERE id = $2)
     ORDER BY pp.active DESC, pp.name`,
    [id.parent.school_id, id.parent.id],
  );

  // Family's kids — used to render the per-student checkbox group on
  // the add form and as the lookup table for the display chips.
  const { rows: kids } = await query<StudentLite>(
    `SELECT id, first_name, last_name, preferred_name
       FROM students
      WHERE family_id = (SELECT family_id FROM parents WHERE id = $1)
        AND school_id = $2
        AND status = 'active'
      ORDER BY first_name`,
    [id.parent.id, id.parent.school_id],
  );
  const kidLabel = (s: StudentLite) => `${s.preferred_name?.trim() || s.first_name} ${s.last_name}`.trim();

  const active = rows.filter((r) => r.active);
  const inactive = rows.filter((r) => !r.active);

  return (
    <div className="space-y-5">
      <Link href="/family" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-3 w-3" /> Back to Family
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Authorized pickup people</h1>
        <p className="mt-1 text-sm text-gray-600">
          Anyone listed here can pick up your child. Set a 6-digit PIN for non-parent pickup
          people so they can sign out at the school&rsquo;s pickup kiosk without needing a parent
          portal account.
        </p>
      </header>

      {sp.new_pin && sp.pin_for ? (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-900">
            New PIN — copy it now
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <code className="rounded bg-white px-3 py-1.5 text-2xl font-mono tabular-nums text-amber-900 border border-amber-200">
              {sp.new_pin}
            </code>
            <p className="text-xs text-amber-900">
              Share this PIN with{' '}
              <strong>
                {rows.find((r) => r.id === sp.pin_for)?.name ?? 'them'}
              </strong>. We won&rsquo;t show it again — if you lose it, just generate a new one.
            </p>
          </div>
        </div>
      ) : null}

      {sp.err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
      ) : null}
      {sp.msg ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
      ) : null}

      {/* Active list */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-2 text-sm font-semibold text-gray-900">
          Currently authorized ({active.length})
        </div>
        {active.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 italic">
            No one added yet. Add someone below.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {active.map((p) => (
              <PersonRow key={p.id} person={p} kids={kids} kidLabel={kidLabel} />
            ))}
          </ul>
        )}
      </section>

      {/* Add new */}
      <section className="rounded-lg border-2 border-emerald-200 bg-emerald-50/30 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <UserPlus className="h-4 w-4" style={{ color: 'var(--brand)' }} />
          Add someone new
        </div>
        <form action="/api/attendance/pickup-persons" method="POST" className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Full name *</span>
              <input
                type="text"
                name="name"
                required
                maxLength={120}
                className={inputCls}
                placeholder="e.g. Maria Hernandez"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Relationship *</span>
              <input
                type="text"
                name="relationship"
                required
                maxLength={80}
                className={inputCls}
                placeholder="e.g. Grandmother, Nanny, Aunt"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Phone (optional)</span>
              <input
                type="tel"
                name="phone"
                maxLength={40}
                className={inputCls}
                placeholder="e.g. 480-555-0123"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Notes (optional)</span>
              <input
                type="text"
                name="notes"
                maxLength={200}
                className={inputCls}
                placeholder="e.g. Spanish only, prefers a text 10 min before"
              />
            </label>
          </div>
          {kids.length > 1 ? (
            <fieldset className="mt-2 rounded-md border border-emerald-200 bg-white px-3 py-2">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                Authorized to pick up
              </legend>
              <p className="text-[11px] text-gray-600 mb-1.5">
                Pick which of your children this person can pick up. Leaving every box unchecked means
                <strong> all kids</strong>.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {kids.map((k) => (
                  <label key={k.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="authorized_student_ids"
                      value={k.id}
                      className="h-4 w-4 rounded border-emerald-300"
                    />
                    <span>{kidLabel(k)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            style={{ background: 'var(--brand)' }}
          >
            Add to authorized list
          </button>
        </form>
      </section>

      {/* Deactivated */}
      {inactive.length > 0 ? (
        <details className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <summary className="cursor-pointer text-sm text-gray-600">
            Previously authorized ({inactive.length}) — shown for transparency, no longer selectable
          </summary>
          <ul className="mt-2 divide-y divide-gray-100">
            {inactive.map((p) => (
              <PersonRow key={p.id} person={p} kids={kids} kidLabel={kidLabel} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PersonRow({ person: p, kids, kidLabel }: { person: PickupPersonRow; kids: StudentLite[]; kidLabel: (s: StudentLite) => string }) {
  const hasPin = !!p.pin_set_at;
  const pinExpired = p.pin_expires_at && new Date(p.pin_expires_at) < new Date();
  // Empty junction = all kids. When the parent restricted to specific
  // kids, render their names as small purple chips so the row reads
  // "Grandma Jo — authorized for: Charlie".
  const authorizedKids = p.authorized_student_ids.length === 0
    ? null
    : kids.filter((k) => p.authorized_student_ids.includes(k.id));
  return (
    <li className="px-4 py-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`font-medium ${p.active ? 'text-gray-900' : 'text-gray-500 line-through'}`}>
            {p.name}
          </span>
          <span className="text-xs text-gray-500">· {p.relationship}</span>
          {hasPin && !pinExpired ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
              🔑 PIN active
              {p.is_temporary ? ' · temp' : ''}
            </span>
          ) : hasPin && pinExpired ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              ⚠ PIN expired
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
              No PIN
            </span>
          )}
        </div>
        {kids.length > 1 ? (
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Authorized for:</span>
            {authorizedKids === null ? (
              <span className="inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">All children</span>
            ) : (
              authorizedKids.map((k) => (
                <span key={k.id} className="inline-block rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800">
                  {kidLabel(k)}
                </span>
              ))
            )}
            {p.active ? (
              <EditAuthorizedStudents
                pickupPersonId={p.id}
                kids={kids.map((k) => ({ id: k.id, label: kidLabel(k) }))}
                currentlyAuthorized={p.authorized_student_ids}
              />
            ) : null}
          </div>
        ) : null}
        {p.phone ? <div className="text-[11px] text-gray-600">{p.phone}</div> : null}
        {p.notes ? <div className="text-[11px] text-gray-600">{p.notes}</div> : null}
        {hasPin && p.pin_expires_at ? (
          <div className="text-[10px] text-gray-500">
            PIN expires {new Date(p.pin_expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        ) : null}
        <div className="text-[10px] text-gray-400">
          Added by {p.added_by_self ? 'you' : `${p.added_by_first_name} ${p.added_by_last_name}`}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {p.active ? (
          <>
            <SetPinControl pickupPersonId={p.id} hasExistingPin={hasPin} />
            <form action="/api/attendance/pickup-persons" method="POST">
              <input type="hidden" name="_method" value="DELETE" />
              <input type="hidden" name="id" value={p.id} />
              <button
                type="submit"
                formAction="/api/attendance/pickup-persons?_method=DELETE"
                className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700"
              >
                Deactivate
              </button>
            </form>
          </>
        ) : (
          // Reactivate by patching active=true. Method-override pattern.
          <form action="/api/attendance/pickup-persons?_method=PATCH" method="POST">
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="active" value="1" />
            <button
              type="submit"
              className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-50"
            >
              Reactivate
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200';
