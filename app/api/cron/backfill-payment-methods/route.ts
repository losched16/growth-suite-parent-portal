// POST /api/cron/backfill-payment-methods?school=<schoolId>
//
// Recovery for payment methods whose `payment_method.attached` webhook
// was dropped because the family's stripe_customer_ids cache had been
// wiped by a GHL snapshot rebuild (the cache lives on the family row;
// the sync rebuilds family rows). Walks the school's connected-account
// Customers, restores the family↔customer mapping from the Customer
// metadata (family_id / school_id set at creation), and upserts every
// attached card / US bank account into payment_methods — the same
// shape the webhook writes.
//
// Auth: Authorization: Bearer <CRON_SECRET> (same guard as the crons).
// Idempotent — reruns upsert.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { query } from '@/lib/db';
import type Stripe from 'stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // Accepts CRON_SECRET (Vercel cron convention) or BACKFILL_SECRET (a
  // separately-minted operator secret — sensitive env values cannot be
  // read back out of Vercel, so operators cannot present CRON_SECRET).
  const auth = request.headers.get('authorization') ?? '';
  const ok = [process.env.CRON_SECRET, process.env.BACKFILL_SECRET]
    .filter(Boolean)
    .some((s) => auth === `Bearer ${s}`);
  if (!ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const schoolId = request.nextUrl.searchParams.get('school');
  if (!schoolId) return NextResponse.json({ error: 'school required' }, { status: 400 });

  const { rows: accts } = await query<{ stripe_account_id: string }>(
    `SELECT stripe_account_id FROM payment_accounts
      WHERE school_id = $1 AND disconnected_at IS NULL AND stripe_account_id IS NOT NULL`,
    [schoolId],
  );
  const acct = accts[0]?.stripe_account_id;
  if (!acct) return NextResponse.json({ error: 'no connected account' }, { status: 404 });

  const out = {
    customers_seen: 0, mappings_restored: 0,
    methods_upserted: 0, skipped_no_family: 0,
    families: [] as string[],
  };

  // Walk every Customer on the connected account (bounded: small schools).
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page++) {
    const batch: Stripe.ApiList<Stripe.Customer> = await stripe().customers.list(
      { limit: 100, starting_after: startingAfter },
      { stripeAccount: acct },
    );
    for (const cust of batch.data) {
      out.customers_seen++;
      const famId = cust.metadata?.family_id;
      const schId = cust.metadata?.school_id;
      if (!famId || schId !== schoolId) { out.skipped_no_family++; continue; }

      // Restore the mapping on the family row (no-op if already there).
      const { rows: fam } = await query<{ id: string }>(
        `UPDATE families
            SET stripe_customer_ids =
                  coalesce(stripe_customer_ids, '{}'::jsonb)
                  || jsonb_build_object($1::text, $2::text),
                updated_at = now()
          WHERE id = $3 AND school_id = $1
          RETURNING id`,
        [schoolId, cust.id, famId],
      );
      if (!fam[0]) { out.skipped_no_family++; continue; }
      out.mappings_restored++;

      // Pull every attached card + bank account for this customer.
      for (const type of ['card', 'us_bank_account'] as const) {
        const pms = await stripe().paymentMethods.list(
          { customer: cust.id, type, limit: 20 },
          { stripeAccount: acct },
        );
        for (const pm of pms.data) {
          const isCard = pm.type === 'card';
          const brand = isCard ? (pm.card?.brand ?? null) : (pm.us_bank_account?.bank_name ?? null);
          const last4 = isCard ? (pm.card?.last4 ?? null) : (pm.us_bank_account?.last4 ?? null);
          const { rows: existing } = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM payment_methods
               WHERE school_id = $1 AND family_id = $2 AND active = true`,
            [schoolId, famId],
          );
          const shouldBeDefault = Number(existing[0]?.count ?? 0) === 0;
          await query(
            `INSERT INTO payment_methods
               (school_id, family_id, stripe_payment_method_id, stripe_customer_id,
                type, brand, last4, exp_month, exp_year, is_default, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
             ON CONFLICT (school_id, stripe_payment_method_id) DO UPDATE SET
               brand = EXCLUDED.brand, last4 = EXCLUDED.last4,
               exp_month = EXCLUDED.exp_month, exp_year = EXCLUDED.exp_year,
               active = true, updated_at = now()`,
            [schoolId, famId, pm.id, cust.id, pm.type, brand, last4,
             isCard ? (pm.card?.exp_month ?? null) : null,
             isCard ? (pm.card?.exp_year ?? null) : null,
             shouldBeDefault],
          );
          out.methods_upserted++;
          out.families.push(famId);
        }
      }
    }
    if (!batch.has_more) break;
    startingAfter = batch.data[batch.data.length - 1]?.id;
  }

  out.families = [...new Set(out.families)];
  return NextResponse.json(out);
}
