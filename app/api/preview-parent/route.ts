// GET /api/preview-parent?p=<parent_id>&exp=<unix>&sig=<hmac>
//
// Admin "see what this parent sees" preview. The dashboards render a
// signed, short-lived link next to each parent; clicking it logs the
// admin into the parent portal AS that parent so they can preview the
// exact experience (tuition, invoices, forms).
//
// Security: the link is an HMAC over `${parent_id}.${exp}` keyed by the
// shared ENCRYPTION_KEY (only the dashboards + portal hold it), with a
// short expiry. It can't be forged or guessed, and it goes stale fast,
// so it's not a standing "become any parent" backdoor.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  PARENT_SESSION_COOKIE, PARENT_SESSION_TTL_S, mintSession, recordSession,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function expectedSig(parentId: string, exp: string): string | null {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) return null;
  return crypto.createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`${parentId}.${exp}`).digest('hex');
}
function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

export async function GET(request: NextRequest) {
  const p = (request.nextUrl.searchParams.get('p') ?? '').trim();
  const exp = (request.nextUrl.searchParams.get('exp') ?? '').trim();
  const sig = (request.nextUrl.searchParams.get('sig') ?? '').trim().toLowerCase();
  if (!p || !exp || !sig) return new NextResponse('Missing parameters', { status: 400 });

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) {
    return new NextResponse('This preview link has expired — reopen it from the dashboard.', { status: 410 });
  }
  const want = expectedSig(p, exp);
  if (!want || !safeEqHex(sig, want)) {
    return new NextResponse('Invalid preview link.', { status: 401 });
  }

  const { rows } = await query<{ id: string; school_id: string; family_id: string; email: string | null; first_name: string | null }>(
    `SELECT id, school_id, family_id, email, first_name FROM parents WHERE id = $1 AND status = 'active' LIMIT 1`,
    [p],
  );
  const parent = rows[0];
  if (!parent) return new NextResponse('Parent not found.', { status: 404 });

  const jwt = await mintSession({
    parent_id: parent.id, school_id: parent.school_id, family_id: parent.family_id,
    email: parent.email ?? `${parent.first_name ?? 'parent'}@preview.local`,
  });
  await recordSession({
    parent_id: parent.id, school_id: parent.school_id,
    ip: request.headers.get('x-forwarded-for') ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
  }).catch(() => undefined);

  const url = request.nextUrl.clone();
  url.pathname = '/';
  url.search = '';
  const res = NextResponse.redirect(url, 303);
  res.cookies.set({
    name: PARENT_SESSION_COOKIE, value: jwt, httpOnly: true, secure: true,
    sameSite: 'lax', path: '/', maxAge: PARENT_SESSION_TTL_S,
  });
  return res;
}
