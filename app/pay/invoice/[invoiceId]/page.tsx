// /pay/invoice/[invoiceId]?t=<token> — PUBLIC invoice pay page (no login).
//
// Lives OUTSIDE the (portal) group so it isn't behind the parent-session
// proxy. Access is gated by the invoice's public_pay_token (constant-time
// compared). Used when a school invoices someone with no parent-portal
// account — a GHL contact, a one-off billee. The session-gated
// /billing/pay/[invoiceId] page still serves logged-in family members.
//
// (Path is /pay/invoice/... rather than /pay/[invoiceId] because /pay
// already has a [schoolSlug] route — two differently-named slugs at the
// same segment is a Next.js error.)

import crypto from 'node:crypto';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { query } from '@/lib/db';
import { fmtCents, type FeeConfig } from '@/lib/billing/fee-math';
import { PaymentForm } from '@/app/(portal)/billing/pay/[invoiceId]/PaymentForm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ invoiceId: string }>;
type SearchParams = Promise<{ t?: string; success?: string }>;

interface InvoiceRow {
  id: string; invoice_number: string; school_id: string; school_name: string;
  recipient_name: string | null;
  title: string; description: string | null; status: string;
  subtotal_cents: number; platform_fee_cents: number; discount_total_cents: number;
  total_cents: number; amount_paid_cents: number; due_at: string;
  public_pay_token: string | null;
}
interface LineRow { id: string; description: string; quantity: number; amount_cents: number }
interface ConfigRow {
  pass_card_fee: boolean; pass_ach_fee: boolean; card_enabled: boolean;
  ach_enabled: boolean; processing_fee_label: string;
}

function tokenOk(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="max-w-2xl mx-auto">{children}</div>
    </main>
  );
}

export default async function PublicPayPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { invoiceId } = await params;
  const sp = await searchParams;
  const token = (sp.t ?? '').trim();

  const [invRows, account] = await Promise.all([
    query<InvoiceRow>(
      `SELECT i.id, i.invoice_number, i.school_id, s.name AS school_name,
              i.recipient_name, i.title, i.description, i.status,
              i.subtotal_cents, i.platform_fee_cents, i.discount_total_cents,
              i.total_cents, i.amount_paid_cents, i.due_at, i.public_pay_token
         FROM invoices i JOIN schools s ON s.id = i.school_id
        WHERE i.id = $1`,
      [invoiceId],
    ).then((r) => r.rows),
    query<{ charges_enabled: boolean }>(
      `SELECT pa.charges_enabled FROM payment_accounts pa
         JOIN invoices i ON i.school_id = pa.school_id WHERE i.id = $1`,
      [invoiceId],
    ).then((r) => r.rows[0] ?? null),
  ]);

  const inv = invRows[0];
  // Don't reveal whether the invoice exists when the token is wrong.
  if (!inv || !inv.public_pay_token || !token || !tokenOk(token, inv.public_pay_token)) notFound();

  if (inv.status === 'paid') {
    return (
      <Shell>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600 mb-3" />
          <h1 className="text-xl font-semibold text-emerald-900">Paid in full</h1>
          <p className="mt-1 text-sm text-emerald-800">{inv.title} · {fmtCents(inv.total_cents)} · {inv.invoice_number}</p>
          <p className="mt-2 text-xs text-emerald-700">Thank you from {inv.school_name}.</p>
        </div>
      </Shell>
    );
  }
  if (inv.status === 'voided') {
    return (
      <Shell>
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-700">This invoice has been voided</h1>
          <p className="mt-1 text-sm text-zinc-600">Contact {inv.school_name} if you have questions.</p>
        </div>
      </Shell>
    );
  }
  if (sp.success === '1') {
    return (
      <Shell>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600 mb-3" />
          <h1 className="text-xl font-semibold text-emerald-900">Payment received</h1>
          <p className="mt-1 text-sm text-emerald-800">Thank you! A receipt is on its way.</p>
        </div>
      </Shell>
    );
  }
  if (!account || !account.charges_enabled) {
    return (
      <Shell>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
          <h1 className="text-xl font-semibold text-amber-900">Online payment isn&rsquo;t set up yet</h1>
          <p className="mt-2 text-sm text-amber-800">Please contact {inv.school_name} to pay this invoice another way.</p>
        </div>
      </Shell>
    );
  }

  const [lineRows, cfgRows] = await Promise.all([
    query<LineRow>(`SELECT id, description, quantity, amount_cents FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`, [invoiceId]).then((r) => r.rows),
    query<ConfigRow>(`SELECT pass_card_fee, pass_ach_fee, card_enabled, ach_enabled, processing_fee_label FROM school_payment_config WHERE school_id = $1`, [inv.school_id]).then((r) => r.rows),
  ]);
  const config: ConfigRow = cfgRows[0] ?? { pass_card_fee: true, pass_ach_fee: false, card_enabled: true, ach_enabled: true, processing_fee_label: 'Processing fee' };
  const feeConfig: FeeConfig = {
    passCardFee: config.pass_card_fee, passAchFee: config.pass_ach_fee,
    cardEnabled: config.card_enabled, achEnabled: config.ach_enabled,
    processingFeeLabel: config.processing_fee_label,
  };

  const owedCents = inv.total_cents - inv.amount_paid_cents;
  const subtotalAfterDiscount = inv.subtotal_cents - inv.discount_total_cents;
  const subtotalForPayment = subtotalAfterDiscount - Math.max(0, inv.amount_paid_cents - inv.platform_fee_cents);

  return (
    <Shell>
      <header className="mb-4">
        <div className="text-xs uppercase tracking-wider text-slate-500">{inv.school_name}</div>
        <div className="mt-1 text-xs font-mono text-slate-500">{inv.invoice_number}</div>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">{inv.title}</h1>
        {inv.recipient_name ? <p className="mt-1 text-sm text-slate-600">Billed to {inv.recipient_name}</p> : null}
        {inv.description ? <p className="mt-1 text-sm text-slate-700">{inv.description}</p> : null}
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">What you&rsquo;re paying for</h2>
        <ul className="divide-y divide-slate-100">
          {lineRows.map((l) => {
            const isDiscount = l.amount_cents < 0;
            return (
              <li key={l.id} className={`py-2 flex items-baseline justify-between gap-3 text-sm ${isDiscount ? 'text-emerald-700' : ''}`}>
                <span className={isDiscount ? '' : 'text-slate-900'}>
                  {l.description}{l.quantity > 1 ? <span className="text-slate-500 text-xs"> · ×{l.quantity}</span> : null}
                </span>
                <span className={`font-mono ${isDiscount ? 'font-semibold' : 'text-slate-700'}`}>
                  {isDiscount ? '−' : ''}{fmtCents(Math.abs(l.amount_cents))}
                </span>
              </li>
            );
          })}
          {inv.platform_fee_cents > 0 ? (
            <li className="py-2 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-slate-900">Family Portal Setup Fee<span className="block text-[11px] text-slate-500">One-time</span></span>
              <span className="font-mono text-slate-700">{fmtCents(inv.platform_fee_cents)}</span>
            </li>
          ) : null}
        </ul>
        <div className="border-t border-slate-200 pt-2 flex items-baseline justify-between text-sm">
          <span className="font-semibold text-slate-900">Subtotal</span>
          <span className="font-mono font-semibold">{fmtCents(subtotalForPayment + inv.platform_fee_cents)}</span>
        </div>
      </div>

      <PaymentForm
        invoiceId={inv.id}
        subtotalCents={subtotalForPayment}
        platformFeeCents={inv.platform_fee_cents}
        owedCents={owedCents}
        feeConfig={feeConfig}
        returnTo={null}
        payToken={token}
      />
    </Shell>
  );
}
