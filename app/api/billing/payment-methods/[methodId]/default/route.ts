// POST /api/billing/payment-methods/{methodId}/default
//
// Marks one of the family's payment methods as the default for autopay.
// Atomic: clears default on all others in the same family first.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query, withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ methodId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { methodId } = await params;
  const session = await readSession();
  if (!session) return NextResponse.redirect(new URL('/login', request.url), 303);

  const url = new URL('/billing/payment-methods', request.url);

  // Verify ownership
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM payment_methods
       WHERE id = $1 AND school_id = $2 AND family_id = $3 AND active = true`,
    [methodId, session.school_id, session.family_id],
  );
  if (rows.length === 0) {
    url.searchParams.set('err', 'Payment method not found.');
    return NextResponse.redirect(url, 303);
  }

  await withTransaction(async (q) => {
    await q(
      `UPDATE payment_methods SET is_default = false, updated_at = now()
        WHERE school_id = $1 AND family_id = $2 AND is_default = true`,
      [session.school_id, session.family_id],
    );
    await q(
      `UPDATE payment_methods SET is_default = true, updated_at = now()
        WHERE id = $1`,
      [methodId],
    );
  });

  url.searchParams.set('msg', 'Default updated.');
  return NextResponse.redirect(url, 303);
}
