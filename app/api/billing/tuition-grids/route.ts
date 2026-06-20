// GET /api/billing/tuition-grids
//
// Lists the active tuition grids (and optionally payment plans) for
// the current parent's school. Powers the TuitionCalculator form
// field in the Forms-V2 renderer.
//
// Query params:
//   academic_year - optional filter (defaults to all active)
//   program       - optional filter
//   grade_level   - optional filter
//   include_plans - '1' to include payment plans in the response

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readSession } from '@/lib/identity';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AddonRow { key: string; label: string; amount_cents: number; required?: boolean }

interface GridRow {
  id: string;
  display_name: string;
  academic_year: string;
  program: string | null;
  grade_level: string | null;
  annual_tuition_cents: number;
  addons: AddonRow[];
}

export async function GET(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const academicYear = url.searchParams.get('academic_year');
  const program = url.searchParams.get('program');
  const gradeLevel = url.searchParams.get('grade_level');
  const includePlans = url.searchParams.get('include_plans') === '1';

  const conds: string[] = ['school_id = $1', 'is_active = true'];
  const params: unknown[] = [session.school_id];
  if (academicYear) { params.push(academicYear); conds.push(`academic_year = $${params.length}`); }
  if (program)      { params.push(program);      conds.push(`program = $${params.length}`); }
  if (gradeLevel)   { params.push(gradeLevel);   conds.push(`grade_level = $${params.length}`); }

  const { rows: gridRows } = await query<{
    id: string;
    display_name: string;
    academic_year: string;
    program: string | null;
    grade_level: string | null;
    annual_tuition_cents: number;
    addons: AddonRow[] | null;
  }>(
    `SELECT id, display_name, academic_year, program, grade_level,
            annual_tuition_cents, addons
       FROM tuition_grids
      WHERE ${conds.join(' AND ')}
      ORDER BY position ASC, display_name ASC`,
    params,
  );

  const grids: GridRow[] = gridRows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    academic_year: r.academic_year,
    program: r.program,
    grade_level: r.grade_level,
    annual_tuition_cents: r.annual_tuition_cents,
    addons: Array.isArray(r.addons) ? r.addons : [],
  }));

  let plans: Array<{
    id: string; slug: string; display_name: string;
    installments: number; cadence: string; discount_bp: number;
    schedule_months: string[] | null; first_due_month_day: string | null;
  }> = [];

  if (includePlans) {
    const { rows: planRows } = await query<{
      id: string;
      slug: string;
      display_name: string;
      installment_count: number;
      discount_basis_points: number;
      schedule_template: { kind?: string; months?: string[] } | null;
      first_due_month_day: string | null;
    }>(
      `SELECT id, slug, display_name, installment_count, discount_basis_points,
              schedule_template, first_due_month_day
         FROM payment_plans
        WHERE school_id = $1 AND is_active = true
        ORDER BY position ASC, display_name ASC`,
      [session.school_id],
    );
    plans = planRows.map((p) => ({
      id: p.id,
      slug: p.slug,
      display_name: p.display_name,
      installments: p.installment_count,
      cadence: p.schedule_template?.kind ?? 'single',
      discount_bp: p.discount_basis_points,
      // Schedule months (e.g. ['08','09',...]) + optional MM-DD anchor let the
      // form compute each installment's due date for the payment-schedule UI.
      schedule_months: Array.isArray(p.schedule_template?.months) ? p.schedule_template!.months! : null,
      first_due_month_day: p.first_due_month_day ?? null,
    }));
  }

  // ── Which addon categories has this family ALREADY paid? ──────────
  // Convention: an addon's `key` is also the line item `category` when
  // it appears on an invoice (e.g. an enrollment-contract form bills a
  // line item with category='enrollment_deposit'). We look at the
  // family's paid invoices in the last 12 months and surface those
  // categories — the TuitionCalculator UI uses this to render paid
  // addons as "Already paid" credits instead of charges.
  const { rows: paidRows } = await query<{ category: string }>(
    `SELECT DISTINCT li.category
       FROM invoices i
       JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE i.school_id = $1
        AND i.family_id = $2
        AND i.status = 'paid'
        AND li.category IS NOT NULL
        AND li.amount_cents > 0
        AND i.paid_at > now() - interval '12 months'`,
    [session.school_id, session.family_id],
  );
  const paid_addon_categories = paidRows.map((r) => r.category);

  return NextResponse.json({ grids, plans, paid_addon_categories });
}
