// Welcome email for a parent that was just added by their co-parent
// from the family page. Mints a one-shot 7-day token so the new
// parent can land directly in /home without typing their email.
//
// The 15-min TTL on regular magic-link logins is way too short here —
// a parent invited Sunday night might not see the email until Monday.

import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 24;

export async function sendCoParentWelcomeEmail(opts: {
  newParentId: string;
  newParentEmail: string;
  newParentFirstName: string;
  invitingParentFirstName: string;
  schoolId: string;
  schoolName: string;
  supportEmail: string | null;
  origin: string;
}): Promise<void> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expires = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000,
  ).toISOString();

  await query(
    `INSERT INTO parent_magic_link_tokens
       (token, email, school_id, parent_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      token,
      opts.newParentEmail.toLowerCase(),
      opts.schoolId,
      opts.newParentId,
      expires,
    ],
  );

  const loginUrl = `${opts.origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const support = opts.supportEmail
    ? `Questions? Reply to this email or contact ${opts.supportEmail}.`
    : `Questions? Reply to this email.`;

  const subject = `${opts.invitingParentFirstName} added you to the ${opts.schoolName} Family Portal`;
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px; font-size: 18px;">You've been added to ${esc(opts.schoolName)}'s Family Portal</h2>
  <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.5;">
    Hi ${esc(opts.newParentFirstName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.5;">
    ${esc(opts.invitingParentFirstName)} added you to your family's account so you can view and complete
    school forms, update emergency contacts, and manage who can pick up your students.
  </p>
  <p style="margin: 24px 0;">
    <a href="${loginUrl}" style="display:inline-block; background:#1F1F1F; color:white; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;">Sign in to the Family Portal</a>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    Or copy this link into your browser:<br>
    <span style="word-break: break-all; font-family: monospace;">${loginUrl}</span>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    The link expires in ${INVITE_TTL_DAYS} days. After that, you can sign in at any time by
    entering your email on the portal's sign-in page — we'll email a fresh link.
  </p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #6b7280;">${esc(support)}</p>
</body></html>
  `.trim();

  const text = `You've been added to ${opts.schoolName}'s Family Portal

Hi ${opts.newParentFirstName},

${opts.invitingParentFirstName} added you to your family's account so you can view and complete
school forms, update emergency contacts, and manage who can pick up your students.

Sign in here (link expires in ${INVITE_TTL_DAYS} days):
${loginUrl}

${support}`;

  await sendBrandedEmail({
    to: opts.newParentEmail,
    schoolId: opts.schoolId,
    subject,
    html,
    text,
  });
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
