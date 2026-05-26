-- Phase 6 — knowledge_documents.
--
-- One row per uploaded document (PDF, image, pasted text) OR per lab
-- panel. The 'Brain' tab (renamed from Notes) renders these alongside
-- the existing notes table as a single timeline.
--
-- Columns:
--   kind          = 'pdf' | 'image' | 'text' | 'lab'
--                   ('lab' is a sub-kind of pdf — implies the secondary
--                   structured-extract pass also fired, populating
--                   health_lab_results rows.)
--   title         = display name shown on the timeline card. For PDFs,
--                   derived from filename or first heading. For images
--                   and text snippets, user-editable.
--   source_text   = full extracted text. Used for client-side preview
--                   and for re-chunking if the chunking strategy changes.
--                   NOT used directly for retrieval (chunks + embeddings
--                   do that work).
--   ai_summary    = one-paragraph natural-language summary from Claude,
--                   shown when the card is expanded.
--   ai_key_facts  = jsonb array of 3-5 bullet strings. Rendered inline
--                   on the timeline card (the "LDL 105 · HDL 58" line).
--   storage_path  = relative path in the 'knowledge' Supabase Storage
--                   bucket. Null for kind='text' (no file uploaded).
--   status        = 'processing' on insert → 'ready' once chunks +
--                   summary are written → 'failed' on any pipeline
--                   error. The timeline UI shows a spinner for
--                   processing cards.
--   metadata      = jsonb for source-specific fields without schema
--                   churn (page_count for PDFs, source_url for
--                   articles, original_filename, etc.).

create table if not exists public.knowledge_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('pdf','image','text','lab')),
  title           text not null,
  source_text     text,
  ai_summary      text,
  ai_key_facts    jsonb,
  storage_path    text,
  status          text not null default 'processing'
                    check (status in ('processing','ready','failed')),
  failure_reason  text,
  uploaded_at     timestamptz not null default now(),
  processed_at    timestamptz,
  metadata        jsonb
);

-- Most reads are "show me the user's recent documents", so a covering
-- index on (user_id, uploaded_at desc) is the workhorse.
create index if not exists knowledge_documents_user_uploaded
  on public.knowledge_documents(user_id, uploaded_at desc);

-- Filter-by-kind in the Brain tab (e.g. show just labs)
create index if not exists knowledge_documents_user_kind
  on public.knowledge_documents(user_id, kind);

alter table public.knowledge_documents enable row level security;

drop policy if exists "knowledge_documents own" on public.knowledge_documents;
create policy "knowledge_documents own" on public.knowledge_documents for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
