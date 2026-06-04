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

// FA_DOCUMENT_CATALOG_MAP moved to ./document-catalog so client
// components can import it without dragging in lib/db. Re-export
// here for back-compat with anything still importing from settings.
export { FA_DOCUMENT_CATALOG_MAP } from './document-catalog';
