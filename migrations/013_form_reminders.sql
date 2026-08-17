-- Automated form-completion reminders (daily cron in the parent portal).
--
-- Per-school schedule lives on school_branding; every send is logged in
-- form_reminder_log so the cadence is enforced per family and the office
-- can see exactly who was nudged and when.
--
-- reminders_enabled           opt-in switch (default off — nothing changes
--                             for any school until they flip it)
-- reminder_interval_days      days between reminders to the same family
--                             (also the grace period after the family's
--                             portal login is created before the first one)
-- reminder_max_count          stop after this many reminders per family;
--                             NULL = keep going while forms are outstanding
-- reminder_send_hour_local    local hour to send (0-23); the daily cron
--                             fires hourly-ish and only sends when the
--                             school's local hour matches
-- reminder_timezone           IANA tz for the hour check
-- reminder_honor_ghl_completion  count legacy GHL-side form completions
--                             (form_<slug>_complete fields) as done — for
--                             schools that migrated off an old forms tool
--
-- Wooster: enabled, every 7 days, max 6, 9am America/New_York, honor GHL.

ALTER TABLE school_branding
  ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_interval_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS reminder_max_count INTEGER,
  ADD COLUMN IF NOT EXISTS reminder_send_hour_local INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS reminder_timezone TEXT NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS reminder_honor_ghl_completion BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS form_reminder_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  family_id     UUID NOT NULL,        -- no FK: families are rebuilt by the snapshot sync (ids preserved)
  parent_id     UUID,                 -- recipient parent (no FK, same reason)
  email         TEXT NOT NULL,
  reminder_number INTEGER NOT NULL,   -- 1, 2, 3 … per family
  forms_outstanding INTEGER NOT NULL,
  form_slugs    TEXT[] NOT NULL DEFAULT '{}',
  provider      TEXT,                 -- 'ghl' | 'resend'
  status        TEXT NOT NULL,        -- 'sent' | 'failed' | 'skipped'
  error         TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_reminder_log_family_idx
  ON form_reminder_log (school_id, family_id, sent_at DESC);
