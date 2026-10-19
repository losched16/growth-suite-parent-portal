// School-level billing hold (migration 116 in growth-suite-dashboards).
//
// A school with billing_hold_from / billing_hold_until set (inclusive dates)
// is paused for that window. "Paused" means two things, both enforced in SQL
// so every charge path agrees:
//
//   1. While today is inside the window, nothing is charged and no late
//      fee accrues for that school.
//   2. An invoice whose charge date (autopay_charge_on, else due_at) falls
//      inside the window is never auto-charged and never fee'd, even after
//      the window closes. Otherwise lifting the hold on Dec 1 would charge
//      every November installment at once.
//
// Retries of an earlier, pre-window failure are blocked during the window
// and resume after it. Parent-initiated payments are not affected.
//
// Both aliases are static identifiers from calling code, never user input.
export function onHoldSql(opts: { cfg: string; inv: string; today: string }): string {
  const { cfg, inv, today } = opts;
  return `(
    ${cfg}.billing_hold_from IS NOT NULL
    AND ${cfg}.billing_hold_until IS NOT NULL
    AND (
      ${today} BETWEEN ${cfg}.billing_hold_from AND ${cfg}.billing_hold_until
      OR COALESCE(${inv}.autopay_charge_on, ${inv}.due_at::date)
         BETWEEN ${cfg}.billing_hold_from AND ${cfg}.billing_hold_until
    )
  )`;
}
