// GET /api/demo-login?school=<ghl_location_id>
//
// Zero-hurdle demo access: one click lands you in the parent portal as
// a school's DEMO family — no login, no magic link, no password, no
// email config required. Safe to share and safe to leave on, because it
// can ONLY ever sign in as a family explicitly marked "(DEMO)" in its
// display name. Real families are never reachable through this route, so
// there's no impersonation surface.
//
// Used for sales demos / handing a prospective school a link to see the
// parent experience for themselves.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
  mintSession,
  recordSession,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

interface DemoParentRow {
  id: string;
  school_id: string;
  family_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export async function GET(request: NextRequest) {
  const location = (request.nextUrl.searchParams.get('school') ?? '').trim();
  if (!location) {
    return new NextResponse('Missing ?school=<location id>', { status: 400 });
  }
  // Optional: target a SPECIFIC demo family (so several admins can each have
  // their own one-click test login). Still bounded by the "(DEMO)" guard
  // below, so it can only ever resolve a demo family. Invalid → ignored.
  const familyRaw = (request.nextUrl.searchParams.get('family') ?? '').trim();
  const familyId = /^[0-9a-fA-F-]{36}$/.test(familyRaw) ? familyRaw : null;

  // Resolve the school's DEMO family's primary parent. The "(DEMO)"
  // display-name guard is the security boundary — this route cannot
  // return a real family, regardless of input.
  const { rows } = await query<DemoParentRow>(
    `SELECT p.id, p.school_id, p.family_id, p.email, p.first_name, p.last_name
       FROM parents p
       JOIN families f ON f.id = p.family_id
       JOIN schools s ON s.id = f.school_id
      WHERE s.ghl_location_id = $1
        AND f.display_name ILIKE '%(demo)%'
        AND p.status = 'active'
        AND ($2::uuid IS NULL OR f.id = $2::uuid)
      ORDER BY p.is_primary DESC, p.created_at ASC
      LIMIT 1`,
    [location, familyId],
  );
  if (rows.length === 0) {
    return new NextResponse(
      'No demo family found for this school. Create a family with "(DEMO)" in its name first.',
      { status: 404 },
    );
  }
  const p = rows[0];

  const jwt = await mintSession({
    parent_id: p.id,
    school_id: p.school_id,
    family_id: p.family_id,
    email: p.email ?? `${p.first_name ?? 'demo'}@demo.local`,
  });

  await recordSession({
    parent_id: p.id,
    school_id: p.school_id,
    ip: request.headers.get('x-forwarded-for') ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
  }).catch(() => undefined);

  const url = request.nextUrl.clone();
  url.pathname = '/';
  url.search = '';
  const response = NextResponse.redirect(url, 303);
  response.cookies.set({
    name: PARENT_SESSION_COOKIE,
    value: jwt,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PARENT_SESSION_TTL_S,
  });
  return response;
}
