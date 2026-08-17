-- When a family reaches 100% form completion, optionally:
--   1. Apply an "enrolled" GHL tag (in addition to completion_tag) so
--      dashboards scoped by enrolled-tag pick them up immediately.
--   2. Move every one of the family's opportunity cards from a source
--      pipeline stage to a target stage (all children move together).
--
-- All three columns are NULL by default → feature disabled for that
-- school. For Wooster (2026-27):
--   enrollment_tag              = 'enrolled - 26/27'
--   pipeline_move_from_stage    = 'Documents Requested'
--   pipeline_move_to_stage      = 'Enrolled'
--
-- Move targets a specific stage NAME (readable in the operator UI) —
-- the stage-id is resolved at fire time from ghl_opportunities so a
-- stage rename in GHL is picked up on the next attribute sync.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS enrollment_tag TEXT,
  ADD COLUMN IF NOT EXISTS pipeline_move_from_stage TEXT,
  ADD COLUMN IF NOT EXISTS pipeline_move_to_stage TEXT;
