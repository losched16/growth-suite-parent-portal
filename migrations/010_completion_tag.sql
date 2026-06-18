-- Configurable per-school tag that gets written to every active
-- parent's GHL contact when their family reaches 100% form completion.
-- Empty / NULL → feature disabled for that school.
--
-- For Wooster: 'forms completed - 26/27'. Bump each year alongside
-- their enrollment-year tag.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS completion_tag TEXT;
