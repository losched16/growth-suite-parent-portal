// Parent portal copy of FA settings — structurally mirrors the
// dashboards repo's lib/financial-aid/settings.ts. Keep in sync when
// adding columns.

import { query } from '@/lib/db';

export interface FinancialAidSettings {
  school_id: string;
  is_enabled: boolean;
  active_academic_year: string;
  application_open: boolean;
  application_deadline: string | null;
  intro_copy_markdown: string | null;
  required_document_types: string[];
  max_award_per_student_cents: number;
  admin_notify_emails: string[];
  decision_letter_template: string | null;
  signature_name: string | null;
  signature_title: string | null;
}

export const LEGACY_FA_DEFAULTS: FinancialAidSettings = {
  school_id: '',
  is_enabled: false,
  active_academic_year: '2026-27',
  application_open: true,
  application_deadline: null,
  intro_copy_markdown: null,
  required_document_types: [],
  max_award_per_student_cents: 5_000_000,
  admin_notify_emails: [],
  decision_letter_template: null,
  signature_name: null,
  signature_title: null,
};

export async function getFinancialAidSettings(schoolId: string): Promise<FinancialAidSettings> {
  const { rows } = await query<FinancialAidSettings>(
    `SELECT school_id, is_enabled, active_academic_year,
            application_open,
            to_char(application_deadline, 'YYYY-MM-DD') AS application_deadline,
            intro_copy_markdown, required_document_types,
            max_award_per_student_cents, admin_notify_emails,
            decision_letter_template, signature_name, signature_title
       FROM school_financial_aid_settings WHERE school_id = $1`,
    [schoolId],
  );
  if (rows.length === 0) return { ...LEGACY_FA_DEFAULTS, school_id: schoolId };
  return rows[0];
}

// Mirrors the dashboards repo's FA_DOCUMENT_CATALOG. Parent portal
// uses this to render upload chips with proper labels for the
// school's required_document_types.
export const FA_DOCUMENT_CATALOG_MAP: Record<string, { label: string; hint: string }> = {
  tax_return:        { label: 'Federal tax return (1040)', hint: 'Most recent year. All pages, including schedules.' },
  w2:                { label: 'W-2 form(s)',                hint: 'All employers for the most recent tax year.' },
  pay_stubs:         { label: 'Recent pay stubs',           hint: 'Last 2 months from every working adult in the household.' },
  ssa_statement:     { label: 'Social Security statement',  hint: 'If anyone in the household receives SSA / SSI / disability.' },
  unemployment:      { label: 'Unemployment benefit letter',hint: 'If anyone is on unemployment in the application year.' },
  self_employed:     { label: 'Schedule C / business returns', hint: 'For self-employed parents — most recent year.' },
  bank_statement:    { label: 'Bank statement',             hint: 'Last 2 months from all checking + savings accounts.' },
  investment_summary:{ label: 'Investment / 401(k) summary',hint: 'Most recent statements for any non-retirement investments.' },
  mortgage_statement:{ label: 'Mortgage statement',         hint: 'Most recent statement showing balance + payment.' },
  rent_lease:        { label: 'Lease / rent receipts',      hint: 'If renting — current lease or recent payment proof.' },
  medical_expenses:  { label: 'Documented medical expenses',hint: 'For families claiming significant out-of-pocket medical bills.' },
  child_support:     { label: 'Child support order',        hint: 'Custody / support paperwork showing payments paid or received.' },
  other:             { label: 'Other supporting documents', hint: "Anything else you'd like the FA committee to see." },
};
