// Receipt / failure emails for parent payments.
//
// Called from the Stripe webhook handler after a payment_intent
// resolves. Best-effort: an email failure should never roll back the
// payment-state DB update.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { fmtCents } from './fee-math';

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

interface PaymentForEmail {
  invoice_id: string;
  invoice_number: string;
  invoice_title: string;
  school_id: string;
  school_name: string;
  family_id: string;
  amount_cents: number;
  payment_method_summary: string;
}

async function loadPaymentForEmail(paymentIntentId: string): Promise<PaymentForEmail | null> {
  const { rows } = await query<{
    invoice_id: string;
    invoice_number: string;
    invoice_title: string;
    school_id: string;
    school_name: string;
    family_id: string;
    amount_cents: number;
    pm_type: string | null;
    pm_brand: string | null;
    pm_last4: string | null;
  }>(
    `SELECT p.invoice_id, i.invoice_number, i.title AS invoice_title,
            p.school_id, s.name AS school_name, p.family_id, p.amount_cents,
            pm.type AS pm_type, pm.brand AS pm_brand, pm.last4 AS pm_last4
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN schools  s ON s.id = p.school_id
       LEFT JOIN payment_methods pm ON pm.stripe_payment_method_id = p.stripe_payment_method_id
      WHERE p.stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const summary = r.pm_brand
    ? `${r.pm_brand.toUpperCase()} ····${r.pm_last4 ?? ''}`
    : (r.pm_type ?? 'saved method');
  return {
    invoice_id: r.invoice_id, invoice_number: r.invoice_number,
    invoice_title: r.invoice_title, school_id: r.school_id,
    school_name: r.school_name, family_id: r.family_id,
    amount_cents: r.amount_cents, payment_method_summary: summary,
  };
}

async function familyParentEmails(familyId: string, schoolId: string): Promise<string[]> {
  const { rows } = await query<{ email: string }>(
    `SELECT email FROM parents
      WHERE family_id = $1 AND school_id = $2 AND status = 'active' AND email IS NOT NULL`,
    [familyId, schoolId],
  );
  return rows.map((r) => r.email);
}

export async function sendPaymentReceiptEmail(stripePaymentIntentId: string): Promise<void> {
  try {
    const p = await loadPaymentForEmail(stripePaymentIntentId);
    if (!p) return;
    const emails = await familyParentEmails(p.family_id, p.school_id);
    if (emails.length === 0) return;

    const portalUrl = `${PARENT_PORTAL_BASE}/billing/pay/${p.invoice_id}`;
    const amount = (p.amount_cents / 100).toFixed(2);
    const subject = `Payment received: ${p.invoice_title} ($${amount})`;
    const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">Payment received</h2>
  <p style="margin: 0 0 16px; font-size: 14px; color: #6b7280;">Thank you from ${escape(p.school_name)}.</p>
  <div style="border: 1px solid #d1fae5; background: #ecfdf5; border-radius: 8px; padding: 16px; margin: 16px 0;">
    <div style="display: flex; justify-content: space-between; font-size: 14px;">
      <span style="color: #6b7280;">Invoice</span>
      <span style="font-family: monospace;">${escape(p.invoice_number)}</span>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 14px;">
      <span style="color: #6b7280;">Description</span>
      <span>${escape(p.invoice_title)}</span>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 14px;">
      <span style="color: #6b7280;">Paid with</span>
      <span>${escape(p.payment_method_summary)}</span>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 12px; padding-top: 12px; border-top: 1px solid #d1fae5; font-size: 16px; font-weight: 600;">
      <span>Amount</span>
      <span>$${amount}</span>
    </div>
  </div>
  <p style="margin: 16px 0;">
    <a href="${portalUrl}" style="display: inline-block; color: #047857; text-decoration: none; font-size: 14px;">View receipt in your portal →</a>
  </p>
</body></html>
    `.trim();
    const text = `Payment received — thank you from ${p.school_name}

Invoice: ${p.invoice_number}
Description: ${p.invoice_title}
Paid with: ${p.payment_method_summary}
Amount: $${amount}

View in portal: ${portalUrl}`;

    for (const email of emails) {
      await sendBrandedEmail({ to: email, schoolId: p.school_id, subject, html, text }).catch(() => undefined);
    }
  } catch (err) {
    console.error('[send-payment-email/receipt] failed:', err);
  }
}

export async function sendPaymentFailureEmail(stripePaymentIntentId: string, failureMessage: string | null): Promise<void> {
  try {
    const p = await loadPaymentForEmail(stripePaymentIntentId);
    if (!p) return;
    const emails = await familyParentEmails(p.family_id, p.school_id);
    if (emails.length === 0) return;

    const portalUrl = `${PARENT_PORTAL_BASE}/billing/pay/${p.invoice_id}`;
    const amount = (p.amount_cents / 100).toFixed(2);
    const subject = `Payment failed: ${p.invoice_title} ($${amount})`;
    const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">Payment didn&rsquo;t go through</h2>
  <p style="margin: 0 0 16px; font-size: 14px;">
    We tried to charge your saved payment method for ${escape(p.school_name)} but it didn&rsquo;t succeed.
  </p>
  <div style="border: 1px solid #fde68a; background: #fffbeb; border-radius: 8px; padding: 16px; margin: 16px 0;">
    <div style="font-size: 14px; margin-bottom: 8px;"><strong>${escape(p.invoice_title)}</strong></div>
    <div style="font-size: 13px; color: #6b7280;">Invoice ${escape(p.invoice_number)} · $${amount}</div>
    ${failureMessage ? `<div style="margin-top: 12px; padding: 8px 12px; background: white; border-radius: 4px; font-size: 13px; color: #b45309;">${escape(failureMessage)}</div>` : ''}
  </div>
  <p style="margin: 16px 0;">
    <a href="${portalUrl}" style="display: inline-block; background: #1F1F1F; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Update payment method
    </a>
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    We&rsquo;ll automatically try again over the next several days. To pay sooner, click the button above.
  </p>
</body></html>
    `.trim();
    const text = `Payment didn't go through — ${p.school_name}

${p.invoice_title}
Invoice: ${p.invoice_number}
Amount: $${amount}
${failureMessage ? `\nReason: ${failureMessage}\n` : ''}

We'll automatically try again. To pay sooner: ${portalUrl}`;

    for (const email of emails) {
      await sendBrandedEmail({ to: email, schoolId: p.school_id, subject, html, text }).catch(() => undefined);
    }
  } catch (err) {
    console.error('[send-payment-email/failure] failed:', err);
  }
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}
