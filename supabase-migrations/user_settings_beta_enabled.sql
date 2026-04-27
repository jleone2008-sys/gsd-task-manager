-- Per-user beta opt-in flag. When set to true, signing in to the prod app
-- (gsdtasks.com/app) auto-redirects to /beta/app. The toggle is exposed in
-- beta settings only, and gated to admin users on the client side. Even if
-- a non-admin somehow flips this on (e.g. via the API), the prod redirect
-- also requires user_profiles.role === 'admin' as a defense in depth.
alter table public.user_settings
  add column if not exists beta_enabled boolean default false not null;
