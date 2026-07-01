// Portal-provisioning gate.
//
// For opted-in schools (PORTAL_PENDING_GATE_SCHOOLS), a parent may only CREATE
// a portal password — i.e. provision an account for the first time — when their
// family's primary contact is currently in the admissions "Pending" stage of
// the pipeline. This stops any random synced contact (the imported roster,
// leads, inquiries) from making a login.
//
// Deliberately gate ONLY the provisioning moment (password-set + the login
// page's create-password branch), NOT sign-in: access is granted at Pending and
// PERSISTS as the contact advances (Offer Accepted / Enrolled), so a family
// never loses the portal mid-enrollment. Once a password exists, sign-in works
// regardless of stage.
//
// Ungated schools are unaffected — any active parent can still provision.

import { query } from '@/lib/db';

export const PORTAL_PENDING_GATE_SCHOOLS = new Set<string>([
  '005c2872-dd27-4c43-9b3c-5fd353b8db44', // Desert Garden Montessori 2.0
]);

// The admissions pipeline stage that grants provisioning eligibility.
const PENDING_STAGE_NAME = 'Pending';

export function portalGateActive(schoolId: string | null | undefined): boolean {
  return !!schoolId && PORTAL_PENDING_GATE_SCHOOLS.has(schoolId);
}

// True when this family is allowed to provision a NEW portal password.
// The opportunity lives on the primary parent's GHL contact, so we check the
// whole family (a secondary guardian with no contact of their own still counts
// as eligible when the family's primary is in Pending).
export async function portalProvisioningAllowed(
  schoolId: string,
  familyId: string,
): Promise<boolean> {
  if (!portalGateActive(schoolId)) return true;
  const { rows } = await query(
    `SELECT 1
       FROM parents p
       JOIN ghl_opportunities o
         ON o.ghl_contact_id = p.ghl_contact_id AND o.school_id = $1
      WHERE p.family_id = $2 AND p.is_primary = true AND p.ghl_contact_id IS NOT NULL
        AND o.stage_name = $3
      LIMIT 1`,
    [schoolId, familyId, PENDING_STAGE_NAME],
  );
  return rows.length > 0;
}
