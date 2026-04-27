-- Phase 4.1 — three-state task status: todo → in_progress → done.
-- The legacy `done` boolean is kept in sync with this column so older
-- code paths (and any out-of-date client) keep working.
alter table public.tasks
  add column if not exists status text default 'todo' not null
  check (status in ('todo', 'in_progress', 'done'));

-- Backfill the new column from the existing done flag so already-completed
-- rows continue to read as 'done'.
update public.tasks set status = 'done' where done = true and status <> 'done';
