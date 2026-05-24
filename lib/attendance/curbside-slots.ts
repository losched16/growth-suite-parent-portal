// Curbside pickup time slots.
//
// Desert Garden's published windows for spring 2026: 12:00, 2:30, 3:15,
// 3:30. Operators will eventually customize per-school via the admin UI,
// but for v1 we hardcode the defaults and accept a per-school override
// via the school_branding table when present.

import { query } from '@/lib/db';

// 24-hour times. The label is what we render to parents / pickup people.
export interface CurbsideSlot {
  value: string;    // canonical form stored in attendance_events.curbside_slot
  label: string;    // human display
}

export const DEFAULT_CURBSIDE_SLOTS: CurbsideSlot[] = [
  { value: '12:00', label: '12:00 pm' },
  { value: '14:30', label: '2:30 pm' },
  { value: '15:15', label: '3:15 pm' },
  { value: '15:30', label: '3:30 pm' },
];

// Per-school override is read from school_branding.curbside_slots
// (JSONB array of {value, label}). If absent or empty, defaults apply.
export async function resolveCurbsideSlots(schoolId: string): Promise<CurbsideSlot[]> {
  try {
    const { rows } = await query<{ curbside_slots: CurbsideSlot[] | null }>(
      `SELECT curbside_slots FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const override = rows[0]?.curbside_slots;
    if (Array.isArray(override) && override.length > 0) return override;
  } catch {
    // Column doesn't exist yet — fall through to defaults. We'll add it
    // when operators want per-school customization.
  }
  return DEFAULT_CURBSIDE_SLOTS;
}

export function isValidSlot(value: string, slots: CurbsideSlot[]): boolean {
  return slots.some((s) => s.value === value);
}
