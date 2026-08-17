// Automated form-completion reminders.
//
// For every school with reminders_enabled, at the school's configured
// local send hour, look at every active family; if it still owes forms
// (same definition as the portal home checklist — lib/forms/pending.ts)
// AND it's been >= reminder_interval_days since the family's last
// reminder (or it has never had one) AND it hasn't hit reminder_max_count,
// email every active parent with an address a personalized reminder:
//
//   - the list of outstanding forms (with student names for per-student ones)
//   - a one-click sign-in button (multi-use magic link, 7-day expiry —
//     no password to remember; the parent lands straight on their to-do)
//   - the school's support address for questions
//
// Sends route through the school's configured provider (GHL for Wooster)
// via sendBrandedEmail. Every attempt lands in form_reminder_log so the
// cadence is enforced per family and the office can audit who was nudged.
//
// Idempotency: the log is checked BEFORE each send with the interval, so a
// cron double-fire in the same hour sends nothing twice.

import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { portalBaseForSchool } from '@/lib/portal-base';
import { loadPendingForms, type PendingForm } from '@/lib/forms/pending';

const LINK_TTL_DAYS = 7;

export interface ReminderSchoolConfig {
  school_id: string;
  school_name: string;
  display_name: string | null;
  support_email: string | null;
  reminders_enabled: boolean;
  reminder_interval_days: number;
  reminder_max_count: number | null;
  reminder_send_hour_local: number;
  reminder_timezone: string;
  reminder_honor_ghl_completion: boolean;
}

export interface SchoolRunResult {
  school_id: string;
  school_name: string;
  ran: boolean;
  reason?: string;
  families_scanned: number;
  families_owing: number;
  families_due: number;
  emails_sent: number;
  emails_failed: number;
  errors: string[];
}

export async function loadReminderSchools(): Promise<ReminderSchoolConfig[]> {
  const { rows } = await query<ReminderSchoolConfig>(
    `SELECT s.id AS school_id, s.name AS school_name,
            b.display_name, b.support_email,
            b.reminders_enabled, b.reminder_interval_days, b.reminder_max_count,
            b.reminder_send_hour_local, b.reminder_timezone, b.reminder_honor_ghl_completion
       FROM school_branding b
       JOIN schools s ON s.id = b.school_id
      WHERE b.reminders_enabled = true`,
  );
  return rows;
}

// Local hour (0-23) right now in the given IANA zone.
export function localHour(tz: string, now = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(now);
    const h = Number(s);
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

interface FamilyRow { family_id: string; display_name: string }
interface ParentRow { id: string; email: string; first_name: string }
interface StudentRow { id: string; first_name: string; preferred_name: string | null }
interface LastReminderRow { count: number; last_sent_at: string | null }

export async function runRemindersForSchool(
  cfg: ReminderSchoolConfig,
  opts: { dryRun?: boolean; force?: boolean; onlyFamilyId?: string | null; now?: Date } = {},
): Promise<SchoolRunResult> {
  const now = opts.now ?? new Date();
  const res: SchoolRunResult = {
    school_id: cfg.school_id, school_name: cfg.school_name, ran: false,
    families_scanned: 0, families_owing: 0, families_due: 0,
    emails_sent: 0, emails_failed: 0, errors: [],
  };

  if (!opts.force) {
    const h = localHour(cfg.reminder_timezone, now);
    if (h !== cfg.reminder_send_hour_local) {
      res.reason = `not_send_hour (local ${h}, configured ${cfg.reminder_send_hour_local})`;
      return res;
    }
  }
  res.ran = true;

  const schoolLabel = cfg.display_name?.trim() || cfg.school_name;
  const base = await portalBaseForSchool(cfg.school_id);

  const { rows: families } = await query<FamilyRow>(
    `SELECT f.id AS family_id, f.display_name
       FROM families f
      WHERE f.school_id = $1 AND f.status = 'active'
        AND ($2::uuid IS NULL OR f.id = $2::uuid)
        -- only families that can actually act: at least one active parent with an email
        AND EXISTS (SELECT 1 FROM parents p WHERE p.family_id = f.id AND p.status = 'active' AND p.email IS NOT NULL AND p.email <> '')
        -- and at least one active student who is actually ENROLLED. Withdrawn
        -- families and admissions-pipeline prospects (no enrollment row yet /
        -- inquiry / tour) must never be nagged for enrollment paperwork.
        AND EXISTS (SELECT 1 FROM students s
                      JOIN enrollments e ON e.student_id = s.id
                     WHERE s.family_id = f.id AND s.status = 'active' AND e.status = 'enrolled')
      ORDER BY f.display_name`,
    [cfg.school_id, opts.onlyFamilyId ?? null],
  );
  res.families_scanned = families.length;

  const intervalMs = Math.max(1, cfg.reminder_interval_days) * 86_400_000;

  for (const fam of families) {
    let pending: PendingForm[];
    try {
      pending = await loadPendingForms({
        schoolId: cfg.school_id, familyId: fam.family_id,
        honorGhlCompletion: cfg.reminder_honor_ghl_completion,
        enrolledOnly: true,
      });
    } catch (e) {
      res.errors.push(`${fam.display_name}: pending lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (pending.length === 0) continue;
    res.families_owing++;

    // Cadence gate.
    const { rows: lr } = await query<LastReminderRow>(
      `SELECT COUNT(*)::int AS count, MAX(sent_at) AS last_sent_at
         FROM form_reminder_log
        WHERE school_id = $1 AND family_id = $2 AND status = 'sent'`,
      [cfg.school_id, fam.family_id],
    );
    const sentCount = lr[0]?.count ?? 0;
    const lastSent = lr[0]?.last_sent_at ? new Date(lr[0].last_sent_at) : null;
    if (cfg.reminder_max_count != null && sentCount >= cfg.reminder_max_count) continue;
    if (lastSent && now.getTime() - lastSent.getTime() < intervalMs) continue;
    res.families_due++;

    // Recipients: every active parent with an email.
    const { rows: parents } = await query<ParentRow>(
      `SELECT id, email, first_name FROM parents
        WHERE family_id = $1 AND status = 'active' AND email IS NOT NULL AND email <> ''
        ORDER BY is_primary DESC, first_name`,
      [fam.family_id],
    );
    const { rows: students } = await query<StudentRow>(
      `SELECT id, first_name, preferred_name FROM students WHERE family_id = $1 AND status = 'active'`,
      [fam.family_id],
    );
    const studentName = new Map(students.map((s) => [s.id, (s.preferred_name?.trim() || s.first_name)]));

    const reminderNumber = sentCount + 1;
    const slugs = pending.map((p) => p.slug);

    for (const parent of parents) {
      // Per-parent scoping: a co-parent restricted to specific students only
      // hears about their students' forms.
      let mine = pending;
      try {
        mine = await loadPendingForms({
          schoolId: cfg.school_id, familyId: fam.family_id, parentId: parent.id,
          honorGhlCompletion: cfg.reminder_honor_ghl_completion,
          enrolledOnly: true,
        });
      } catch { /* fall back to family-wide list */ }
      if (mine.length === 0) continue;

      if (opts.dryRun) {
        res.emails_sent++;
        continue;
      }

      let loginUrl: string;
      try {
        loginUrl = await mintReminderLink({ schoolId: cfg.school_id, parentId: parent.id, email: parent.email, base });
      } catch (e) {
        res.emails_failed++;
        res.errors.push(`${fam.display_name} / ${parent.email}: link mint failed: ${e instanceof Error ? e.message : String(e)}`);
        await logAttempt({ cfg, fam, parent, reminderNumber, slugs, status: 'failed', error: 'link_mint_failed' });
        continue;
      }

      const { subject, html, text } = renderReminderEmail({
        schoolLabel, parentFirstName: parent.first_name, pending: mine, studentName, loginUrl,
        supportEmail: cfg.support_email, reminderNumber,
      });

      try {
        await sendBrandedEmail({ to: parent.email, schoolId: cfg.school_id, subject, html, text });
        res.emails_sent++;
        await logAttempt({ cfg, fam, parent, reminderNumber, slugs, status: 'sent' });
      } catch (e) {
        res.emails_failed++;
        const msg = e instanceof Error ? e.message : String(e);
        res.errors.push(`${fam.display_name} / ${parent.email}: send failed: ${msg}`);
        await logAttempt({ cfg, fam, parent, reminderNumber, slugs, status: 'failed', error: msg.slice(0, 500) });
      }
    }
  }
  return res;
}

async function mintReminderLink(o: { schoolId: string; parentId: string; email: string; base: string }): Promise<string> {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + LINK_TTL_DAYS * 86_400_000).toISOString();
  await query(
    `INSERT INTO parent_magic_link_tokens (token, email, school_id, parent_id, expires_at, multi_use)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [token, o.email.toLowerCase(), o.schoolId, o.parentId, expires],
  );
  return `${o.base}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

async function logAttempt(o: {
  cfg: ReminderSchoolConfig; fam: FamilyRow; parent: ParentRow;
  reminderNumber: number; slugs: string[]; status: 'sent' | 'failed' | 'skipped'; error?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO form_reminder_log
         (school_id, family_id, parent_id, email, reminder_number, forms_outstanding, form_slugs, provider, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [o.cfg.school_id, o.fam.family_id, o.parent.id, o.parent.email, o.reminderNumber,
       o.slugs.length, o.slugs, 'ghl', o.status, o.error ?? null],
    );
  } catch (e) {
    console.error('[form-reminders] log insert failed:', e);
  }
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => (
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

export function renderReminderEmail(o: {
  schoolLabel: string;
  parentFirstName: string;
  pending: PendingForm[];
  studentName: Map<string, string>;
  loginUrl: string;
  supportEmail: string | null;
  reminderNumber: number;
}): { subject: string; html: string; text: string } {
  const items = o.pending.map((p) => {
    if (p.per_student) {
      const kids = p.missing_student_ids.map((id) => o.studentName.get(id) ?? 'your student');
      return { label: p.display_name, detail: kids.length ? `for ${kids.join(', ')}` : '' };
    }
    return { label: p.display_name, detail: '' };
  });
  const n = items.length;
  const subject = n === 1
    ? `Reminder: 1 form still needed — ${o.schoolLabel}`
    : `Reminder: ${n} forms still needed — ${o.schoolLabel}`;

  const greeting = o.parentFirstName?.trim() ? `Hi ${esc(o.parentFirstName.trim())},` : 'Hello,';
  const support = o.supportEmail
    ? `Questions? Reply to this email or reach us at ${o.supportEmail}.`
    : 'Questions? Just reply to this email.';

  const listHtml = items.map((it) =>
    `<li style="margin:0 0 8px;"><strong>${esc(it.label)}</strong>${it.detail ? ` <span style="color:#6b7280;">${esc(it.detail)}</span>` : ''}</li>`,
  ).join('');
  const listText = items.map((it) => `  • ${it.label}${it.detail ? ` (${it.detail})` : ''}`).join('\n');

  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:520px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 16px;font-size:18px;">${esc(o.schoolLabel)} — a few forms still need your attention</h2>
  <p style="margin:0 0 12px;font-size:14px;line-height:1.5;">${greeting}</p>
  <p style="margin:0 0 12px;font-size:14px;line-height:1.5;">
    Thanks for getting started in the Family Portal. Our records show the following ${n === 1 ? 'form is' : 'forms are'} still outstanding for your family:
  </p>
  <ul style="margin:0 0 20px 20px;padding:0;font-size:14px;line-height:1.5;">${listHtml}</ul>
  <p style="margin:0 0 8px;font-size:14px;line-height:1.5;">Click below to sign in — no password needed — and you'll land right on your checklist. Each form only takes a few minutes.</p>
  <p style="margin:20px 0;">
    <a href="${o.loginUrl}" style="display:inline-block;background:#1F1F1F;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Open my forms</a>
  </p>
  <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">This sign-in link works for ${LINK_TTL_DAYS} days. If it stops working, visit the portal and choose "Forgot password" to get a new one.</p>
  <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="margin:0;font-size:12px;color:#6b7280;">${esc(support)}<br>If you've already completed these in the last day or two, thank you — you can disregard this note.</p>
</body></html>`.trim();

  const text = `${o.schoolLabel} — a few forms still need your attention

${greeting.replace(/,$/, ',')}

Thanks for getting started in the Family Portal. Our records show the following ${n === 1 ? 'form is' : 'forms are'} still outstanding for your family:

${listText}

Sign in here (no password needed) and you'll land right on your checklist:
${o.loginUrl}

This sign-in link works for ${LINK_TTL_DAYS} days.

${support}
If you've already completed these in the last day or two, thank you — you can disregard this note.`;

  return { subject, html, text };
}
