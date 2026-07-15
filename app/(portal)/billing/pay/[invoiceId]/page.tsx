// /billing/pay/[invoiceId] — the parent's payment page for one invoice.
//
// Server loads the invoice + school fee config; the PaymentForm
// client component handles the card/ACH toggle, live fee math display,
// and Stripe Payment Element / Financial Connections.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { requireParent } from '@/lib/identity';
import { query } from '@/lib/db';
import { fmtCents, type FeeConfig } from '@/lib/billing/fee-math';
import { PaymentForm } from './PaymentForm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ invoiceId: string }>;
type SearchParams = Promise<{ return_to?: string; success?: string }>;

// Allow-list of return-to prefixes so a malicious link can't bounce the
// parent to an attacker site after a successful payment.
const SAFE_RETURN_PREFIXES = ['/billing', '/forms-v2', '/profile', '/dashboard'];
function safeReturnTo(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  for (const prefix of SAFE_RETURN_PREFIXES) {
    if (raw === prefix || raw.startsWith(prefix + '/') || raw.startsWith(prefix + '?')) {
      return raw;
    }
  }
  return null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  school_id: string;
  family_id: string;
  responsible_parent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  subtotal_cents: number;
  platform_fee_cents: number;
  discount_total_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  due_at: string;
  includes_platform_setup_fee: boolean;
}

interface LineRow {
  id: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
}

interface ConfigRow {
  pass_card_fee: boolean;
  pass_ach_fee: boolean;
  card_enabled: boolean;
  ach_enabled: boolean;
  processing_fee_label: string;
}

interface AccountRow {
  stripe_account_id: string;
  charges_enabled: boolean;
}

export default async function PayInvoicePage({
  params,
  searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { invoiceId } = await params;
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.return_to);
  const me = await requireParent();

  const [invRows, paymentAccount] = await Promise.all([
    query<InvoiceRow>(
      `SELECT id, invoice_number, school_id, family_id, title, description, status,
              subtotal_cents, platform_fee_cents, discount_total_cents,
              total_cents, amount_paid_cents,
              due_at, includes_platform_setup_fee,
              responsible_parent_id
         FROM invoices WHERE id = $1`,
      [invoiceId],
    ).then((r) => r.rows),
    query<AccountRow>(
      `SELECT pa.stripe_account_id, pa.charges_enabled
         FROM payment_accounts pa
         JOIN invoices i ON i.school_id = pa.school_id
        WHERE i.id = $1`,
      [invoiceId],
    ).then((r) => r.rows[0] ?? null),
  ]);

  const inv = invRows[0];
  if (!inv) notFound();
  if (inv.family_id !== me.parent.family_id) notFound();
  // Split-billing access check: when an invoice is addressed to a
  // specific co-parent (responsible_parent_id IS NOT NULL), only that
  // parent can open the pay page. Joint invoices (NULL) stay visible
  // to either co-parent. Prevents direct-URL access to a co-parent's
  // bill.
  if (inv.responsible_parent_id && inv.responsible_parent_id !== me.parent.id) notFound();

  const [lineRows, configRows] = await Promise.all([
    query<LineRow>(
      `SELECT id, description, quantity, unit_amount_cents, amount_cents
         FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
      [invoiceId],
    ).then((r) => r.rows),
    query<ConfigRow>(
      `SELECT pass_card_fee, pass_ach_fee, card_enabled, ach_enabled, processing_fee_label
         FROM school_payment_config WHERE school_id = $1`,
      [inv.school_id],
    ).then((r) => r.rows),
  ]);

  const config: ConfigRow = configRows[0] ?? {
    pass_card_fee: true, pass_ach_fee: false,
    card_enabled: true, ach_enabled: true,
    processing_fee_label: 'Processing fee',
  };

  const feeConfig: FeeConfig = {
    passCardFee: config.pass_card_fee,
    passAchFee: config.pass_ach_fee,
    cardEnabled: config.card_enabled,
    achEnabled: config.ach_enabled,
    processingFeeLabel: config.processing_fee_label,
  };

  // If we came back from Stripe's redirect with success=1 AND a safe
  // return_to, bounce there immediately (so the parent goes back to
  // their form history instead of seeing the receipt panel).
  if (sp.success === '1' && returnTo) {
    redirect(returnTo);
  }

  // Already paid?
  if (inv.status === 'paid') {
    return (
      <div className="max-w-xl mx-auto py-12">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600 mb-3" />
          <h1 className="text-xl font-semibold text-emerald-900">Paid in full</h1>
          <p className="mt-1 text-sm text-emerald-800">
            {inv.title} · {fmtCents(inv.total_cents)} · {inv.invoice_number}
          </p>
          <Link href="/billing" className="mt-4 inline-block text-sm text-emerald-700 underline">
            Back to billing
          </Link>
        </div>
      </div>
    );
  }
  if (inv.status === 'voided') {
    return (
      <div className="max-w-xl mx-auto py-12">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-700">This invoice has been voided</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Contact the school office if you have questions.
          </p>
          <Link href="/billing" className="mt-4 inline-block text-sm underline" style={{ color: 'var(--brand)' }}>
            Back to billing
          </Link>
        </div>
      </div>
    );
  }

  // Not connected? Show a helpful message instead of a broken form.
  if (!paymentAccount || !paymentAccount.charges_enabled) {
    return (
      <div className="max-w-xl mx-auto py-12">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
          <h1 className="text-xl font-semibold text-amber-900">Online payment isn&rsquo;t set up yet</h1>
          <p className="mt-2 text-sm text-amber-800">
            The school hasn&rsquo;t finished setting up online payments. Please contact the school
            office to pay this invoice another way.
          </p>
          <Link href="/billing" className="mt-4 inline-block text-sm text-amber-800 underline">
            Back to billing
          </Link>
        </div>
      </div>
    );
  }

  const owedCents = inv.total_cents - inv.amount_paid_cents;
  // After-discount subtotal (the line-items column already contains the
  // negative discount lines, so the visible subtotal here matches the
  // visible line items column).
  const subtotalAfterDiscount = inv.subtotal_cents - inv.discount_total_cents;
  const subtotalForPayment = subtotalAfterDiscount
    - Math.max(0, inv.amount_paid_cents - inv.platform_fee_cents);
  // Note: if invoice is partially paid, we let the parent pay the
  // remaining balance. For Phase 1c we just allow full remainder; partial-
  // pay-of-remainder UX is a Phase 2 concern.

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <Link href="/billing" className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-3 w-3" /> Back to billing
        </Link>
      </div>

      <header>
        <div className="text-xs font-mono text-gray-500">{inv.invoice_number}</div>
        <h1 className="mt-1 text-2xl font-semibold text-gray-900">{inv.title}</h1>
        {inv.description ? <p className="mt-1 text-sm text-gray-700">{inv.description}</p> : null}
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What you&rsquo;re paying for</h2>
        <ul className="divide-y divide-gray-100">
          {lineRows.map((l) => {
            const isDiscount = l.amount_cents < 0;
            return (
              <li
                key={l.id}
                className={`py-2 flex items-baseline justify-between gap-3 text-sm ${isDiscount ? 'text-emerald-700' : ''}`}
              >
                <span className={isDiscount ? '' : 'text-gray-900'}>
                  {l.description}
                  {l.quantity > 1 ? <span className="text-gray-500 text-xs"> · ×{l.quantity}</span> : null}
                </span>
                <span className={`font-mono ${isDiscount ? 'font-semibold' : 'text-gray-700'}`}>
                  {isDiscount ? '−' : ''}{fmtCents(Math.abs(l.amount_cents))}
                </span>
              </li>
            );
          })}
          {inv.platform_fee_cents > 0 ? (
            <li className="py-2 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-gray-900">
                One-Time Setup Fee
                <span className="block text-[11px] text-gray-500">Payment processor · charged once</span>
              </span>
              <span className="font-mono text-gray-700">{fmtCents(inv.platform_fee_cents)}</span>
            </li>
          ) : null}
        </ul>
        <div className="border-t border-gray-200 pt-2 flex items-baseline justify-between text-sm">
          <span className="font-semibold text-gray-900">Subtotal</span>
          <span className="font-mono font-semibold">{fmtCents(subtotalForPayment + inv.platform_fee_cents)}</span>
        </div>
      </div>

      <PaymentForm
        invoiceId={inv.id}
        subtotalCents={subtotalForPayment}
        platformFeeCents={inv.platform_fee_cents}
        owedCents={owedCents}
        feeConfig={feeConfig}
        returnTo={returnTo}
      />
    </div>
  );
}
