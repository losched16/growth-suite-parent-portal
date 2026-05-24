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
    '/((?!login|api/auth|api/dev|api/webhooks|api/cron|kiosk|api/kiosk|_next/static|_next/image|favicon.ico|robots.txt).*)',
  ],
};
