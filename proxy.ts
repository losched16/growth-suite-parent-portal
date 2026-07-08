// Next.js 16 renamed `middleware` to `proxy`. Same behavior.
// Guards every route except /login + /api/auth/* + Next plumbing.
// On miss, redirects to /login.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(PARENT_SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (session) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // `api/dev` is excluded because the dev-bypass route does its own
    // env-gated auth check; without exclusion the proxy would redirect
    // unauth'd hits to /login before the bypass logic could run.
    // The route itself returns 404 when DEV_AUTH_BYPASS != 'true'.
    //
    // `api/webhooks` is excluded so Stripe (and any future webhook
    // sender) can POST signed events to us without session cookies. The
    // route handler verifies STRIPE_WEBHOOK_SECRET signatures itself.
    //
    // `api/cron` is excluded so Vercel Cron can hit scheduled routes
    // without session cookies. Each cron route verifies a Bearer
    // CRON_SECRET header itself.
    //
    // `kiosk` and `api/kiosk` are excluded because the pickup-kiosk page
    // is used by non-parents (grandma, babysitter) who don't have a
    // parent portal session. Auth happens via a 6-digit PIN + per-IP
    // rate limiting on PIN attempts.
    //
    // `pay` and `api/billing/public` are excluded because the public
    // invoice pay page (/pay/invoice/<id>?t=<token>) is used by people
    // a school invoices who have no parent account — a GHL contact, a
    // one-off billee. Auth is the invoice's public_pay_token, verified
    // by the page + the public payment-intent route. (The /pay product
    // checkout pages were already outside the session model.)
    //
    // `api/admin-impersonate` is excluded because the route is itself
    // an auth-mint endpoint — it verifies a signed token in the URL,
    // mints the parent session cookie, and redirects to /home. If the
    // proxy fires first, it sees no cookie yet and bounces the admin
    // to /login — exactly what View as parent is designed to avoid.
    //
    // `api/demo-login` is excluded for the same reason: it's a zero-login
    // bypass that mints a parent session for a "(DEMO)"-guarded family and
    // redirects to /. Without this exclusion the proxy sees no cookie yet
    // and bounces to /login, defeating the whole point of the link. The
    // route's own "(DEMO)" display-name guard is the security boundary —
    // it can only ever resolve a demo family, never a real one.
    // `cosign` + `api/portal-forms/cosign` excluded: the counter-signature
    // page is used by a second guardian who has no parent account — auth is
    // the secure cosign_token emailed to them (same public-token model as
    // /pay). The general api/portal-forms/submit route stays guarded.
    //
    // `forgot-password` + `reset-password` excluded: both are used by
    // parents who, by definition, can't sign in. The reset page's auth is
    // the single-use emailed token.
    '/((?!login|forgot-password|reset-password|api/auth|api/admin-impersonate|api/demo-login|api/dev|api/webhooks|api/cron|kiosk|api/kiosk|pay|api/billing/public|cosign|api/portal-forms/cosign|_next/static|_next/image|favicon.ico|robots.txt).*)',
  ],
};
