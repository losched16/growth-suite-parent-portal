// Admissions pipeline automation for applicant schools (settings.applicant_student
// + settings.applicant_pipeline). Keeps the school's CRM pipeline in step with
// what a family does in the portal, and sends the "schedule your interview" email
// the moment a child's required materials are all in:
//
//   application submitted        -> opportunity (named for the child) in the
//                                   application stage, created if missing
//   every required form done     -> opportunity advanced to the materials stage,
//                                   optional tag, and the school's own CRM email
//                                   template sent once per family
//
// Stages only ever move FORWARD (pipeline order), so a card staff already moved
// further is never pulled back. Every step is best-effort and never throws: a
// CRM hiccup must not fail the family's submit.
//
//   settings.applicant_pipeline = {
//     pipeline_id, application_stage_id, materials_stage_id,
//     complete_tag?,                       // tag added when materials are complete
//     interview_email_template_id?,        // CRM email-builder template id
//     interview_email_subject?
//   }

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { sendMessage } from '@/lib/ghl/conversations';
import { sendBrandedEmail } from '@/lib/email';
import { studentMatchesAppliesTo, type FormAppliesTo } from '@/lib/forms/applies-to';
import { loadApplicantStudentConfig } from '@/lib/forms/applicant-student';

interface PipelineCfg {
  pipeline_id: string;
  application_stage_id: string;
  materials_stage_id: string;
  complete_tag: string | null;
  interview_email_template_id: string | null;
  interview_email_subject: string | null;
}

async function loadPipelineCfg(schoolId: string): Promise<PipelineCfg | null> {
  const { rows } = await query<{ c: Record<string, unknown> | null }>(
    `SELECT settings->'applicant_pipeline' AS c FROM schools WHERE id = $1`, [schoolId],
  );
  const c = rows[0]?.c;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!c || !s(c.pipeline_id) || !s(c.application_stage_id) || !s(c.materials_stage_id)) return null;
  return {
    pipeline_id: s(c.pipeline_id)!, application_stage_id: s(c.application_stage_id)!,
    materials_stage_id: s(c.materials_stage_id)!, complete_tag: s(c.complete_tag),
    interview_email_template_id: s(c.interview_email_template_id),
    interview_email_subject: s(c.interview_email_subject),
  };
}

const norm = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');

// ── CRM opportunity helpers ────────────────────────────────────────────────
interface Opp { id: string; name: string; pipelineId: string; pipelineStageId: string; status: string }

async function stageOrder(client: GhlClient, pipelineId: string): Promise<string[]> {
  const { data } = await client.axios.get<{ pipelines?: Array<{ id: string; stages: Array<{ id: string }> }> }>(
    `/opportunities/pipelines?locationId=${client.locationId}`,
  );
  return (data.pipelines ?? []).find((p) => p.id === pipelineId)?.stages.map((s) => s.id) ?? [];
}

async function opportunitiesFor(client: GhlClient, contactId: string, pipelineId: string): Promise<Opp[]> {
  const { data } = await client.axios.get<{ opportunities?: Opp[] }>(
    `/opportunities/search?location_id=${client.locationId}&contact_id=${contactId}&limit=100`,
  );
  return (data.opportunities ?? []).filter((o) => o.pipelineId === pipelineId);
}

// Put the child's card in `stageId` (create it if the contact has none for this
// child). Never moves a card backwards.
async function advanceOpportunity(opts: {
  client: GhlClient; cfg: PipelineCfg; contactId: string; childName: string;
  onlyChild: boolean; stageId: string;
}): Promise<void> {
  const { client, cfg, contactId, childName, stageId } = opts;
  const [order, opps] = await Promise.all([
    stageOrder(client, cfg.pipeline_id), opportunitiesFor(client, contactId, cfg.pipeline_id),
  ]);
  const want = childName.toLowerCase();
  let opp = opps.find((o) => norm(o.name).toLowerCase().includes(want));
  // A family with one child and one open card in the pipeline: that card is theirs.
  if (!opp && opts.onlyChild) { const open = opps.filter((o) => o.status === 'open'); if (open.length === 1) opp = open[0]; }

  if (!opp) {
    await client.axios.post('/opportunities/', {
      pipelineId: cfg.pipeline_id, locationId: client.locationId, name: childName,
      pipelineStageId: stageId, contactId, status: 'open',
    });
    return;
  }
  const cur = order.indexOf(opp.pipelineStageId);
  const tgt = order.indexOf(stageId);
  if (tgt < 0 || (cur >= 0 && cur >= tgt)) return;
  await client.axios.put(`/opportunities/${opp.id}`, { pipelineStageId: stageId, status: 'open' });
}

// ── completeness ───────────────────────────────────────────────────────────
interface Child { id: string; first_name: string; last_name: string; metadata: Record<string, unknown> }

async function applicantChildren(familyId: string): Promise<Child[]> {
  const { rows } = await query<Child>(
    `SELECT id, first_name, last_name, COALESCE(metadata, '{}'::jsonb) AS metadata
       FROM students WHERE family_id = $1 AND status = 'active' AND metadata->>'applicant' = 'true'
      ORDER BY created_at`, [familyId],
  );
  return rows;
}

async function materialsComplete(schoolId: string, familyId: string, child: Child): Promise<boolean> {
  const { rows: forms } = await query<{ id: string; per_student: boolean; applies_to: FormAppliesTo | null }>(
    `SELECT id, per_student, applies_to FROM portal_form_definitions
      WHERE school_id = $1 AND is_active = true AND audience IS DISTINCT FROM 'staff'
        AND COALESCE(is_optional, false) = false`, [schoolId],
  );
  const { rows: subs } = await query<{ form_definition_id: string; student_id: string | null }>(
    `SELECT s.form_definition_id, s.student_id FROM portal_form_submissions s
      WHERE s.school_id = $1 AND (s.family_id = $2 OR s.student_id = $3)
        AND COALESCE(s.is_test, false) = false
        AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')`,
    [schoolId, familyId, child.id],
  );
  for (const f of forms) {
    if (f.per_student) {
      const applies = studentMatchesAppliesTo(
        { studentId: child.id, metadata: child.metadata, tuitionGridName: null, enrollmentAddonKeys: [], tags: [] },
        f.applies_to,
      );
      if (!applies) continue;
      if (!subs.some((s) => s.form_definition_id === f.id && s.student_id === child.id)) return false;
    } else if (!subs.some((s) => s.form_definition_id === f.id)) return false;
  }
  return true;
}

// ── interview email ────────────────────────────────────────────────────────
// Uses the school's own CRM email template (so edits there are honored) and
// sends it through the CRM so it comes from their domain and replies reach them.
async function sendInterviewEmail(opts: {
  client: GhlClient; cfg: PipelineCfg; schoolId: string; contactId: string;
  email: string; firstName: string;
}): Promise<boolean> {
  const { client, cfg } = opts;
  if (!cfg.interview_email_template_id) return false;
  const { data } = await client.axios.get<{ builders?: Array<{ id: string; previewUrl?: string }> }>(
    `/emails/builder?locationId=${client.locationId}&limit=100`,
  );
  const url = data.builders?.find((b) => b.id === cfg.interview_email_template_id)?.previewUrl;
  if (!url) { console.error('[applicant-pipeline] interview template not found:', cfg.interview_email_template_id); return false; }
  const raw = await (await fetch(url)).text();
  const html = raw
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi, opts.firstName)
    .replace(/\{\{\s*contact\.name\s*\}\}/gi, opts.firstName)
    .replace(/\{\{[^}]*\}\}/g, '');
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const subject = cfg.interview_email_subject ?? 'Next step: schedule your interview';
  try {
    await sendMessage(client, { contactId: opts.contactId, type: 'Email', subject, html, body: text });
    return true;
  } catch (e) {
    console.error('[applicant-pipeline] CRM send failed, falling back:', e instanceof Error ? e.message : e);
    await sendBrandedEmail({ to: opts.email, schoolId: opts.schoolId, subject, html, text });
    return true;
  }
}

// ── entry point (called after every form submission) ───────────────────────
export async function onApplicantSubmission(opts: {
  schoolId: string; familyId: string; parentId: string; formSlug: string;
  responses: Record<string, unknown>;
}): Promise<void> {
  const [appCfg, cfg] = await Promise.all([
    loadApplicantStudentConfig(opts.schoolId).catch(() => null), loadPipelineCfg(opts.schoolId),
  ]);
  if (!appCfg || !cfg) return;

  const { rows: pr } = await query<{ ghl_contact_id: string | null; email: string | null; first_name: string | null }>(
    `SELECT ghl_contact_id, email, first_name FROM parents WHERE id = $1`, [opts.parentId],
  );
  const parent = pr[0];
  if (!parent?.ghl_contact_id) return;
  const client = await loadGhlClient(opts.schoolId);
  const children = await applicantChildren(opts.familyId);
  if (children.length === 0) return;

  // 1. Application just submitted: that child's card -> application stage.
  if (opts.formSlug === appCfg.form_slug) {
    const first = norm(opts.responses[appCfg.first_name_field]).toLowerCase();
    const last = norm(opts.responses[appCfg.last_name_field]).toLowerCase();
    const child = children.find((c) => norm(c.first_name).toLowerCase() === first && norm(c.last_name).toLowerCase() === last);
    if (child) {
      await advanceOpportunity({
        client, cfg, contactId: parent.ghl_contact_id, childName: `${child.first_name} ${child.last_name}`.trim(),
        onlyChild: children.length === 1, stageId: cfg.application_stage_id,
      }).catch((e) => console.error('[applicant-pipeline] application stage failed:', e instanceof Error ? e.message : e));
    }
  }

  // 2. Every child whose required materials are now all in.
  for (const child of children) {
    if (child.metadata.materials_complete_at) continue;
    if (!(await materialsComplete(opts.schoolId, opts.familyId, child))) continue;

    await query(
      `UPDATE students SET metadata = metadata || jsonb_build_object('materials_complete_at', now()::text) WHERE id = $1`,
      [child.id],
    );
    const name = `${child.first_name} ${child.last_name}`.trim();
    await advanceOpportunity({
      client, cfg, contactId: parent.ghl_contact_id, childName: name,
      onlyChild: children.length === 1, stageId: cfg.materials_stage_id,
    }).catch((e) => console.error('[applicant-pipeline] materials stage failed:', e instanceof Error ? e.message : e));
    if (cfg.complete_tag) {
      await client.axios.post(`/contacts/${parent.ghl_contact_id}/tags`, { tags: [cfg.complete_tag] })
        .catch((e) => console.error('[applicant-pipeline] tag failed:', e instanceof Error ? e.message : e));
    }

    // One interview email per family, however many children finish.
    const already = children.some((c) => c.id !== child.id && c.metadata.interview_email_sent_at);
    if (!already && parent.email) {
      const sent = await sendInterviewEmail({
        client, cfg, schoolId: opts.schoolId, contactId: parent.ghl_contact_id,
        email: parent.email, firstName: norm(parent.first_name) || 'there',
      }).catch((e) => { console.error('[applicant-pipeline] interview email failed:', e instanceof Error ? e.message : e); return false; });
      if (sent) {
        await query(
          `UPDATE students SET metadata = metadata || jsonb_build_object('interview_email_sent_at', now()::text) WHERE id = $1`,
          [child.id],
        );
        child.metadata.interview_email_sent_at = 'now';
      }
    }
  }
}
