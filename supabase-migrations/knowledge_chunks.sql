-- Phase 6 — knowledge_chunks.
--
-- One row per ~500-token piece of a document, with its OpenAI
-- text-embedding-3-small vector (1536 dims). Semantic search runs
-- as cosine-similarity over this table.
--
-- user_id is denormalized from knowledge_documents so the RLS policy
-- can be a simple `user_id = auth.uid()` (index-friendly) instead of
-- a subquery into knowledge_documents per row. The ingest function
-- writes both tables atomically with the same user_id; the FK + ON
-- DELETE CASCADE keeps them consistent.

create table if not exists public.knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.knowledge_documents(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  chunk_index   int not null,
  content       text not null,
  embedding     vector(1536) not null,
  created_at    timestamptz not null default now()
);

-- IVFFlat index for cosine similarity. lists=100 is a reasonable
-- starting point for thousands of chunks; rebuild with higher lists
-- if the corpus grows past ~50k chunks. Picked over HNSW because
-- IVFFlat has lower memory + faster builds for personal-scale corpora.
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Document drill-in (Brain detail panel) needs all chunks for a doc.
create index if not exists knowledge_chunks_document
  on public.knowledge_chunks(document_id, chunk_index);

-- User-scoped queries (the semantic search path).
create index if not exists knowledge_chunks_user
  on public.knowledge_chunks(user_id);

alter table public.knowledge_chunks enable row level security;

drop policy if exists "knowledge_chunks own" on public.knowledge_chunks;
create policy "knowledge_chunks own" on public.knowledge_chunks for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
