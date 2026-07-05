// Portal-provisioning gate.
//
// Schools that set `portal_gate_stage` (school Settings → schools.settings)
// only let a parent CREATE a portal password — i.e. provision an account for
// the first time — while the family's primary contact sits in that pipeline
// stage. This stops any random synced contact (the imported roster, leads,
// inquiries) from making a login.
//
// Deliberately gates ONLY the provisioning moment (password-set + the login
// page's create-password branch), NOT sign-in: access is granted at the gate
// stage and PERSISTS as the contact advances, so a family never loses the
// portal mid-enrollment. Once a password exists, sign-in works regardless of
// stage. Schools without a gate stage are unaffected — any active parent can
// provision.

import { query } from '@/lib/db';
import { loadSchoolSettings } from '@/lib/school-settings';

// True when this family is allowed to provision a NEW portal password.
// The opportunity lives on the primary parent's GHL contact, so we check the
// whole family (a secondary guardian with no contact of their own still counts
// as eligible when the family's primary is in the gate stage).
//
// A family with a CURRENTLY-ENROLLED student is always allowed, gate or no
// gate — the stage gate exists to keep random synced contacts (leads,
// inquiries) from making logins, not to lock out the actual student body.
// Without this, an imported enrolled family whose contact never passes
// through the gate stage could never create a password at all.
export async function portalProvisioningAllowed(
  schoolId: string,
  familyId: string,
): Promise<boolean> {
  const settings = await loadSchoolSettings(schoolId);
  if (!settings.portal_gate_stage) return true; // ungated school
  const { rows } = await query(
    `SELECT 1
       FROM parents p
       JOIN ghl_opportunities o
         ON o.ghl_contact_id = p.ghl_contact_id AND o.school_id = $1
      WHERE p.family_id = $2 AND p.is_primary = true AND p.ghl_contact_id IS NOT NULL
        AND o.stage_name = $3
      LIMIT 1`,
    [schoolId, familyId, settings.portal_gate_stage],
  );
  if (rows.length > 0) return true;
  const { rows: enrolled } = await query(
    `SELECT 1
       FROM students s
       JOIN enrollments e ON e.student_id = s.id
      WHERE s.family_id = $1 AND s.school_id = $2 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
        AND e.status = 'enrolled'
      LIMIT 1`,
    [familyId, schoolId],
  );
  return enrolled.length > 0;
}
