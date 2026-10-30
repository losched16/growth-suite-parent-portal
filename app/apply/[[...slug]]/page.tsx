// /apply/<school-slug> — public "start an application" page. Anyone with the
// link can begin: they give name + email, we email a confirm link, and the
// account is created when they open it (see lib/apply/open-applications.ts).
// On a school-owned host, plain /apply resolves the school from the host.

import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GraduationCap, AlertCircle, MailCheck } from 'lucide-react';
import { schoolIdForHost } from '@/lib/branding';
import {
  loadApplyBranding, loadOpenApplyBySchool, loadOpenApplyBySlug,
} from '@/lib/apply/open-applications';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug?: string[] }>;
type SearchParams = Promise<{ sent?: string; email?: string; err?: string }>;

const inputCls =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200';

export default async function ApplyPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { slug } = await params;
  const sp = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');

  const cfg = slug?.[0]
    ? await loadOpenApplyBySlug(slug[0])
    : await (async () => {
        const id = await schoolIdForHost(host);
        return id ? loadOpenApplyBySchool(id) : null;
      })();
  if (!cfg) notFound();
  const b = await loadApplyBranding(cfg.schoolId, cfg.schoolName);

  return (
    <main
      className="flex flex-1 items-center justify-center px-4 py-16"
      style={{ ['--brand' as string]: b.primary_color, ['--brand-soft' as string]: b.primary_color_soft, ['--brand-fg' as string]: b.primary_color_fg } as React.CSSProperties}
    >
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-full" style={{ background: 'var(--brand-soft)' }}>
            {b.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.logo_url} alt="" className="h-12 w-12 object-contain" />
            ) : (
              <GraduationCap className="h-6 w-6" style={{ color: 'var(--brand-fg)' }} />
            )}
          </div>
          <h1 className="text-xl font-semibold text-gray-900">{b.display_name}</h1>
          <p className="mt-1 text-sm text-gray-500">Start your application</p>
        </div>

        {sp.sent === '1' ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <div className="mb-1 flex items-center gap-2 font-semibold"><MailCheck className="h-4 w-4" /> Check your email</div>
            We sent a confirmation link{sp.email ? <> to <span className="font-mono">{sp.email}</span></> : null}. Open it to create
            your password and begin the application. It can take a minute, and the link is good for 24 hours.
          </div>
        ) : (
          <>
            {sp.err ? (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Please enter your first name, last name and a valid email address.</span>
              </div>
            ) : null}
            <form action="/api/apply/start" method="POST" className="space-y-3">
              <input type="hidden" name="school" value={cfg.slug} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="first_name" className="block text-sm font-medium text-gray-700">First name</label>
                  <input id="first_name" name="first_name" required autoComplete="given-name" className={inputCls} />
                </div>
                <div>
                  <label htmlFor="last_name" className="block text-sm font-medium text-gray-700">Last name</label>
                  <input id="last_name" name="last_name" required autoComplete="family-name" className={inputCls} />
                </div>
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email address</label>
                <input id="email" name="email" type="email" required autoComplete="email" defaultValue={sp.email ?? ''} className={inputCls} />
              </div>
              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-gray-700">Mobile phone <span className="text-gray-400">(optional)</span></label>
                <input id="phone" name="phone" type="tel" autoComplete="tel" className={inputCls} />
              </div>
              <button type="submit" className="w-full rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90" style={{ background: 'var(--brand)' }}>
                Continue
              </button>
            </form>
            <p className="mt-4 text-center text-xs text-gray-500">
              Already started? <Link href="/login" className="underline">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
