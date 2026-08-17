// When a family reaches 100% form completion, optionally advance them
// through the admissions pipeline: apply an "enrolled" tag, and move
// every opportunity card the family owns from a source stage to a
// target stage. All three levers are per-school (school_branding
// columns from migration 012); if any of them is NULL/empty, that lever
// is a no-op — the school opted out.
//
// Multi-child families: a family typically owns one opportunity per
// child. This looks up EVERY open opportunity for the primary parent's
// GHL contact whose current stage matches the configured source stage,
// and moves each of them. Cards already sitting in the target stage
// (or any other stage) are left untouched.
//
// Fired as a fire-and-forget effect from the portal form submit
// handler, alongside the existing completion-tag effect. Both share the
// same "is the family fully complete?" definition to stay consistent.
//
// Idempotent: writing the same tag or moving an opportunity to the
// stage it's already in are both no-ops on GHL's side.

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';

interface FormRow { id: string; per_student: boolean }
interface StudentRow { id: string }
interface SubRow { form_definition_id: string; student_id: string | null }

async function isFamilyFullyComplete(schoolId: string, familyId: string): Promise<boolean> {
  const { rows: forms } = await query<FormRow>(
    `SELECT id, per_student
       FROM portal_form_definitions
      WHERE school_id = $1
        AND is_active = true
        AND COALESCE(audience, 'parents') = 'parents'`,
    [schoolId],
  );
  if (forms.length === 0) return false;

  const { rows: students } = await query<StudentRow>(
    `SELECT id FROM students
      WHERE school_id = $1 AND family_id = $2 AND status = 'active'`,
    [schoolId, familyId],
  );
  if (students.length === 0) return false;
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
  for (const form of forms) {
    if (form.per_student) {
      for (const sid of studentIds) {
        if (!studentSubs.has(`${form.id}|${sid}`)) return false;
      }
    } else {
      if (!familySubs.has(form.id)) return false;
    }
  }
  return true;
}

interface AdvanceConfig {
  enrollment_tag: string | null;
  pipeline_move_from_stage: string | null;
  pipeline_move_to_stage: string | null;
}

interface Parent {
  ghl_contact_id: string;
  is_primary: boolean;
}

interface OppRow {
  id: string;
  pipeline_id: string;
  stage_id: string;
}

interface TargetStageRow {
  stage_id: string;
  pipeline_id: string;
}

export interface AdvanceResult {
  ran: boolean;
  reason?: string;
  tag_applied_to?: number;
  opportunities_moved?: number;
  opportunities_skipped?: number;
  errors: string[];
}

/**
 * If the family is fully complete AND the school has advance config:
 *   1) apply enrollment_tag to every parent's GHL contact,
 *   2) move every open opportunity whose current stage matches
 *      pipeline_move_from_stage to pipeline_move_to_stage.
 * Both steps are best-effort and independent — one failing doesn't
 * abort the other.
 */
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
    enrollment_tag: null,
    pipeline_move_from_stage: null,
    pipeline_move_to_stage: null,
  };
  const enrollmentTag = (cfg.enrollment_tag ?? '').trim() || null;
  const fromStage = (cfg.pipeline_move_from_stage ?? '').trim() || null;
  const toStage = (cfg.pipeline_move_to_stage ?? '').trim() || null;
  if (!enrollmentTag && !(fromStage && toStage)) {
    return { ran: false, reason: 'no_advance_config', errors };
  }

  const complete = await isFamilyFullyComplete(opts.schoolId, opts.familyId);
  if (!complete) return { ran: false, reason: 'family_not_yet_complete', errors };

  let client: GhlClient;
  try {
    client = await loadGhlClient(opts.schoolId);
  } catch (e) {
    return { ran: false, reason: 'ghl_client_load_failed', errors: [String(e)] };
  }

  // Step 1: enrollment tag → every active parent.
  let tagged = 0;
  if (enrollmentTag) {
    const { rows: parents } = await query<Parent>(
      `SELECT ghl_contact_id, is_primary
         FROM parents
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

  // Step 2: opportunity moves → every open opp whose current stage matches.
  let moved = 0;
  let skipped = 0;
  if (fromStage && toStage) {
    // The primary parent's contact is the anchor for opportunities in
    // Wooster's setup. If we ever hit a school where multiple parents own
    // separate opportunities we'd sweep all of them — but querying by
    // primary keeps the safe default of "one family, one opportunity
    // owner" and avoids double-moving co-parent-mirrored cards.
    const { rows: primary } = await query<{ ghl_contact_id: string }>(
      `SELECT ghl_contact_id FROM parents
        WHERE school_id = $1 AND family_id = $2 AND is_primary = true
          AND ghl_contact_id IS NOT NULL LIMIT 1`,
      [opts.schoolId, opts.familyId],
    );
    if (primary.length === 0) {
      errors.push('no_primary_parent_with_ghl_contact');
    } else {
      const contactId = primary[0].ghl_contact_id;
      // Every open opp owned by this contact currently sitting in fromStage.
      const { rows: opps } = await query<OppRow>(
        `SELECT id, pipeline_id, stage_id
           FROM ghl_opportunities
          WHERE school_id = $1
            AND ghl_contact_id = $2
            AND stage_name = $3
            AND status = 'open'`,
        [opts.schoolId, contactId, fromStage],
      );
      if (opps.length === 0) {
        skipped = 1;
      } else {
        // Resolve target stage id per pipeline (same stage name might exist
        // in multiple pipelines with different ids).
        const targetStageByPipeline = new Map<string, string>();
        for (const opp of opps) {
          if (targetStageByPipeline.has(opp.pipeline_id)) continue;
          const { rows: t } = await query<TargetStageRow>(
            `SELECT DISTINCT stage_id, pipeline_id
               FROM ghl_opportunities
              WHERE school_id = $1 AND pipeline_id = $2 AND stage_name = $3
              LIMIT 1`,
            [opts.schoolId, opp.pipeline_id, toStage],
          );
          if (t.length === 0) {
            errors.push(`target stage "${toStage}" not found in pipeline ${opp.pipeline_id} (no existing card in it — set one manually first)`);
            continue;
          }
          targetStageByPipeline.set(opp.pipeline_id, t[0].stage_id);
        }
        for (const opp of opps) {
          const targetStageId = targetStageByPipeline.get(opp.pipeline_id);
          if (!targetStageId) { skipped++; continue; }
          if (opp.stage_id === targetStageId) { skipped++; continue; }
          try {
            await client.axios.put(`/opportunities/${opp.id}`, {
              pipelineId: opp.pipeline_id,
              pipelineStageId: targetStageId,
            });
            moved++;
          } catch (err) {
            errors.push(`move opp ${opp.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  return {
    ran: true,
    tag_applied_to: tagged,
    opportunities_moved: moved,
    opportunities_skipped: skipped,
    errors,
  };
}
