// Server action — send a message from the logged-in parent to the school
// via GHL Conversations API.
//
// Authorization: pulls contactId from the parent's row (not from form data)
// so a malicious parent can't send messages on behalf of someone else.

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { readSession } from '@/lib/identity';
import { loadGhlClient } from '@/lib/ghl/client';
import { sendMessage } from '@/lib/ghl/conversations';

export async function sendMessageAction(formData: FormData): Promise<void> {
  const result = await sendMessageInner(formData);
  const url = new URL('/messages', 'https://placeholder');
  if (result.ok) url.searchParams.set('msg', result.message ?? 'Message sent.');
  else url.searchParams.set('err', result.error ?? 'Send failed.');
  redirect(`${url.pathname}${url.search}`);
}

async function sendMessageInner(
  formData: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const session = await readSession();
    if (!session) return { ok: false, error: 'Not signed in.' };

    const body = String(formData.get('body') ?? '').trim();
    if (!body) return { ok: false, error: 'Message can\'t be empty.' };
    if (body.length > 5000) return { ok: false, error: 'Message too long (max 5000 chars).' };

    // Pull the parent's contactId from THEIR row — never trust form data.
    // For Parent 2 users (no own GHL contact), fall back to family's primary
    // contact so the message still goes out from the family.
    const { rows } = await query<{ ghl_contact_id: string | null }>(
      `SELECT ghl_contact_id FROM parents
       WHERE id = $1 AND family_id = $2 AND status = 'active'`,
      [session.parent_id, session.family_id],
    );
    let contactId = rows[0]?.ghl_contact_id ?? null;
    if (!contactId) {
      const { rows: pri } = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents
         WHERE family_id = $1 AND is_primary = true AND status = 'active' AND ghl_contact_id IS NOT NULL
         LIMIT 1`,
        [session.family_id],
      );
      contactId = pri[0]?.ghl_contact_id ?? null;
    }
    if (!contactId) {
      return {
        ok: false,
        error: 'No GHL contact linked to your family yet — contact the school office.',
      };
    }

    const client = await loadGhlClient(session.school_id);
    let result;
    try {
      result = await sendMessage(client, {
        contactId,
        body,
        type: 'Live_Chat', // in-app conversation
      });
    } catch (err) {
      // Some PITs lack the conversations.write scope — surface a helpful error
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Could not send: ${msg.includes('403') || msg.includes('scope') ? 'School needs to enable in-portal messaging (PIT scope)' : msg}`,
      };
    }

    // Audit
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'send_message', $4::jsonb)`,
      [
        session.school_id,
        session.parent_id,
        session.family_id,
        JSON.stringify({
          conversation_id: result.conversationId,
          message_id: result.messageId,
          length: body.length,
        }),
      ],
    );

    revalidatePath('/messages');
    return { ok: true, message: 'Message sent.' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
