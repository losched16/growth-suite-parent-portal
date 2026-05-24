// POST /api/tuition/enrollment/[enrollmentId]/select-plan
//
// Parent locks in a payment plan + addon selection for a tuition
// enrollment. The school admin already created the enrollment row
// with the canonical tuition amount (from FACTS CSV import or manual
// entry); the parent's role here is purely to pick HOW to pay it.
//
// Auth: parent-session-authed. The enrollment must belong to the
// logged-in parent's family.
//
// Side effects:
//   1. Update family_tuition_enrollments: payment_plan_id, addons
//      (with `selected` flags persisted), total_annual_cents,
//      installment_count, plan_discount_basis_points, schedule.
//   2. (TODO) Generate invoice rows for each installment when the
//      schedule resolves to dates within the academic year.
//
// Note: schedule resolution to ACTUAL dates lives in
// lib/billing/tuition-plan-generator.ts on the dashboards side — we
// just save the plan choice here. The cron picks it up to generate
// invoices.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PARENT_SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ enrollmentId: string }>;

interface Body {
  payment_plan_id: string;
  addon_selections: Record<string, boolean>;
}

interface EnrollmentRow {
  id: string;
  school_id: string;
  family_id: string;
  annual_tuition_cents: number;
  addons: Array<{ key: string; label: string; amount_cents: number; selected?: boolean }>;
  status: string;
}
interface PlanRow {
  id: string;
  installment_count: number;
  discount_basis_points: number;
  schedule_template: { kind?: string; months?: string[] };
}
interface SchoolConfigRow {
  monthly_plan_admin_fee_bp: number;
  annual_plan_discount_bp: number;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySession(ck.get(PARENT_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { enrollmentId } = await params;

  let body: Body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.payment_plan_id) {
    return NextResponse.json({ error: 'missing_payment_plan_id' }, { status: 400 });
  }

  // Load enrollment + verify it belongs to this parent's family
  const enrolls = (await query<EnrollmentRow>(
    `SELECT id, school_id, family_id, annual_tuition_cents, addons, status
       FROM family_tuition_enrollments WHERE id = $1`,
    [enrollmentId],
  )).rows;
  if (enrolls.length === 0) {
    return NextResponse.json({ error: 'enrollment_not_found' }, { status: 404 });
  }
  const enrollment = enrolls[0];
  if (enrollment.family_id !== session.family_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (enrollment.school_id !== session.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Load plan + verify it belongs to this school
  const plans = (await query<PlanRow>(
    `SELECT id, installment_count, discount_basis_points, schedule_template
       FROM payment_plans
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [body.payment_plan_id, session.school_id],
  )).rows;
  if (plans.length === 0) {
    return NextResponse.json({ error: 'plan_not_found_or_inactive' }, { status: 404 });
  }
  const plan = plans[0];

  // Load school payment config for plan-level fee/discount overrides
  const cfgs = (await query<SchoolConfigRow>(
    `SELECT monthly_plan_admin_fee_bp, annual_plan_discount_bp
       FROM school_payment_config WHERE school_id = $1`,
    [session.school_id],
  )).rows;
  const cfg = cfgs[0];

  // Apply addon selections to the existing addon list. Preserve label /
  // amount_cents / category from the enrollment row, just flip `selected`.
  const updatedAddons = (enrollment.addons ?? []).map((a) => ({
    ...a,
    selected: !!body.addon_selections[a.key],
  }));

  const selectedAddonTotal = updatedAddons
    .filter((a) => a.selected)
    .reduce((sum, a) => sum + (a.amount_cents ?? 0), 0);

  // Compute final total. Same logic as TuitionPlanPicker but server-authoritative.
  const subtotal = enrollment.annual_tuition_cents + selectedAddonTotal;
  let adjustmentBp = plan.discount_basis_points;
  if (cfg) {
    if (plan.installment_count === 1 && cfg.annual_plan_discount_bp > 0) {
      adjustmentBp = cfg.annual_plan_discount_bp;
    } else if (plan.installment_count > 2 && cfg.monthly_plan_admin_fee_bp > 0) {
      adjustmentBp = -cfg.monthly_plan_admin_fee_bp;
    }
  }
  const adjustment = Math.round((subtotal * adjustmentBp) / 10000);
  const totalAnnualCents = subtotal - adjustment;

  // Persist the choice. Schedule resolution to dates is handled by the
  // tuition-plan-generator cron (separate concern). Here we just stamp
  // the template so the cron knows how to generate.
  await query(
    `UPDATE family_tuition_enrollments
        SET payment_plan_id = $1,
            plan_discount_basis_points = $2,
            addons = $3::jsonb,
            total_annual_cents = $4,
            installment_count = $5,
            schedule = $6::jsonb,
            status = CASE WHEN status = 'draft' THEN 'committed' ELSE status END,
            updated_at = now()
      WHERE id = $7`,
    [
      plan.id,
      adjustmentBp,
      JSON.stringify(updatedAddons),
      totalAnnualCents,
      plan.installment_count,
      JSON.stringify(plan.schedule_template),
      enrollmentId,
    ],
  );

  return NextResponse.json({
    ok: true,
    enrollment_id: enrollmentId,
    total_annual_cents: totalAnnualCents,
    installment_count: plan.installment_count,
  });
}
