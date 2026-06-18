// Parent login — email + password (no magic link, no email required).
//
// Two-step flow:
//   1. Parent enters email. If a parent record exists for that email:
//      - If password_hash is set     → show "Sign in" form
//      - If no password_hash yet     → show "Create your password" form
//      Either way, the next POST resolves them into a session.
//   2. Parent enters their password (or sets a new one) → signed in.
//
// We don't disclose whether an email is on file (security: prevents
// enumeration). If the email isn't found, we show the same "Set your
// password" form anyway and the POST silently no-ops on the server.
//
// Pre-login branding: if the request host is registered as a school's
// custom_host (e.g. family.woomontessori.org → Wooster), we render the
// header with that school's logo + brand color so the parent lands on
// a recognizably-school page before they sign in. Otherwise we fall
// through to the generic Family Portal branding.

import Link from 'next/link';
import { headers } from 'next/headers';
import { ShieldCheck, AlertCircle } from 'lucide-react';
import { query } from '@/lib/db';
import { loadBrandingByHost, type PreloginBranding } from '@/lib/branding';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  email?: string;
  err?: string;
  out?: string;
}>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const branding = await loadBrandingByHost(host);
  const appName = branding?.display_name
    ?? process.env.NEXT_PUBLIC_APP_NAME
    ?? 'Family Portal';

  // Step 1 — if no email yet, show the email-only form
  if (!sp.email) {
    return (
      <main
        className="flex flex-1 items-center justify-center px-4 py-16"
        style={brandStyle(branding)}
      >
        <div className="w-full max-w-md">
          <Header
            appName={appName}
            subtitle="Sign in with your email and password."
            branding={branding}
          />

          {sp.out === '1' ? (
            <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
              You&rsquo;ve been signed out.
            </div>
          ) : null}

          <form action="/login" method="GET" className="space-y-3">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email address
            </label>
            <input
              id="email" name="email" type="email" required autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              className={inputCls}
            />
            <PrimaryBtn branding={branding}>Continue</PrimaryBtn>
          </form>

          <Footer branding={branding} />
        </div>
      </main>
    );
  }

  const email = sp.email.trim().toLowerCase();

  // Look up whether this email has a password set. We DON'T disclose
  // existence — if the email isn't on file, we still show the "Create
  // your password" form, and the POST silently no-ops.
  const { rows } = await query<{ has_password: boolean }>(
    `SELECT (password_hash IS NOT NULL) AS has_password
       FROM parents
      WHERE LOWER(email) = $1 AND status = 'active'
      ORDER BY (password_hash IS NOT NULL) DESC
      LIMIT 1`,
    [email],
  );
  const hasPassword = rows[0]?.has_password === true;

  return (
    <main
      className="flex flex-1 items-center justify-center px-4 py-16"
      style={brandStyle(branding)}
    >
      <div className="w-full max-w-md">
        <Header
          appName={appName}
          subtitle={hasPassword
            ? `Welcome back. Sign in to continue.`
            : `First time here? Set a password so you can sign in any time.`}
          branding={branding}
        />

        {sp.err === 'wrong_password' ? (
          <ErrorBanner>Email or password is incorrect.</ErrorBanner>
        ) : sp.err === 'weak_password' ? (
          <ErrorBanner>Password must be at least 8 characters.</ErrorBanner>
        ) : sp.err === 'unknown_email' ? (
          <ErrorBanner>We couldn&rsquo;t find that email. Double-check it or contact the school office.</ErrorBanner>
        ) : sp.err === 'mismatch' ? (
          <ErrorBanner>Passwords didn&rsquo;t match. Try again.</ErrorBanner>
        ) : null}

        {hasPassword ? (
          // ── Sign-in mode ───────────────────────────────────────
          <form action="/api/auth/password-signin" method="POST" className="space-y-3">
            <input type="hidden" name="email" value={email} />
            <div>
              <div className="text-xs text-gray-500 mb-1 font-mono">{email}</div>
              <Link href="/login" className="text-[11px] underline" style={{ color: 'var(--brand-fg)' }}>
                use a different email
              </Link>
            </div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mt-2">
              Password
            </label>
            <input
              id="password" name="password" type="password" required autoFocus
              autoComplete="current-password"
              className={inputCls}
            />
            <PrimaryBtn branding={branding}>Sign in</PrimaryBtn>
          </form>
        ) : (
          // ── First-time / set-password mode ─────────────────────
          <form action="/api/auth/password-set" method="POST" className="space-y-3">
            <input type="hidden" name="email" value={email} />
            <div>
              <div className="text-xs text-gray-500 mb-1 font-mono">{email}</div>
              <Link href="/login" className="text-[11px] underline" style={{ color: 'var(--brand-fg)' }}>
                use a different email
              </Link>
            </div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mt-2">
              Create a password
            </label>
            <input
              id="password" name="password" type="password" required autoFocus
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              className={inputCls}
            />
            <label htmlFor="password_confirm" className="block text-sm font-medium text-gray-700">
              Confirm password
            </label>
            <input
              id="password_confirm" name="password_confirm" type="password" required
              minLength={8}
              autoComplete="new-password"
              className={inputCls}
            />
            <PrimaryBtn branding={branding}>Create password &amp; sign in</PrimaryBtn>
          </form>
        )}

        <Footer branding={branding} />
      </div>
    </main>
  );
}

// Inject brand CSS custom properties on the outer container so child
// buttons / links pick them up via var(--brand). Falls back to the
// emerald defaults already in globals.css when no branding match.
function brandStyle(b: PreloginBranding | null): React.CSSProperties {
  if (!b) return {};
  return {
    ['--brand' as string]: b.primary_color,
    ['--brand-soft' as string]: b.primary_color_soft,
    ['--brand-fg' as string]: b.primary_color_fg,
  };
}

function Header({ appName, subtitle, branding }: {
  appName: string;
  subtitle: string;
  branding: PreloginBranding | null;
}) {
  return (
    <div className="mb-6 text-center">
      <div
        className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full overflow-hidden"
        style={{
          background: branding ? 'var(--brand-soft)' : '#d1fae5',
        }}
      >
        {branding?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logo_url} alt="" className="h-12 w-12 object-contain" />
        ) : (
          <ShieldCheck
            className="h-6 w-6"
            style={{ color: branding ? 'var(--brand-fg)' : '#047857' }}
          />
        )}
      </div>
      <h1 className="text-xl font-semibold text-gray-900">{appName}</h1>
      <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
    </div>
  );
}

function Footer({ branding }: { branding: PreloginBranding | null }) {
  if (branding?.support_email || branding?.support_phone) {
    return (
      <p className="mt-6 text-center text-xs text-gray-400">
        Trouble signing in? Contact{' '}
        {branding.support_email ? (
          <a href={`mailto:${branding.support_email}`} className="underline" style={{ color: 'var(--brand-fg)' }}>
            {branding.support_email}
          </a>
        ) : null}
        {branding.support_email && branding.support_phone ? ' or ' : null}
        {branding.support_phone ? (
          <a href={`tel:${branding.support_phone}`} className="underline" style={{ color: 'var(--brand-fg)' }}>
            {branding.support_phone}
          </a>
        ) : null}
        .
      </p>
    );
  }
  return (
    <p className="mt-6 text-center text-xs text-gray-400">
      Trouble signing in? Contact your school directly.
    </p>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100';

// Primary submit button. Uses the school's brand color when a branding
// match is found; falls back to the emerald default otherwise.
function PrimaryBtn({ branding, children }: { branding: PreloginBranding | null; children: React.ReactNode }) {
  if (branding) {
    return (
      <button
        type="submit"
        className="w-full rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        style={{ background: 'var(--brand)' }}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type="submit"
      className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
    >
      {children}
    </button>
  );
}
