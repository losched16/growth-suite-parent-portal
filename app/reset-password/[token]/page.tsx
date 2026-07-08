// /reset-password/{token} — choose a new password from the emailed link.
// Branded like the login page; invalid/expired tokens get a friendly
// dead-end with a path back to requesting a fresh link.

import Link from 'next/link';
import { headers } from 'next/headers';
import { query } from '@/lib/db';
import { loadBrandingByHost } from '@/lib/branding';
import { PasswordInput } from '@/app/login/PasswordInput';

export const dynamic = 'force-dynamic';

type Params = Promise<{ token: string }>;
type SearchParams = Promise<{ err?: string }>;

export default async function ResetPasswordPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { token } = await params;
  const sp = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const branding = await loadBrandingByHost(host);
  const appName = branding?.display_name ?? process.env.NEXT_PUBLIC_APP_NAME ?? 'Family Portal';

  const { rows } = await query<{ email: string }>(
    `SELECT email FROM parent_password_reset_tokens
      WHERE token = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [token],
  );
  const valid = rows[0] ?? null;

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
          <p className="mt-1 text-sm text-gray-600">
            {valid ? 'Choose a new password.' : 'This reset link isn’t valid.'}
          </p>
        </div>

        {sp.err === 'weak_password' ? (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            Password must be at least 8 characters.
          </div>
        ) : sp.err === 'mismatch' ? (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            Passwords didn&rsquo;t match. Try again.
          </div>
        ) : sp.err === 'invalid' ? (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            This link has expired or was already used.
          </div>
        ) : null}

        {valid ? (
          <form action="/api/auth/password-reset/complete" method="POST" className="space-y-3">
            <input type="hidden" name="token" value={token} />
            <div className="text-xs font-mono text-gray-500">{valid.email}</div>
            <label htmlFor="password" className="mt-2 block text-sm font-medium text-gray-700">
              New password
            </label>
            <PasswordInput id="password" name="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" autoFocus />
            <label htmlFor="password_confirm" className="block text-sm font-medium text-gray-700">
              Confirm new password
            </label>
            <PasswordInput id="password_confirm" name="password_confirm" minLength={8} autoComplete="new-password" />
            <button
              type="submit"
              className="w-full rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              style={{ background: branding ? 'var(--brand)' : '#047857' }}
            >
              Set new password &amp; sign in
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Reset links expire after 60 minutes and can only be used once. Request a fresh one from the
              sign-in page.
            </div>
            <Link
              href="/login"
              className="inline-block rounded-md px-3 py-2 text-sm font-medium text-white"
              style={{ background: branding ? 'var(--brand)' : '#047857' }}
            >
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
