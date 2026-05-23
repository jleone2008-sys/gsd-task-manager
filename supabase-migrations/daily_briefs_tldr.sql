-- Phase 1.5 — Brief UX polish: TL;DR replaces the long narrative as the
-- primary prose on the daily brief. New rows populate `tldr` and leave
-- `narrative` NULL. The narrative column stays for back-compat with rows
-- generated under the Phase 1 schema (UI falls back to the first sentence
-- of narrative when only narrative is present).
alter table public.daily_briefs
  add column if not exists tldr text;
