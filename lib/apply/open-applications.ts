// Open applications — admissions schools (Nativity) can hand ANYONE a link to
// start an application. No pre-provisioning: a visitor gives their name and
// email, proves the mailbox with a one-time emailed link, picks a password, and
// lands in the application.
//
// Config (schools.settings.open_applications):
//   { enabled: true, slug: 'nativity', form_slug: 'nativity-application',
//     tag: 'portal applicant' }            // tag is optional
//
// CRM link: if the email already belongs to a contact in the school's GHL
// location, the new parent row is linked to THAT contact (so the portal pre-fills
// from it and the application writes back to it). Otherwise a contact is created.
// The contact is only looked up after the mailbox is verified, so typing
// someone else's email can never pull their record into a stranger's session.

import { SignJWT, jwtVerify } from 'jose';
import { query, withTransaction } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { createContact, searchContacts } from '@/lib/ghl/contacts';
import { hashPassword } from '@/lib/auth/password';

export interface OpenApplyConfig {
  schoolId: string;
  schoolName: string;
  slug: string;
  formSlug: string;
  tag: string | null;
}

export interface ApplyBranding {
  display_name: string;
  logo_url: string | null;
  primary_color: string;
  primary_color_soft: string;
  primary_color_fg: string;
  support_email: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (s: string) => EMAIL_RE.test(s) && s.length <= 254;

type Row = { id: string; name: string; cfg: Record<string, unknown> | null };

function toConfig(r: Row | undefined): OpenApplyConfig | null {
  const c = r?.cfg;
  if (!r || !c || c.enabled !== true) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const slug = str(c.slug);
  const formSlug = str(c.form_slug);
  if (!slug || !formSlug) return null;
  return { schoolId: r.id, schoolName: r.name, slug, formSlug, tag: str(c.tag) };
}

export async function loadOpenApplyBySlug(slug: string): Promise<OpenApplyConfig | null> {
  const { rows } = await query<Row>(
    `SELECT id, name, settings->'open_applications' AS cfg FROM schools
      WHERE lower(settings->'open_applications'->>'slug') = lower($1) LIMIT 1`,
    [slug],
  );
  return toConfig(rows[0]);
}

export async function loadOpenApplyBySchool(schoolId: string): Promise<OpenApplyConfig | null> {
  const { rows } = await query<Row>(
    `SELECT id, name, settings->'open_applications' AS cfg FROM schools WHERE id = $1`,
    [schoolId],
  );
  return toConfig(rows[0]);
}

export async function loadApplyBranding(schoolId: string, fallbackName: string): Promise<ApplyBranding> {
  const { rows } = await query<{
    display_name: string | null; logo_url: string | null; primary_color: string | null;
    primary_color_soft: string | null; primary_color_fg: string | null; support_email: string | null;
  }>(
    `SELECT display_name, logo_url, primary_color, primary_color_soft, primary_color_fg, support_email
       FROM school_branding WHERE school_id = $1`,
    [schoolId],
  );
  const b = rows[0];
  return {
    display_name: b?.display_name ?? fallbackName,
    logo_url: b?.logo_url ?? null,
    primary_color: b?.primary_color ?? '#047857',
    primary_color_soft: b?.primary_color_soft ?? '#ecfdf5',
    primary_color_fg: b?.primary_color_fg ?? '#064e3b',
    support_email: b?.support_email ?? null,
  };
}

// ── Email-proof token (24h) ────────────────────────────────────────────────
export interface ApplyClaims {
  school_id: string;
  email: string;
  first: string;
  last: string;
  phone: string;
}

function secret(): Uint8Array {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) throw new Error('PARENT_SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

export async function mintApplyToken(c: ApplyClaims): Promise<string> {
  return new SignJWT({ ...c, purpose: 'apply' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret());
}

export async function verifyApplyToken(token: string | null | undefined): Promise<ApplyClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (payload.purpose !== 'apply') return null;
    return payload as unknown as ApplyClaims;
  } catch {
    return null;
  }
}

// ── Account creation ───────────────────────────────────────────────────────
export type ProvisionResult =
  | { kind: 'created' | 'password_set'; parentId: string; familyId: string; email: string }
  | { kind: 'has_password' };

const clean = (s: unknown, n = 80) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

async function addTag(contactId: string, tag: string, schoolId: string): Promise<void> {
  try {
    const client = await loadGhlClient(schoolId);
    await client.axios.post(`/contacts/${contactId}/tags`, { tags: [tag] });
  } catch (e) {
    console.error('[apply] tag add failed:', e instanceof Error ? e.message : e);
  }
}

// Find the school's CRM contact for this email, or create one. Never throws:
// the account still gets created without a link (the application then simply
// has no contact to write to, which is logged for the school to reconcile).
async function resolveContact(
  cfg: OpenApplyConfig, email: string, first: string, last: string, phone: string,
): Promise<{ id: string | null; first: string; last: string; phone: string; existed: boolean }> {
  try {
    const client = await loadGhlClient(cfg.schoolId);
    const found = await searchContacts({
      client, pageLimit: 5, maxPages: 1,
      filters: [{ field: 'email', operator: 'eq', value: email }],
    });
    const hit = found.find((c) => (c.email ?? '').toLowerCase() === email) ?? found[0];
    if (hit?.id) {
      return {
        id: hit.id,
        first: clean(hit.firstName) || first,
        last: clean(hit.lastName) || last,
        phone: clean(hit.phone, 32) || phone,
        existed: true,
      };
    }
    try {
      const id = await createContact(client, {
        firstName: first, lastName: last, email, phone: phone || undefined,
        source: 'Parent portal application',
      });
      if (cfg.tag) await addTag(id, cfg.tag, cfg.schoolId);
      return { id, first, last, phone, existed: false };
    } catch (e: unknown) {
      // GHL rejects a duplicate email but names the existing contact.
      const dup = (e as { response?: { data?: { meta?: { contactId?: string } } } })?.response?.data?.meta?.contactId;
      if (dup) {
        // The search missed it (index lag) — read the contact so its own name/phone win.
        let c: { firstName?: string; lastName?: string; phone?: string | null } | undefined;
        try { c = (await client.axios.get<{ contact?: { firstName?: string; lastName?: string; phone?: string | null } }>(`/contacts/${dup}`)).data.contact; } catch { /* keep typed values */ }
        return {
          id: dup,
          first: clean(c?.firstName) || first,
          last: clean(c?.lastName) || last,
          phone: clean(c?.phone, 32) || phone,
          existed: true,
        };
      }
      throw e;
    }
  } catch (e) {
    console.error('[apply] CRM contact resolve failed:', e instanceof Error ? e.message : e);
    return { id: null, first, last, phone, existed: false };
  }
}

export async function provisionApplicant(
  cfg: OpenApplyConfig, claims: ApplyClaims, password: string,
): Promise<ProvisionResult> {
  const email = claims.email.trim().toLowerCase();
  const hash = await hashPassword(password);

  const { rows: ex } = await query<{ id: string; family_id: string; has_password: boolean }>(
    `SELECT id, family_id, (password_hash IS NOT NULL) AS has_password
       FROM parents WHERE school_id = $1 AND lower(email) = $2 AND status = 'active'
      ORDER BY (password_hash IS NOT NULL) DESC, created_at ASC LIMIT 1`,
    [cfg.schoolId, email],
  );
  if (ex[0]) {
    if (ex[0].has_password) return { kind: 'has_password' };
    // Mailbox is proven, so a parent the school already has on file may set
    // their password here too (same trust as a magic link).
    await query(
      `UPDATE parents SET password_hash = $1, password_set_at = now(), updated_at = now() WHERE id = $2`,
      [hash, ex[0].id],
    );
    return { kind: 'password_set', parentId: ex[0].id, familyId: ex[0].family_id, email };
  }

  const first = clean(claims.first) || 'Parent';
  const last = clean(claims.last);
  const phone = clean(claims.phone, 32);
  const contact = await resolveContact(cfg, email, first, last, phone);

  // A contact already carried by another parent row (different email on file):
  // don't double-link it.
  let contactId = contact.id;
  if (contactId) {
    const { rows: taken } = await query(
      `SELECT 1 FROM parents WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
      [cfg.schoolId, contactId],
    );
    if (taken.length > 0) {
      console.error('[apply] contact', contactId, 'already linked to another parent — not linking', email);
      contactId = null;
    }
  }

  const out = await withTransaction(async (q) => {
    const fam = await q<{ id: string }>(
      `INSERT INTO families (school_id, display_name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [cfg.schoolId, `${contact.last || last || contact.first} Family`.trim()],
    );
    const par = await q<{ id: string }>(
      `INSERT INTO parents (family_id, school_id, ghl_contact_id, first_name, last_name, email, phone,
                            role, is_primary, status, portal_invited_at, password_hash, password_set_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'parent', true, 'active', now(), $8, now()) RETURNING id`,
      [fam.rows[0].id, cfg.schoolId, contactId, contact.first, contact.last, email, contact.phone || null, hash],
    );
    return { familyId: fam.rows[0].id, parentId: par.rows[0].id };
  });
  return { kind: 'created', ...out, email };
}
