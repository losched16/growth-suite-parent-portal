// Stripe Customer-per-family helper.
//
// Stripe Customers are required to attach saved payment methods. We
// create one Customer PER (school, family), nested inside the school's
// connected account. The id is cached on families.stripe_customer_ids
// (jsonb mapping school_id → cus_...).
//
// First payment creates it lazily; subsequent calls reuse it.

import { query } from '@/lib/db';
import { stripe } from './client';

interface FamilyContact {
  primary_email: string | null;
  primary_name: string;
  family_display_name: string | null;
}

export async function ensureStripeCustomerForFamily(opts: {
  schoolId: string;
  familyId: string;
  stripeAccountId: string;
}): Promise<string> {
  // Check the cached map first
  const { rows } = await query<{ stripe_customer_ids: Record<string, string> }>(
    `SELECT stripe_customer_ids FROM families WHERE id = $1`, [opts.familyId],
  );
  const cached = rows[0]?.stripe_customer_ids?.[opts.schoolId];
  if (cached) return cached;

  // Need to create it. Load family contact info for the Customer metadata.
  const { rows: fRows } = await query<FamilyContact>(
    `SELECT
        (SELECT email FROM parents WHERE family_id = $1 AND is_primary = true AND email IS NOT NULL LIMIT 1) AS primary_email,
        (SELECT CONCAT_WS(' ', first_name, last_name)
           FROM parents WHERE family_id = $1 AND is_primary = true LIMIT 1) AS primary_name,
        (SELECT display_name FROM families WHERE id = $1) AS family_display_name
    `, [opts.familyId],
  );
  const f = fRows[0] ?? { primary_email: null, primary_name: '', family_display_name: null };

  const customer = await stripe().customers.create(
    {
      email: f.primary_email ?? undefined,
      name: f.family_display_name || f.primary_name || undefined,
      metadata: {
        family_id: opts.familyId,
        school_id: opts.schoolId,
      },
    },
    { stripeAccount: opts.stripeAccountId },
  );

  // Persist back into the jsonb map (merge with existing keys)
  await query(
    `UPDATE families
        SET stripe_customer_ids = stripe_customer_ids || jsonb_build_object($1::text, $2::text),
            updated_at = now()
      WHERE id = $3`,
    [opts.schoolId, customer.id, opts.familyId],
  );
  return customer.id;
}
