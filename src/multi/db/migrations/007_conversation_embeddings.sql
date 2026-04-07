-- 007_conversation_embeddings.sql
-- Adds vector embeddings + native chat_id + external message id to bc_conversation
-- so Betsy can semantically recall old messages and reply-quote them.

create extension if not exists vector;

alter table bc_conversation
  add column if not exists embedding vector(768),
  add column if not exists chat_id text,
  add column if not exists external_message_id bigint;

-- ivfflat cosine index for nearest-neighbour search.
-- lists=100 is a reasonable default up to ~1M rows.
create index if not exists bc_conversation_embedding_idx
  on bc_conversation using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Composite index for chat-scoped chronological queries used by recall_messages
-- (filter by chat_id, then order).
create index if not exists bc_conversation_chat_created_idx
  on bc_conversation (workspace_id, chat_id, created_at desc);
