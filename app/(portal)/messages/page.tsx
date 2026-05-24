// /messages — chat-style thread with the school. v1 shows messages from
// all conversations involving the parent's contact (most schools have
// one), with a single send-message form at the bottom.
//
// Direction:
//   inbound  = from school → parent  (left-aligned, gray)
//   outbound = from parent → school  (right-aligned, brand color)

import { MessageSquare, Send } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { searchConversations, listMessages, type GhlMessage } from '@/lib/ghl/conversations';
import { sendMessageAction } from '@/lib/actions/send-message';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ msg?: string; err?: string }>;

interface ResolvedMessage {
  id: string;
  body: string;
  direction: 'inbound' | 'outbound';
  type_label: string;
  date: string;
}

export default async function MessagesPage({ searchParams }: { searchParams: SearchParams }) {
  const id = await requireParent();
  const { msg, err } = await searchParams;

  // Pull parent's contactId (or fall back to family primary). Same pattern
  // as the send action, kept here so the read side works even when the
  // parent doesn't have a GHL contact of their own.
  const { rows: contactRows } = await query<{ ghl_contact_id: string | null }>(
    `SELECT ghl_contact_id FROM parents
     WHERE family_id = $1 AND ghl_contact_id IS NOT NULL AND status = 'active'
     ORDER BY (id = $2) DESC, is_primary DESC
     LIMIT 1`,
    [id.parent.family_id, id.parent.id],
  );
  const contactId = contactRows[0]?.ghl_contact_id ?? null;

  let messages: ResolvedMessage[] = [];
  let loadError: string | null = null;
  let usableContact = !!contactId;

  if (contactId) {
    try {
      const client = await loadGhlClient(id.parent.school_id);
      const conversations = await searchConversations(client, contactId);
      const lists = await Promise.all(
        conversations.slice(0, 5).map((c) => listMessages(client, c.id, 50).catch(() => [])),
      );
      const flat: GhlMessage[] = lists.flat();
      messages = flat
        .filter((m) => !!m.body)
        .map((m): ResolvedMessage => ({
          id: m.id,
          body: m.body ?? '',
          direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
          type_label: friendlyType(m.messageType ?? typeNumberToLabel(m.type)),
          date: m.dateAdded ?? '',
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Messages</h1>
        <p className="mt-1 text-sm text-gray-600">
          Chat directly with the school office. Messages also reach them
          via their normal staff inbox.
        </p>
      </header>

      {msg ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
      ) : null}
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      {!usableContact ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Your account isn&apos;t linked to a school contact yet, so we can&apos;t send messages
          on your behalf. Please contact the school office directly:{' '}
          {id.branding.support_email ? (
            <a className="underline" href={`mailto:${id.branding.support_email}`}>{id.branding.support_email}</a>
          ) : 'see contact info in your school welcome packet.'}
        </div>
      ) : (
        <>
          {/* Thread */}
          <section className="rounded-lg border border-gray-200 bg-white">
            <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4">
              {loadError ? (
                <div className="text-sm text-amber-700">
                  Couldn&apos;t load message history: {loadError}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center py-8 text-center text-sm text-gray-500">
                  <MessageSquare className="mb-2 h-8 w-8 text-gray-300" />
                  No messages yet. Send the school a hello below to start a conversation.
                </div>
              ) : (
                messages.map((m) => <MessageBubble key={m.id} message={m} />)
              )}
            </div>

            {/* Compose */}
            <form
              action={sendMessageAction}
              className="border-t border-gray-100 bg-gray-50 p-3"
            >
              <div className="flex items-end gap-2">
                <textarea
                  name="body"
                  rows={2}
                  placeholder="Type a message…"
                  required
                  maxLength={5000}
                  className="flex-1 resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
                />
                <button
                  type="submit"
                  className="inline-flex h-10 items-center gap-1.5 rounded-md px-4 text-sm font-medium text-white"
                  style={{ background: 'var(--brand)' }}
                >
                  <Send className="h-4 w-4" /> Send
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-gray-500">
                Replies usually within one business day.
                {id.branding.support_phone ? ` For urgent matters, call ${id.branding.support_phone}.` : ''}
              </p>
            </form>
          </section>
        </>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ResolvedMessage }) {
  const isOutbound = message.direction === 'outbound';
  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div
          className={`rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
            isOutbound
              ? 'rounded-br-sm text-white'
              : 'rounded-bl-sm bg-gray-100 text-gray-900'
          }`}
          style={isOutbound ? { background: 'var(--brand)' } : undefined}
        >
          {message.body}
        </div>
        <div className={`mt-0.5 px-2 text-[10px] text-gray-400 ${isOutbound ? 'text-right' : 'text-left'}`}>
          {message.type_label}{message.date ? ` · ${fmtTime(message.date)}` : ''}
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function typeNumberToLabel(n: number | string | undefined): string {
  const num = typeof n === 'number' ? n : Number(n);
  switch (num) {
    case 1: return 'TYPE_SMS';
    case 3: return 'TYPE_EMAIL';
    case 25: return 'TYPE_LIVE_CHAT';
    default: return 'TYPE_OTHER';
  }
}

function friendlyType(t: string): string {
  switch (t) {
    case 'TYPE_SMS': return 'SMS';
    case 'TYPE_EMAIL': return 'Email';
    case 'TYPE_LIVE_CHAT': return 'In-portal';
    case 'TYPE_WEBCHAT': return 'Web chat';
    case 'TYPE_WHATSAPP': return 'WhatsApp';
    case 'TYPE_FB': return 'Facebook';
    case 'TYPE_IG': return 'Instagram';
    default: return 'Message';
  }
}
