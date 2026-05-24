// GHL Conversations API client. The parent portal Messages page wraps
// these endpoints to give parents a chat-style thread with the school.
//
// Endpoints used:
//   GET /conversations/search?locationId=...&contactId=...
//        → list of conversations for one contact
//   GET /conversations/{conversationId}/messages
//        → messages in a conversation, newest first
//   POST /conversations/messages
//        → send a message; GHL creates the conversation if needed
//
// Scopes required on the PIT: conversations/message.readonly,
// conversations/message.write, conversations.readonly.

import type { GhlClient } from './client';

export interface GhlConversation {
  id: string;
  contactId: string;
  locationId: string;
  type?: string;       // 'TYPE_PHONE' | 'TYPE_EMAIL' | etc.
  lastMessageType?: string;
  lastMessageBody?: string;
  lastMessageDate?: string;
  unreadCount?: number;
  dateAdded?: string;
  dateUpdated?: string;
}

export interface GhlMessage {
  id: string;
  type: number | string; // 1 = SMS, 3 = Email, 25 = LiveChat, etc.
  messageType?: string;  // 'TYPE_SMS' | 'TYPE_EMAIL' | 'TYPE_LIVE_CHAT' | etc.
  conversationId?: string;
  contactId?: string;
  locationId?: string;
  body?: string;
  direction?: 'inbound' | 'outbound';
  status?: string;
  dateAdded?: string;
  // For email
  meta?: {
    email?: { subject?: string; from?: string; to?: string[] };
  };
}

export async function searchConversations(
  client: GhlClient,
  contactId: string,
): Promise<GhlConversation[]> {
  const { data } = await client.axios.get<{ conversations?: GhlConversation[] }>(
    `/conversations/search?locationId=${client.locationId}&contactId=${contactId}`,
  );
  return data.conversations ?? [];
}

export async function listMessages(
  client: GhlClient,
  conversationId: string,
  limit = 50,
): Promise<GhlMessage[]> {
  const { data } = await client.axios.get<{ messages?: { messages?: GhlMessage[] } }>(
    `/conversations/${conversationId}/messages?limit=${limit}`,
  );
  // GHL response shape: { messages: { messages: [], lastMessageId, nextPage } }
  return data.messages?.messages ?? [];
}

export interface SendMessageInput {
  contactId: string;
  body: string;
  // 'SMS' | 'Email' | 'Live_Chat' | 'WhatsApp' — defaults to 'Live_Chat' which
  // creates a new conversation if none exists and is fully in-app.
  type?: string;
  subject?: string; // required for Email
  // Array of public file URLs (e.g. from GHL media library) to attach.
  attachments?: string[];
}

export interface SendMessageResult {
  conversationId: string;
  messageId: string;
}

export async function sendMessage(
  client: GhlClient,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    type: input.type ?? 'Live_Chat',
    contactId: input.contactId,
    message: input.body,
  };
  if (input.subject) body.subject = input.subject;
  if (input.attachments && input.attachments.length > 0) {
    body.attachments = input.attachments;
  }

  const { data } = await client.axios.post<{ conversationId?: string; messageId?: string; conversationAdded?: boolean; messageAdded?: boolean }>(
    '/conversations/messages',
    body,
  );
  if (!data.conversationId || !data.messageId) {
    throw new Error('GHL did not return conversationId/messageId — message may not have sent');
  }
  return { conversationId: data.conversationId, messageId: data.messageId };
}
