// POST /api/attendance/pickup-persons/set-pin
//
// Generates a fresh 6-digit PIN for the given pickup_persons row,
// shows it back to the parent ONCE in the response (so they can copy
// it and pass to Grandma), and stores only the hash. Re-generating
// invalidates the previous PIN.
//
// DELETE /api/attendance/pickup-persons/set-pin?id=<uuid>
// Revokes the PIN (clears pin_hash, pin_set_at, pin_expires_at).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { generatePin, hashPin } from '@/lib/attendance/pickup-pin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface OwnershipRow {
  id: string;
  school_id: string;
}

async function loadOwnedPickupPerson(
  pickupPersonId: string,
  parentId: string,
  schoolId: string,
): Promise<OwnershipRow | null> {
  const { rows } = await query<OwnershipRow>(
    `SELECT pp.id, pp.school_id
       FROM pickup_persons pp
       JOIN parents p ON p.id = pp.added_by_parent_id
      WHERE pp.id = $1
        AND pp.school_id = $2
        AND p.family_id = (SELECT family_id FROM parents WHERE id = $3)
      LIMIT 1`,
    [pickupPersonId, schoolId, parentId],
  );
  return rows[0] ?? null;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  let pickupPersonId = '';
  let expiresAt: string | null = null;
  let isTemporary = false;
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    pickupPersonId = String(body.id ?? '').trim();
    expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null;
    isTemporary = body.is_temporary === true;
  } else {
    const fd = await request.formData();
    pickupPersonId = String(fd.get('id') ?? '').trim();
    expiresAt = String(fd.get('expires_at') ?? '').trim() || null;
    isTemporary = fd.get('is_temporary') === '1';
  }

  if (!pickupPersonId) return new NextResponse('id required', { status: 400 });

  const owned = await loadOwnedPickupPerson(pickupPersonId, session.parent_id, session.school_id);
  if (!owned) return new NextResponse('forbidden', { status: 403 });

  const pin = generatePin();
  const pinHash = await hashPin(pin);

  await query(
    `UPDATE pickup_persons
        SET pin_hash = $1,
            pin_set_at = now(),
            pin_expires_at = $2,
            is_temporary = $3,
            active = true,
            updated_at = now()
      WHERE id = $4`,
    [pinHash, expiresAt, isTemporary, pickupPersonId],
  );

  // We return the redirect-friendly response on HTML form submits, but
  // PIN-show needs JS to display the PIN in a modal — so encourage JSON
  // callers always. If a browser POSTs HTML form, redirect with the PIN
  // in a one-time query (caller is responsible for clearing it).
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json')
    || ct.includes('application/json');
  if (wantsJson) {
    return NextResponse.json({
      ok: true,
      pin,
      pickup_person_id: pickupPersonId,
      expires_at: expiresAt,
      is_temporary: isTemporary,
    });
  }
  const referer = request.headers.get('referer') ?? '/settings/pickup-people';
  const u = new URL(referer, request.url);
  u.searchParams.set('new_pin', pin);
  u.searchParams.set('pin_for', pickupPersonId);
  return NextResponse.redirect(u, 303);
}

export async function DELETE(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return new NextResponse('id required', { status: 400 });

  const owned = await loadOwnedPickupPerson(id, session.parent_id, session.school_id);
  if (!owned) return new NextResponse('forbidden', { status: 403 });

  await query(
    `UPDATE pickup_persons
        SET pin_hash = NULL,
            pin_set_at = NULL,
            pin_expires_at = NULL,
            is_temporary = false,
            updated_at = now()
      WHERE id = $1`,
    [id],
  );
  return NextResponse.json({ ok: true });
}
