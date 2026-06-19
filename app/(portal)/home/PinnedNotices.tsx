// Pinned notification banners on the Home page. Renders any pinned, not-
// yet-dismissed notifications for this parent up top, so important notices
// are unmissable. Dismiss hides the banner (the item stays in /notifications).

import { Megaphone, X, ExternalLink } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { dismissNoticeAction } from '@/lib/actions/dismiss-notice';

interface Row {
  id: string;
  title: string;
  body: string;
  link_url: string | null;
  link_label: string | null;
}

export async function PinnedNotices() {
  const me = await requireParent();
  if (!me) return null;

  const { rows } = await query<Row>(
    `SELECT n.id, n.title, n.body, n.link_url, n.link_label
       FROM portal_notification_recipients r
       JOIN portal_notifications n ON n.id = r.notification_id
      WHERE r.school_id = $1 AND r.parent_id = $2
        AND r.dismissed_at IS NULL AND n.pinned = true
      ORDER BY n.created_at DESC
      LIMIT 5`,
    [me.parent.school_id, me.parent.id],
  );
  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      {rows.map((n) => (
        <section
          key={n.id}
          className="rounded-lg border-l-4 p-4 shadow-sm"
          style={{ borderLeftColor: 'var(--brand)', background: 'var(--brand-soft)' }}
        >
          <div className="flex items-start gap-3">
            <Megaphone className="h-5 w-5 shrink-0 mt-0.5" style={{ color: 'var(--brand)' }} />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-gray-900">{n.title}</h2>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-gray-700">{n.body}</p>
              {n.link_url ? (
                <a
                  href={n.link_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                  style={{ background: 'var(--brand)' }}
                >
                  {n.link_label || 'Open link'} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            <form action={dismissNoticeAction}>
              <input type="hidden" name="notification_id" value={n.id} />
              <button
                type="submit"
                aria-label="Dismiss"
                className="rounded p-1 text-gray-400 hover:bg-white/60 hover:text-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
          </div>
        </section>
      ))}
    </div>
  );
}
