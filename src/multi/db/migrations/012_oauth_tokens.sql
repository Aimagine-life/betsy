-- Wave 3a: OAuth tokens for MCP integrations.
-- Access/refresh tokens are encrypted at the application layer (AES-256-GCM,
-- see src/multi/oauth/crypto.ts) before being stored here. Postgres sees only
-- opaque ciphertext blobs; the encryption key lives outside the DB.

CREATE TABLE IF NOT EXISTS bc_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  access_token TEXT NOT NULL,            -- encrypted blob (v1:iv:tag:ct)
  refresh_token TEXT,                    -- encrypted blob (v1:iv:tag:ct)
  expires_at TIMESTAMPTZ,
  account_label TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- UNIQUE INDEX (not constraint) so we can use COALESCE to treat NULL
-- account_label as a real key (Postgres UNIQUE constraint doesn't support
-- expressions).
CREATE UNIQUE INDEX IF NOT EXISTS bc_oauth_tokens_ws_provider_label_uidx
  ON bc_oauth_tokens(workspace_id, provider, COALESCE(account_label, ''));

ALTER TABLE bc_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE bc_oauth_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY oauth_tokens_ws_scoped ON bc_oauth_tokens
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bc_oauth_tokens TO bc_app;
