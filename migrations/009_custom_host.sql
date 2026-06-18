-- Custom host per school for pre-login branding by hostname.
--
-- When a parent hits the portal at e.g. family.woomontessori.org, we
-- look up which school owns that hostname and render the login page
-- with that school's logo + brand color BEFORE they sign in. Without
-- this, custom subdomains all serve the generic Growth Suite login.
--
-- A school without a custom_host (or a request hitting a host that
-- nobody owns, like family.mygrowthsuite.com) falls through to the
-- default branding. Existing rows are unaffected — column is nullable.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS custom_host TEXT;

-- Unique on lower(custom_host) so two schools can't claim the same
-- hostname. The partial index keeps the constraint cheap when most
-- rows are NULL.
CREATE UNIQUE INDEX IF NOT EXISTS school_branding_custom_host_idx
  ON school_branding (lower(custom_host))
  WHERE custom_host IS NOT NULL;
