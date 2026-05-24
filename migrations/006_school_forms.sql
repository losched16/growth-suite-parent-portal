-- Per-school form catalog. Each row is one form the school wants
-- parents to see/complete in the portal.
--
-- Completion is detected by reading a GHL custom field on the parent's
-- primary contact (or per-student via slot prefixing). The field is
-- typically a DATE field that gets set when the form is submitted.
--
-- Operator manages this list; parents only read it.

CREATE TABLE IF NOT EXISTS school_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  description text,
  -- Abstract field key (looked up via the school's field schema).
  -- For per-student forms, slot is auto-prepended. For family-level forms,
  -- the key is used as-is.
  completion_field_key text NOT NULL,
  -- Where the parent goes to fill it out. Usually a hosted GHL form URL.
  -- Can be null if the form is informational-only (no fill-out action).
  fill_out_url text,
  -- True = check the field per student (student_<base> in slot 1, etc.)
  -- False = check it once on the parent's primary contact.
  per_student boolean NOT NULL DEFAULT false,
  -- Display order
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_school_forms_school
  ON school_forms (school_id, position) WHERE is_active = true;
