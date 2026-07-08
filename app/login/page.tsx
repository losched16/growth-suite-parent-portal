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
import { PasswordInput } from './PasswordInput';
import { portalProvisioningAllowed } from '@/lib/auth/portal-provisioning';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  email?: string;
  err?: string;
  out?: string;
  msg?: string;
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

          <p className="mt-3 text-center">
            <Link href="/forgot-password" className="text-xs underline text-gray-500 hover:text-gray-800">
              Forgot Password?
            </Link>
          </p>

          <Footer branding={branding} />
        </div>
      </main>
    );
  }

  const email = sp.email.trim().toLowerCase();

  // Password creation is LOCKED to the contacts DB: an email only gets a
  // sign-in or create-password form if it matches an active parent record.
  // An unknown email gets a clear "not on file" message — we never show a
  // create-password form for an address the school doesn't have (which
  // misled testers into thinking any email could make an account).
  // On a school-owned custom host, resolution is scoped to that school —
  // the same email can exist as parent rows at two schools, and picking
  // the row with a password would land the parent in the wrong portal.
  const hostSchoolId = branding?.school_id ?? null;
  const { rows } = await query<{ has_password: boolean; school_id: string; family_id: string }>(
    `SELECT (password_hash IS NOT NULL) AS has_password, school_id, family_id
       FROM parents
      WHERE LOWER(email) = $1 AND status = 'active'
        AND ($2::uuid IS NULL OR school_id = $2::uuid)
      ORDER BY (password_hash IS NOT NULL) DESC
      LIMIT 1`,
    [email, hostSchoolId],
  );
  const onFile = rows.length > 0;
  const hasPassword = rows[0]?.has_password === true;
  // First-time provisioning is gated to the admissions "Pending" stage for
  // opted-in schools: an on-file email WITHOUT a password only gets the
  // create-password form when the family is eligible. Sign-in (already has a
  // password) is never gated — access persists once granted.
  const canProvision = onFile && !hasPassword && rows[0]
    ? await portalProvisioningAllowed(rows[0].school_id, rows[0].family_id)
    : true;

  return (
    <main
      className="flex flex-1 items-center justify-center px-4 py-16"
      style={brandStyle(branding)}
    >
      <div className="w-full max-w-md">
        <Header
          appName={appName}
          subtitle={!onFile
            ? `We don't have that email on file.`
            : hasPassword
              ? `Welcome back. Sign in to continue.`
              : canProvision
                ? `First time here? Set a password so you can sign in any time.`
                : `Your portal isn't available yet.`}
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
        ) : sp.err === 'not_eligible' ? (
          <ErrorBanner>Your portal isn&rsquo;t available yet. You&rsquo;ll be able to set it up once the school moves your enrollment forward.</ErrorBanner>
        ) : null}

        {sp.msg === 'reset_sent' ? (
          <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            If that email is on file, a password-reset link is on its way. It expires in 60 minutes —
            check spam if you don&rsquo;t see it.
          </div>
        ) : null}

        {!onFile ? (
          // ── Not on file — locked to the contacts DB ────────────
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              We don&rsquo;t have <span className="font-mono">{email}</span> on file. Please sign in with the
              email address your school has on record for you. If you think this is a mistake, contact the
              school office{branding?.support_email ? <> at <a href={`mailto:${branding.support_email}`} className="underline" style={{ color: 'var(--brand-fg)' }}>{branding.support_email}</a></> : ''}.
            </div>
            <Link
              href="/login"
              className="inline-block rounded-md px-3 py-2 text-sm font-medium text-white"
              style={{ background: 'var(--brand)' }}
            >
              Try a different email
            </Link>
          </div>
        ) : hasPassword ? (
          // ── Sign-in mode ───────────────────────────────────────
          <>
          <form action="/api/auth/password-signin" method="POST" className="space-y-3">
            <input type="hidden" name="email" value={email} />
            <div className="text-xs text-gray-500 font-mono">{email}</div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mt-2">
              Password
            </label>
            <PasswordInput id="password" name="password" autoComplete="current-password" autoFocus />
            <PrimaryBtn branding={branding}>Sign in</PrimaryBtn>
          </form>
          <p className="mt-3">
            <Link href={`/forgot-password?email=${encodeURIComponent(email)}`} className="text-xs underline text-gray-500 hover:text-gray-800">
              Forgot Password?
            </Link>
          </p>
          </>
        ) : canProvision ? (
          // ── First-time / set-password mode ─────────────────────
          <form action="/api/auth/password-set" method="POST" className="space-y-3">
            <input type="hidden" name="email" value={email} />
            <div className="text-xs text-gray-500 font-mono">{email}</div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mt-2">
              Create a password
            </label>
            <PasswordInput id="password" name="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" autoFocus />
            <label htmlFor="password_confirm" className="block text-sm font-medium text-gray-700">
              Confirm password
            </label>
            <PasswordInput id="password_confirm" name="password_confirm" minLength={8} autoComplete="new-password" />
            <PrimaryBtn branding={branding}>Create password &amp; sign in</PrimaryBtn>
          </form>
        ) : (
          // ── Not eligible — provisioning gated to the "Pending" stage ──
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Your family portal isn&rsquo;t available yet. You&rsquo;ll be able to set up your login once the
              school moves your enrollment forward. If you think this is a mistake, contact the school
              office{branding?.support_email ? <> at <a href={`mailto:${branding.support_email}`} className="underline" style={{ color: 'var(--brand-fg)' }}>{branding.support_email}</a></> : ''}.
            </div>
            <Link
              href="/login"
              className="inline-block rounded-md px-3 py-2 text-sm font-medium text-white"
              style={{ background: 'var(--brand)' }}
            >
              Try a different email
            </Link>
          </div>
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
