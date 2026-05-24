// CRUD endpoints for a family's authorized pickup persons.
// All actions are scoped to the authenticated parent's school via session;
// editing an entry that doesn't belong to your family returns 403.
//
//   GET    → list all active pickup_persons visible to the parent's family
//   POST   → add new (multipart or form-encoded). Fields: name, relationship,
//            phone (optional), notes (optional)
//   PATCH  → edit existing. Fields: id, name?, relationship?, phone?,
//            notes?, active?
//   DELETE → deactivate (sets active=false; keeps row for audit/history)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface PickupPersonRow {
  id: string;
  school_id: string;
  added_by_parent_id: string;
  name: string;
  relationship: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
  added_by_first_name: string | null;
  added_by_last_name: string | null;
}

// ----- list helper used by GET + by other endpoints --------------------
//
// Visibility query per brief §5: pickup persons added by ANY parent who
// shares a family with the requesting parent. For now we approximate
// "shares a family" via parents.family_id since the unified stack
// already has that. Brief uses a `family_members` join table — same
// idea, different shape.
async function listFamilyPickupPersons(parentId: string, schoolId: string, includeInactive: boolean) {
  const { rows } = await query<PickupPersonRow>(
    `SELECT
       pp.id, pp.school_id, pp.added_by_parent_id, pp.name, pp.relationship,
       pp.phone, pp.notes, pp.active,
       p.first_name AS added_by_first_name, p.last_name AS added_by_last_name
     FROM pickup_persons pp
     JOIN parents p ON p.id = pp.added_by_parent_id
     WHERE pp.school_id = $1
       AND p.family_id = (SELECT family_id FROM parents WHERE id = $2)
       ${includeInactive ? '' : 'AND pp.active = true'}
     ORDER BY pp.active DESC, pp.name`,
    [schoolId, parentId],
  );
  return rows;
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });
  const includeInactive = request.nextUrl.searchParams.get('include_inactive') === '1';
  const rows = await listFamilyPickupPersons(session.parent_id, session.school_id, includeInactive);
  return NextResponse.json({ pickup_persons: rows });
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  // HTML forms only emit POST. Method-override pattern: a `_method`
  // field (or `?_method=DELETE` query param) lets the same form trigger
  // PATCH/DELETE without JS. Inline-dispatch here.
  const fd = await readForm(request);
  const override = (
    request.nextUrl.searchParams.get('_method') ||
    (fd.get('_method')?.toString() ?? '')
  ).toUpperCase();
  if (override === 'DELETE') return handleDelete(request, session, fd);
  if (override === 'PATCH') return handlePatch(request, session, fd);

  const name = (fd.get('name') ?? '').toString().trim();
  const relationship = (fd.get('relationship') ?? '').toString().trim();
  if (!name || !relationship) {
    return badRequest(request, 'Name and relationship are required.');
  }
  const phone = strOrNull(fd.get('phone'));
  const notes = strOrNull(fd.get('notes'));

  await query(
    `INSERT INTO pickup_persons (school_id, added_by_parent_id, name, relationship, phone, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [session.school_id, session.parent_id, name, relationship, phone, notes],
  );
  return redirectBack(request);
}

export async function PATCH(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });
  return handlePatch(request, session, await readForm(request));
}

export async function DELETE(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });
  return handleDelete(request, session, await readForm(request));
}

async function handlePatch(
  request: NextRequest,
  session: { parent_id: string; school_id: string },
  fd: FormData,
): Promise<NextResponse> {
  const id = (fd.get('id') ?? '').toString().trim();
  if (!id) return new NextResponse('id required', { status: 400 });

  const visible = await listFamilyPickupPersons(session.parent_id, session.school_id, true);
  if (!visible.some((p) => p.id === id)) return new NextResponse('forbidden', { status: 403 });

  const name = strOrNull(fd.get('name'));
  const relationship = strOrNull(fd.get('relationship'));
  const phone = strOrNull(fd.get('phone'));
  const notes = strOrNull(fd.get('notes'));
  const activeRaw = fd.get('active');
  const active = activeRaw === null ? null : activeRaw === '1' || activeRaw === 'true';

  await query(
    `UPDATE pickup_persons
     SET name         = COALESCE($1, name),
         relationship = COALESCE($2, relationship),
         phone        = COALESCE($3, phone),
         notes        = COALESCE($4, notes),
         active       = COALESCE($5, active)
     WHERE id = $6`,
    [name, relationship, phone, notes, active, id],
  );
  return redirectBack(request);
}

async function handleDelete(
  request: NextRequest,
  session: { parent_id: string; school_id: string },
  fd: FormData,
): Promise<NextResponse> {
  const id = (fd.get('id') ?? '').toString().trim();
  if (!id) return new NextResponse('id required', { status: 400 });
  const visible = await listFamilyPickupPersons(session.parent_id, session.school_id, true);
  if (!visible.some((p) => p.id === id)) return new NextResponse('forbidden', { status: 403 });
  await query(`UPDATE pickup_persons SET active = false WHERE id = $1`, [id]);
  return redirectBack(request);
}

// ----- helpers ----------------------------------------------------------

async function readForm(request: NextRequest): Promise<FormData> {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    return request.formData();
  }
  // Tolerate JSON for fetch() callers
  const fd = new FormData();
  try {
    const j = (await request.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) fd.set(k, String(v ?? ''));
  } catch {
    // empty
  }
  return fd;
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function redirectBack(request: NextRequest): NextResponse {
  const referer = request.headers.get('referer');
  const accept = request.headers.get('accept') ?? '';
  // If the form was submitted from a browser nav, 303 back to the page
  if (referer && !accept.includes('application/json')) {
    return NextResponse.redirect(referer, 303);
  }
  return NextResponse.json({ ok: true });
}

function badRequest(request: NextRequest, msg: string): NextResponse {
  const referer = request.headers.get('referer');
  if (referer) {
    const u = new URL(referer);
    u.searchParams.set('err', msg);
    return NextResponse.redirect(u, 303);
  }
  return new NextResponse(msg, { status: 400 });
}
