-- Track per-upload GHL push state. When a parent uploads a file, we:
--   1. Save bytea locally
--   2. Push to GHL media library  → fileId + URL
--   3. Send a Conversations message on the parent's contact with the URL
--   4. Record both IDs here so operator can see what synced + retry if not
--
-- All new columns are nullable so older rows (pre-this-migration) keep working.

ALTER TABLE parent_uploads
  ADD COLUMN IF NOT EXISTS ghl_media_id text,
  ADD COLUMN IF NOT EXISTS ghl_media_url text,
  ADD COLUMN IF NOT EXISTS ghl_conversation_id text,
  ADD COLUMN IF NOT EXISTS ghl_message_id text,
  ADD COLUMN IF NOT EXISTS ghl_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghl_sync_error text;

-- Index for the operator "show me anything that failed to push to GHL" filter
CREATE INDEX IF NOT EXISTS idx_parent_uploads_unsynced
  ON parent_uploads (school_id, uploaded_at DESC)
  WHERE ghl_synced_at IS NULL;
