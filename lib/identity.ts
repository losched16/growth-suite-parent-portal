// Server-side helpers for authenticated routes. Reads the session cookie,
// loads the parent + family + branding once. Components downstream get a
// fully-resolved identity bundle, no ad-hoc DB calls in pages.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PARENT_SESSION_COOKIE, verifySession, type ParentClaims } from '@/lib/auth/session';
import { query } from '@/lib/db';

export interface PortalBranding {
  display_name: string;     // school name (or branding override)
  logo_url: string | null;
  primary_color: string;    // hex
  primary_color_soft: string;
  primary_color_fg: string;
  support_email: string | null;
  support_phone: string | null;
  footer_html: string | null;
  // Nav hrefs the school has turned OFF in the portal (school_branding
  // .portal_hidden_nav). Empty = show every menu. The layout filters
  // NAV_ITEMS by this.
  hidden_nav: string[];
}

export interface ParentIdentity {
  parent: {
    id: string;
    family_id: string;
    school_id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    is_primary: boolean;
    role: string;
    ghl_contact_id: string | null;
  };
  family: {
    id: string;
    display_name: string | null;
    notes: string | null;
    status: string;
  };
  school: {
    id: string;
    name: string;
    ghl_location_id: string;
  };
  branding: PortalBranding;
}

const DEFAULT_BRAND_PRIMARY = '#047857';
const DEFAULT_BRAND_SOFT = '#ecfdf5';
const DEFAULT_BRAND_FG = '#064e3b';

// Resolve the current parent's identity from the cookie. Redirects to
// /login on miss. Use in any authenticated page.
export async function requireParent(): Promise<ParentIdentity> {
  const claims = await readSession();
  if (!claims) redirect('/login');
  const identity = await loadIdentity(claims);
  if (!identity) redirect('/login?err=invalid_or_expired');
  return identity;
}

export async function readSession(): Promise<ParentClaims | null> {
  const store = await cookies();
  const token = store.get(PARENT_SESSION_COOKIE)?.value;
  return verifySession(token);
}

async function loadIdentity(claims: ParentClaims): Promise<ParentIdentity | null> {
  const { rows } = await query<{
    p_id: string; p_family_id: string; p_school_id: string;
    p_first_name: string; p_last_name: string; p_email: string;
    p_phone: string | null; p_is_primary: boolean; p_role: string;
    p_ghl_contact_id: string | null;
    f_id: string; f_display_name: string | null; f_notes: string | null; f_status: string;
    s_id: string; s_name: string; s_ghl_location_id: string;
    b_display_name: string | null; b_logo_url: string | null;
    b_primary_color: string | null; b_primary_color_soft: string | null;
    b_primary_color_fg: string | null;
    b_support_email: string | null; b_support_phone: string | null; b_footer_html: string | null;
    b_portal_hidden_nav: string[] | null;
  }>(
    `SELECT
       p.id AS p_id, p.family_id AS p_family_id, p.school_id AS p_school_id,
       p.first_name AS p_first_name, p.last_name AS p_last_name, p.email AS p_email,
       p.phone AS p_phone, p.is_primary AS p_is_primary, p.role AS p_role,
       p.ghl_contact_id AS p_ghl_contact_id,
       f.id AS f_id, f.display_name AS f_display_name, f.notes AS f_notes, f.status AS f_status,
       s.id AS s_id, s.name AS s_name, s.ghl_location_id AS s_ghl_location_id,
       b.display_name AS b_display_name, b.logo_url AS b_logo_url,
       b.primary_color AS b_primary_color, b.primary_color_soft AS b_primary_color_soft,
       b.primary_color_fg AS b_primary_color_fg,
       b.support_email AS b_support_email, b.support_phone AS b_support_phone,
       b.footer_html AS b_footer_html, b.portal_hidden_nav AS b_portal_hidden_nav
     FROM parents p
     JOIN families f ON f.id = p.family_id
     JOIN schools s ON s.id = p.school_id
     LEFT JOIN school_branding b ON b.school_id = p.school_id
     WHERE p.id = $1 AND p.school_id = $2 AND p.status = 'active'`,
    [claims.parent_id, claims.school_id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    parent: {
      id: r.p_id,
      family_id: r.p_family_id,
      school_id: r.p_school_id,
      first_name: r.p_first_name,
      last_name: r.p_last_name,
      email: r.p_email,
      phone: r.p_phone,
      is_primary: r.p_is_primary,
      role: r.p_role,
      ghl_contact_id: r.p_ghl_contact_id,
    },
    family: {
      id: r.f_id,
      display_name: r.f_display_name,
      notes: r.f_notes,
      status: r.f_status,
    },
    school: {
      id: r.s_id,
      name: r.s_name,
      ghl_location_id: r.s_ghl_location_id,
    },
    branding: {
      display_name: r.b_display_name ?? r.s_name,
      logo_url: r.b_logo_url,
      primary_color: r.b_primary_color ?? DEFAULT_BRAND_PRIMARY,
      primary_color_soft: r.b_primary_color_soft ?? DEFAULT_BRAND_SOFT,
      primary_color_fg: r.b_primary_color_fg ?? DEFAULT_BRAND_FG,
      support_email: r.b_support_email,
      support_phone: r.b_support_phone,
      footer_html: r.b_footer_html,
      hidden_nav: r.b_portal_hidden_nav ?? [],
    },
  };
}
