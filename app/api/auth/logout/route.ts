import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PARENT_SESSION_COOKIE } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('out', '1');
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: PARENT_SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
