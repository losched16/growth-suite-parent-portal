// Post-submit side effects for real form submissions:
//
//   1. Office notification email to every address in
//      portal_form_definitions.notify_emails
//   2. Webhook fan-out: JSON POST to every URL in
//      portal_form_definitions.webhook_urls
//
// Both are fire-and-forget — a slow notification or webhook does NOT
// block the parent's redirect after submit. Errors are logged but
// never bubble up.
//
// The dashboards repo mirrors the JSON payload shape in its test-mode
// dry-run report so what staff sees in test mode is what production
// will actually deliver.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

export interface WebhookPayload {
  event: 'form.submitted';
  submission_id: string;
  form: {
    id: string;
    slug: string;
    display_name: string;
    category: string | null;
  };
  school: {
    id: string;
    ghl_location_id: string | null;
    name: string | null;
  };
  family: {
    id: string;
    parent_id: string;
    student_id: string | null;
  };
  responses: Record<string, unknown>;
  submitted_at: string;     // ISO timestamp
}

export interface FireOpts {
  submissionId: string;
  schoolId: string;
  formId: string;
  formSlug: string;
  formDisplayName: string;
  formCategory: string | null;
  familyId: string;
  parentId: string;
  studentId: string | null;
  responses: Record<string, unknown>;
  notifyEmails: string[] | null;
  webhookUrls: string[] | null;
}

// Single entry point — call this once at the end of a real (non-test)
// submission. Returns immediately; both branches are detached.
export function firePostSubmitEffects(opts: FireOpts): void {
  if (opts.notifyEmails && opts.notifyEmails.length > 0) {
    sendOfficeNotification(opts).catch((e) => {
      console.error('[post-submit] office notification failed:', e);
    });
  }
  if (opts.webhookUrls && opts.webhookUrls.length > 0) {
    fanoutWebhooks(opts).catch((e) => {
      console.error('[post-submit] webhook fan-out failed:', e);
    });
  }
}

// ─── Office notification email ─────────────────────────────────────

async function sendOfficeNotification(opts: FireOpts): Promise<void> {
  if (!opts.notifyEmails || opts.notifyEmails.length === 0) return;

  // Resolve some friendly labels for the email body.
  const { rows } = await query<{
    school_name: string;
    family_label: string;
    parent_email: string | null;
    parent_phone: string | null;
    student_label: string | null;
  }>(
    `SELECT s.name AS school_name,
            COALESCE(NULLIF(f.display_name, ''),
                     CONCAT_WS(' ', p.first_name, p.last_name),
                     '(unnamed family)') AS family_label,
            p.email AS parent_email,
            p.phone AS parent_phone,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label
       FROM schools s
       JOIN families f ON f.id = $2
       LEFT JOIN parents p ON p.id = $3
       LEFT JOIN students st ON st.id = $4
      WHERE s.id = $1`,
    [opts.schoolId, opts.familyId, opts.parentId, opts.studentId],
  );
  const meta = rows[0] ?? {
    school_name: '', family_label: '(unknown)', parent_email: null,
    parent_phone: null, student_label: null,
  };

  const subject = `New ${opts.formDisplayName} submission — ${meta.family_label}`;

  const responsePairs = Object.entries(opts.responses)
    .filter(([k]) => !k.startsWith('__'))
    .slice(0, 40); // cap at 40 rows so the email body stays readable

  const rowsHtml = responsePairs
    .map(([k, v]) => `<tr><td style="padding:4px 8px;font-family:monospace;color:#475569;font-size:11px;border-bottom:1px solid #f1f5f9;">${escape(k)}</td><td style="padding:4px 8px;border-bottom:1px solid #f1f5f9;">${escape(formatValue(v))}</td></tr>`)
    .join('');

  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 8px;">${escape(opts.formDisplayName)} — new submission</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px;">
    A parent just submitted the <strong>${escape(opts.formDisplayName)}</strong> form for <strong>${escape(meta.school_name)}</strong>.
  </p>

  <h3 style="margin:16px 0 4px;font-size:13px;color:#0f172a;">Family</h3>
  <table style="font-size:13px;color:#0f172a;border-collapse:collapse;">
    <tr><td style="padding:2px 8px;color:#64748b;">Family</td><td style="padding:2px 8px;">${escape(meta.family_label)}</td></tr>
    ${meta.student_label ? `<tr><td style="padding:2px 8px;color:#64748b;">Student</td><td style="padding:2px 8px;">${escape(meta.student_label)}</td></tr>` : ''}
    ${meta.parent_email ? `<tr><td style="padding:2px 8px;color:#64748b;">Parent email</td><td style="padding:2px 8px;"><a href="mailto:${escape(meta.parent_email)}">${escape(meta.parent_email)}</a></td></tr>` : ''}
    ${meta.parent_phone ? `<tr><td style="padding:2px 8px;color:#64748b;">Parent phone</td><td style="padding:2px 8px;">${escape(meta.parent_phone)}</td></tr>` : ''}
  </table>

  <h3 style="margin:24px 0 4px;font-size:13px;color:#0f172a;">Responses</h3>
  <table style="font-size:12px;color:#0f172a;border-collapse:collapse;width:100%;border:1px solid #e2e8f0;border-radius:4px;">
    ${rowsHtml || '<tr><td style="padding:8px;color:#94a3b8;">(no fields filled)</td></tr>'}
  </table>

  <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">
    Submission ID <code>${escape(opts.submissionId)}</code>
  </p>
</body></html>`.trim();

  const textPairs = responsePairs.map(([k, v]) => `${k}: ${formatValue(v)}`).join('\n');
  const text = [
    `${opts.formDisplayName} — new submission`,
    '',
    `Family: ${meta.family_label}`,
    meta.student_label ? `Student: ${meta.student_label}` : null,
    meta.parent_email ? `Parent email: ${meta.parent_email}` : null,
    meta.parent_phone ? `Parent phone: ${meta.parent_phone}` : null,
    '',
    'Responses:',
    textPairs,
    '',
    `Submission ID: ${opts.submissionId}`,
  ].filter(Boolean).join('\n');

  // sendBrandedEmail takes one recipient at a time — fan out so each
  // office address gets its own message (and one failure doesn't
  // suppress the others).
  await Promise.allSettled(opts.notifyEmails.map((to) =>
    sendBrandedEmail({
      to,
      schoolId: opts.schoolId,
      subject,
      html,
      text,
    }),
  ));
}

// ─── Webhook fan-out ──────────────────────────────────────────────

async function fanoutWebhooks(opts: FireOpts): Promise<void> {
  if (!opts.webhookUrls || opts.webhookUrls.length === 0) return;

  // Pull school metadata once for the payload.
  const { rows } = await query<{ ghl_location_id: string | null; name: string | null }>(
    `SELECT ghl_location_id, name FROM schools WHERE id = $1`,
    [opts.schoolId],
  );
  const schoolMeta = rows[0] ?? { ghl_location_id: null, name: null };

  const payload: WebhookPayload = {
    event: 'form.submitted',
    submission_id: opts.submissionId,
    form: {
      id: opts.formId,
      slug: opts.formSlug,
      display_name: opts.formDisplayName,
      category: opts.formCategory,
    },
    school: {
      id: opts.schoolId,
      ghl_location_id: schoolMeta.ghl_location_id,
      name: schoolMeta.name,
    },
    family: {
      id: opts.familyId,
      parent_id: opts.parentId,
      student_id: opts.studentId,
    },
    responses: stripInternalKeys(opts.responses),
    submitted_at: new Date().toISOString(),
  };

  await Promise.allSettled(opts.webhookUrls.map(async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrowthSuite-FormWebhook/1' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.warn(`[webhook] ${url} returned ${res.status}`);
      }
    } catch (e) {
      console.warn(`[webhook] ${url} failed:`, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────

function stripInternalKeys(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('__')) continue;
    out[k] = v;
  }
  return out;
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : v.map(String).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v.startsWith('data:') ? '(data URL — signature/file)' : v;
  return String(v);
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
