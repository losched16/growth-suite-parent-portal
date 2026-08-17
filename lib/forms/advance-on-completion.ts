// Per-STUDENT advance-on-completion. When a form submission lands, check
// each student in the family individually: a student is "ready to
// enroll" when every active per-student form has a submission for THEM
// and every family-level form has a family submission. For each ready
// student:
//
//   1. Write student_[N_]enrollment_status = 'enrolled' on the primary
//      parent's GHL contact (N = the student's GHL slot). The sync then
//      flows it into enrollments.status → dashboards update per student.
//   2. Move THAT student's opportunity card (matched by card name) from
//      the school's source stage to its target stage. Sibling cards stay
//      put until their own forms are done.
//   3. Apply the school's enrollment tag to the parents (fires on the
//      first ready student — the family now belongs on enrolled-scoped
//      views).
//
// Card ↔ student name matching (Wooster convention: cards are named
// after the student):
//   - exact "first last" match (case/whitespace-insensitive), else
//   - a card whose name starts with the student's first name, IF no
//     other student in the family shares that first name and only one
//     card matches. Anything ambiguous or misspelled is SKIPPED with a
//     warning — never guess. The office fixes the card name in GHL and
//     the next submission (or backfill run) picks it up.
//
// All levers are per-school via school_branding (migration 012):
// enrollment_tag, pipeline_move_from_stage, pipeline_move_to_stage.
// NULL/empty → that lever is off. The status-field write additionally
// requires the school's field schema to map enrollmentStatus.
//
// Idempotent: re-writing the same field value, re-applying a tag, and
// re-moving an already-moved card are all no-ops.

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';

interface FormRow { id: string; per_student: boolean }
interface StudentRow {
  id: string;
  first_name: string;
  last_name: string;
  ghl_slot: number | null;
}
interface SubRow { form_definition_id: string; student_id: string | null }

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Which students in the family are fully complete? Returns [] when the
// school has no active forms or the family has no active students.
async function completedStudents(schoolId: string, familyId: string): Promise<StudentRow[]> {
  const { rows: forms } = await query<FormRow>(
    `SELECT id, per_student
       FROM portal_form_definitions
      WHERE school_id = $1
        AND is_active = true
        AND COALESCE(audience, 'parents') = 'parents'`,
    [schoolId],
  );
  if (forms.length === 0) return [];

  const { rows: students } = await query<StudentRow>(
    `SELECT id, first_name, last_name,
            NULLIF(metadata->>'ghl_slot','')::int AS ghl_slot
       FROM students
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'`,
    [schoolId, familyId],
  );
  if (students.length === 0) return [];
  const studentIds = students.map((s) => s.id);

  const { rows: subs } = await query<SubRow>(
    `SELECT form_definition_id, student_id
       FROM portal_form_submissions
      WHERE school_id = $1
        AND COALESCE(is_test, false) = false
        AND status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        AND (family_id = $2 OR student_id = ANY($3::uuid[]))`,
    [schoolId, familyId, studentIds],
  );

  const familySubs = new Set<string>();
  const studentSubs = new Set<string>();
  for (const s of subs) {
    if (s.student_id) studentSubs.add(`${s.form_definition_id}|${s.student_id}`);
    else familySubs.add(s.form_definition_id);
  }

  // Family-level forms are shared prerequisites for every student.
  const familyFormsDone = forms
    .filter((f) => !f.per_student)
    .every((f) => familySubs.has(f.id));
  if (!familyFormsDone) return [];

  const perStudentForms = forms.filter((f) => f.per_student);
  return students.filter((st) =>
    perStudentForms.every((f) => studentSubs.has(`${f.id}|${st.id}`)),
  );
}

interface AdvanceConfig {
  enrollment_tag: string | null;
  pipeline_move_from_stage: string | null;
  pipeline_move_to_stage: string | null;
}

interface LiveOpp {
  id: string;
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
}

export interface AdvanceResult {
  ran: boolean;
  reason?: string;
  students_ready?: number;
  status_fields_written?: number;
  tag_applied_to?: number;
  opportunities_moved?: number;
  errors: string[];
}

export async function maybeAdvanceOnCompletion(opts: {
  schoolId: string;
  familyId: string;
}): Promise<AdvanceResult> {
  const errors: string[] = [];

  const { rows: brandingRows } = await query<AdvanceConfig>(
    `SELECT enrollment_tag, pipeline_move_from_stage, pipeline_move_to_stage
       FROM school_branding WHERE school_id = $1`,
    [opts.schoolId],
  );
  const cfg = brandingRows[0] ?? {
    enrollment_tag: null, pipeline_move_from_stage: null, pipeline_move_to_stage: null,
  };
  const enrollmentTag = (cfg.enrollment_tag ?? '').trim() || null;
  const fromStage = (cfg.pipeline_move_from_stage ?? '').trim() || null;
  const toStage = (cfg.pipeline_move_to_stage ?? '').trim() || null;

  // Status-field lever: on iff the school's field schema maps enrollmentStatus.
  const { rows: schemaRows } = await query<{ base: string | null }>(
    `SELECT student_fields->>'enrollmentStatus' AS base
       FROM school_field_schemas WHERE school_id = $1`,
    [opts.schoolId],
  );
  const statusBase = (schemaRows[0]?.base ?? '').trim() || null;

  if (!enrollmentTag && !(fromStage && toStage) && !statusBase) {
    return { ran: false, reason: 'no_advance_config', errors };
  }

  const ready = await completedStudents(opts.schoolId, opts.familyId);
  if (ready.length === 0) return { ran: false, reason: 'no_students_complete', errors };

  const { rows: primary } = await query<{ ghl_contact_id: string }>(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND family_id = $2 AND is_primary = true
        AND ghl_contact_id IS NOT NULL LIMIT 1`,
    [opts.schoolId, opts.familyId],
  );
  if (primary.length === 0) {
    return { ran: false, reason: 'no_primary_parent_with_ghl_contact', errors };
  }
  const contactId = primary[0].ghl_contact_id;

  let client: GhlClient;
  try {
    client = await loadGhlClient(opts.schoolId);
  } catch (e) {
    return { ran: false, reason: 'ghl_client_load_failed', errors: [String(e)] };
  }

  // ── 1. Per-student enrollment-status field writes ──────────────────
  let fieldsWritten = 0;
  if (statusBase) {
    // Resolve slot → field id from the location's field list. Slot 1 is
    // the bare key (student_enrollment_status), slots 2+ are prefixed.
    try {
      const res = await client.axios.get(`/locations/${client.locationId}/customFields`, {
        params: { model: 'contact' },
      });
      const fields: Array<{ id: string; fieldKey?: string }> = res.data.customFields ?? [];
      const idByKey = new Map(fields.map((f) => [String(f.fieldKey ?? '').replace(/^contact\./, ''), f.id]));
      const slotKey = (slot: number) => (slot === 1 ? `student_${statusBase}` : `student_${slot}_${statusBase}`);

      const updates: Array<{ id: string; value: string }> = [];
      for (const st of ready) {
        if (!st.ghl_slot) { errors.push(`no ghl_slot for student ${st.first_name} ${st.last_name} — status field skipped`); continue; }
        const fid = idByKey.get(slotKey(st.ghl_slot));
        if (!fid) { errors.push(`field ${slotKey(st.ghl_slot)} not found on location — status field skipped`); continue; }
        updates.push({ id: fid, value: 'enrolled' });
      }
      if (updates.length > 0) {
        await client.axios.put(`/contacts/${contactId}`, { customFields: updates });
        fieldsWritten = updates.length;
      }
    } catch (err) {
      errors.push(`status-field write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. Per-student opportunity card moves (matched by card name) ───
  let moved = 0;
  if (fromStage && toStage) {
    try {
      // Live fetch — the cache has no card names and may hold stale stages.
      const res = await client.axios.get('/opportunities/search', {
        params: { location_id: client.locationId, contact_id: contactId, limit: 40 },
      });
      const opps: LiveOpp[] = (res.data.opportunities ?? []).filter((o: LiveOpp) => o.status === 'open');

      // Stage-name → stage-id maps from our cache (per pipeline).
      const { rows: stageRows } = await query<{ pipeline_id: string; stage_id: string; stage_name: string }>(
        `SELECT DISTINCT pipeline_id, stage_id, stage_name
           FROM ghl_opportunities WHERE school_id = $1`,
        [opts.schoolId],
      );
      const fromIds = new Set(stageRows.filter((r) => r.stage_name === fromStage).map((r) => r.stage_id));
      const toIdByPipeline = new Map(
        stageRows.filter((r) => r.stage_name === toStage).map((r) => [r.pipeline_id, r.stage_id]),
      );

      const candidates = opps.filter((o) => fromIds.has(o.pipelineStageId));

      const firstNameCounts = new Map<string, number>();
      const { rows: allStudents } = await query<{ first_name: string }>(
        `SELECT first_name FROM students
          WHERE school_id = $1 AND family_id = $2 AND status = 'active'`,
        [opts.schoolId, opts.familyId],
      );
      for (const s of allStudents) {
        const k = norm(s.first_name);
        firstNameCounts.set(k, (firstNameCounts.get(k) ?? 0) + 1);
      }

      for (const st of ready) {
        const full = norm(`${st.first_name} ${st.last_name}`);
        const first = norm(st.first_name);

        let matches = candidates.filter((o) => norm(o.name) === full);
        if (matches.length === 0 && (firstNameCounts.get(first) ?? 0) === 1) {
          // First-name fallback only when the name is unique in the family.
          matches = candidates.filter((o) => norm(o.name).startsWith(first));
          if (matches.length > 1) {
            errors.push(`ambiguous cards for "${st.first_name} ${st.last_name}" (${matches.map((m) => m.name).join(' / ')}) — skipped, fix card names in GHL`);
            continue;
          }
        }
        if (matches.length === 0) {
          errors.push(`no ${fromStage} card matches "${st.first_name} ${st.last_name}" — skipped (card may be misspelled, already moved, or missing)`);
          continue;
        }

        for (const card of matches) {
          const targetId = toIdByPipeline.get(card.pipelineId);
          if (!targetId) { errors.push(`target stage "${toStage}" unknown in pipeline ${card.pipelineId}`); continue; }
          try {
            await client.axios.put(`/opportunities/${card.id}`, {
              pipelineId: card.pipelineId,
              pipelineStageId: targetId,
            });
            moved++;
          } catch (err) {
            errors.push(`move card "${card.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      errors.push(`opportunity sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 3. Enrollment tag → every active parent (first ready student) ──
  let tagged = 0;
  if (enrollmentTag) {
    const { rows: parents } = await query<{ ghl_contact_id: string }>(
      `SELECT ghl_contact_id FROM parents
        WHERE school_id = $1 AND family_id = $2 AND status = 'active'
          AND ghl_contact_id IS NOT NULL`,
      [opts.schoolId, opts.familyId],
    );
    for (const p of parents) {
      try {
        await client.axios.post(`/contacts/${p.ghl_contact_id}/tags`, { tags: [enrollmentTag] });
        tagged++;
      } catch (err) {
        errors.push(`tag ${p.ghl_contact_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    console.warn('[advance-on-completion]', opts.familyId, errors);
  }
  return {
    ran: true,
    students_ready: ready.length,
    status_fields_written: fieldsWritten,
    tag_applied_to: tagged,
    opportunities_moved: moved,
    errors,
  };
}
