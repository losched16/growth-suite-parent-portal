// Preview of today's Wooster reminder run: exact recipients + rendered email.
// NO SENDS. Writes preview files for review.
import fs from 'node:fs';
import { query } from '../lib/db';
import { loadReminderSchools, renderReminderEmail } from '../lib/forms/reminders';
import { loadPendingForms } from '../lib/forms/pending';
import { portalBaseForSchool } from '../lib/portal-base';

const OUT = process.argv[2] ?? '.';
const schools = await loadReminderSchools();
const cfg = schools.find((s) => /wooster/i.test(s.school_name))!;
const base = await portalBaseForSchool(cfg.school_id);

const { rows: families } = await query<{ family_id: string; display_name: string }>(
  `SELECT f.id AS family_id, f.display_name FROM families f
    WHERE f.school_id = $1 AND f.status = 'active'
      AND EXISTS (SELECT 1 FROM parents p WHERE p.family_id = f.id AND p.status = 'active' AND p.email IS NOT NULL AND p.email <> '')
      AND EXISTS (SELECT 1 FROM students s JOIN enrollments e ON e.student_id = s.id WHERE s.family_id = f.id AND s.status = 'active' AND e.status = 'enrolled')
    ORDER BY f.display_name`, [cfg.school_id]);

const rows: string[] = ['family,parent_email,parent_has_ghl_contact,forms_outstanding,forms'];
let famDue = 0, emails = 0, complete = 0, p2NoContact = 0;
let sample: { fam: string; email: string; first: string; pending: any[]; names: Map<string, string> } | null = null;

for (const f of families) {
  const pending = await loadPendingForms({ schoolId: cfg.school_id, familyId: f.family_id, honorGhlCompletion: cfg.reminder_honor_ghl_completion, enrolledOnly: true });
  if (pending.length === 0) { complete++; continue; }
  const { rows: sent } = await query<{ n: number }>(`SELECT COUNT(*)::int n FROM form_reminder_log WHERE school_id=$1 AND family_id=$2 AND status='sent' AND sent_at > now() - interval '7 days'`, [cfg.school_id, f.family_id]);
  if (sent[0].n > 0) continue; // already reminded this week
  famDue++;
  const { rows: parents } = await query<{ id: string; email: string; first_name: string; ghl_contact_id: string | null }>(
    `SELECT id, email, first_name, ghl_contact_id FROM parents WHERE family_id=$1 AND status='active' AND email IS NOT NULL AND email<>'' ORDER BY is_primary DESC, first_name`, [f.family_id]);
  const { rows: students } = await query<{ id: string; first_name: string; preferred_name: string | null }>(`SELECT id, first_name, preferred_name FROM students WHERE family_id=$1 AND status='active'`, [f.family_id]);
  const names = new Map(students.map((s) => [s.id, s.preferred_name?.trim() || s.first_name]));
  for (const p of parents) {
    const mine = await loadPendingForms({ schoolId: cfg.school_id, familyId: f.family_id, parentId: p.id, honorGhlCompletion: cfg.reminder_honor_ghl_completion, enrolledOnly: true });
    if (mine.length === 0) continue;
    // GHL send needs a contact id resolvable from this email
    const { rows: c } = await query<{ ghl_contact_id: string | null }>(`SELECT ghl_contact_id FROM parents WHERE school_id=$1 AND lower(email)=lower($2) AND ghl_contact_id IS NOT NULL LIMIT 1`, [cfg.school_id, p.email]);
    const hasContact = c.length > 0;
    if (!hasContact) p2NoContact++;
    emails++;
    rows.push(`"${f.display_name}",${p.email},${hasContact ? 'yes' : 'NO'},${mine.length},"${mine.map((x) => x.display_name + (x.per_student ? ` [${x.missing_student_ids.map((id) => names.get(id)).join('/')}]` : '')).join(' | ')}"`);
    if (!sample && mine.length >= 3 && hasContact) sample = { fam: f.display_name, email: p.email, first: p.first_name, pending: mine, names };
  }
}

const s = sample!;
const { subject, html, text } = renderReminderEmail({
  schoolLabel: cfg.display_name?.trim() || cfg.school_name, parentFirstName: s.first, pending: s.pending, studentName: s.names,
  loginUrl: `${base}/api/auth/verify?token=EXAMPLE-ONE-CLICK-LINK`, supportEmail: cfg.support_email, reminderNumber: 1,
});
fs.writeFileSync(`${OUT}/wooster-reminder-preview.html`, `<!-- Sample: ${s.fam} → ${s.email} | Subject: ${subject} -->\n` + html);
fs.writeFileSync(`${OUT}/wooster-reminder-preview.txt`, `SUBJECT: ${subject}\nSAMPLE FAMILY: ${s.fam} → ${s.email}\n\n${text}`);
fs.writeFileSync(`${OUT}/wooster-reminder-recipients.csv`, rows.join('\n'));
console.log(JSON.stringify({ enrolled_families_scanned: families.length, complete_no_email: complete, families_due_today: famDue, emails_to_send: emails, parent2_rows_without_ghl_contact: p2NoContact, sample_family: s.fam, subject, portal_base: base, support: cfg.support_email, provider: 'ghl' }, null, 2));
process.exit(0);
