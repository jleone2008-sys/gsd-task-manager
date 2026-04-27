-- Lazy recurring-task spawning: a completed recurring task no longer creates
-- its next instance synchronously. Instead, the client checks on every load
-- (and on day-change) whether the next due date has arrived and only then
-- spawns. The "spawned" flag tracks which completed recurring tasks have
-- already had their successor created so we don't double-spawn.
alter table public.tasks
  add column if not exists spawned boolean default false not null;

-- Backfill: under the old eager-spawn behaviour, every existing completed
-- recurring task already produced its next instance. Mark them as spawned
-- so the new lazy logic doesn't create duplicates on first load.
update public.tasks
  set spawned = true
  where done = true
    and recur is not null
    and spawned = false;
