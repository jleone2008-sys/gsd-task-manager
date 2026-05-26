-- Phase 7 — patterns_discovered.
--
-- Recurring patterns Opus identifies during weekly synthesis. Stored
-- so the next week's synthesis can reference / strengthen / dismiss
-- them, and so the Patterns subtab in Insights can show them with a
-- dismiss affordance.
--
-- Examples of what gets stored here:
--   - "Late-night Fridays correlate with low Saturday HRV"
--   - "Sleep score drops on rest days following heavy lift weeks"
--   - "Mood is consistently 'Bad' on days with no morning sun exposure"
--
-- Columns:
--   label              = short headline (≤80 chars) — shown on the
--                        Patterns subtab card
--   description        = 1-3 sentence explanation including evidence
--                        (≤500 chars)
--   evidence_window    = jsonb { start_date, end_date, n_days } —
--                        the period this pattern was observed over
--   n                  = sample size used (e.g. 12 Fridays)
--   strength_score     = numeric confidence in the pattern. For
--                        correlations: |r|. For binary patterns:
--                        observation count / window. Range 0-1.
--   first_seen_at      = when first detected by any weekly run
--   last_seen_at       = updated each weekly run that re-confirms
--   dismissed_by_user  = bool; the dismiss button on the Patterns
--                        card flips this true
--   dismissed_at       = when dismissed (for the 60-day suppression
--                        window the next weekly synthesis honors)
--   metadata           = jsonb for pattern-specific extras (e.g.
--                        correlation r-value + p-value, source
--                        metrics, related document_ids from RAG)

create table if not exists public.patterns_discovered (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  label               text not null,
  description         text not null,
  evidence_window     jsonb,
  n                   integer,
  strength_score      numeric,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  dismissed_by_user   boolean not null default false,
  dismissed_at        timestamptz,
  metadata            jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists patterns_user_recent
  on public.patterns_discovered(user_id, last_seen_at desc)
  where dismissed_by_user = false;

create index if not exists patterns_user_dismissed
  on public.patterns_discovered(user_id, dismissed_at)
  where dismissed_by_user = true;

-- For search_patterns tool — look up by label substring
create index if not exists patterns_label_search
  on public.patterns_discovered using gin(to_tsvector('english', label || ' ' || description));

alter table public.patterns_discovered enable row level security;
drop policy if exists "patterns_discovered own" on public.patterns_discovered;
create policy "patterns_discovered own" on public.patterns_discovered for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
