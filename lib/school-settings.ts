// Per-school settings (schools.settings jsonb, migration 071) — the
// data-driven replacement for what used to be hardcoded school-id sets
// sprinkled through the code. Absent keys fall back to the platform
// defaults below, so a brand-new school needs zero setup to behave sanely
// and every behavior is opt-in from the school Settings page.

import { query } from '@/lib/db';

export interface SchoolSettings {
  // Active academic year, e.g. '2026-27'. Drives enrollment rows, payment
  // plans, and the year the portal stamps on submissions.
  academic_year: string;
  // Pipeline stage that unlocks parent-portal account creation. null = any
  // active parent can create a login (ungated).
  portal_gate_stage: string | null;
  // Auto-assign a random 8-digit Student ID to active students missing one
  // (written to the contact first, then mirrored).
  auto_student_ids: boolean;
  // Nightly Parent-2 → own-contact promotion for email marketing.
  promote_parent2: boolean;
  // When non-empty: only contacts carrying one of these tags become roster
  // families ("withdrawn" keeps the family but marks students withdrawn).
  roster_tag_filter: string[];
}

export const SCHOOL_SETTINGS_DEFAULTS: SchoolSettings = {
  academic_year: '2026-27',
  portal_gate_stage: null,
  auto_student_ids: false,
  promote_parent2: false,
  roster_tag_filter: [],
};

export function normalizeSchoolSettings(raw: unknown): SchoolSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    academic_year: typeof r.academic_year === 'string' && r.academic_year.trim()
      ? r.academic_year.trim() : SCHOOL_SETTINGS_DEFAULTS.academic_year,
    portal_gate_stage: typeof r.portal_gate_stage === 'string' && r.portal_gate_stage.trim()
      ? r.portal_gate_stage.trim() : null,
    auto_student_ids: r.auto_student_ids === true,
    promote_parent2: r.promote_parent2 === true,
    roster_tag_filter: Array.isArray(r.roster_tag_filter)
      ? r.roster_tag_filter.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [],
  };
}

export async function loadSchoolSettings(schoolId: string): Promise<SchoolSettings> {
  const { rows } = await query<{ settings: unknown }>(
    `SELECT settings FROM schools WHERE id = $1`,
    [schoolId],
  );
  return normalizeSchoolSettings(rows[0]?.settings);
}
