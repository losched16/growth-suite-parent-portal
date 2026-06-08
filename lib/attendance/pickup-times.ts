// Pickup-time logic — shared between the parent-portal check-in form and
// the dashboards attendance widget. Keep the two repo copies in sync.
//
// Three pickup waves:
//   - 2:30 PM (14:30)  Infant / Toddler / Primary
//   - 3:15 PM (15:15)  Lower Elementary
//   - 3:30 PM (15:30)  Upper Elementary / Middle Years / High School
//
// We match on substrings of the student's program label so the mapping
// survives the operator renaming "01 Infant" → "Infants" or similar.

export interface PickupTimeOption {
  value: string;          // 'HH:MM' 24h — what gets persisted
  label: string;          // '2:30 PM' — what the parent sees
  programs_short: string; // 'Infant · Toddler · Primary' — context line
}

export const PICKUP_TIME_OPTIONS: PickupTimeOption[] = [
  { value: '14:30', label: '2:30 PM', programs_short: 'Infant · Toddler · Primary' },
  { value: '15:15', label: '3:15 PM', programs_short: 'Lower Elementary' },
  { value: '15:30', label: '3:30 PM', programs_short: 'Upper Elementary · MY/HS' },
];

// Given a student's free-text program label, return the times that
// student is allowed to pick from. Returns ALL three options if we can't
// confidently classify the program — better to over-offer than block a
// parent from checking in.
export function eligiblePickupTimes(program: string | null | undefined): PickupTimeOption[] {
  const p = (program ?? '').toLowerCase();
  if (!p) return PICKUP_TIME_OPTIONS;

  // 2:30 wave — anything pre-elementary
  if (/infant|toddler|primary|nursery|preschool|pre-?k/.test(p)) {
    return [PICKUP_TIME_OPTIONS[0]];
  }
  // 3:15 wave — Lower Elementary (1st-3rd in Montessori)
  if (/lower\s*el|lower\s*elementary|\ble\b/.test(p)) {
    return [PICKUP_TIME_OPTIONS[1]];
  }
  // 3:30 wave — Upper Elementary, Middle Years, High School
  if (/upper\s*el|upper\s*elementary|\bue\b|middle\s*year|my\/?hs|\bmys?\b|\bhs\b|high\s*school/.test(p)) {
    return [PICKUP_TIME_OPTIONS[2]];
  }

  return PICKUP_TIME_OPTIONS;
}

// Format a stored HH:MM string back to a friendly display string for
// staff dashboards. Defensive — returns the input untouched if it
// doesn't look like a time.
export function formatPickupTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return value;
  const hh = parseInt(m[1], 10);
  const mm = m[2];
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return value;
  const period = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm} ${period}`;
}
