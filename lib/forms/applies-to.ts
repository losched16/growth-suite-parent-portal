// Per-form visibility rule. Lives in portal_form_definitions.applies_to
// (JSONB). When NULL or empty, the form shows for every student in the
// family — preserves the historical behavior every existing school
// relies on. When set, ANY criterion match (OR semantics) admits a
// student to the form.
//
// We resolve against the cheapest data we already have on the page:
// students.metadata + each student's active tuition_grid display_name
// + their enrollment.addons[].key. No new joins needed in callers that
// already display the per-student form list.
//
// Used by:
//   /forms-v2 hub          → hide rows whose applies_to matches 0 students
//   /forms-v2/[slug] page  → restrict the per-student picker to matching students
//
// Schools rarely need MORE expressive rules than this — when they do
// (e.g. classroom-specific, age-bracketed), add a new criterion field
// and a matching branch here. Keep the parser permissive: unknown keys
// in the JSON are ignored.

export interface FormAppliesTo {
  // Substring match on the student's active tuition_grid.display_name
  // (case-insensitive). e.g. ["kindergarten"] matches MCH's
  // "Kindergarten — 5 Full Days (8:30am–3:15pm)" grid.
  tuition_grid_match?: string[];

  // Substring match on students.metadata.program (case-insensitive).
  // e.g. ["young community"] matches both "Young Community" and the
  // legacy "young community 3-day" variant some imports produced.
  program_match?: string[];

  // Match against the family's GHL contact TAGS (synced from GHL into
  // ghl_contact_tags). Case-insensitive, exact-tag (not substring).
  // e.g. ["kindergarten"] shows the form only to families whose contact
  // carries a "kindergarten" tag. This is the most direct lever for a
  // school: tag the contact in GHL, list the tag here. GHL stays the
  // source of truth for who sees what.
  tag_match?: string[];

  // For each key, the student matches if their metadata[key] value
  // (lowercased) is one of the listed values (also lowercased).
  // e.g. { aftercare: ["before","after","both","full"] } matches any
  // child enrolled in extended care, but not 'half' / 'none' / null.
  metadata_match?: Record<string, string[]>;

  // Exact match against the keys of family_tuition_enrollments.addons
  // (which is a JSONB array of { key, label, amount_cents }). Reserved
  // for the future when MCH actually adds extended-care as an
  // addon line — today the signal lives in students.metadata.aftercare.
  addon_keys?: string[];

  // Explicit allowlist of student UUIDs. The form shows ONLY for these
  // students. Use when the school hands you a hand-picked list that
  // doesn't follow any program/grade rule (e.g. "these 42 kids need a
  // current physical on file"). Resolved against the rendering
  // student's id, so it's robust to name-spelling differences. Manage
  // the list with the operator roster tool; never hand-edit UUIDs.
  student_ids?: string[];
}

export interface AppliesToContext {
  // The rendering student's id — matched against rule.student_ids.
  studentId: string;
  metadata: Record<string, unknown>;
  // The active enrollment's tuition_grid.display_name. May be null if
  // the student has no active enrollment row yet (rare; usually means
  // school hasn't set up tuition for them).
  tuitionGridName: string | null;
  // Distinct keys from family_tuition_enrollments.addons[].key for the
  // student's active enrollment. Empty when joint-billed family has no
  // addons, or when no enrollment exists.
  enrollmentAddonKeys: string[];
  // The family's GHL contact tags (union across the family's parent
  // contacts, from ghl_contact_tags). Empty when none synced. Matched
  // against rule.tag_match.
  tags: string[];
}

export function studentMatchesAppliesTo(
  ctx: AppliesToContext,
  rule: FormAppliesTo | null | undefined,
): boolean {
  if (!rule || isEmptyRule(rule)) return true;

  if (rule.student_ids?.length) {
    if (rule.student_ids.includes(ctx.studentId)) return true;
  }

  if (rule.tuition_grid_match?.length && ctx.tuitionGridName) {
    const grid = ctx.tuitionGridName.toLowerCase();
    if (rule.tuition_grid_match.some((s) => grid.includes(s.toLowerCase()))) {
      return true;
    }
  }

  if (rule.program_match?.length) {
    const prog = stringField(ctx.metadata.program).toLowerCase();
    if (prog && rule.program_match.some((s) => prog.includes(s.toLowerCase()))) {
      return true;
    }
  }

  if (rule.tag_match?.length && ctx.tags.length) {
    const have = new Set(ctx.tags.map((t) => t.toLowerCase()));
    if (rule.tag_match.some((t) => have.has(t.toLowerCase()))) return true;
  }

  if (rule.metadata_match) {
    for (const [k, vals] of Object.entries(rule.metadata_match)) {
      const v = stringField(ctx.metadata[k]).toLowerCase();
      if (!v) continue;
      if (vals.some((vv) => vv.toLowerCase() === v)) return true;
    }
  }

  if (rule.addon_keys?.length) {
    if (rule.addon_keys.some((k) => ctx.enrollmentAddonKeys.includes(k))) {
      return true;
    }
  }

  return false;
}

function isEmptyRule(r: FormAppliesTo): boolean {
  return !(
    (r.student_ids && r.student_ids.length > 0) ||
    (r.tuition_grid_match && r.tuition_grid_match.length > 0) ||
    (r.program_match && r.program_match.length > 0) ||
    (r.tag_match && r.tag_match.length > 0) ||
    (r.metadata_match && Object.keys(r.metadata_match).length > 0) ||
    (r.addon_keys && r.addon_keys.length > 0)
  );
}

function stringField(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}
