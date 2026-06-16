// Outbound email via Resend.
//
// Sender selection: per-school overrides take precedence. If a school
// has email_from_address / email_reply_to_address set in school_branding,
// those are used. Otherwise the global env-var fallbacks apply.
//
// Required env: RESEND_API_KEY, RESEND_FROM_ADDRESS
// Optional: RESEND_REPLY_TO

import { Resend } from 'resend';
import { query } from '@/lib/db';
import { sendEmailViaGhl } from '@/lib/email-ghl';

let _resend: Resend | undefined;

// Per-school provider toggle (school_branding.email_provider, migration
// 059). 'ghl' routes through the GHL Conversations API; anything else
// (incl. no row) → Resend. Default-safe for tenants that never opted in.
async function emailProviderFor(schoolId: string | null): Promise<'resend' | 'ghl'> {
  if (!schoolId) return 'resend';
  try {
    const { rows } = await query<{ email_provider: string | null }>(
      `SELECT email_provider FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    return rows[0]?.email_provider === 'ghl' ? 'ghl' : 'resend';
  } catch {
    return 'resend';
  }
}

// Returns null when RESEND_API_KEY isn't set — callers should log+skip
// rather than crash. This lets the demo run without Resend configured
// (transactional emails just don't send; nothing else breaks).
function client(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

interface SchoolSender {
  fromAddress: string;     // e.g. 'family@mygrowthsuite.com'
  fromName: string | null; // e.g. 'Montessori School of Wooster'
  replyTo: string | null;  // e.g. 'admissions@woomontessori.org'
}

// Resolve the From / Reply-to addresses to use for emails about this
// school. Per-school overrides come from school_branding; everything
// else falls back to env vars.
async function resolveSenderForSchool(schoolId: string | null): Promise<SchoolSender> {
  const envFrom = process.env.RESEND_FROM_ADDRESS ?? 'Family Portal <family@mygrowthsuite.com>';
  const envReply = process.env.RESEND_REPLY_TO ?? null;

  if (!schoolId) {
    return { fromAddress: envFrom, fromName: null, replyTo: envReply };
  }

  try {
    const { rows } = await query<{
      email_from_address: string | null;
      email_from_name: string | null;
      email_reply_to_address: string | null;
    }>(
      `SELECT email_from_address, email_from_name, email_reply_to_address
       FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const r = rows[0];
    if (!r) return { fromAddress: envFrom, fromName: null, replyTo: envReply };

    return {
      fromAddress: r.email_from_address || envFrom,
      fromName: r.email_from_name,
      replyTo: r.email_reply_to_address || envReply,
    };
  } catch {
    return { fromAddress: envFrom, fromName: null, replyTo: envReply };
  }
}

// Build the canonical From header. If we have a display name and a bare
// address, format as `"Display Name" <address@example.com>`. If the
// address already contains a `<...>` block, leave it alone.
function formatFrom(sender: SchoolSender): string {
  const addr = sender.fromAddress;
  if (addr.includes('<')) return addr;
  if (sender.fromName) return `"${sender.fromName.replace(/"/g, "'")}" <${addr}>`;
  return addr;
}

export async function sendMagicLinkEmail(opts: {
  to: string;
  loginUrl: string;
  schoolId: string | null;
  schoolName: string;
  supportEmail: string | null;
}): Promise<void> {
  const sender = await resolveSenderForSchool(opts.schoolId);

  const subject = `Your sign-in link for ${opts.schoolName}`;
  const support = opts.supportEmail
    ? `If you didn't request this, ignore the email or contact ${opts.supportEmail}.`
    : `If you didn't request this, ignore the email.`;

  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 480px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px; font-size: 18px;">Sign in to ${escape(opts.schoolName)} Family Portal</h2>
  <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5;">
    Click the button below to sign in. The link expires in 15 minutes and works only once.
  </p>
  <p style="margin: 24px 0;">
    <a href="${opts.loginUrl}" style="display:inline-block; background:#1F1F1F; color:white; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;">Sign in</a>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    Or copy this link into your browser:<br>
    <span style="word-break: break-all; font-family: monospace;">${opts.loginUrl}</span>
  </p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #6b7280;">${support}</p>
</body></html>
  `.trim();

  const text = `Sign in to ${opts.schoolName} Family Portal

Open this link in your browser to sign in. The link expires in 15 minutes and works only once.

${opts.loginUrl}

${support}`;

  // GHL-only for opted-in schools — no Resend fallback. The school
  // explicitly chose GHL as their sending provider, so a Resend
  // fallback would send from our default domain (not their branded
  // one) and bypass the deliverability work they did to verify
  // their sending domain in GHL. Better to surface the failure than
  // to silently send from the wrong sender.
  if (opts.schoolId && (await emailProviderFor(opts.schoolId)) === 'ghl') {
    const r = await sendEmailViaGhl({ to: opts.to, schoolId: opts.schoolId, subject, html, text });
    if (r.ok) return;
    console.error('[email/magic-link] GHL send failed for school', opts.schoolId, '→', r.reason, '(to:', opts.to, ')');
    throw new Error(`magic_link_send_failed_ghl: ${r.reason}`);
  }

  const c = client();
  if (!c) {
    console.warn('[email/magic-link] RESEND_API_KEY not set — skipping send to', opts.to);
    return;
  }
  await c.emails.send({
    from: formatFrom(sender),
    to: opts.to,
    subject,
    html,
    text,
    replyTo: sender.replyTo || opts.supportEmail || undefined,
  });
}

// Generic helper for any other transactional email. Use this from new
// flows (form-submission confirmation, launch blast, reminders) so they
// all pick up the per-school sender automatically.
export async function sendBrandedEmail(opts: {
  to: string;
  schoolId: string | null;
  subject: string;
  html: string;
  text: string;
  replyToOverride?: string | null;   // optional one-off override
  attachments?: Array<{
    filename: string;
    // Buffer of bytes (e.g. from generated PDFs)
    content: Buffer;
  }>;
}): Promise<void> {
  // GHL-only for opted-in schools — no Resend fallback. The one
  // exception is attachments: GHL's Conversations API only attaches
  // by public URL, not raw bytes, so emails carrying a PDF
  // (invoice copies, form receipts) still go via Resend. Without
  // attachments, GHL is the sole path; failures throw so callers
  // see them instead of silently sending from a wrong-domain
  // fallback.
  const hasAttachments = opts.attachments && opts.attachments.length > 0;
  if (opts.schoolId && (await emailProviderFor(opts.schoolId)) === 'ghl') {
    if (!hasAttachments) {
      const r = await sendEmailViaGhl({
        to: opts.to, schoolId: opts.schoolId,
        subject: opts.subject, html: opts.html, text: opts.text,
      });
      if (r.ok) return;
      console.error('[email/branded] GHL send failed for school', opts.schoolId, '→', r.reason, '(to:', opts.to, ', subject:', opts.subject, ')');
      throw new Error(`branded_email_send_failed_ghl: ${r.reason}`);
    }
    // Attachments present — explicitly fall through to Resend with
    // a clear log since this is the documented exception.
    console.warn('[email/branded] GHL provider has attachments — routing through Resend so the file isn\'t dropped. (to:', opts.to, ')');
  }

  const c = client();
  if (!c) {
    console.warn('[email/branded] RESEND_API_KEY not set — skipping send to', opts.to, '(subject:', opts.subject, ')');
    return;
  }
  const sender = await resolveSenderForSchool(opts.schoolId);
  await c.emails.send({
    from: formatFrom(sender),
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyToOverride ?? sender.replyTo ?? undefined,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      // Resend SDK accepts a Buffer or a base64 string for content.
      // Passing the Buffer directly is cleaner.
      content: a.content,
    })),
  });
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
