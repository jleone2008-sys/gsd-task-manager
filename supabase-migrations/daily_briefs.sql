-- Phase 1 — Daily brief synthesis layer storage. One row per user per local
-- day; written by beta-daily-brief.js (on-demand) or cron-daily-brief.js
-- (scheduled 06:00 user-local). The Home tab reads its own briefs directly
-- via RLS, no Netlify proxy needed for the read.
--
-- Schema notes:
--   brief_date           the user's local date the brief is "for" (yesterday's
--                        data narrated). Stored as date with no timezone — the
--                        client converts using user_profiles.timezone.
--   narrative            prose recap, 2-4 short paragraphs. Voice: direct,
--                        no emojis, "vs your norm" phrasing.
--   highlights           jsonb array of {label, value_today, baseline,
--                        direction, percent_change} produced by Claude's
--                        forced tool_use schema.
--   actions              jsonb array of {title, why, area, est_minutes,
--                        source_metric}. Cap = 2, empty array valid (silence
--                        beats noise).
--   confidence           'high' | 'medium' | 'low'. Set by Claude based on
--                        baseline n_days; UI hides actions when 'low'.
--   status               'ok'          full brief, fresh data
--                        'preliminary' generated against stale/missing Oura
--                                      data; UI shows refresh affordance
--                        'fallback'    Claude API call failed; deterministic
--                                      template used for narrative
--                        'failed'      could not generate even fallback
--   fallback_reason      free text for debugging when status != 'ok'
--   model                model id used (e.g. 'claude-sonnet-4-6')
--   prompt_tokens /
--     completion_tokens  for cost tracking
--   input_snapshot       exact JSON payload sent to Claude. Useful for
--                        replay/debugging and for the upcoming "what gets
--                        sent to Anthropic" Settings disclosure.

create table if not exists public.daily_briefs (
  id                  uuid          primary key default gen_random_uuid(),
  user_id             uuid          not null references auth.users(id) on delete cascade,
  brief_date          date          not null,
  generated_at        timestamptz   not null default now(),
  model               text,
  prompt_tokens       int,
  completion_tokens   int,
  narrative           text,
  highlights          jsonb         default '[]'::jsonb,
  actions             jsonb         default '[]'::jsonb,
  confidence          text,
  status              text          not null default 'ok',
  fallback_reason     text,
  input_snapshot      jsonb,
  unique (user_id, brief_date)
);

create index if not exists daily_briefs_user_date_idx
  on public.daily_briefs(user_id, brief_date desc);

-- RLS: users read their own briefs from the client (Home tab). Writes happen
-- in the Netlify function with the service key, which bypasses RLS, so no
-- insert/update/delete policy is needed.
alter table public.daily_briefs enable row level security;

drop policy if exists "daily_briefs_select_own" on public.daily_briefs;
create policy "daily_briefs_select_own" on public.daily_briefs
  for select
  using (auth.uid() = user_id);
