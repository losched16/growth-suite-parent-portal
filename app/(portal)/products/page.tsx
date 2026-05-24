// /products — logged-in parents browse and buy school products.
//
// Shows everything the school has flagged available_to IN ('parents', 'both')
// that's currently within its sale window. Clicking "Buy" goes to the
// same hosted payment page used by public links, but pre-fills the
// parent's name + email so it's a one-tap purchase.

import Link from 'next/link';
import { Sparkles, Calendar, Tag, ShoppingBag, Heart, Gift, ChevronRight } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface ProductRow {
  id: string;
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
  image_url: string | null;
  position: number;
}

function fmtCents(c: number | null | undefined): string {
  if (c == null) return '—';
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export default async function ProductsPage() {
  const id = await requireParent();

  // Pull all products for this school that parents can buy + are in window
  const products = (await query<ProductRow>(
    `SELECT id, slug, name, description, category, product_type,
            price_cents, suggested_amounts_cents, donation_min_cents,
            recurring_interval, recurring_installment_count, per_student,
            image_url, position
       FROM school_products
      WHERE school_id = $1
        AND is_active = true
        AND available_to IN ('parents', 'both')
        AND (available_from IS NULL OR available_from <= now())
        AND (available_until IS NULL OR available_until >= now())
      ORDER BY position ASC, created_at DESC`,
    [id.parent.school_id],
  )).rows;

  // Group by category for visual organization
  const groups = new Map<string, ProductRow[]>();
  for (const p of products) {
    const cat = (p.category ?? '').trim() || 'Other';
    const list = groups.get(cat) ?? [];
    list.push(p);
    groups.set(cat, list);
  }
  // Sort categories: known ones first, "Other" last
  const knownOrder = ['event', 'donation', 'supplies', 'tuition_addon', 'activities', 'enrichment'];
  const sortedCategories = [...groups.keys()].sort((a, b) => {
    const ai = knownOrder.indexOf(a.toLowerCase());
    const bi = knownOrder.indexOf(b.toLowerCase());
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  // School slug for the hosted-link URL — uses GHL location id (or UUID fallback)
  const schoolSlug = id.school.ghl_location_id || id.school.id;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">School store</h1>
        <p className="mt-1 text-sm text-gray-600">
          Events, supplies, donations, and other items from {id.family.display_name?.includes(' Family') ? 'the school' : 'your school'}.
        </p>
      </header>

      {products.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-gray-200 bg-white p-12 text-center">
          <ShoppingBag className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm text-gray-700 font-medium">Nothing in the store yet</p>
          <p className="mt-1 text-xs text-gray-500 max-w-sm mx-auto">
            When the school posts events, fundraisers, or other items, they&rsquo;ll show up here.
          </p>
        </div>
      ) : (
        sortedCategories.map((cat) => (
          <section key={cat}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              {prettyCategory(cat)}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.get(cat)!.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  schoolSlug={schoolSlug}
                  parentEmail={id.parent.email}
                  parentName={`${id.parent.first_name} ${id.parent.last_name}`.trim()}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function prettyCategory(cat: string): string {
  const map: Record<string, string> = {
    event: 'Events',
    donation: 'Donations',
    supplies: 'Supplies',
    tuition_addon: 'Tuition Add-ons',
    activities: 'Activities',
    enrichment: 'Enrichment',
    Other: 'Other',
  };
  return map[cat] ?? map[cat.toLowerCase()] ?? cat;
}

function ProductCard({
  product, schoolSlug, parentEmail, parentName,
}: {
  product: ProductRow;
  schoolSlug: string;
  parentEmail: string | null;
  parentName: string;
}) {
  // Build pre-filled buy URL — uses the public hosted page so the
  // same code path serves portal + public + GHL-form-redirected buyers.
  const params = new URLSearchParams();
  if (parentEmail) params.set('email', parentEmail);
  if (parentName) params.set('name', parentName);
  params.set('ref', 'parent_portal');
  const href = `/pay/${schoolSlug}/${product.slug}?${params}`;

  const Icon = product.product_type === 'donation' ? Heart
    : product.product_type === 'recurring' ? Calendar
    : product.category?.toLowerCase().includes('gift') ? Gift
    : Tag;

  return (
    <Link
      href={href}
      className="group block rounded-lg border border-gray-200 bg-white hover:border-emerald-300 hover:shadow-sm transition overflow-hidden"
    >
      {product.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image_url} alt={product.name} className="w-full aspect-video object-cover" />
      ) : null}
      <div className="p-4">
        <div className="flex items-start gap-2">
          <Icon className="h-4 w-4 mt-0.5 text-gray-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 line-clamp-2">{product.name}</h3>
            {product.description ? (
              <p className="mt-0.5 text-xs text-gray-600 line-clamp-2">{product.description}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <PriceDisplay product={product} />
          <span className="inline-flex items-center gap-0.5 text-xs text-emerald-700 font-medium opacity-0 group-hover:opacity-100 transition">
            Buy <ChevronRight className="h-3 w-3" />
          </span>
        </div>
        {product.per_student ? (
          <div className="mt-2 inline-block rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
            Per student
          </div>
        ) : null}
      </div>
    </Link>
  );
}

function PriceDisplay({ product }: { product: ProductRow }) {
  if (product.product_type === 'donation') {
    const first = product.suggested_amounts_cents?.[0];
    return (
      <div className="text-sm">
        <span className="text-gray-700">
          {first ? `From ${fmtCents(first)}` : 'Any amount'}
        </span>
        <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
          <Sparkles className="h-2.5 w-2.5" /> Donation
        </span>
      </div>
    );
  }
  if (product.product_type === 'recurring') {
    return (
      <div className="text-sm">
        <span className="font-semibold text-gray-900">{fmtCents(product.price_cents)}</span>
        <span className="text-xs text-gray-500 ml-1">
          /{product.recurring_interval}
          {product.recurring_installment_count ? ` × ${product.recurring_installment_count}` : ''}
        </span>
      </div>
    );
  }
  return <div className="text-sm font-semibold text-gray-900">{fmtCents(product.price_cents)}</div>;
}
