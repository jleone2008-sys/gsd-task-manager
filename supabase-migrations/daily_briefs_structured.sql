-- Phase 1.7 — Structured "coach brief" redesign.
--
-- New columns:
--   mode        morning | evening — two daily briefs per user, swapping
--               hero ring → recap chip and today_play → tomorrow_setup at 16:00 local
--   structured  jsonb payload matching the mockup layout (headline,
--               subhead, hero_metric, stats[], evidence_pills[], today_play[]
--               or tomorrow_setup[], weather_chip). The UI renders block by
--               block; no parsing or prose splitting needed.
--
-- UNIQUE shifts from (user_id, brief_date) to (user_id, brief_date, mode) so
-- the upsert path can store morning + evening as separate rows.
--
-- narrative / tldr / highlights / actions stay nullable for back-compat with
-- rows generated under Phase 1 / 1.5 / 1.6 schemas. The renderer falls back
-- to the legacy paragraph path when `structured` is missing.

alter table public.daily_briefs
  add column if not exists mode text not null default 'morning'
    check (mode in ('morning','evening')),
  add column if not exists structured jsonb;

alter table public.daily_briefs
  drop constraint if exists daily_briefs_user_id_brief_date_key;

alter table public.daily_briefs
  add constraint daily_briefs_user_id_brief_date_mode_key
    unique (user_id, brief_date, mode);
