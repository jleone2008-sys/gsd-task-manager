-- Phase 8 — chat_messages.
--
-- The Ask chat surface inside Insights. One row per message
-- (user or assistant) in a per-day conversation thread.
--
-- Threading model: one thread per (user_id, thread_date). The Ask
-- subtab defaults to today's thread; the user can navigate to prior
-- days from a date picker.
--
-- Columns:
--   thread_date    = YYYY-MM-DD. The "day" the conversation belongs
--                    to. New chats default to today.
--   role           = 'user' | 'assistant' | 'tool_summary'
--                    (tool_summary is a collapsed display-only entry
--                    summarizing what tools fired during the
--                    assistant's response — actual tool_use blocks
--                    live in tool_calls_log on the assistant row)
--   content        = the displayed message text
--   tool_calls_log = jsonb of agentic-loop tool calls (assistant rows
--                    only). Capped to last 50 entries.
--   model          = which Claude model produced this row
--                    (assistant rows only)
--   prompt_tokens / completion_tokens / iterations = telemetry per
--                    assistant turn
--   client_msg_id  = optional client-supplied UUID for optimistic UI
--                    de-dupe (so client can render its own user msg
--                    before the server round-trip completes)
--   status         = 'streaming' | 'complete' | 'failed'
--                    (only assistant rows transit 'streaming')

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  thread_date     date not null,
  role            text not null check (role in ('user','assistant','tool_summary')),
  content         text,
  tool_calls_log  jsonb,
  model           text,
  prompt_tokens   integer,
  completion_tokens integer,
  iterations      integer,
  client_msg_id   text,
  status          text default 'complete' check (status in ('streaming','complete','failed')),
  failure_reason  text,
  created_at      timestamptz not null default now()
);

-- The main read pattern: "give me this thread's messages in order"
create index if not exists chat_messages_thread
  on public.chat_messages(user_id, thread_date, created_at asc);

-- For the date picker — list of dates with messages
create index if not exists chat_messages_user_dates
  on public.chat_messages(user_id, thread_date desc);

-- Optional uniqueness on client_msg_id within a user so retries don't
-- dupe. NULL allowed for assistant rows + legacy entries.
create unique index if not exists chat_messages_client_id_uniq
  on public.chat_messages(user_id, client_msg_id)
  where client_msg_id is not null;

alter table public.chat_messages enable row level security;
drop policy if exists "chat_messages own" on public.chat_messages;
create policy "chat_messages own" on public.chat_messages for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
