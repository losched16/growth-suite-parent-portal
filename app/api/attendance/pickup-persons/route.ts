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

  // Per-student authorization (Rachel's ask): the form submits one
  // `authorized_student_ids` value per checked kid. An empty list →
  // "authorized for every student in the family" (matches the back-
  // compat default for legacy rows; back-end keeps the junction empty).
  // We accept either repeated values OR a CSV (for JSON callers).
  const familyRow = await query<{ family_id: string }>(
    `SELECT family_id FROM parents WHERE id = $1`,
    [session.parent_id],
  );
  const familyId = familyRow.rows[0]?.family_id;
  if (!familyId) return badRequest(request, 'Could not resolve your family — please refresh.');

  const allStudentIds = (await query<{ id: string }>(
    `SELECT id FROM students WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
    [familyId, session.school_id],
  )).rows.map((r) => r.id);

  const requestedIds = fd
    .getAll('authorized_student_ids')
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  // Scope to this family — silently drop anything else (defense in depth).
  const scopedIds = requestedIds.filter((id) => allStudentIds.includes(id));
  // If the user checked every kid OR none, treat as "applies to all" by
  // leaving the junction empty. Cleaner data, same effective meaning.
  const persistIds = (scopedIds.length === 0 || scopedIds.length === allStudentIds.length)
    ? []
    : scopedIds;

  // Dedupe-aware insert: if a row already exists with this name (case-
  // insensitive) in the same family AND active=true, treat it as an
  // edit instead of an insert. Migration 045's partial unique index
  // would error otherwise.
  const ins = await query<{ id: string }>(
    `INSERT INTO pickup_persons (school_id, added_by_parent_id, family_id, name, relationship, phone, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (school_id, family_id, lower(name)) WHERE active = true
     DO UPDATE SET relationship = EXCLUDED.relationship,
                   phone = COALESCE(EXCLUDED.phone, pickup_persons.phone),
                   notes = COALESCE(EXCLUDED.notes, pickup_persons.notes),
                   updated_at = now()
     RETURNING id`,
    [session.school_id, session.parent_id, familyId, name, relationship, phone, notes],
  );
  const pickupPersonId = ins.rows[0].id;

  // Replace the per-student authorization set in one transaction-ish
  // pair: delete + insert. Empty `persistIds` means "all kids".
  await query(`DELETE FROM pickup_person_students WHERE pickup_person_id = $1`, [pickupPersonId]);
  for (const sid of persistIds) {
    await query(
      `INSERT INTO pickup_person_students (pickup_person_id, student_id, school_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (pickup_person_id, student_id) DO NOTHING`,
      [pickupPersonId, sid, session.school_id],
    );
  }

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

  // If `authorized_student_ids` is in the form, also replace the
  // per-student authorization set. Same convention as POST: empty
  // list (or all-kids) means "applies to all" → junction stays empty.
  if (fd.has('authorized_student_ids') || fd.get('_update_students') === '1') {
    const familyRow = await query<{ family_id: string }>(
      `SELECT family_id FROM parents WHERE id = $1`,
      [session.parent_id],
    );
    const familyId = familyRow.rows[0]?.family_id;
    if (familyId) {
      const allStudentIds = (await query<{ id: string }>(
        `SELECT id FROM students WHERE family_id = $1 AND school_id = $2 AND status = 'active'`,
        [familyId, session.school_id],
      )).rows.map((r) => r.id);

      const requestedIds = fd
        .getAll('authorized_student_ids')
        .flatMap((v) => String(v).split(','))
        .map((s) => s.trim())
        .filter(Boolean);
      const scopedIds = requestedIds.filter((sid) => allStudentIds.includes(sid));
      const persistIds = (scopedIds.length === 0 || scopedIds.length === allStudentIds.length)
        ? []
        : scopedIds;

      await query(`DELETE FROM pickup_person_students WHERE pickup_person_id = $1`, [id]);
      for (const sid of persistIds) {
        await query(
          `INSERT INTO pickup_person_students (pickup_person_id, student_id, school_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (pickup_person_id, student_id) DO NOTHING`,
          [id, sid, session.school_id],
        );
      }
    }
  }

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
