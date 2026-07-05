// Pre-login branding by hostname. When a parent hits the portal at a
// school-owned subdomain (e.g. family.woomontessori.org), we render
// the login page with that school's logo + brand color before they
// sign in.
//
// A request hitting the generic Growth Suite host (or any host not
// claimed by a school) returns null → caller falls back to default
// branding. Authenticated pages still resolve branding via the
// parent's session (lib/identity.ts) — this helper is only for the
// pre-session shell.

import { query } from '@/lib/db';

const DEFAULT_BRAND_PRIMARY = '#047857';
const DEFAULT_BRAND_SOFT = '#ecfdf5';
const DEFAULT_BRAND_FG = '#064e3b';

export interface PreloginBranding {
  school_id: string;
  display_name: string;
  logo_url: string | null;
  primary_color: string;
  primary_color_soft: string;
  primary_color_fg: string;
  support_email: string | null;
  support_phone: string | null;
}

// Host → school scoping for auth. On a school-owned custom host, email →
// parent resolution must stay inside that school: the same email can exist
// as parent rows at two schools (e.g. a school rebuilt as a fresh instance),
// and an unscoped lookup resolves to whichever row has a password — landing
// the parent in the wrong school's portal. Returns null for generic hosts,
// where the global lookup remains the behavior.
export async function schoolIdForHost(host: string | null | undefined): Promise<string | null> {
  const branding = await loadBrandingByHost(host);
  return branding?.school_id ?? null;
}

export async function loadBrandingByHost(host: string | null | undefined): Promise<PreloginBranding | null> {
  if (!host) return null;
  // Strip port (localhost:3000), normalize.
  const clean = host.split(':')[0].trim().toLowerCase();
  if (!clean) return null;

  const { rows } = await query<{
    school_id: string;
    school_name: string;
    display_name: string | null;
    logo_url: string | null;
    primary_color: string | null;
    primary_color_soft: string | null;
    primary_color_fg: string | null;
    support_email: string | null;
    support_phone: string | null;
  }>(
    `SELECT b.school_id,
            s.name AS school_name,
            b.display_name,
            b.logo_url,
            b.primary_color,
            b.primary_color_soft,
            b.primary_color_fg,
            b.support_email,
            b.support_phone
       FROM school_branding b
       JOIN schools s ON s.id = b.school_id
      WHERE lower(b.custom_host) = $1
      LIMIT 1`,
    [clean],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    school_id: r.school_id,
    display_name: r.display_name ?? r.school_name,
    logo_url: r.logo_url,
    primary_color: r.primary_color ?? DEFAULT_BRAND_PRIMARY,
    primary_color_soft: r.primary_color_soft ?? DEFAULT_BRAND_SOFT,
    primary_color_fg: r.primary_color_fg ?? DEFAULT_BRAND_FG,
    support_email: r.support_email,
    support_phone: r.support_phone,
  };
}
