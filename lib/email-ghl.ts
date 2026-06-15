// GHL email send path for the parent portal. Routes a transactional
// email through the school's GHL location via the Conversations API
// (type=Email) instead of Resend, when the school's email_provider is
// 'ghl'. Mirrors the dashboards copy.
//
// Always wrapped by lib/email.ts in a try/fallback — on ANY failure the
// caller re-sends via Resend, so this can return ok:false freely.
//
// Recipient → contactId: GHL email addresses a CONTACT, so we resolve
// the parent by email within the school. No match → null → caller
// falls back to Resend (covers brand-new leads, operators, etc.).

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { sendMessage } from '@/lib/ghl/conversations';

export interface GhlEmailResult {
  ok: boolean;
  reason?: string;
}

async function contactIdForEmail(schoolId: string, email: string): Promise<string | null> {
  const { rows } = await query<{ ghl_contact_id: string | null }>(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND lower(email) = lower($2)
        AND ghl_contact_id IS NOT NULL
      ORDER BY is_primary DESC, created_at
      LIMIT 1`,
    [schoolId, email],
  );
  return rows[0]?.ghl_contact_id ?? null;
}

export async function sendEmailViaGhl(opts: {
  to: string | string[];
  schoolId: string;
  subject: string;
  html: string;
  text: string;
}): Promise<GhlEmailResult> {
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

  let client;
  try {
    client = await loadGhlClient(opts.schoolId);
  } catch (err) {
    return { ok: false, reason: `ghl_client: ${err instanceof Error ? err.message : String(err)}` };
  }

  const contactIds: string[] = [];
  for (const r of recipients) {
    const cid = await contactIdForEmail(opts.schoolId, r);
    if (!cid) return { ok: false, reason: `no_contact_for:${r}` };
    contactIds.push(cid);
  }

  try {
    for (const contactId of contactIds) {
      await sendMessage(client, {
        contactId,
        type: 'Email',
        subject: opts.subject,
        html: opts.html,
        body: opts.text,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `ghl_send: ${err instanceof Error ? err.message : String(err)}` };
  }
}
