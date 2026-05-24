// /pay/[schoolSlug]/[productSlug]
//
// Public hosted payment page. No auth required — anyone with the URL
// can pay. Use cases:
//   - GHL form "thank you" redirect (school sells event tickets via
//     a GHL native form, then sends buyers here to actually pay)
//   - Email blasts ("Donate to our annual fund")
//   - Social posts / printed flyers (QR code → this URL)
//   - Direct shares to non-parent supporters
//
// Charge flows through the SCHOOL'S Stripe Connect account, never the
// platform's. School name + branding are loaded from the schools row.
//
// schoolSlug is either the school's ghl_location_id OR a future
// human-friendly slug. We try ghl_location_id first, then fall back
// to school_id (UUID) — handles both URL styles.

import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { PaymentForm } from './PaymentForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolSlug: string; productSlug: string }>;
type SearchParams = Promise<{ qty?: string; amount?: string; email?: string; name?: string; ref?: string }>;

interface SchoolRow {
  id: string;
  name: string;
  ghl_location_id: string | null;
}

interface ProductRow {
  id: string;
  school_id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  product_type: 'one_time' | 'recurring' | 'donation';
  price_cents: number | null;
  suggested_amounts_cents: number[] | null;
  donation_min_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  per_student: boolean;
  max_quantity: number | null;
  available_to: 'parents' | 'public' | 'both';
  available_from: string | null;
  available_until: string | null;
  image_url: string | null;
  is_active: boolean;
}

interface PaymentAccountRow {
  charges_enabled: boolean;
}

export default async function HostedPaymentPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { schoolSlug, productSlug } = await params;
  const sp = await searchParams;

  // Resolve the school. Try ghl_location_id first, then UUID fallback.
  const schoolRows = (await query<SchoolRow>(
    `SELECT id, name, ghl_location_id FROM schools
      WHERE ghl_location_id = $1 OR id::text = $1
      LIMIT 1`,
    [schoolSlug],
  )).rows;
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Resolve the product
  const productRows = (await query<ProductRow>(
    `SELECT id, school_id, slug, name, description, category, product_type,
            price_cents, suggested_amounts_cents, donation_min_cents,
            recurring_interval, recurring_installment_count, per_student,
            max_quantity, available_to, available_from, available_until,
            image_url, is_active
       FROM school_products
      WHERE school_id = $1 AND slug = $2`,
    [school.id, productSlug],
  )).rows;
  if (productRows.length === 0) notFound();
  const product = productRows[0];

  // Availability checks — return a friendly explanation rather than 404
  if (!product.is_active) return <Unavailable reason="inactive" school={school.name} />;
  if (product.available_to === 'parents') return <Unavailable reason="parents_only" school={school.name} />;

  const now = new Date();
  if (product.available_from && new Date(product.available_from) > now) {
    return <Unavailable reason="not_yet" school={school.name} date={product.available_from} />;
  }
  if (product.available_until && new Date(product.available_until) < now) {
    return <Unavailable reason="ended" school={school.name} date={product.available_until} />;
  }

  // Make sure the school's Stripe Connect is ready
  const paymentAccount = (await query<PaymentAccountRow>(
    `SELECT charges_enabled FROM payment_accounts WHERE school_id = $1`,
    [school.id],
  )).rows[0];
  if (!paymentAccount?.charges_enabled) {
    return <Unavailable reason="payments_not_ready" school={school.name} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <header className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-gray-500">{school.name}</p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-semibold text-gray-900">
            {product.name}
          </h1>
          {product.category ? (
            <p className="mt-1 text-xs text-gray-500">{product.category}</p>
          ) : null}
        </header>

        {product.image_url ? (
          <div className="mb-5 overflow-hidden rounded-lg bg-white border border-gray-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={product.image_url} alt={product.name} className="w-full" />
          </div>
        ) : null}

        {product.description ? (
          <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700 whitespace-pre-wrap">
            {product.description}
          </div>
        ) : null}

        <PaymentForm
          schoolName={school.name}
          product={{
            id: product.id,
            slug: product.slug,
            name: product.name,
            product_type: product.product_type,
            price_cents: product.price_cents,
            suggested_amounts_cents: product.suggested_amounts_cents,
            donation_min_cents: product.donation_min_cents,
            recurring_interval: product.recurring_interval,
            recurring_installment_count: product.recurring_installment_count,
            max_quantity: product.max_quantity,
            per_student: product.per_student,
          }}
          schoolSlug={schoolSlug}
          defaults={{
            email: sp.email ?? '',
            name: sp.name ?? '',
            quantity: sp.qty ? Math.max(1, Number(sp.qty)) : 1,
            amount: sp.amount ? Number(sp.amount) : null,
          }}
          sourceRef={sp.ref ?? null}
        />

        <p className="mt-6 text-center text-[11px] text-gray-500">
          Secure payment processed by Stripe on behalf of {school.name}.
        </p>
      </div>
    </div>
  );
}

function Unavailable({
  reason, school, date,
}: { reason: 'inactive' | 'parents_only' | 'not_yet' | 'ended' | 'payments_not_ready'; school: string; date?: string }) {
  const text: Record<typeof reason, string> = {
    inactive: 'This item is no longer available.',
    parents_only: `Only enrolled families at ${school} can purchase this. Please log in to the parent portal.`,
    not_yet: `Sales for this item open on ${date ? new Date(date).toLocaleDateString() : 'a later date'}.`,
    ended: `Sales for this item ended on ${date ? new Date(date).toLocaleDateString() : 'an earlier date'}.`,
    payments_not_ready: `${school} hasn't finished setting up payments yet. Please check back soon.`,
  };
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-900">Not available</h1>
        <p className="mt-3 text-sm text-gray-700">{text[reason]}</p>
      </div>
    </div>
  );
}
