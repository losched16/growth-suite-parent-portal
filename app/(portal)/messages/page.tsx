// /messages — in-portal messaging has been removed. Parents email the
// school office directly instead of sending messages through the portal.
// The nav entry is gone; this page only renders if someone hits the URL
// directly (old bookmark/link), so it just points them to email.

import { Mail } from 'lucide-react';
import { requireParent } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const id = await requireParent();
  const email = id.branding.support_email;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Questions?</h1>
        <p className="mt-1 text-sm text-gray-600">
          For anything you need, email the school office and we&rsquo;ll get back to you.
        </p>
      </header>

      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center">
        <div
          className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: 'var(--brand-soft)', color: 'var(--brand-fg)' }}
        >
          <Mail className="h-6 w-6" />
        </div>
        {email ? (
          <>
            <p className="text-sm text-gray-700">Email us at</p>
            <a
              href={`mailto:${email}`}
              className="mt-1 inline-block text-base font-semibold underline"
              style={{ color: 'var(--brand)' }}
            >
              {email}
            </a>
          </>
        ) : (
          <p className="text-sm text-gray-700">
            Please contact the school office — see your welcome packet for contact details.
          </p>
        )}
        {id.branding.support_phone ? (
          <p className="mt-2 text-xs text-gray-500">Or call {id.branding.support_phone}.</p>
        ) : null}
      </div>
    </div>
  );
}
