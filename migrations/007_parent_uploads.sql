-- Parent-uploaded documents. Files stored as bytea inline so there's no
-- external storage dependency for v1. Hard cap of 8 MB per file enforced
-- in the server action; Postgres TOAST handles the row size fine.
--
-- Schools view + download these via the operator admin (separate UI in
-- the dashboards repo). Parents view their own family's uploads.

CREATE TABLE IF NOT EXISTS parent_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  -- Optional: tag the upload to a specific student (e.g. immunization records)
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  -- Optional: tag the upload to a school_forms row (e.g. "this is my emergency card")
  form_id uuid REFERENCES school_forms(id) ON DELETE SET NULL,

  display_name text NOT NULL,            -- parent-supplied label
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),

  -- The file. Postgres handles bytea via TOAST; rows over ~2KB get
  -- compressed + out-of-line storage automatically.
  contents bytea NOT NULL,

  notes text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  -- When the school marks it as reviewed/handled
  acknowledged_at timestamptz,
  acknowledged_by_email text
);

-- Parent dashboard query: list family's uploads sorted newest-first
CREATE INDEX IF NOT EXISTS idx_parent_uploads_family
  ON parent_uploads (family_id, uploaded_at DESC);

-- Operator admin query: list school's recent uploads
CREATE INDEX IF NOT EXISTS idx_parent_uploads_school
  ON parent_uploads (school_id, uploaded_at DESC);
