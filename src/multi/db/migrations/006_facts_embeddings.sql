-- Enable pgvector extension (no-op if already installed)
create extension if not exists vector;

-- Add embedding column to facts table (768-dim for text-embedding-004)
alter table bc_memory_facts add column if not exists embedding vector(768);

-- IVFFlat cosine index — will warm up on first ANALYZE / first real query
-- lists=100 is appropriate for up to ~1M rows
create index if not exists bc_memory_facts_embedding_idx
  on bc_memory_facts
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
