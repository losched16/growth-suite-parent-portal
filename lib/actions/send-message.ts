// In-portal parent→school messaging has been removed — parents email the
// school office directly instead. This server action is retained as a
// no-op so any lingering reference (or a hand-crafted POST to the action
// endpoint) can't send a message; it just bounces back to /messages,
// which now shows the "email us" notice.

'use server';

import { redirect } from 'next/navigation';

export async function sendMessageAction(_formData: FormData): Promise<void> {
  redirect('/messages');
}
