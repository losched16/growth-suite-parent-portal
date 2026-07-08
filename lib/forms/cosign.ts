// Co-sign (DocuSign-style counter-signature) helpers.
//
// When an agreement's Legal Decision-Making Authority (LDMA) answer says the
// guardians share JOINT authority, BOTH must sign. Parent 1 signs in their
// own portal session; Parent 2 is then emailed a secure link to review the
// completed agreement and add their signature. This module centralizes the
// "is a co-signer required?" decision + the field keys so the submit route,
// the form schema, and the co-sign page all agree on the same rule.

// LDMA answers that require BOTH guardians to sign. Per Clint
// (2026-07-08): only SEPARATED or DIVORCED joint-authority situations
// need the counter-signature — married or single households sign once.
// The regex in isCoSignRequired also catches future label variants that
// mention divorced/separated.
export const JOINT_LDMA_VALUES: ReadonlySet<string> = new Set([
  'Parents/Guardians share joint LDMA (divorced)',
]);

// Form field keys involved in the co-sign flow.
export const LDMA_FIELD_KEY = 'ldma';
export const COSIGNER_NAME_FIELD = 'cosigner_name';
export const COSIGNER_EMAIL_FIELD = 'cosigner_email';
// Where Parent 2's typed signature + timestamp land in `responses` once they
// counter-sign, so the completed record (and any PDF) carries both names.
export const COSIGNER_SIGNATURE_FIELD = 'cosigner_signature';
export const COSIGNER_SIGNED_AT_FIELD = 'cosigner_signature_signed_at';

// True when the submitted answers require a second guardian's signature.
export function isCoSignRequired(responses: Record<string, unknown>): boolean {
  const v = String(responses[LDMA_FIELD_KEY] ?? '').trim();
  if (JOINT_LDMA_VALUES.has(v)) return true;
  return /(divorced|separated)/i.test(v);
}
