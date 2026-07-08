// /forgot-password — the page behind the login screen's "Forgot Password?"
// link. One email field → branded reset email. The endpoint responds
// neutrally whether or not the email is on file.

import Link from 'next/link';
import { headers } from 'next/headers';
import { loadBrandingByHost } from '@/lib/branding';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ email?: string; sent?: string }>;

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const branding = await loadBrandingByHost(host);
  const appName = branding?.display_name ?? process.env.NEXT_PUBLIC_APP_NAME ?? 'Family Portal';

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-16"
      style={branding ? {
        ['--brand' as string]: branding.primary_color,
        ['--brand-soft' as string]: branding.primary_color_soft,
        ['--brand-fg' as string]: branding.primary_color_fg,
      } : undefined}
    >
      <div className="w-full max-w-md">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">{appName}</h1>
          <p className="mt-1 text-sm text-gray-600">Reset your password.</p>
        </div>

        {sp.sent === '1' ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              If that email is on file, a reset link is on its way. It expires in 60 minutes —
              check spam if you don&rsquo;t see it.
            </div>
            <Link href="/login" className="text-sm underline text-gray-600 hover:text-gray-900">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form action="/api/auth/password-reset/request" method="POST" className="space-y-3">
            <input type="hidden" name="from" value="forgot" />
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email address
            </label>
            <input
              id="email" name="email" type="email" required autoFocus
              autoComplete="email"
              defaultValue={sp.email ?? ''}
              placeholder="you@example.com"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
            <button
              type="submit"
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              style={{ background: branding ? 'var(--brand)' : '#047857' }}
            >
              Email me a reset link
            </button>
            <Link href="/login" className="block text-center text-xs underline text-gray-500 hover:text-gray-800">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
