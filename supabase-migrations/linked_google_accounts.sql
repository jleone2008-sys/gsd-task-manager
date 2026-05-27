-- Multi-account Google calendar — a user can link additional Google
-- accounts beyond their primary sign-in account so calendars from
-- those accounts also feed Journal + Brief.
--
-- Each row stores one (user, secondary Google email) pair plus the
-- encrypted refresh_token captured during the link OAuth flow.
-- Insert/update is performed by service-role from
-- /.netlify/functions/beta-link-google-account (which decrypts the
-- exchanged refresh_token); RLS only allows the row's owning user to
-- SELECT and DELETE (delete revokes via Netlify fn first).

create table if not exists public.linked_google_accounts (
  user_id            uuid        not null references auth.users(id) on delete cascade,
  google_email       text        not null,
  refresh_token_enc  text        not null,
  display_name       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, google_email)
);

alter table public.linked_google_accounts enable row level security;

drop policy if exists "linked_google_accounts own select" on public.linked_google_accounts;
create policy "linked_google_accounts own select" on public.linked_google_accounts
  for select using (user_id = auth.uid());

drop policy if exists "linked_google_accounts own delete" on public.linked_google_accounts;
create policy "linked_google_accounts own delete" on public.linked_google_accounts
  for delete using (user_id = auth.uid());

-- No insert/update policy — service role only.

create or replace function public.touch_linked_google_accounts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists linked_google_accounts_updated_at on public.linked_google_accounts;
create trigger linked_google_accounts_updated_at
  before update on public.linked_google_accounts
  for each row execute function public.touch_linked_google_accounts_updated_at();
