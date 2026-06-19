// /notifications — the parent's in-portal notification inbox.
//
// Lists every notification delivered to this parent, newest first. We
// capture each item's read state for display, then mark all unread ones
// read (so the bell badge clears on the next navigation).

import Link from 'next/link';
import { Bell, ExternalLink } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  title: string;
  body: string;
  link_url: string | null;
  link_label: string | null;
  pinned: boolean;
  created_at: string;
  read_at: string | null;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default async function NotificationsInbox() {
  const me = await requireParent();

  const { rows } = await query<Row>(
    `SELECT n.id, n.title, n.body, n.link_url, n.link_label, n.pinned,
            n.created_at, r.read_at
       FROM portal_notification_recipients r
       JOIN portal_notifications n ON n.id = r.notification_id
      WHERE r.school_id = $1 AND r.parent_id = $2
      ORDER BY n.created_at DESC
      LIMIT 100`,
    [me.parent.school_id, me.parent.id],
  );

  // Mark everything read now that they're looking at it.
  await query(
    `UPDATE portal_notification_recipients SET read_at = now()
      WHERE school_id = $1 AND parent_id = $2 AND read_at IS NULL`,
    [me.parent.school_id, me.parent.id],
  );

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Bell className="h-5 w-5" style={{ color: 'var(--brand)' }} /> Notifications
        </h1>
        <p className="mt-1 text-sm text-gray-600">Updates from {me.branding.display_name}.</p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
          <Bell className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <p className="text-sm text-gray-500">No notifications yet. We&rsquo;ll let you know when there&rsquo;s something new.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((n) => {
            const isNew = n.read_at === null;
            return (
              <li
                key={n.id}
                className={`rounded-lg border bg-white p-4 ${isNew ? 'border-l-4 border-l-emerald-500 border-gray-200' : 'border-gray-200'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-gray-900">{n.title}</h2>
                  {isNew ? (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">New</span>
                  ) : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{n.body}</p>
                {n.link_url ? (
                  <a
                    href={n.link_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                    style={{ background: 'var(--brand)' }}
                  >
                    {n.link_label || 'Open link'} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
                <div className="mt-2 text-[11px] text-gray-400">{fmt(n.created_at)}</div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="pt-2">
        <Link href="/home" className="text-xs text-gray-500 hover:text-gray-700">← Back to your portal</Link>
      </div>
    </div>
  );
}
