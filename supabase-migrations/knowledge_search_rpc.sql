-- Phase 6 — semantic search RPC for the knowledge base.
--
-- Exposed via PostgREST as /rest/v1/rpc/search_knowledge_chunks.
-- Called from netlify/functions/beta-knowledge-search.js after the
-- function has authenticated the user and embedded the query string.
--
-- Signature:
--   p_user_id        — UUID of the calling user (server passes the
--                      validated JWT-derived id; the WHERE clause
--                      enforces it server-side as a defense-in-depth
--                      even though the function is called with the
--                      service key).
--   query_embedding  — vector(1536) — OpenAI text-embedding-3-small
--                      embedding of the query string.
--   match_count      — int — max chunks to return. Default 5.
--
-- Returns: top-K chunks ordered by cosine similarity (highest first),
-- joined with their parent document title + kind so the caller has
-- enough context to surface results without a follow-up query.
--
-- Uses the IVFFlat index on knowledge_chunks.embedding (vector_cosine_ops)
-- created by knowledge_chunks.sql. <=> is the pgvector cosine distance
-- operator; smaller distance = more similar, so we ORDER BY it ASC
-- and return (1 - distance) as similarity for callers.

create or replace function public.search_knowledge_chunks(
  p_user_id       uuid,
  query_embedding vector(1536),
  match_count     int default 5
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  chunk_index     int,
  content         text,
  similarity      float,
  document_title  text,
  document_kind   text
)
language sql
stable
as $$
  select
    c.id          as chunk_id,
    c.document_id,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> query_embedding))::float as similarity,
    d.title       as document_title,
    d.kind        as document_kind
  from public.knowledge_chunks c
  join public.knowledge_documents d on d.id = c.document_id
  where c.user_id = p_user_id
    and d.status = 'ready'
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Grant execute to the authenticated + service_role roles so both
-- direct user calls (future Brain-tab in-app search via JWT) and
-- server-side calls (the Netlify function with service key) work.
grant execute on function public.search_knowledge_chunks(uuid, vector, int) to authenticated, service_role;
