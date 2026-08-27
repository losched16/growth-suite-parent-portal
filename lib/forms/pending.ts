// What forms does a family still owe? Single source of truth shared by
// the portal home checklist and the automated reminder cron — so the
// email a parent gets and the to-do list they see on login can never
// disagree.
//
// "Fully done" means:
//   - per_student form → every eligible active student has a submission
//   - per_family form  → the family has a submission
// Submissions in status submitted / paid / pending_payment / legacy_imported
// count. Drafts do not.
//
// applies_to targeting (tag_match / tag_exclude / program / grid rules) is
// honored — a form targeted at "pending"-tagged families is not owed by
// everyone else. An open enrollment invite (office push) overrides the
// rule so a pushed form still counts as owed.
//
// Legacy completions (opt-in via honorGhlCompletion): schools that moved
// off an older forms tool (Wooster ← Final Forms) carry per-form
// completion signals as GHL custom-field values on the primary contact
// (`form_<slug>_complete`, `form_<slug>_s<N>`) with NO portal submission
// row. The office tracker already treats those as complete; the reminder
// MUST too or those families get nagged for paperwork they finished.
// The mapping below mirrors PortalFormsTracker/fetcher.ts ghlComplete().

import { query } from '@/lib/db';
import { studentMatchesAppliesTo, type AppliesToContext, type FormAppliesTo } from '@/lib/forms/applies-to';

export interface PendingForm {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  missing_student_ids: string[]; // per_student only
  family_missing: boolean;       // per_family only
  // Office pushed this form to the family (live enrollment_invite):
  // it renders as non-dismissible in the banner.
  pushed: boolean;
}

interface FormRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  applies_to: FormAppliesTo | null;
  submitted_student_ids: string[] | null;
  family_has_any: boolean;
  has_invite: boolean;
}

interface StudentRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

export async function loadPendingForms(opts: {
  schoolId: string;
  familyId: string;
  // When set, per-parent student scoping (parent_student_assignments)
  // limits which students count. Omit for a whole-family view.
  parentId?: string | null;
  honorGhlCompletion?: boolean;
  // When true, only students with an active 'enrolled' enrollment row are
  // considered for per-student forms — a withdrawn sibling doesn't keep the
  // family "owing". Used by the reminder cron; the portal checklist keeps
  // the default (all active students) so a parent can still see/complete
  // anything the office asked for.
  enrolledOnly?: boolean;
}): Promise<PendingForm[]> {
  const { schoolId, familyId } = opts;
  const parentId = opts.parentId ?? null;
  const enrolledOnly = opts.enrolledOnly === true;

  const { rows } = await query<FormRow>(
    `SELECT
       d.id, d.slug, d.display_name, d.description, d.category, d.per_student,
       d.applies_to,
       ARRAY(
         SELECT DISTINCT s.student_id::text
           FROM portal_form_submissions s
          WHERE s.form_definition_id = d.id
            AND s.family_id = $1
            AND s.student_id IS NOT NULL
            AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
            AND COALESCE(s.is_test, false) = false
       ) AS submitted_student_ids,
       EXISTS (
         SELECT 1 FROM portal_form_submissions s
          WHERE s.form_definition_id = d.id
            AND s.family_id = $1
            AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
            AND COALESCE(s.is_test, false) = false
       ) AS family_has_any,
       EXISTS (
         SELECT 1 FROM enrollment_invites i
          WHERE i.form_definition_id = d.id
            AND i.family_id = $1
            AND i.consumed_at IS NULL
            AND i.expires_at > now()
       ) AS has_invite
     FROM portal_form_definitions d
    WHERE d.school_id = $2
      AND d.is_active = true
      AND d.audience IS DISTINCT FROM 'staff'
      -- A form is OWED (yellow Action Items banner + reminders) when:
      --   (a) it's a listed, non-optional checklist form — the default; OR
      --   (b) the office PUSHED it to this family (live enrollment_invite).
      -- (b) is how link-only forms like the New Student Application or a
      -- one-off amendment become "required" for exactly one family:
      -- Leslie sends it, the family's yellow box says the form is
      -- waiting, and nobody else ever sees it (8/26 call).
      AND (
        (COALESCE(d.list_in_checklist, true) = true
         AND COALESCE(d.is_optional, false) = false)
        OR EXISTS (
          SELECT 1 FROM enrollment_invites i
           WHERE i.form_definition_id = d.id
             AND i.family_id = $1
             AND i.consumed_at IS NULL
             AND i.expires_at > now()
        )
      )
      -- Parent dismissals (migration 104): a family that dismissed a
      -- form stops seeing it in the banner AND stops getting reminders.
      -- An office push overrides the dismissal - pushed forms always owe.
      AND (
        NOT EXISTS (
          SELECT 1 FROM portal_form_dismissals fd
           WHERE fd.form_definition_id = d.id AND fd.family_id = $1
        )
        OR EXISTS (
          SELECT 1 FROM enrollment_invites i2
           WHERE i2.form_definition_id = d.id
             AND i2.family_id = $1
             AND i2.consumed_at IS NULL
             AND i2.expires_at > now()
        )
      )
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
  if (rows.length === 0) return [];

  const { rows: activeStudents } = await query<StudentRow>(
    `SELECT id, metadata FROM students WHERE family_id = $1 AND status = 'active'
        AND ($2::uuid IS NULL
             OR NOT EXISTS (SELECT 1 FROM parent_student_assignments psa WHERE psa.parent_id = $2::uuid)
             OR EXISTS (SELECT 1 FROM parent_student_assignments psa
                         WHERE psa.parent_id = $2::uuid AND psa.student_id = students.id))
        AND ($3::boolean = false
             OR EXISTS (SELECT 1 FROM enrollments e
                         WHERE e.student_id = students.id AND e.status = 'enrolled'))
      ORDER BY first_name`,
    [familyId, parentId, enrolledOnly],
  );
  const activeStudentIds = activeStudents.map((s) => s.id);

  // Targeting context — only fetched when at least one form carries a rule.
  const hasRules = rows.some((r) => r.applies_to);
  let familyTags: string[] = [];
  const enrollCtx = new Map<string, { tuitionGridName: string | null; addonKeys: string[] }>();
  const invitesByForm = new Map<string, { familyWide: boolean; studentIds: Set<string> }>();
  if (hasRules) {
    const [tagRows, enrRows, inviteRows] = await Promise.all([
      query<{ tag: string }>(
        `SELECT DISTINCT t.tag FROM ghl_contact_tags t
           JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
          WHERE t.school_id = $1 AND p.family_id = $2 AND p.is_primary = true`,
        [schoolId, familyId],
      ),
      activeStudentIds.length > 0
        ? query<{ student_id: string; tuition_grid_name: string | null; addons: Array<{ key?: string }> | null }>(
            `SELECT fte.student_id, g.display_name AS tuition_grid_name, fte.addons
               FROM family_tuition_enrollments fte
               LEFT JOIN tuition_grids g ON g.id = fte.tuition_grid_id
              WHERE fte.school_id = $1 AND fte.student_id = ANY($2::uuid[])
                AND fte.status = 'active'`,
            [schoolId, activeStudentIds],
          )
        : Promise.resolve({ rows: [] as Array<{ student_id: string; tuition_grid_name: string | null; addons: Array<{ key?: string }> | null }> }),
      query<{ form_definition_id: string; student_id: string | null }>(
        `SELECT form_definition_id, student_id FROM enrollment_invites
          WHERE family_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [familyId],
      ),
    ]);
    familyTags = tagRows.rows.map((t) => t.tag).filter(Boolean);
    for (const e of enrRows.rows) {
      const addons = Array.isArray(e.addons) ? e.addons : [];
      enrollCtx.set(e.student_id, {
        tuitionGridName: e.tuition_grid_name,
        addonKeys: addons.map((a) => a?.key).filter((k): k is string => typeof k === 'string'),
      });
    }
    for (const inv of inviteRows.rows) {
      const entry = invitesByForm.get(inv.form_definition_id)
        ?? { familyWide: false, studentIds: new Set<string>() };
      if (inv.student_id) entry.studentIds.add(inv.student_id);
      else entry.familyWide = true;
      invitesByForm.set(inv.form_definition_id, entry);
    }
  }

  // Legacy GHL-side completion signals (see header). Keyed by field key.
  let ghlKeys: Set<string> | null = null;
  const slotByStudent = new Map<string, number>();
  if (opts.honorGhlCompletion) {
    const { rows: ghlRows } = await query<{ field_key: string }>(
      `SELECT v.field_key
         FROM ghl_contact_field_values v
         JOIN parents p ON p.ghl_contact_id = v.ghl_contact_id AND p.school_id = v.school_id
        WHERE v.school_id = $1 AND p.family_id = $2 AND p.is_primary = true
          AND v.field_key ~ '^form_[a-z0-9_]+(_complete(_s[1-6])?|_s[1-6])$'
          AND v.value IS NOT NULL AND v.value <> ''`,
      [schoolId, familyId],
    );
    ghlKeys = new Set(ghlRows.map((r) => r.field_key));
    for (const s of activeStudents) {
      const slot = Number((s.metadata ?? {})['ghl_slot']);
      if (Number.isInteger(slot) && slot >= 1) slotByStudent.set(s.id, slot);
    }
  }
  const ghlComplete = (slug: string, o: { slot?: number; familyLevel: boolean }): boolean => {
    if (!ghlKeys) return false;
    const k = slug.replace(/-/g, '_');
    if (o.familyLevel) {
      if (ghlKeys.has(`form_${k}_complete`)) return true;
      for (let i = 1; i <= 6; i++) {
        if (ghlKeys.has(`form_${k}_complete_s${i}`) || ghlKeys.has(`form_${k}_s${i}`)) return true;
      }
      return false;
    }
    const slot = o.slot ?? 1;
    return ghlKeys.has(`form_${k}_s${slot}`)
      || ghlKeys.has(`form_${k}_complete_s${slot}`)
      || (slot === 1 && ghlKeys.has(`form_${k}_complete`));
  };

  const studentMatchesRule = (studentId: string, rule: FormAppliesTo): boolean => {
    const s = activeStudents.find((st) => st.id === studentId);
    const enr = enrollCtx.get(studentId);
    const ctx: AppliesToContext = {
      studentId,
      metadata: (s?.metadata ?? {}) as Record<string, unknown>,
      tuitionGridName: enr?.tuitionGridName ?? null,
      enrollmentAddonKeys: enr?.addonKeys ?? [],
      tags: familyTags,
    };
    return studentMatchesAppliesTo(ctx, rule);
  };

  const pending: PendingForm[] = [];
  for (const r of rows) {
    const invite = invitesByForm.get(r.id);
    if (r.per_student) {
      const submitted = new Set(r.submitted_student_ids ?? []);
      const eligible = r.applies_to && !invite?.familyWide
        ? activeStudentIds.filter((sid) => studentMatchesRule(sid, r.applies_to!) || invite?.studentIds.has(sid))
        : activeStudentIds;
      const missing = eligible.filter((sid) =>
        !submitted.has(sid)
        && !ghlComplete(r.slug, { slot: slotByStudent.get(sid), familyLevel: false }),
      );
      if (missing.length > 0) {
        pending.push({
          id: r.id, slug: r.slug, display_name: r.display_name,
          description: r.description, category: r.category,
          per_student: true, missing_student_ids: missing, family_missing: false,
          pushed: r.has_invite,
        });
      }
    } else if (!r.family_has_any && !ghlComplete(r.slug, { familyLevel: true })) {
      if (r.applies_to && !invite) {
        const have = new Set(familyTags.map((t) => t.toLowerCase()));
        const excl = r.applies_to.tag_exclude;
        if (excl?.length && excl.some((t) => have.has(t.toLowerCase()))) continue;
        const want = r.applies_to.tag_match;
        if (want?.length && !want.some((t) => have.has(t.toLowerCase()))) continue;
      }
      pending.push({
        id: r.id, slug: r.slug, display_name: r.display_name,
        description: r.description, category: r.category,
        per_student: false, missing_student_ids: [], family_missing: true,
        pushed: r.has_invite,
      });
    }
  }
  return pending;
}
