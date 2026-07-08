// Canonical parent-portal origin per school. Every link that lands in a
// parent's inbox (magic links, password resets, co-sign requests, form
// invites) must use the school's OWN domain (school_branding.custom_host,
// e.g. portal.desertgardenmontessori.org) — links to the shared
// *.vercel.app host trip corporate/ISP security filters and look
// unbranded. Falls back to the provided request origin (or the shared
// host) for schools without a custom domain.

import { query } from '@/lib/db';

const SHARED_BASE = (process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app').replace(/\/$/, '');

export async function portalBaseForSchool(
  schoolId: string,
  fallbackOrigin?: string | null,
): Promise<string> {
  try {
    const { rows } = await query<{ custom_host: string | null }>(
      `SELECT custom_host FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const host = rows[0]?.custom_host?.trim().toLowerCase();
    if (host) return `https://${host}`;
  } catch { /* fall through */ }
  return (fallbackOrigin ?? SHARED_BASE).replace(/\/$/, '');
}
