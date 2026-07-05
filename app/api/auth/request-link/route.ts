// POST form handler for /login. Always responds with 303 → /login?sent=1
// regardless of whether the email matched a parent (anti-enumeration).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { handleLoginRequest } from '@/lib/auth/magic-link';
import { schoolIdForHost } from '@/lib/branding';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
  const ua = request.headers.get('user-agent');

  if (email) {
    // Best-effort — failures (DB, email) are logged inside handleLoginRequest
    // but never bubble up. Always behave as if "we sent the link" to the user.
    try {
      await handleLoginRequest({
        rawEmail: email,
        origin: originFromRequest(request),
        requestIp: ip,
        userAgent: ua,
        hostSchoolId: await schoolIdForHost(
          request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
        ),
      });
    } catch (err) {
      console.error('[parent-portal] login request handler crashed:', err);
    }
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('sent', '1');
  url.searchParams.set('e', email.slice(0, 80));
  return NextResponse.redirect(url, 303);
}

function originFromRequest(request: NextRequest): string {
  const fwdProto = request.headers.get('x-forwarded-proto');
  const host = request.headers.get('host');
  const proto = fwdProto ?? request.nextUrl.protocol.replace(/:$/, '');
  if (host) return `${proto}://${host}`;
  return request.nextUrl.origin;
}
