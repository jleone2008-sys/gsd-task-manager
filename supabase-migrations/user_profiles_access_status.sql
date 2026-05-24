-- Phase 3 / Stage 3 — allowlist via user_profiles.access_status.
--
-- New signups arrive in 'pending' and must be flipped to 'active' by an admin
-- before they can use the app. Existing users (anyone with a user_profiles row
-- or an entry in the legacy beta_users allowlist) are presumed allowed and
-- get backfilled to 'active' so this migration doesn't lock anyone out.

alter table public.user_profiles
  add column if not exists access_status text
    default 'pending'
    check (access_status in ('pending', 'active', 'revoked'));

-- ALTER ADD COLUMN ... DEFAULT 'pending' backfills every existing row with
-- 'pending'. Override that for the rows that pre-date this migration — they
-- were already using the app, they stay active.
update public.user_profiles
   set access_status = 'active'
 where access_status = 'pending';

-- Ensure anyone in the legacy beta_users allowlist has a user_profiles row
-- (pre-marked 'active') so the admin UI surfaces them. Skip users that
-- already have a row; their access_status was just set to 'active' above.
insert into public.user_profiles (email, access_status)
select b.email, 'active'
  from public.beta_users b
  left join public.user_profiles p on p.email = b.email
 where p.email is null;

-- From here on, new rows created by upsert_user_profile_id (on first sign-in)
-- inherit the column default 'pending'. The auth gate in beta/src/01-core.js
-- enforces 'active' before loading user data; non-active users see the
-- waitlist screen and get signed out.
