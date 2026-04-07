-- Wave 2C: feedback loop (thumbs up/down on Betsy replies).
-- Rows written by FeedbackService on callback-query clicks. CoachAgent (future
-- wave) consumes these for supervised fine-tuning / persona nudging.

CREATE TABLE IF NOT EXISTS bc_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID,                  -- bc_conversation.id if we can correlate
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,                 -- native channel chat id
  message_id TEXT NOT NULL,              -- native channel message id (telegram message_id)
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),  -- 👎 / 👍
  reason TEXT,                           -- optional free-form comment (future use)
  raw_text TEXT,                         -- snapshot of assistant reply
  user_message TEXT,                     -- snapshot of the preceding user message
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, channel, message_id)
);

ALTER TABLE bc_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE bc_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY feedback_ws_scoped ON bc_feedback
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bc_feedback TO bc_app;

CREATE INDEX IF NOT EXISTS bc_feedback_workspace_created_idx
  ON bc_feedback(workspace_id, created_at DESC);
