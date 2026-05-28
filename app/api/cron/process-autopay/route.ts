// GET /api/cron/process-autopay — daily autopay processor.
//
// Vercel Cron hits this once a day. It:
//   1. Finds all open invoices where autopay is enabled AND
//      (autopay_charge_on <= today OR next_retry_at <= now()).
//   2. Charges each one off-session via Stripe using the saved
//      payment method.
//   3. On failure, schedules the next retry per the school's
//      retry_schedule_days policy (e.g., [1, 3, 7] days later).
//   4. Writes a summary row to autopay_run_log.
//
// Authentication: Vercel Cron sends an Authorization: Bearer
// CRON_SECRET header. We verify it.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { chargeAutopayInvoice, type AutopayChargeResult } from '@/lib/billing/autopay-charge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes — enough to chew through hundreds of charges

interface DueInvoiceRow {
  id: string;
  school_id: string;
  invoice_number: string;
  retry_attempt_count: number;
}

interface SchoolRetryConfig {
  retry_schedule_days: number[];
}

export async function GET(request: NextRequest) {
  // Auth check — bypass in dev when CRON_SECRET is unset
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Find all autopay invoices that should be processed now.
  // Dry-run gate (migration 046): skip schools where billing_active=false.
  // Their invoices live in 'draft' status anyway, but this filter also
  // protects against any operator who manually flipped one to 'open' —
  // dry-run means dry-run; no card actually gets charged until the
  // school clicks "Go live" on their Payments hub.
  const { rows: due } = await query<DueInvoiceRow>(
    `SELECT i.id, i.school_id, i.invoice_number, i.retry_attempt_count
       FROM invoices i
       JOIN school_payment_config spc ON spc.school_id = i.school_id
      WHERE i.autopay_enabled = true
        AND i.autopay_payment_method_id IS NOT NULL
        AND i.status IN ('open', 'partially_paid')
        AND COALESCE(spc.billing_active, false) = true
        AND (
              (i.autopay_charge_on IS NULL AND i.due_at::date <= $1::date)
           OR (i.autopay_charge_on IS NOT NULL AND i.autopay_charge_on <= $1::date)
           OR (i.next_retry_at IS NOT NULL AND i.next_retry_at <= now())
        )
      ORDER BY i.due_at ASC
      LIMIT 500`,
    [today],
  );

  const results: Array<{
    invoice_id: string;
    invoice_number: string;
    result: AutopayChargeResult;
  }> = [];

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const inv of due) {
    // Bump attempt count + stamp last_autopay_attempted_at BEFORE the
    // charge so idempotency keys differ between attempts.
    await query(
      `UPDATE invoices
          SET retry_attempt_count = retry_attempt_count + 1,
              last_autopay_attempted_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [inv.id],
    );

    let result: AutopayChargeResult;
    try {
      result = await chargeAutopayInvoice(inv.id);
    } catch (e) {
      result = {
        ok: false,
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      };
    }
    results.push({ invoice_id: inv.id, invoice_number: inv.invoice_number, result });

    if (result.ok) {
      // The webhook will mark the invoice paid + clear next_retry_at.
      // We optimistically clear next_retry_at here too so we don't
      // re-process this invoice on subsequent runs while waiting for
      // the webhook.
      await query(
        `UPDATE invoices SET next_retry_at = NULL, updated_at = now() WHERE id = $1`,
        [inv.id],
      );
      succeeded++;
    } else if (result.reason === 'no_account' || result.reason === 'no_method') {
      // Permanently un-process-able until config changes. Disable autopay.
      await query(
        `UPDATE invoices
            SET autopay_enabled = false,
                next_retry_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [inv.id],
      );
      skipped++;
    } else {
      // Transient failure (declined, requires_action, unknown) — schedule
      // the next retry based on school config.
      const nextRetry = await computeNextRetry(inv.school_id, inv.retry_attempt_count + 1);
      if (nextRetry) {
        await query(
          `UPDATE invoices SET next_retry_at = $1, updated_at = now() WHERE id = $2`,
          [nextRetry.toISOString(), inv.id],
        );
        failed++;
      } else {
        // Exhausted retries — turn autopay off, leave invoice open for manual pay.
        await query(
          `UPDATE invoices
              SET autopay_enabled = false, next_retry_at = NULL, updated_at = now()
            WHERE id = $1`,
          [inv.id],
        );
        skipped++;
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  await query(
    `INSERT INTO autopay_run_log
       (invoices_attempted, invoices_succeeded, invoices_failed, invoices_skipped,
        duration_ms, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [due.length, succeeded, failed, skipped, durationMs, JSON.stringify({ results })],
  ).catch(() => undefined);

  return NextResponse.json({
    attempted: due.length,
    succeeded,
    failed,
    skipped,
    duration_ms: durationMs,
  });
}

async function computeNextRetry(schoolId: string, attemptNumber: number): Promise<Date | null> {
  const { rows } = await query<SchoolRetryConfig>(
    `SELECT retry_schedule_days FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  const schedule = rows[0]?.retry_schedule_days ?? [1, 3, 7];
  // attemptNumber is 1-based (the attempt that just failed).
  // The schedule maps: attempt 1 fails → wait schedule[0] days,
  // attempt 2 fails → wait schedule[1] days, etc.
  // After we've exhausted the schedule, give up.
  const daysOut = schedule[attemptNumber - 1];
  if (daysOut === undefined) return null;
  const next = new Date();
  next.setDate(next.getDate() + daysOut);
  return next;
}
