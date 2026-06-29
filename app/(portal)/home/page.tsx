// Home page — concise dashboard for the family. Shows:
//   - greeting + their name
//   - "Pending enrollment forms" banner (when applicable) — top priority
//   - student summary (count + first names)
//   - parents on file
//   - quick links to other sections (Forms, email the office)
// Each section deeper-dives in its own page.

import Link from 'next/link';
import { Users, FileText, Mail, ChevronRight, AlertCircle, ArrowRight } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { PinnedNotices } from './PinnedNotices';

export const dynamic = 'force-dynamic';

interface StudentSummary {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  classroom_name: string | null;
  enrollment_status: string | null;
  // Surfaced so the family can always re-find the grade + Student ID they
  // need for FACTS tuition setup — not just on the post-submit thanks page.
  grade_level: string | null;
  student_id: string | null;
}

interface ParentSummary {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  is_primary: boolean;
}

interface PendingForm {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  // For per-student forms: which students still need to submit?
  missing_student_ids: string[];
  // For per-family forms: just a boolean — true if family hasn't done it.
  family_missing: boolean;
}

export default async function HomePage() {
  const id = await requireParent();
  const familyId = id.family.id;
  const schoolId = id.parent.school_id;

  const [studentRows, parentRows, pendingForms, factsRows] = await Promise.all([
    query<StudentSummary>(
      `SELECT
         s.id, s.first_name, s.last_name, s.preferred_name,
         c.name AS classroom_name,
         e.status AS enrollment_status,
         s.metadata->>'grade_level' AS grade_level,
         s.metadata->>'student_id' AS student_id
       FROM students s
       LEFT JOIN LATERAL (
         SELECT status, classroom_id FROM enrollments e2
         WHERE e2.student_id = s.id
         ORDER BY e2.created_at DESC LIMIT 1
       ) e ON true
       LEFT JOIN classrooms c ON c.id = e.classroom_id
       WHERE s.family_id = $1 AND s.status = 'active'
       ORDER BY s.first_name`,
      [familyId],
    ),
    query<ParentSummary>(
      `SELECT id, first_name, last_name, email, is_primary
       FROM parents
       WHERE family_id = $1 AND status = 'active'
       ORDER BY is_primary DESC, first_name`,
      [familyId],
    ),
    // Active forms this family hasn't submitted yet (this academic year).
    // Categorize by per_student vs. per_family so the banner can show
    // which students still need to be covered.
    loadPendingForms({ schoolId, familyId }),
    // The enrollment form's confirmation message doubles as the school's
    // tuition-setup (FACTS) instructions. We re-show it on Home so a parent
    // who already submitted can come back and find their grade, Student ID,
    // and the payment-portal link any time — not just on the thanks page.
    query<{ confirmation_message: string | null }>(
      `SELECT confirmation_message
         FROM portal_form_definitions
        WHERE school_id = $1 AND is_active = true
          AND confirmation_message IS NOT NULL AND confirmation_message <> ''
        ORDER BY (category = 'enrollment') DESC, updated_at DESC
        LIMIT 1`,
      [schoolId],
    ),
  ]);

  const students = studentRows.rows;
  const parents = parentRows.rows;
  const factsInstructions = factsRows.rows[0]?.confirmation_message ?? null;
  // Only show the FACTS card once the school has actually assigned Student
  // IDs (DGM generates these). Avoids a confusing empty card elsewhere.
  const studentsWithId = students.filter((s) => s.student_id && s.student_id.trim());
  const showFactsCard = factsInstructions != null && studentsWithId.length > 0;
  const studentNames = students
    .map((s) => s.preferred_name || s.first_name)
    .join(', ');

  // Build a quick map studentId → display name so the pending-forms
  // banner can show which kid each row is for.
  const studentNameById = new Map<string, string>();
  for (const s of students) {
    studentNameById.set(s.id, s.preferred_name || s.first_name);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">
          Hi, {id.parent.first_name}.
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {id.family.display_name ?? `${id.parent.last_name} Family`}
          {students.length > 0 ? ` · ${students.length} student${students.length === 1 ? '' : 's'}: ${studentNames}` : ''}
        </p>
      </header>

      {/* Pinned notifications from the school — unmissable, dismissible. */}
      <PinnedNotices />

      {/* PENDING ENROLLMENT FORMS BANNER — top priority. Only renders
          when there's something to do. */}
      {pendingForms.length > 0 ? (
        <section className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-amber-900">
                Pending enrollment forms ({pendingForms.length})
              </h2>
              <p className="mt-0.5 text-sm text-amber-800">
                The school needs you to complete the following form{pendingForms.length === 1 ? '' : 's'}.
                Tap a form to begin — your progress is saved as you go.
              </p>
              <ul className="mt-3 space-y-2">
                {pendingForms.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/forms-v2/${f.slug}`}
                      className="block rounded-md border border-amber-200 bg-white px-3 py-2.5 hover:border-amber-400 hover:shadow-sm transition"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{f.display_name}</div>
                          {f.per_student && f.missing_student_ids.length > 0 ? (
                            <div className="text-[11px] text-amber-700 mt-0.5">
                              Needed for: {f.missing_student_ids
                                .map((sid) => studentNameById.get(sid) ?? 'student')
                                .join(', ')}
                            </div>
                          ) : f.description ? (
                            <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-1">{f.description}</div>
                          ) : null}
                        </div>
                        <ArrowRight className="h-4 w-4 text-amber-600 shrink-0" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {/* Tuition / FACTS setup — persistent so a parent can always come
          back for their child's grade, Student ID, and the payment link. */}
      {showFactsCard ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <h2 className="text-sm font-semibold text-emerald-900">Setting up tuition payments</h2>
          <div className="mt-2 overflow-hidden rounded-md border border-emerald-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-emerald-50 text-left text-[11px] uppercase tracking-wide text-emerald-700">
                <tr>
                  <th className="px-3 py-2 font-medium">Student</th>
                  <th className="px-3 py-2 font-medium">Grade</th>
                  <th className="px-3 py-2 font-medium">Student ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-50">
                {studentsWithId.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2 font-medium text-gray-900">
                      {s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name} {s.last_name}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{s.grade_level || '—'}</td>
                    <td className="px-3 py-2 font-mono text-gray-700">{s.student_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm text-emerald-900">{factsInstructions}</p>
        </section>
      ) : null}

      {/* Quick stats grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Students" value={String(students.length)} href="/family" icon={<Users className="h-4 w-4" />} />
        <SummaryCard label="Parents on file" value={String(parents.length)} href="/family" icon={<Users className="h-4 w-4" />} />
        <SummaryCard label="Forms" value="View status" href="/forms-v2" icon={<FileText className="h-4 w-4" />} />
      </div>

      {/* Students card */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Your students</h2>
          <Link href="/family" className="text-xs hover:underline" style={{ color: 'var(--brand)' }}>
            Manage details →
          </Link>
        </div>
        {students.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No students on file yet. If this looks wrong, contact the school office.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {students.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    {s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name}{' '}
                    {s.last_name}
                  </div>
                  <div className="text-xs text-gray-500">
                    {s.classroom_name ?? 'Unassigned'}
                    {s.grade_level ? ` · Grade ${s.grade_level}` : ''}
                    {s.enrollment_status ? ` · ${s.enrollment_status}` : ''}
                    {s.student_id ? <> · ID <span className="font-mono">{s.student_id}</span></> : null}
                  </div>
                </div>
                <Link href={`/family#student-${s.id}`} className="text-gray-400 hover:text-gray-600">
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Parents card */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Parents on file</h2>
          <Link href="/family" className="text-xs hover:underline" style={{ color: 'var(--brand)' }}>
            Update info →
          </Link>
        </div>
        <ul className="divide-y divide-gray-100">
          {parents.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">
                  {p.first_name} {p.last_name}
                  {p.is_primary ? (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">
                      primary
                    </span>
                  ) : null}
                  {p.id === id.parent.id ? (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
                      you
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-gray-500">{p.email ?? '(no email)'}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Quick links */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <QuickLink
          href="/forms"
          icon={<FileText className="h-5 w-5" />}
          title="Forms & Documents"
          description="See what's pending and submit re-enrollment, emergency cards, and more."
        />
        {id.branding.support_email ? (
          <a
            href={`mailto:${id.branding.support_email}`}
            className="group flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50"
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
              style={{ background: 'var(--brand-soft)', color: 'var(--brand-fg)' }}
            >
              <Mail className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm font-medium text-gray-900">
                Questions? <ChevronRight className="h-3 w-3 text-gray-400 group-hover:text-gray-600" />
              </div>
              <p className="mt-0.5 text-xs text-gray-600">
                Email the school office at {id.branding.support_email} — we&rsquo;re happy to help.
              </p>
            </div>
          </a>
        ) : null}
      </section>
    </div>
  );
}

function SummaryCard({
  label, value, href, icon,
}: {
  label: string; value: string; href: string; icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </Link>
  );
}

function QuickLink({
  href, icon, title, description,
}: {
  href: string; icon: React.ReactNode; title: string; description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:bg-gray-50"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
        style={{ background: 'var(--brand-soft)', color: 'var(--brand-fg)' }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm font-medium text-gray-900">
          {title} <ChevronRight className="h-3 w-3 text-gray-400 group-hover:text-gray-600" />
        </div>
        <p className="mt-0.5 text-xs text-gray-600">{description}</p>
      </div>
    </Link>
  );
}

// Loads the active forms for this school that this family hasn't fully
// submitted yet. "Fully" means:
//   - per_student form  → at least one active student lacks a submission
//   - per_family form   → no submission exists for the family
//
// Submissions in status submitted / paid / pending_payment / legacy_imported
// count as "done." Drafts do not.
async function loadPendingForms({
  schoolId, familyId,
}: { schoolId: string; familyId: string }): Promise<PendingForm[]> {
  const { rows } = await query<{
    id: string;
    slug: string;
    display_name: string;
    description: string | null;
    category: string | null;
    per_student: boolean;
    submitted_student_ids: string[] | null;
    family_has_any: boolean;
  }>(
    `SELECT
       d.id, d.slug, d.display_name, d.description, d.category, d.per_student,
       ARRAY(
         SELECT DISTINCT s.student_id::text
           FROM portal_form_submissions s
          WHERE s.form_definition_id = d.id
            AND s.family_id = $1
            AND s.student_id IS NOT NULL
            AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
       ) AS submitted_student_ids,
       EXISTS (
         SELECT 1 FROM portal_form_submissions s
          WHERE s.form_definition_id = d.id
            AND s.family_id = $1
            AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
       ) AS family_has_any
     FROM portal_form_definitions d
    WHERE d.school_id = $2
      AND d.is_active = true
      -- Staff-facing forms (supply/labor/incident requests) never surface
      -- to parents. IS DISTINCT FROM keeps legacy null-audience forms visible.
      AND d.audience IS DISTINCT FROM 'staff'
      -- On-demand forms (e.g. the Enrollment Amendment) are reachable by link
      -- but are NOT part of the completion checklist.
      AND COALESCE(d.list_in_checklist, true) = true
    ORDER BY
      CASE d.category
        WHEN 'registration' THEN 1
        WHEN 'medical' THEN 2
        WHEN 'permission' THEN 3
        WHEN 'release' THEN 4
        WHEN 'legal' THEN 5
        WHEN 'trip' THEN 6
        ELSE 9
      END,
      d.display_name`,
    [familyId, schoolId],
  );

  // Active students on this family — used to compute missing-student-ids
  // for per-student forms.
  const { rows: activeStudents } = await query<{ id: string }>(
    `SELECT id FROM students WHERE family_id = $1 AND status = 'active'`,
    [familyId],
  );
  const activeStudentIds = activeStudents.map((s) => s.id);

  const pending: PendingForm[] = [];
  for (const r of rows) {
    if (r.per_student) {
      const submitted = new Set(r.submitted_student_ids ?? []);
      const missing = activeStudentIds.filter((sid) => !submitted.has(sid));
      if (missing.length > 0) {
        pending.push({
          id: r.id,
          slug: r.slug,
          display_name: r.display_name,
          description: r.description,
          category: r.category,
          per_student: true,
          missing_student_ids: missing,
          family_missing: false,
        });
      }
    } else if (!r.family_has_any) {
      pending.push({
        id: r.id,
        slug: r.slug,
        display_name: r.display_name,
        description: r.description,
        category: r.category,
        per_student: false,
        missing_student_ids: [],
        family_missing: true,
      });
    }
  }
  return pending;
}
