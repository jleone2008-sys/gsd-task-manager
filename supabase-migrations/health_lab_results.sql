-- Phase 6 — health_lab_results.
--
-- Populated by the ingest pipeline when a document is uploaded with
-- kind='lab'. A secondary Claude call with a structured-extract tool
-- parses the document text into one row per test result. Enables
-- trend charts ("LDL: 130 → 105 → 95 over 18 months") in the Brain
-- detail panel and in any future health insights surfaces.
--
-- A single lab panel (e.g. a comprehensive metabolic panel PDF) will
-- produce many rows here — one per test. They're tied back to the
-- source document via source_document_id so the detail panel can
-- group them by panel.
--
-- ref_range_low + ref_range_high cover the common numeric range case.
-- Some tests have non-numeric ranges ("negative", "<1:40") — those
-- go in ref_range_text.
--
-- flag captures the lab's own assessment: 'low' | 'normal' | 'high' |
-- 'critical_low' | 'critical_high'. Not all panels include this; null
-- is fine — the UI can derive a flag from value vs range when needed.

create table if not exists public.health_lab_results (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  source_document_id   uuid references public.knowledge_documents(id) on delete cascade,
  test_date            date not null,
  test_name            text not null,
  value                numeric,
  unit                 text,
  ref_range_low        numeric,
  ref_range_high       numeric,
  ref_range_text       text,
  flag                 text check (flag in ('low','normal','high','critical_low','critical_high')),
  notes                text,
  created_at           timestamptz not null default now()
);

-- Trend queries: "show me LDL over time"
create index if not exists health_lab_results_user_test_date
  on public.health_lab_results(user_id, test_name, test_date desc);

-- Recent panel queries: "what were the last test results?"
create index if not exists health_lab_results_user_date
  on public.health_lab_results(user_id, test_date desc);

-- Panel grouping: "show all tests from this document"
create index if not exists health_lab_results_source
  on public.health_lab_results(source_document_id)
  where source_document_id is not null;

alter table public.health_lab_results enable row level security;

drop policy if exists "health_lab_results own" on public.health_lab_results;
create policy "health_lab_results own" on public.health_lab_results for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
