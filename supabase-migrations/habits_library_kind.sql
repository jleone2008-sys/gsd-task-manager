-- Phase 4 commit 4 — habits.library_kind column.
--
-- Optional FK from habits.library_kind → habit_library.kind. When set,
-- the matching events (per habit_library.auto_complete_source) auto-mark
-- this habit complete on the event's date. NULL means manual-only (the
-- existing behavior) — all historical habit_completions are unaffected.
--
-- 'set null' on delete so removing a library entry doesn't cascade into
-- a habit deletion; the habit just goes back to manual-only.

alter table public.habits
  add column if not exists library_kind text
    references public.habit_library(kind) on delete set null;

create index if not exists habits_library_kind_idx
  on public.habits(user_id, library_kind)
  where library_kind is not null;
