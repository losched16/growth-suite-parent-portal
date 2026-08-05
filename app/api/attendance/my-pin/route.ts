// POST   /api/attendance/my-pin — parent sets their OWN kiosk PIN.
// DELETE /api/attendance/my-pin — parent clears it.
//
// Body (POST): { pin } — 4-8 digits, parent-chosen.
//
// Strictly self-scoped: a parent can only set THEIR pin, never a
// co-parent's. Divorced households each manage their own from their
// own login; nothing about the other parent's PIN is visible.
//
// School-wide uniqueness: two people sharing a PIN would make kiosk
// attribution ambiguous, so we reject a PIN whose lookup digest is
// already claimed by any parent or pickup person at the school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { hashPin, pinLookup, validateChosenPin } from '@/lib/attendance/pickup-pin';
import { encryptPin } from '@/lib/attendance/pin-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Office-managed schools (parent_managed_pickups=false, e.g. DGM):
  // parents may set their PIN ONCE (first-time setup stays self-serve),
  // but changing it afterward goes through the office so admissions
  // always knows the family's active PIN.
  {
    const { loadSchoolSettings } = await import('@/lib/school-settings');
    const settings = await loadSchoolSettings(session.school_id);
    if (!settings.parent_managed_pickups) {
      const { rows } = await query<{ has_pin: boolean }>(
        `SELECT pin_hash IS NOT NULL AS has_pin FROM parents WHERE id = $1`,
        [session.parent_id],
      );
      if (rows[0]?.has_pin) {
        return NextResponse.json(
          { error: 'office_managed', detail: 'Your PIN is already set — contact the school office to change it.' },
          { status: 403 },
        );
      }
    }
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';

  const problem = validateChosenPin(pin);
  if (problem) return NextResponse.json({ error: 'invalid_pin', detail: problem }, { status: 400 });

  const lookup = pinLookup(session.school_id, pin);

  // Uniqueness across parents + pickup persons in this school,
  // excluding the caller's own row (re-setting your own PIN to the
  // same value is a no-op, not a conflict).
  const { rows: clash } = await query<{ n: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM parents
         WHERE school_id = $1 AND pin_lookup = $2 AND id <> $3)
       +
       (SELECT COUNT(*) FROM pickup_persons
         WHERE school_id = $1 AND pin_lookup = $2 AND active = true)
     )::text AS n`,
    [session.school_id, lookup, session.parent_id],
  );
  if (Number(clash[0]?.n ?? 0) > 0) {
    return NextResponse.json({
      error: 'pin_taken',
      detail: 'That PIN is already in use at your school — please pick a different one.',
    }, { status: 409 });
  }

  const hash = await hashPin(pin);
  const enc = encryptPin(pin);
  await query(
    `UPDATE parents
        SET pin_hash = $1, pin_lookup = $2, pin_set_at = now(), updated_at = now(),
            pin_encrypted = $5, pin_iv = $6, pin_tag = $7
      WHERE id = $3 AND school_id = $4`,
    [hash, lookup, session.parent_id, session.school_id,
     enc?.ct ?? null, enc?.iv ?? null, enc?.tag ?? null],
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  {
    const { loadSchoolSettings } = await import('@/lib/school-settings');
    const settings = await loadSchoolSettings(session.school_id);
    if (!settings.parent_managed_pickups) {
      return NextResponse.json(
        { error: 'office_managed', detail: 'PINs are managed by the school office — please contact admissions.' },
        { status: 403 },
      );
    }
  }

  await query(
    `UPDATE parents
        SET pin_hash = NULL, pin_lookup = NULL, pin_set_at = NULL, pin_encrypted = NULL, pin_iv = NULL, pin_tag = NULL, updated_at = now()
      WHERE id = $1 AND school_id = $2`,
    [session.parent_id, session.school_id],
  );
  return NextResponse.json({ ok: true });
}
