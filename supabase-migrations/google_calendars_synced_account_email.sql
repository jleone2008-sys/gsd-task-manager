-- Multi-account Google calendar — scope per-calendar toggles to the
-- Google account they live in. Before this migration, the table's pk
-- was (user_id, google_calendar_id), which collided when two linked
-- accounts both expose a calendar id 'primary' (per-account alias).
--
-- After: pk is (user_id, google_account_email, google_calendar_id).
-- Empty string '' = the user's primary signed-in Google account
-- (existing rows). Linked accounts store their real Google email.

alter table public.google_calendars_synced
  add column if not exists google_account_email text not null default '';

alter table public.google_calendars_synced
  drop constraint if exists google_calendars_synced_pkey;

alter table public.google_calendars_synced
  add constraint google_calendars_synced_pkey
  primary key (user_id, google_account_email, google_calendar_id);
