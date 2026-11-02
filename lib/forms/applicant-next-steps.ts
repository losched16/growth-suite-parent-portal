// "How it works" for admissions schools (settings.applicant_student):
//   1. fill out the application   2. go to Forms and upload the documents.
// Shared by the home/forms pages (state) and the email a family gets the moment
// their application is submitted.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { portalBaseForSchool } from '@/lib/portal-base';
import { loadApplicantStudentConfig } from '@/lib/forms/applicant-student';

export interface ApplicantStepsState {
  formSlug: string;
  step1Done: boolean;        // an application has been submitted (child exists)
  docNames: string[];        // the document forms that follow the application
  supportEmail: string | null;
  contactName: string | null;
}

async function contactFor(schoolId: string): Promise<{ supportEmail: string | null; contactName: string | null }> {
  const { rows } = await query<{ support_email: string | null; contact_name: string | null }>(
    `SELECT b.support_email, s.settings->'open_applications'->>'contact_name' AS contact_name
       FROM schools s LEFT JOIN school_branding b ON b.school_id = s.id WHERE s.id = $1`,
    [schoolId],
  );
  return { supportEmail: rows[0]?.support_email ?? null, contactName: rows[0]?.contact_name ?? null };
}

async function docFormNames(schoolId: string, appSlug: string): Promise<string[]> {
  const { rows } = await query<{ display_name: string }>(
    `SELECT display_name FROM portal_form_definitions
      WHERE school_id = $1 AND is_active = true AND slug <> $2
        AND audience IS DISTINCT FROM 'staff'
      ORDER BY display_name`,
    [schoolId, appSlug],
  );
  return rows.map((r) => r.display_name);
}

export async function loadApplicantStepsState(
  schoolId: string, familyId: string,
): Promise<ApplicantStepsState | null> {
  const cfg = await loadApplicantStudentConfig(schoolId).catch(() => null);
  if (!cfg) return null;
  const [done, docNames, contact] = await Promise.all([
    query(
      `SELECT 1 FROM students WHERE family_id = $1 AND status = 'active' AND metadata->>'applicant' = 'true' LIMIT 1`,
      [familyId],
    ),
    docFormNames(schoolId, cfg.form_slug),
    contactFor(schoolId),
  ]);
  return { formSlug: cfg.form_slug, step1Done: done.rows.length > 0, docNames, ...contact };
}

// True when this school gates its other forms behind the application and the
// family has not submitted one yet (server-side guard for the lock on the list).
export async function isLockedUntilApplication(
  schoolId: string, familyId: string, formSlug: string,
): Promise<boolean> {
  const cfg = await loadApplicantStudentConfig(schoolId).catch(() => null);
  if (!cfg || cfg.form_slug === formSlug) return false;
  const { rows } = await query(
    `SELECT 1 FROM students WHERE family_id = $1 AND status = 'active' AND metadata->>'applicant' = 'true' LIMIT 1`,
    [familyId],
  );
  return rows.length === 0;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string));

// Fired after the application form is submitted (not for the document forms).
export async function sendApplicantNextSteps(opts: {
  schoolId: string; formSlug: string; parentId: string;
}): Promise<void> {
  const cfg = await loadApplicantStudentConfig(opts.schoolId).catch(() => null);
  if (!cfg || cfg.form_slug !== opts.formSlug) return;

  const { rows } = await query<{ email: string | null; first_name: string | null; school_name: string }>(
    `SELECT p.email, p.first_name, s.name AS school_name
       FROM parents p JOIN schools s ON s.id = p.school_id WHERE p.id = $1`,
    [opts.parentId],
  );
  const p = rows[0];
  if (!p?.email) return;

  const [docs, contact, base] = await Promise.all([
    docFormNames(opts.schoolId, cfg.form_slug),
    contactFor(opts.schoolId),
    portalBaseForSchool(opts.schoolId),
  ]);
  const url = `${base}/forms-v2`;
  const who = contact.supportEmail
    ? (contact.contactName ? `${contact.contactName} at ${contact.supportEmail}` : contact.supportEmail)
    : null;
  const list = docs.map((d) => `<li style="margin:2px 0;">${esc(d)}</li>`).join('');

  await sendBrandedEmail({
    to: p.email,
    schoolId: opts.schoolId,
    subject: `We received your application — next, upload your documents`,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:480px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 12px;font-size:18px;">Your application to ${esc(p.school_name)} is in</h2>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5;">Hi ${esc(p.first_name ?? 'there')}, thank you. <strong>Step 1 of 2 is done.</strong></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Step 2: upload your documents.</strong> Sign in, open <strong>Forms</strong>, and upload each of these (you can come back any time; your progress is saved):</p>
<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.5;">${list}</ul>
<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;background:#047857;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Go to Forms</a></p>
<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;"><p style="margin:0;font-size:12px;color:#6b7280;">${who ? `Questions? Contact ${esc(who)}. ` : ''}This address does not receive replies.</p></body></html>`,
    text: `Your application to ${p.school_name} is in\n\nStep 1 of 2 is done.\n\nStep 2: upload your documents. Sign in, open Forms, and upload:\n${docs.map((d) => `- ${d}`).join('\n')}\n\n${url}\n\n${who ? `Questions? Contact ${who}. ` : ''}This address does not receive replies.`,
  });
}
