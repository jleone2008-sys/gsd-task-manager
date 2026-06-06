-- Unread-pattern badge: the Insights nav icon now shows the count of UNREAD
-- discovered patterns (was the note count). A pattern is "read" once the user
-- clicks into its card. read_at NULL = unread.
alter table public.patterns_discovered
  add column if not exists read_at timestamptz;
