-- Phase 1.8 — "Today I Learned" alongside Daily Reflection.
-- New nullable text column on journal_entries; saved via the same
-- scheduleSave/saveJournalEntry path (patch is merged into existing row).
alter table public.journal_entries
  add column if not exists learning text;
