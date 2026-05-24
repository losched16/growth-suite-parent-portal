-- Parent portal tables. Additive — doesn't touch family-graph or
-- dashboards rows; this app is a READER of families/parents/students
-- and only writes its own auth tables here.
--
-- Tables:
--   school_branding              — per-school portal display config
--   parent_magic_link_tokens     — one-shot login codes (sent via email)
--   parent_sessions              — issued JWT family + parent identity
--                                  (we also use signed cookies, this is
--                                  the audit table)
--   parent_portal_audit_log      — auth events, edit events

CREATE TABLE IF NOT EXISTS school_branding (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  display_name text,                 -- override schools.name if set
  logo_url text,                     -- absolute URL or null
  primary_color text,                -- hex like '#047857'
  primary_color_soft text,           -- light variant for backgrounds
  primary_color_fg text,             -- dark variant for text on soft bg
  support_email text,                -- where the magic-link email is "from"
  support_phone text,                -- displayed on login + footer
  footer_html text,                  -- raw HTML (operator-trusted)
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use, short-lived (15 min) login codes. We email a URL containing
-- the token; on click we look it up, mark consumed, mint a session.
-- Indexed by token AND email so cleanup is fast.
CREATE TABLE IF NOT EXISTS parent_magic_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,        -- url-safe random
  email text NOT NULL,               -- the parent's email (lowercased)
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE, -- null if email matched parents in multiple schools (rare)
  parent_id uuid REFERENCES parents(id) ON DELETE CASCADE, -- null until lookup succeeds
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,           -- non-null = already used
  request_ip text,
  request_user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_magic_link_email ON parent_magic_link_tokens (email);
CREATE INDEX IF NOT EXISTS idx_magic_link_expires ON parent_magic_link_tokens (expires_at) WHERE consumed_at IS NULL;

-- Audit table for sessions. The session itself is a signed JWT in a
-- cookie — this row is for "show me all the times this parent logged in".
CREATE TABLE IF NOT EXISTS parent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_parent_sessions_parent ON parent_sessions (parent_id);

-- Generic audit log for portal events (login, edit-contact, etc.)
CREATE TABLE IF NOT EXISTS parent_portal_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  event_type text NOT NULL,          -- 'login_request', 'login_success', 'login_fail', 'edit_parent', 'edit_student', 'view'
  detail jsonb,                       -- arbitrary event-specific data
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_parent ON parent_portal_audit_log (parent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_school ON parent_portal_audit_log (school_id, created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION school_branding_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS school_branding_updated_at ON school_branding;
CREATE TRIGGER school_branding_updated_at
  BEFORE UPDATE ON school_branding
  FOR EACH ROW EXECUTE FUNCTION school_branding_set_updated_at();
