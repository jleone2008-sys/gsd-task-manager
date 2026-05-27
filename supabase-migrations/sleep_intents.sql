-- Sleep Intent — user self-reports "I'm going to bed now."
--
-- One row per tap of the bedtime button in the brief header. The tap
-- captures the user's intent; cron-evaluate-actions later compares that
-- intent_at timestamp to Oura's detected sleep onset (derived from
-- oura_daily.sleep_midpoint_offset_min minus half the total sleep) and
-- stores the delta. Over weeks the delta becomes a personal signal —
-- "I usually fall asleep ~18 min after I think I'm going to bed."
--
-- Why a dedicated table (not brief_action_outcomes): this isn't a
-- recommendation outcome; it's primary behavioral data. Schema needs
-- different fields (intent_at vs proposal+adherence), the lifecycle
-- has no Accept/Decline, and the comparison target is Oura's onset
-- estimate rather than a brief-recommended metric.
--
-- Columns:
--   intent_at              user's local moment of tapping the button
--   source                 'manual' (current); future: 'auto_sleep_mode'
--                          if we ever detect bedtime intent from other
--                          signals (e.g. screen-time wind-down, NFC tag)
--   oura_detected_onset_at the timestamptz Oura's data implies the user
--                          actually fell asleep — back-computed from the
--                          NEXT oura_daily row (date = intent_date+1) as
--                          (midpoint_offset - total_sleep_min/2)
--   oura_intent_delta_min  signed minutes: positive = Oura detected onset
--                          AFTER intent (typical), negative = Oura puts
--                          onset before intent (rare; user probably napped
--                          earlier and tapped late)
--   computed_at            set by cron-evaluate-actions once delta filled

create table if not exists public.sleep_intents (
  id                     uuid          primary key default gen_random_uuid(),
  user_id                uuid          not null references auth.users(id) on delete cascade,
  intent_at              timestamptz   not null default now(),
  source                 text          not null default 'manual'
                            check (source in ('manual','auto_sleep_mode')),
  oura_detected_onset_at timestamptz,
  oura_intent_delta_min  numeric,
  computed_at            timestamptz,
  note                   text,
  created_at             timestamptz   not null default now()
);

create index if not exists sleep_intents_user_recent_idx
  on public.sleep_intents (user_id, intent_at desc);

-- Helper index for the nightly cron: pick up intents that haven't been
-- compared to Oura yet. Filtered partial index keeps it tiny.
create index if not exists sleep_intents_pending_idx
  on public.sleep_intents (user_id, intent_at)
  where computed_at is null;

alter table public.sleep_intents enable row level security;

-- Read-own. Writes go through beta-sleep-intent.js with service key, but
-- since the user can write their own intent from the client this could be
-- simplified to client-direct inserts; the function path lets us add
-- server-side validation (rate-limit, dedupe within N minutes) without
-- moving the bar.
drop policy if exists "sleep_intents_select_own" on public.sleep_intents;
create policy "sleep_intents_select_own" on public.sleep_intents
  for select using (auth.uid() = user_id);

drop policy if exists "sleep_intents_insert_own" on public.sleep_intents;
create policy "sleep_intents_insert_own" on public.sleep_intents
  for insert with check (auth.uid() = user_id);

drop policy if exists "sleep_intents_delete_own" on public.sleep_intents;
create policy "sleep_intents_delete_own" on public.sleep_intents
  for delete using (auth.uid() = user_id);
