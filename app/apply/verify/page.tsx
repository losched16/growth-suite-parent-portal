// /apply/verify?t=<token> — the emailed link. A valid token proves the mailbox;
// the visitor picks a password and /api/apply/complete creates the account.

import Link from 'next/link';
import { GraduationCap, AlertCircle } from 'lucide-react';
import { PasswordInput } from '@/app/login/PasswordInput';
import {
  loadApplyBranding, loadOpenApplyBySchool, verifyApplyToken,
} from '@/lib/apply/open-applications';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ t?: string; err?: string }>;

export default async function ApplyVerifyPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const claims = await verifyApplyToken(sp.t);
  const cfg = claims ? await loadOpenApplyBySchool(claims.school_id) : null;
  const b = cfg ? await loadApplyBranding(cfg.schoolId, cfg.schoolName) : null;

  return (
    <main
      className="flex flex-1 items-center justify-center px-4 py-16"
      style={b ? ({ ['--brand' as string]: b.primary_color, ['--brand-soft' as string]: b.primary_color_soft, ['--brand-fg' as string]: b.primary_color_fg } as React.CSSProperties) : {}}
    >
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-full" style={{ background: b ? 'var(--brand-soft)' : '#e5e7eb' }}>
            {b?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.logo_url} alt="" className="h-12 w-12 object-contain" />
            ) : (
              <GraduationCap className="h-6 w-6 text-gray-600" />
            )}
          </div>
          <h1 className="text-xl font-semibold text-gray-900">{b?.display_name ?? 'Family Portal'}</h1>
          <p className="mt-1 text-sm text-gray-500">{claims ? 'Email confirmed. Choose a password to continue.' : 'This link has expired.'}</p>
        </div>

        {!claims || !cfg ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              This confirmation link is invalid or has expired. Start again to get a new one.
            </div>
            <Link href="/login" className="inline-block text-sm underline text-gray-600">Go to sign in</Link>
          </div>
        ) : (
          <>
            {sp.err ? (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{sp.err === 'mismatch' ? 'Those passwords do not match.' : 'Use at least 8 characters.'}</span>
              </div>
            ) : null}
            <form action="/api/apply/complete" method="POST" className="space-y-3">
              <input type="hidden" name="t" value={sp.t} />
              <div className="font-mono text-xs text-gray-500">{claims.email}</div>
              <label htmlFor="password" className="mt-2 block text-sm font-medium text-gray-700">Create a password</label>
              <PasswordInput id="password" name="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" autoFocus />
              <label htmlFor="password_confirm" className="block text-sm font-medium text-gray-700">Confirm password</label>
              <PasswordInput id="password_confirm" name="password_confirm" minLength={8} autoComplete="new-password" />
              <button type="submit" className="w-full rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90" style={{ background: 'var(--brand)' }}>
                Create account &amp; start application
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
