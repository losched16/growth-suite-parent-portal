// Notifies the school's admin address when a parent changes their family's
// authorized pickup-person list — added, updated, or removed. Lets the
// office keep the front-desk / SIS authorized-pickup list in sync.
//
// Destination = school_branding.admin_change_notification_email (for DGM:
// admissions@desertgardenmontessori.org), falling back to support_email
// then the env reply-to. Never throws — safe to await from a route.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

type Action = 'added' | 'updated' | 'removed';

interface PickupNotifyArgs {
  schoolId: string;
  parentId: string;          // the parent who made the change
  action: Action;
  person: {
    name: string;
    relationship?: string | null;
    phone?: string | null;
    notes?: string | null;
  };
  // Student IDs this person is authorized for. `[]` means "all students in
  // the family". `undefined` means "unchanged / unknown" → omit the line.
  authorizedStudentIds?: string[];
}

export async function notifyAdminOfPickupPersonChange(args: PickupNotifyArgs): Promise<void> {
  try {
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
      console.warn('[pickup-notify] no destination email configured; skipping');
      return;
    }

    // Who made the change + their family.
    const { rows: pRows } = await query<{
      first_name: string | null; last_name: string | null; email: string | null;
      family_name: string | null;
    }>(
      `SELECT p.first_name, p.last_name, p.email, f.display_name AS family_name
         FROM parents p JOIN families f ON f.id = p.family_id
        WHERE p.id = $1`,
      [args.parentId],
    );
    const parent = pRows[0];
    const parentName =
      (parent ? `${parent.first_name ?? ''} ${parent.last_name ?? ''}`.trim() : '') ||
      parent?.email || 'A parent';
    const familyName = parent?.family_name ?? 'their family';

    // Resolve student-scope names (when provided).
    let scopeText: string | null = null;
    if (args.authorizedStudentIds) {
      if (args.authorizedStudentIds.length === 0) {
        scopeText = 'All students in the family';
      } else {
        const { rows: sRows } = await query<{ name: string }>(
          `SELECT CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
             FROM students WHERE id = ANY($1::uuid[])`,
          [args.authorizedStudentIds],
        );
        scopeText = sRows.length > 0 ? sRows.map((r) => r.name).join(', ') : 'All students in the family';
      }
    }

    const schoolName = brandRows[0]?.display_name ?? 'School';
    const verb = args.action; // 'added' | 'updated' | 'removed'
    const subject = `[Authorized pickup ${verb}] ${args.person.name} — ${familyName}`;

    const lines: string[] = [];
    lines.push(`${parentName} (${familyName}) ${verb} an authorized pickup person in the ${schoolName} family portal.\n`);
    lines.push('PICKUP PERSON:');
    lines.push(`  • Name: ${args.person.name}`);
    if (args.person.relationship) lines.push(`  • Relationship: ${args.person.relationship}`);
    if (args.person.phone) lines.push(`  • Phone: ${args.person.phone}`);
    if (args.person.notes) lines.push(`  • Notes: ${args.person.notes}`);
    if (scopeText) lines.push(`  • Authorized for: ${scopeText}`);
    lines.push('');
    lines.push(`Changed by: ${parentName}${parent?.email ? ` (${parent.email})` : ''}`);

    const text = lines.join('\n');
    const html = `<pre style="font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; font-size: 13px; color: #111827;">${escape(text)}</pre>`;

    await sendBrandedEmail({ to: dest, schoolId: args.schoolId, subject, html, text });
    console.log(`[pickup-notify] notified ${dest}: ${args.person.name} ${verb} for ${familyName}`);
  } catch (err) {
    // Never block the parent's action on a notification failure.
    console.error('[pickup-notify] failed:', err);
  }
}

function escape(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}
