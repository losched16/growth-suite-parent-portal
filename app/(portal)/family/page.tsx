// /family — the parent's family detail page.
//
// Layout:
//   - Parents grid: one card per parent. Logged-in parent has an editable
//     form inline (first/last/phone). Other parents are read-only.
//   - Students grid: one card per student. Each card has an inline form
//     for parent-editable fields (allergy, emergency contact, etc.).
//     Read-only fields (classroom, status, DOB, IEP/504) are displayed
//     above the form.

import Link from 'next/link';
import { Pencil, ShieldCheck, Phone, Mail, AlertTriangle, Users, ArrowRight, Heart, Lock, UserPlus } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { loadParentsForFamily, loadStudentsForFamily, loadParentStudentAssignments } from '@/lib/family-data';
import { editParentAction } from '@/lib/actions/edit-parent';
import { editStudentAction } from '@/lib/actions/edit-student';
import { addCoParentAction } from '@/lib/actions/add-co-parent';
import { query } from '@/lib/db';
import { loadSchoolSettings } from '@/lib/school-settings';
import type { ParentRow, StudentRow, ParentStudentAssignment } from '@/lib/family-data';

// One row per emergency contact slot — the emergency-medical form
// stores up to 5 family-level contacts in ec1/ec2/ec3/ec4/ec5 fields,
// plus an `additional_emergency_contacts` free-form textarea for any
// overflow beyond that.
interface EmergencyContact {
  slot: number;
  name: string | null;
  phone: string | null;
  relationship: string | null;
  // Student IDs this contact applies to. The special string 'all'
  // (or an empty array) means "every student in the family".
  applies_to: string[];
}

interface EmergencyContactsBundle {
  slots: EmergencyContact[];
  additional: string | null;
  additional_applies_to: string[];
}

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function FamilyPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const { msg, err } = await searchParams;

  const [parents, students, assignments, pickupCount, emergencyContacts, settings] = await Promise.all([
    loadParentsForFamily(id.family.id),
    loadStudentsForFamily(id.family.id),
    loadParentStudentAssignments(id.family.id),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pickup_persons pp
       JOIN parents p ON p.id = pp.added_by_parent_id
       WHERE pp.school_id = $1 AND p.family_id = $2 AND pp.active = true`,
      [id.parent.school_id, id.family.id],
    ).then((r) => Number(r.rows[0]?.count ?? 0)),
    // Pull emergency contacts from the most recent emergency-medical
    // submission. The form is family-level on Wooster and stores up
    // to 5 structured contacts in ecN_name/phone/relationship plus an
    // overflow "additional_emergency_contacts" textarea for any
    // beyond that.
    query<{ responses: Record<string, unknown> }>(
      `SELECT s.responses
         FROM portal_form_submissions s
         JOIN portal_form_definitions d ON d.id = s.form_definition_id
        WHERE s.family_id = $1 AND s.school_id = $2 AND d.slug = 'emergency-medical'
        ORDER BY s.submitted_at DESC LIMIT 1`,
      [id.family.id, id.parent.school_id],
    ).then<EmergencyContactsBundle>((r) => {
      const resp = r.rows[0]?.responses ?? {};
      const slots: EmergencyContact[] = [];
      const readApplies = (key: string): string[] => {
        const v = resp[key];
        if (Array.isArray(v)) return v.map(String);
        return [];
      };
      // Iterate through any ecN_* keys (1..10) — we only have 5 today
      // but the loop is future-proof if we ever extend the form.
      for (let i = 1; i <= 10; i++) {
        const name = typeof resp[`ec${i}_name`] === 'string' ? String(resp[`ec${i}_name`]).trim() : '';
        const phone = typeof resp[`ec${i}_phone`] === 'string' ? String(resp[`ec${i}_phone`]).trim() : '';
        const rel = typeof resp[`ec${i}_relationship`] === 'string' ? String(resp[`ec${i}_relationship`]).trim() : '';
        const applies_to = readApplies(`ec${i}_applies_to`);
        if (name || phone) slots.push({
          slot: i,
          name: name || null,
          phone: phone || null,
          relationship: rel || null,
          applies_to,
        });
      }
      const additional = typeof resp.additional_emergency_contacts === 'string'
        ? String(resp.additional_emergency_contacts).trim() || null
        : null;
      const additional_applies_to = readApplies('additional_emergency_contacts_applies_to');
      return { slots, additional, additional_applies_to };
    }),
    loadSchoolSettings(id.parent.school_id),
  ]);
  // Admissions/office email for the allergies notice (allergy edits are
  // office-vetted for schools with parent_editable_allergies=false).
  const officeEmail = (settings.parent_editable_allergies && settings.parent_editable_family) ? null : (await query<{ e: string | null }>(
    `SELECT COALESCE(NULLIF(btrim(admin_change_notification_email), ''), NULLIF(btrim(support_email), '')) AS e
       FROM school_branding WHERE school_id = $1`,
    [id.parent.school_id],
  )).rows[0]?.e ?? null;


  // Pretty-print "applies to" for the cards. 'all' (or empty after a
  // legacy submission predates the new field) → "All students"; specific
  // IDs → comma-joined preferred/first names.
  function appliesToLabel(ids: string[]): string {
    if (ids.length === 0 || ids.includes('all')) return 'All students';
    const named = ids.map((sid) => {
      const s = students.find((x) => x.id === sid);
      if (!s) return null;
      return s.preferred_name || s.first_name;
    }).filter(Boolean) as string[];
    return named.length === 0 ? 'All students' : named.join(', ');
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">My Family</h1>
        <p className="mt-1 text-sm text-gray-600">
          {id.family.display_name ?? `${id.parent.last_name} Family`} ·{' '}
          {parents.length} parent{parents.length === 1 ? '' : 's'}, {students.length} student{students.length === 1 ? '' : 's'}
        </p>
      </header>

      {msg ? <Banner kind="success">{msg}</Banner> : null}
      {err ? <Banner kind="error">{err}</Banner> : null}

      {/* Parents */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Parents</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {parents.map((p) => {
            const myAssignments = assignments.filter((a) => a.parent_id === p.id);
            return (
              <ParentCard
                key={p.id}
                parent={p}
                isMe={p.id === id.parent.id}
                students={students}
                assignments={myAssignments}
                editable={settings.parent_editable_family}
                officeEmail={officeEmail}
              />
            );
          })}
        </div>
        {/* Quick context for divorced / separated families using the
            privacy toggle — surfaces only when at least one co-parent
            in the family has flagged themselves private, so most
            families never see it. */}
        {parents.some((p) => p.is_private_from_co_parents && p.id !== id.parent.id) ? (
          <p className="mt-2 text-[11px] text-gray-500 flex items-center gap-1">
            <Lock className="h-3 w-3 text-gray-400" />
            A co-parent in your family has chosen to keep their contact info private from you.
            School staff still see their full record.
          </p>
        ) : null}

        <AddCoParent />
      </section>

      {/* Students */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Students</h2>
        {students.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
            No students on file. If this looks wrong, contact the school office.
          </div>
        ) : (
          <div className="space-y-4">
            {students.map((s) => <StudentCard key={s.id} student={s} allergiesEditable={settings.parent_editable_allergies} familyEditable={settings.parent_editable_family} officeEmail={officeEmail} />)}
          </div>
        )}
      </section>

      {/* Emergency Contacts — surfaces the family's ec1/ec2/ec3 from
          the most recent emergency-medical form submission. Linked to
          the form so parents can edit / add more (up to 3). Rachel
          Kilgore reported on her test call that she couldn't find a
          spot to add additional emergency contacts on the Family page;
          this card fixes that. */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Emergency Contacts
        </h2>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-50 text-rose-600 shrink-0">
                <Heart className="h-4 w-4" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900">
                  {emergencyContacts.slots.length === 0 && !emergencyContacts.additional
                    ? 'No emergency contacts on file yet'
                    : `${emergencyContacts.slots.length} emergency contact${emergencyContacts.slots.length === 1 ? '' : 's'} on file${emergencyContacts.additional ? ' (+ extras)' : ''}`}
                </div>
                <div className="mt-0.5 text-xs text-gray-600">
                  {settings.parent_editable_family
                    ? 'Up to five structured contacts who can be reached if we can’t get to you, plus a free-form section for any extras. Stored on your Emergency Medical form.'
                    : 'People we can reach if we can’t get to you.'}
                </div>
                {!settings.parent_editable_family ? (
                  <p className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-800">
                    To add or update emergency contacts or authorized pickup people, please contact
                    admissions{officeEmail ? (
                      <> at <a href={`mailto:${officeEmail}`} className="font-medium underline">{officeEmail}</a></>
                    ) : null}.
                  </p>
                ) : null}
              </div>
            </div>
            {settings.parent_editable_family ? (
            <Link
              href="/forms-v2/emergency-medical"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-white whitespace-nowrap"
              style={{ background: 'var(--brand)' }}
            >
              {emergencyContacts.slots.length === 0 ? 'Add contacts' : 'Edit / add more'}
            </Link>
            ) : null}
          </div>
          {emergencyContacts.slots.length > 0 || emergencyContacts.additional ? (
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {emergencyContacts.slots.map((ec) => (
                <li key={ec.slot} className="rounded-md border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
                    Contact #{ec.slot}
                  </div>
                  <div className="mt-0.5 font-medium text-gray-900 truncate">{ec.name ?? '(no name)'}</div>
                  {ec.relationship ? (
                    <div className="text-[11px] text-gray-500 italic">{ec.relationship}</div>
                  ) : null}
                  {ec.phone ? (
                    <a href={`tel:${ec.phone}`} className="mt-0.5 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                      <Phone className="h-3 w-3" />{ec.phone}
                    </a>
                  ) : null}
                  <div className="mt-1 text-[10px] text-gray-600">
                    <span className="font-medium">For:</span> {appliesToLabel(ec.applies_to)}
                  </div>
                </li>
              ))}
              {/* Empty placeholder card prompting them to add one more
                  (capped at 3 placeholders to keep the grid tidy). */}
              {settings.parent_editable_family ? Array.from({ length: Math.max(0, 3 - emergencyContacts.slots.length) }).map((_, i) => {
                const nextSlot = emergencyContacts.slots.length + i + 1;
                return (
                  <li key={`empty-${nextSlot}`} className="rounded-md border-2 border-dashed border-gray-200 bg-white px-3 py-2 text-xs text-gray-400 italic">
                    Contact #{nextSlot} — empty.{' '}
                    <Link href="/forms-v2/emergency-medical" className="not-italic font-medium text-gray-600 hover:underline">
                      add →
                    </Link>
                  </li>
                );
              }) : null}
              {emergencyContacts.additional ? (
                <li className="rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm sm:col-span-2 md:col-span-3">
                  <div className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
                    Additional contacts (free-form)
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap text-gray-800 text-xs">
                    {emergencyContacts.additional}
                  </div>
                  <div className="mt-1 text-[10px] text-amber-800">
                    <span className="font-medium">For:</span> {appliesToLabel(emergencyContacts.additional_applies_to)}
                  </div>
                </li>
              ) : null}
            </ul>
          ) : null}
          {emergencyContacts.slots.length >= 3 && !emergencyContacts.additional ? (
            <p className="mt-3 text-[11px] text-gray-500">
              Need to add more than three? The form supports up to five structured contacts,
              plus a free-form section for any extras. <Link href="/forms-v2/emergency-medical" className="text-emerald-700 underline hover:text-emerald-800">Add more →</Link>
            </p>
          ) : null}
        </div>
      </section>

      {/* Authorized Pickup People */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Authorized Pickup People
        </h2>
        <Link
          href="/settings/pickup-people"
          className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50"
        >
          <div className="flex items-start gap-3">
            <Users className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-gray-900">
                Manage who can pick up your students
              </div>
              <div className="mt-0.5 text-xs text-gray-600">
                Separate from emergency contacts. {settings.parent_managed_pickups
                  ? 'Add grandparents, nannies, or family friends who are authorized to come pick up your children from school.'
                  : 'See who is authorized to pick up your children, and manage their kiosk PINs. New people are added by the school office.'}
              </div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--brand-fg)' }}>
                {pickupCount === 0
                  ? (settings.parent_managed_pickups ? 'None added yet · tap to add someone' : 'None on the list yet · tap to view')
                  : `${pickupCount} ${pickupCount === 1 ? 'person' : 'people'} authorized · tap to ${settings.parent_managed_pickups ? 'edit' : 'view'}`}
              </div>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-gray-400" />
        </Link>
      </section>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  const cls = kind === 'success'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-red-200 bg-red-50 text-red-800';
  return <div className={`rounded-md border ${cls} px-3 py-2 text-sm`}>{children}</div>;
}

function ParentCard({
  parent, isMe, students, assignments, editable, officeEmail,
}: {
  parent: ParentRow;
  isMe: boolean;
  students: StudentRow[];
  // Assignment rows for THIS parent. Empty → applies to every kid in
  // the family (the back-compat default).
  assignments: ParentStudentAssignment[];
  editable: boolean;
  officeEmail: string | null;
}) {
  // Render the per-student assignment summary. Always at least
  // "applies to all" — never blank.
  function assignmentLabel(): string {
    if (assignments.length === 0) return `All children (${students.length})`;
    const named = assignments.map((a) => {
      const s = students.find((x) => x.id === a.student_id);
      if (!s) return null;
      return s.preferred_name || s.first_name;
    }).filter(Boolean) as string[];
    if (named.length === 0) return `All children (${students.length})`;
    return named.join(', ');
  }

  // Office-managed schools: every parent card is read-only — changes go
  // through the office so the CRM stays the source of truth.
  if (!editable) {
    return (
      <article className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm font-medium text-gray-900">
          {parent.first_name} {parent.last_name}{isMe ? ' (you)' : ''}
          {parent.is_primary ? <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-800">primary</span> : null}
        </div>
        <div className="mt-1 space-y-0.5 text-[12px] text-gray-600">
          <div><Mail className="mr-1 inline-block h-3 w-3" />{parent.email ?? '(no email)'}</div>
          {parent.phone ? <div><Phone className="mr-1 inline-block h-3 w-3" />{parent.phone}</div> : null}
          <div className="text-[11px] text-gray-500">Parent of: {assignmentLabel()}</div>
        </div>
        {isMe ? (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-800">
            To update your contact information, please contact the school office{officeEmail ? (
              <> at <a href={`mailto:${officeEmail}`} className="font-medium underline">{officeEmail}</a></>
            ) : null}.
          </p>
        ) : null}
      </article>
    );
  }

  if (isMe) {
    return (
      <form
        action={editParentAction}
        className="rounded-lg border border-gray-200 bg-white p-4"
      >
        <input type="hidden" name="parent_id" value={parent.id} />
        <div className="mb-3 flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full"
                style={{ background: 'var(--brand-soft)', color: 'var(--brand-fg)' }}>
            <Pencil className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900">You</div>
            <div className="text-[11px] text-gray-500">Edit your contact info — saves to the school&apos;s records.</div>
          </div>
        </div>
        <div className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">First name</span>
              <input
                name="first_name"
                defaultValue={parent.first_name}
                required
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Last name</span>
              <input
                name="last_name"
                defaultValue={parent.last_name}
                required
                className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Phone</span>
            <input
              name="phone"
              type="tel"
              defaultValue={parent.phone ?? ''}
              placeholder="(optional)"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <div className="text-[11px] text-gray-500">
            <Mail className="mr-1 inline-block h-3 w-3" />
            {parent.email ?? '(no email)'} <span className="ml-1 text-gray-400">· can&apos;t change here (it&apos;s your sign-in)</span>
          </div>
        </div>

        {/* Per-student assignment picker. Lets a parent narrow their
            scope to specific kids in the family (e.g. blended family
            where one parent is biological to kid A and stepparent to
            kid B). Hidden default "all" sentinel ensures the action
            can distinguish "applies to all" from "no submission yet". */}
        {students.length > 1 ? (
          <div className="mt-3 rounded-md border border-gray-200 bg-gray-50/40 px-3 py-2">
            <div className="text-sm font-medium text-gray-900 mb-1">
              I&rsquo;m a parent of:
            </div>
            <p className="text-[11px] text-gray-600 mb-2">
              Default is every child in your family. Untick &ldquo;All&rdquo; to scope to
              specific kids — useful for blended or step-family setups.
            </p>
            <label className="flex items-center gap-2 text-sm font-medium mb-1">
              <input
                type="checkbox"
                name="assigned_students[]"
                value="all"
                defaultChecked={assignments.length === 0}
                className="h-4 w-4 rounded border-gray-300 peer/all"
              />
              <span>All children ({students.length})</span>
            </label>
            <div className="ml-6 space-y-1 peer-checked/all:opacity-50">
              {students.map((s) => {
                const display = s.preferred_name || s.first_name;
                const checked = assignments.some((a) => a.student_id === s.id);
                return (
                  <label key={s.id} className="flex items-center gap-2 text-sm peer-checked/all:pointer-events-none">
                    <input
                      type="checkbox"
                      name="assigned_students[]"
                      value={s.id}
                      defaultChecked={checked && assignments.length > 0}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    {display} {s.last_name}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Privacy toggle for divorced / separated families.
            Hidden field is required so an unchecked box still gets
            written through as "false" (otherwise FormData would omit
            it entirely and we'd never flip it back off). */}
        <div className={`mt-3 rounded-md border px-3 py-2 ${parent.is_private_from_co_parents ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50/40'}`}>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              name="is_private_from_co_parents"
              value="1"
              defaultChecked={parent.is_private_from_co_parents}
              className="mt-0.5 h-4 w-4 rounded border-gray-300"
            />
            <span>
              <span className="font-medium text-gray-900 flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Keep my contact info private from the other parent(s)
              </span>
              <span className="block text-[11px] text-gray-600 mt-0.5">
                For divorced / separated families. When on, other parents in this family
                can&rsquo;t see or overwrite your phone, email, or other contact details.
                School staff always see your full record.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--brand)' }}
          >
            Save my info
          </button>
        </div>
      </form>
    );
  }

  // Co-parent view. When the other parent has marked themselves
  // private, we mask their email + phone. Their name, role, and
  // primary-parent flag stay visible — those are operationally needed
  // (the viewer should still know "Charlie has a co-parent named X").
  const masked = parent.is_private_from_co_parents;
  return (
    <div className={`rounded-lg border bg-white p-4 ${masked ? 'border-amber-200' : 'border-gray-200'}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900">
            {parent.first_name} {parent.last_name}
            {parent.is_primary ? (
              <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">
                primary
              </span>
            ) : null}
            {masked ? (
              <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                <Lock className="h-2.5 w-2.5" /> private
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-gray-500">{parent.role}</div>
        </div>
      </div>
      {masked ? (
        <div className="rounded-md bg-amber-50/60 border border-amber-200 px-2 py-1.5 text-[11px] text-amber-900">
          {parent.first_name} has chosen to keep their contact info private.
          The school office can still reach them directly — contact the school if you need to.
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-1.5 text-gray-700">
            <Mail className="h-3 w-3 shrink-0 text-gray-400" />
            <span className="truncate">{parent.email ?? '(no email)'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-700">
            <Phone className="h-3 w-3 shrink-0 text-gray-400" />
            <span>{parent.phone ?? '—'}</span>
          </div>
        </div>
      )}
      {/* Co-parent's per-student assignment, if anything is set. We
          deliberately render this even when the parent has chosen
          "All" (assignments empty) — it's reassuring context for the
          viewer to know who the other parent applies to. */}
      {students.length > 1 ? (
        <div className="mt-2 text-[11px] text-gray-600">
          <span className="font-medium">Parent of:</span> {assignmentLabel()}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-400">
        Only {parent.first_name} can edit their own record.
      </p>
    </div>
  );
}

function StudentCard({ student, allergiesEditable, familyEditable, officeEmail }: { student: StudentRow; allergiesEditable: boolean; familyEditable: boolean; officeEmail: string | null }) {
  const md = student.metadata;
  const allergy = (md.allergy as string) ?? '';
  const allergyNotes = (md.allergyNotes as string) ?? '';
  const emergency = (md.emergencyFirstContact as string) ?? '';
  const hcp = (md.healthCareProvider as string) ?? '';
  const hcpPhone = (md.healthCareProviderPhone as string) ?? '';
  const iep = (md.iep as string) ?? '';
  const five04 = (md.five04_plan as string) ?? '';

  const hasAllergy = allergy && allergy.toLowerCase() !== 'no' && allergy.toLowerCase() !== 'none';

  return (
    <article className="overflow-hidden rounded-lg border border-gray-200 bg-white" id={`student-${student.id}`}>
      {/* Header — read-only school-managed info */}
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-gray-900">
            {student.preferred_name ? `${student.preferred_name} (${student.first_name})` : student.first_name}{' '}
            {student.last_name}
          </h3>
          {student.enrollment_status ? (
            <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
              {student.enrollment_status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-4">
          <Field label="DOB" value={fmtDate(student.date_of_birth)} />
          <Field label="Age" value={ageFrom(student.date_of_birth)} />
          <Field label="Classroom" value={student.classroom_name ?? '—'} />
          <Field label="Teacher" value={student.lead_teacher_name ?? '—'} />
          <Field label="Schedule" value={student.schedule ?? '—'} />
          <Field label="Year" value={student.academic_year ?? '—'} />
          <Field label="IEP" value={iep || '—'} highlight={!!iep && iep.toLowerCase() !== 'no'} />
          <Field label="504" value={five04 || '—'} highlight={!!five04 && five04.toLowerCase() !== 'no'} />
        </div>
        {hasAllergy ? (
          <div className="mt-2 inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-800">
            <AlertTriangle className="h-3 w-3" /> Allergy on file
          </div>
        ) : null}
      </div>

      {/* Office-managed schools: health/emergency info is read-only. */}
      {!familyEditable ? (
        <div className="space-y-2 p-4 text-sm">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Allergies on file</div>
              <div className="text-sm text-gray-900">{allergy || '—'}{allergyNotes ? ` — ${allergyNotes}` : ''}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Health care provider</div>
              <div className="text-sm text-gray-900">{hcp || '—'}{hcpPhone ? ` · ${hcpPhone}` : ''}</div>
            </div>
          </div>
          <p className="rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-800">
            Please contact our admissions coordinator{officeEmail ? (
              <> at <a href={`mailto:${officeEmail}`} className="font-medium underline">{officeEmail}</a></>
            ) : null} to update your student&rsquo;s information.
          </p>
        </div>
      ) : (
      <form action={editStudentAction} className="space-y-3 p-4 text-sm">
        <input type="hidden" name="student_id" value={student.id} />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {allergiesEditable ? (
          <>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Allergies (yes/no/none)</span>
            <input
              name="allergy"
              defaultValue={allergy}
              placeholder="e.g. peanuts, none"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Allergy notes / details</span>
            <input
              name="allergy_notes"
              defaultValue={allergyNotes}
              placeholder="(severity, treatment, etc.)"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          </>
          ) : (
          <div className="md:col-span-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Allergies on file</div>
            <div className="mt-0.5 text-sm text-gray-900">{allergy || '—'}{allergyNotes ? ` — ${allergyNotes}` : ''}</div>
            <p className="mt-1 text-[11px] text-amber-800">
              Please contact our admissions coordinator{officeEmail ? (
                <> at <a href={`mailto:${officeEmail}`} className="font-medium underline">{officeEmail}</a></>
              ) : null} if you would like to update your student&rsquo;s allergy information.
            </p>
          </div>
          )}
          {/* Emergency contacts intentionally NOT shown per-student
              here — they're family-level on the new Emergency Contacts
              card above (which supports up to 3). Keeping the legacy
              field value behind the form so existing data survives a
              save, but hiding the input to avoid the confusion Rachel
              hit ("only one emergency contact"). */}
          <input type="hidden" name="emergency_first_contact" defaultValue={emergency} />
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Health care provider</span>
            <input
              name="health_care_provider"
              defaultValue={hcp}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Provider phone</span>
            <input
              name="health_care_provider_phone"
              type="tel"
              defaultValue={hcpPhone}
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-gray-100 pt-3">
          <p className="text-[11px] text-gray-500">
            Saves directly to the school&apos;s records. Updates appear in school dashboards immediately.
          </p>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--brand)' }}
          >
            Save changes
          </button>
        </div>
      </form>
      )}
    </article>
  );
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>{' '}
      <span className={highlight ? 'font-medium text-amber-700' : 'text-gray-700'}>{value}</span>
    </div>
  );
}

// "Add another parent" form. Family-record completeness — only first
// and last name are required. Email + portal access are optional add-ons.
// Native <details> for no-JS disclosure.
function AddCoParent() {
  return (
    <details className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-gray-800 hover:bg-gray-50">
        <UserPlus className="h-4 w-4 text-gray-500" />
        Add another parent
        <span className="ml-1 text-[11px] font-normal text-gray-500">
          — list a spouse, partner, or other parent on your family record
        </span>
      </summary>
      <form action={addCoParentAction} className="space-y-3 border-t border-gray-100 p-4 text-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">First name *</span>
            <input
              name="first_name"
              required
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Last name *</span>
            <input
              name="last_name"
              required
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Phone</span>
            <input
              name="phone"
              type="tel"
              placeholder="(optional)"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">Role</span>
            <select
              name="role"
              defaultValue="parent"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none bg-white"
            >
              <option value="parent">Parent</option>
              <option value="guardian">Guardian</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/40 p-3 space-y-2">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-gray-600">
              Email <span className="font-normal text-gray-400">(optional — only needed if they want portal access)</span>
            </span>
            <input
              name="email"
              type="email"
              placeholder="leave blank to just list them"
              className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="flex items-start gap-2 text-[12px] text-gray-700">
            <input
              type="checkbox"
              name="send_invite"
              value="1"
              className="mt-0.5 h-4 w-4 rounded border-gray-300"
            />
            <span>
              Email them a sign-in link so they can access the portal too. Leave unchecked
              to just list them on your record.
            </span>
          </label>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 pt-3">
          <p className="text-[11px] text-gray-500">
            Updates your family record at the school. School staff see the update right away.
          </p>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: 'var(--brand)' }}
          >
            Add to family record
          </button>
        </div>
      </form>
    </details>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ageFrom(dob: string | null): string {
  if (!dob) return '—';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  let mos = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) mos--;
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs >= 1) return `${yrs}y ${Math.max(0, mos)}m`;
  return `${Math.max(0, mos)}m`;
}
