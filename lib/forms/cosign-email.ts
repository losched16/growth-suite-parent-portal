// Emails for the co-sign flow:
//   - sendCoSignRequestEmail: to Parent 2, asking them to add their signature
//   - notifyCoSignComplete:    to Parent 1, confirming both signatures are in
//
// The school-office notification on full execution is handled separately by
// firePostSubmitEffects (reusing the form's notify_emails list), fired from
// the co-sign API once Parent 2 signs.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;');
}

export async function sendCoSignRequestEmail(opts: {
  schoolId: string;
  to: string;
  cosignerName: string;
  submitterParentId: string;
  studentId: string | null;
  formDisplayName: string;
  cosignUrl: string;
}): Promise<void> {
  const { rows } = await query<{
    school_name: string; support_email: string | null;
    submitter: string | null; student: string | null;
  }>(
    `SELECT sch.name AS school_name,
            b.support_email,
            NULLIF(BTRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS submitter,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student
       FROM schools sch
       LEFT JOIN school_branding b ON b.school_id = sch.id
       LEFT JOIN parents p ON p.id = $2
       LEFT JOIN students st ON st.id = $3
      WHERE sch.id = $1`,
    [opts.schoolId, opts.submitterParentId, opts.studentId],
  );
  const r = rows[0];
  const schoolName = r?.school_name ?? 'the school';
  const submitter = r?.submitter ?? 'The other parent/guardian';
  const student = r?.student ?? null;
  const firstName = opts.cosignerName.trim().split(/\s+/)[0] || '';
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hello,';
  const childLine = student ? ` for <strong>${esc(student)}</strong>` : '';
  const childLineText = student ? ` for ${student}` : '';
  const subject = `Your signature is requested: ${opts.formDisplayName}${student ? ` — ${student}` : ''}`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
  <h2 style="color:#047857;margin-bottom:4px">A signature is requested</h2>
  <p>${hi}</p>
  <p>${esc(submitter)} has completed and signed the <strong>${esc(opts.formDisplayName)}</strong>${childLine} at ${esc(schoolName)}, and because you share legal decision-making authority, your signature is needed to finalize it.</p>
  <p>Please review the completed agreement and add your signature:</p>
  <p style="margin:28px 0">
    <a href="${opts.cosignUrl}" style="background:#047857;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Review &amp; sign</a>
  </p>
  <p style="font-size:12px;color:#6b7280">If the button doesn't work, paste this link into your browser:<br>${opts.cosignUrl}</p>
  <p style="font-size:12px;color:#6b7280">This link is unique to you. The enrollment isn't final until your signature is added.</p>
</div>`;
  const text = `A signature is requested

${firstName ? `Hi ${firstName},` : 'Hello,'}

${submitter} has completed and signed the ${opts.formDisplayName}${childLineText} at ${schoolName}. Because you share legal decision-making authority, your signature is needed to finalize it.

Review the completed agreement and add your signature:
${opts.cosignUrl}

This link is unique to you. The enrollment isn't final until your signature is added.`;

  await sendBrandedEmail({
    to: opts.to, schoolId: opts.schoolId, subject, html, text,
    replyToOverride: r?.support_email ?? undefined,
  });
}

// Tell Parent 1 (the original submitter) that Parent 2 has signed and the
// agreement is now fully executed. Best-effort.
export async function notifyCoSignComplete(opts: {
  schoolId: string; submissionId: string;
}): Promise<void> {
  const { rows } = await query<{
    school_name: string; support_email: string | null;
    submitter_email: string | null; submitter_first: string | null;
    form_name: string; cosigner_name: string | null; student: string | null;
  }>(
    `SELECT sch.name AS school_name,
            b.support_email,
            p.email AS submitter_email,
            p.first_name AS submitter_first,
            d.display_name AS form_name,
            s.cosign_name AS cosigner_name,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student
       FROM portal_form_submissions s
       JOIN schools sch ON sch.id = s.school_id
       LEFT JOIN school_branding b ON b.school_id = sch.id
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
       LEFT JOIN parents p ON p.id = s.parent_id
       LEFT JOIN students st ON st.id = s.student_id
      WHERE s.id = $1`,
    [opts.submissionId],
  );
  const r = rows[0];
  if (!r?.submitter_email) return;

  const schoolName = r.school_name ?? 'the school';
  const cosigner = r.cosigner_name?.trim() || 'The co-signer';
  const childLine = r.student ? ` for ${r.student}` : '';
  const hi = r.submitter_first ? `Hi ${esc(r.submitter_first)},` : 'Hello,';
  const subject = `Signed & complete: ${r.form_name}${r.student ? ` — ${r.student}` : ''}`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#111827">
  <h2 style="color:#047857;margin-bottom:4px">Fully signed</h2>
  <p>${hi}</p>
  <p>${esc(cosigner)} has added their signature, so the <strong>${esc(r.form_name)}</strong>${esc(childLine)} at ${esc(schoolName)} is now fully signed and complete. No further action is needed.</p>
</div>`;
  const text = `Fully signed

${r.submitter_first ? `Hi ${r.submitter_first},` : 'Hello,'}

${cosigner} has added their signature, so the ${r.form_name}${childLine} at ${schoolName} is now fully signed and complete. No further action is needed.`;

  await sendBrandedEmail({
    to: r.submitter_email, schoolId: opts.schoolId, subject, html, text,
    replyToOverride: r.support_email ?? undefined,
  });
}
