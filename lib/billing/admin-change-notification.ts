// Fires an email to the school's admin notification address when a
// parent submits an enrollment with parent/guardian info that differs
// from what's on file. Used to keep external SIS (e.g. Transparent
// Classroom for DGM) in sync.
//
// Detection logic: any of the canonical pg1_* fields below differing
// from the existing parents row triggers a notification. We also send
// the email if any pg2_* field is non-empty (since we don't currently
// store a second-parent record, any pg2 info is necessarily new).
//
// Never throws — caller wraps in .catch().

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

interface NotifyArgs {
  schoolId: string;
  submissionId: string;
  parentId: string;
  responses: Record<string, unknown>;
  formDisplayName: string;
}

const PG1_TO_PARENT_COLUMN: Array<{ field: string; col: keyof ExistingParent; label: string }> = [
  { field: 'pg1_first_name', col: 'first_name', label: 'First name' },
  { field: 'pg1_last_name', col: 'last_name', label: 'Last name' },
  { field: 'pg1_mobile_phone', col: 'phone', label: 'Mobile phone' },
  { field: 'pg1_home_email', col: 'email', label: 'Email' },
];

const PG1_INFO_FIELDS = [
  { field: 'pg1_first_name', label: 'First name' },
  { field: 'pg1_last_name', label: 'Last name' },
  { field: 'pg1_street', label: 'Street' },
  { field: 'pg1_city', label: 'City' },
  { field: 'pg1_state', label: 'State' },
  { field: 'pg1_zip', label: 'ZIP' },
  { field: 'pg1_home_phone', label: 'Home phone' },
  { field: 'pg1_mobile_phone', label: 'Mobile phone' },
  { field: 'pg1_office_phone', label: 'Office phone' },
  { field: 'pg1_home_email', label: 'Home email' },
  { field: 'pg1_office_email', label: 'Office email' },
  { field: 'pg1_employer', label: "Employer's name" },
  { field: 'pg1_position', label: 'Position / title' },
];

const PG2_INFO_FIELDS = PG1_INFO_FIELDS.map((f) => ({
  field: f.field.replace('pg1_', 'pg2_'),
  label: f.label,
}));

interface ExistingParent {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

export async function notifyAdminOfParentChanges(args: NotifyArgs): Promise<void> {
  // 1. Resolve the destination email.
  const { rows: brandRows } = await query<{
    admin_change_notification_email: string | null;
    support_email: string | null;
    display_name: string | null;
  }>(
    `SELECT admin_change_notification_email, support_email, display_name
       FROM school_branding WHERE school_id = $1`,
    [args.schoolId],
  );
  const dest =
    brandRows[0]?.admin_change_notification_email
    || brandRows[0]?.support_email
    || process.env.RESEND_REPLY_TO
    || null;
  if (!dest) {
    console.warn('[admin-notify] no destination email configured; skipping');
    return;
  }

  // 2. Compare submitted pg1_* values to the existing parent record.
  const { rows: parentRows } = await query<ExistingParent>(
    `SELECT first_name, last_name, email, phone
       FROM parents WHERE id = $1`,
    [args.parentId],
  );
  const existing = parentRows[0];
  if (!existing) return;

  const changedCore: Array<{ label: string; before: string; after: string }> = [];
  for (const m of PG1_TO_PARENT_COLUMN) {
    const submitted = normalize(args.responses[m.field]);
    const onFile = normalize(existing[m.col]);
    if (submitted && submitted !== onFile) {
      changedCore.push({ label: m.label, before: onFile || '(none)', after: submitted });
    }
  }

  // 3. Check if any pg2_* field has any value — since we don't model
  //    second parents yet, any pg2 entry is by definition new info.
  const pg2HasContent = PG2_INFO_FIELDS.some(
    (f) => normalize(args.responses[f.field]) !== '',
  );

  // 4. Also collect every non-core pg1 field that has a value (street,
  //    employer, etc.) for inclusion in the email body. We can't tell
  //    "changed" for these without a separate snapshot column, so we
  //    include the current submitted value for Leslie to review.
  const pg1Address: Array<{ label: string; value: string }> = [];
  for (const f of PG1_INFO_FIELDS) {
    if (PG1_TO_PARENT_COLUMN.some((c) => c.field === f.field)) continue;
    const v = normalize(args.responses[f.field]);
    if (v) pg1Address.push({ label: f.label, value: v });
  }

  if (changedCore.length === 0 && !pg2HasContent && pg1Address.length === 0) {
    return; // nothing to notify
  }

  // 5. Build the email.
  const schoolName = brandRows[0]?.display_name ?? 'School';
  const subject = `[Parent info update] ${args.formDisplayName} (submission ${args.submissionId.slice(0, 8)})`;

  const lines: string[] = [];
  lines.push(`A parent just submitted ${args.formDisplayName}. Their parent/guardian information may need to be mirrored into Transparent Classroom.\n`);

  if (changedCore.length > 0) {
    lines.push('CHANGES FROM EXISTING RECORD:');
    for (const c of changedCore) {
      lines.push(`  • ${c.label}: ${c.before}  →  ${c.after}`);
    }
    lines.push('');
  }

  if (pg1Address.length > 0) {
    lines.push('SUBMITTED PARENT/GUARDIAN 1 DETAILS (please verify in TC):');
    for (const f of pg1Address) {
      lines.push(`  • ${f.label}: ${f.value}`);
    }
    lines.push('');
  }

  if (pg2HasContent) {
    lines.push('PARENT/GUARDIAN 2 INFO PROVIDED (we don\'t have this on file yet):');
    for (const f of PG2_INFO_FIELDS) {
      const v = normalize(args.responses[f.field]);
      if (v) lines.push(`  • ${f.label}: ${v}`);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  const html = `<pre style="font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; font-size: 13px; color: #111827;">${escape(text)}</pre>`;

  await sendBrandedEmail({
    to: dest,
    schoolId: args.schoolId,
    subject,
    html,
    text,
  });
  console.log(`[admin-notify] notified ${dest} of parent-info change in submission ${args.submissionId}`);
}

function normalize(v: unknown): string {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function escape(s: string): string {
  return s.replace(/[<>&]/g, (c) => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;');
}
