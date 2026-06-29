-- Per-school parent-portal nav visibility. Holds the nav hrefs a school has
-- turned OFF in the portal (e.g. {'/attendance','/products'}). Empty/NULL =
-- every menu item shows. Replaces the hardcoded HIDDEN_NAV_BY_SCHOOL map that
-- used to live in app/(portal)/layout.tsx, so schools can toggle menus
-- self-serve (admin "Portal menus" settings) without a code change.
ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS portal_hidden_nav text[];
