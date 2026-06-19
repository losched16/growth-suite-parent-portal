'use server';

// Dismiss a pinned notification's Home-page banner for the current parent.
// The notification stays in their /notifications inbox — dismiss only hides
// the prominent banner.

import { revalidatePath } from 'next/cache';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export async function dismissNoticeAction(formData: FormData): Promise<void> {
  const id = String(formData.get('notification_id') ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return;

  const me = await requireParent();
  if (!me) return;

  await query(
    `UPDATE portal_notification_recipients
        SET dismissed_at = now()
      WHERE notification_id = $1 AND parent_id = $2 AND school_id = $3`,
    [id, me.parent.id, me.parent.school_id],
  );
  revalidatePath('/home');
}
