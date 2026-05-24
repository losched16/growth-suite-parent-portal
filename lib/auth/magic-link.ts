// Magic-link auth flow.
//
//   1. Parent visits /login, types email, submits.
//   2. POST /api/auth/request-link  →  we look up email in `parents`
//      table. If we find at least one matching parent, mint a token,
//      store in parent_magic_link_tokens, send via email.
//      If we DON'T find a match, we STILL return success (don't leak
//      whether email exists).
//   3. Parent clicks email link → GET /api/auth/verify?token=...
//      We verify token (unconsumed, unexpired), mark consumed, mint a
//      session JWT cookie, redirect to /home.

import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendMagicLinkEmail } from '@/lib/email';

const TOKEN_BYTES = 24; // 192 bits → ~32 base64url chars
const TOKEN_TTL_MIN = 15;

export interface ParentLookupResult {
  email: string;
  candidates: Array<{
    parent_id: string;
    school_id: string;
    school_name: string;
    family_id: string;
    first_name: string;
    last_name: string;
    branding_display_name: string | null;
    support_email: string | null;
  }>;
}

// Find ALL parent rows matching a normalized email. A single email may
// be tied to parents at multiple schools (rare but possible — the auth
// flow handles this by creating one token per (email, parent_id) pair
// and the verify step picks the right school).
export async function lookupParentsByEmail(rawEmail: string): Promise<ParentLookupResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { email, candidates: [] };

  const { rows } = await query<{
    parent_id: string;
    school_id: string;
    school_name: string;
    family_id: string;
    first_name: string;
    last_name: string;
    branding_display_name: string | null;
    support_email: string | null;
  }>(
    `SELECT
       p.id AS parent_id,
       p.school_id,
       s.name AS school_name,
       p.family_id,
       p.first_name,
       p.last_name,
       b.display_name AS branding_display_name,
       b.support_email
     FROM parents p
     JOIN schools s ON s.id = p.school_id
     LEFT JOIN school_branding b ON b.school_id = p.school_id
     WHERE LOWER(p.email) = $1 AND p.status = 'active'`,
    [email],
  );
  return { email, candidates: rows };
}

export async function issueMagicLinkTokens(opts: {
  email: string;
  candidates: ParentLookupResult['candidates'];
  requestIp: string | null;
  userAgent: string | null;
}): Promise<Array<{ token: string; school_id: string; school_name: string; support_email: string | null }>> {
  const expires = new Date(Date.now() + TOKEN_TTL_MIN * 60_000).toISOString();
  const issued: Array<{ token: string; school_id: string; school_name: string; support_email: string | null }> = [];

  for (const c of opts.candidates) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    await query(
      `INSERT INTO parent_magic_link_tokens
         (token, email, school_id, parent_id, expires_at, request_ip, request_user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token, opts.email, c.school_id, c.parent_id, expires, opts.requestIp, opts.userAgent],
    );
    issued.push({
      token,
      school_id: c.school_id,
      school_name: c.school_name,
      support_email: c.support_email,
    });
  }
  return issued;
}

// Best-effort audit log row — never throws, never blocks the auth path.
export async function logEvent(opts: {
  event_type: string;
  email?: string;
  school_id?: string | null;
  parent_id?: string | null;
  family_id?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  user_agent?: string | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO parent_portal_audit_log
         (school_id, parent_id, family_id, event_type, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        opts.school_id ?? null,
        opts.parent_id ?? null,
        opts.family_id ?? null,
        opts.event_type,
        JSON.stringify({ email: opts.email, ...opts.detail }),
        opts.ip ?? null,
        opts.user_agent ?? null,
      ],
    );
  } catch {
    // swallow
  }
}

export interface ConsumeTokenResult {
  parent_id: string;
  school_id: string;
  family_id: string;
  email: string;
}

// Look up the token, ensure unconsumed + unexpired, mark consumed atomically.
// Returns null on any failure (caller decides how to redirect).
export async function consumeToken(token: string): Promise<ConsumeTokenResult | null> {
  if (!token || typeof token !== 'string') return null;

  // Atomic mark-consumed: only succeeds if not already consumed and not expired.
  const { rows } = await query<{
    parent_id: string;
    school_id: string;
    email: string;
  }>(
    `UPDATE parent_magic_link_tokens
     SET consumed_at = now()
     WHERE token = $1
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING parent_id, school_id, email`,
    [token],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  // Look up family_id (parents.family_id). Could JOIN above but easier as a
  // follow-up since we need the parent row to validate it still exists.
  const { rows: parentRows } = await query<{ family_id: string }>(
    `SELECT family_id FROM parents WHERE id = $1 AND status = 'active'`,
    [row.parent_id],
  );
  if (parentRows.length === 0) return null;

  return {
    parent_id: row.parent_id,
    school_id: row.school_id,
    family_id: parentRows[0].family_id,
    email: row.email,
  };
}

// Convenience: do the full request-link flow end-to-end.
export async function handleLoginRequest(opts: {
  rawEmail: string;
  origin: string; // e.g. https://family.mygrowthsuite.com — for the link URL
  requestIp: string | null;
  userAgent: string | null;
}): Promise<{ sent: number }> {
  const { email, candidates } = await lookupParentsByEmail(opts.rawEmail);
  await logEvent({
    event_type: 'login_request',
    email,
    detail: { candidate_count: candidates.length },
    ip: opts.requestIp,
    user_agent: opts.userAgent,
  });

  if (candidates.length === 0) return { sent: 0 };

  const tokens = await issueMagicLinkTokens({
    email,
    candidates,
    requestIp: opts.requestIp,
    userAgent: opts.userAgent,
  });

  // One email per matched school. Almost always 1.
  for (const t of tokens) {
    const url = `${opts.origin}/api/auth/verify?token=${encodeURIComponent(t.token)}`;
    try {
      await sendMagicLinkEmail({
        to: email,
        loginUrl: url,
        schoolId: t.school_id,
        schoolName: t.school_name,
        supportEmail: t.support_email,
      });
    } catch (err) {
      await logEvent({
        event_type: 'login_email_failed',
        email,
        school_id: t.school_id,
        detail: { error: err instanceof Error ? err.message : String(err) },
        ip: opts.requestIp,
        user_agent: opts.userAgent,
      });
    }
  }

  return { sent: tokens.length };
}
