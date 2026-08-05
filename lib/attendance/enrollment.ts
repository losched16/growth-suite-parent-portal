// Students whose enrollment status marks them NOT ATTENDING (on hold /
// withdrawn / graduated / declined on the CRM contact) are excluded from
// every check-in/out surface — the parent portal attendance pages and
// the front-door kiosk. Metadata-driven (raw contact value), so it works
// regardless of whether an enrollment row exists for the status.
// Interpolate with an alias, e.g. notAttendingSql('s').

export function notAttendingSql(alias: string): string {
  return `lower(coalesce(${alias}.metadata->>'enrollment_status', ''))
    NOT IN ('hold', 'on hold', 'on_hold', 'withdrawn', 'withdrew', 'graduated', 'declined')`;
}
