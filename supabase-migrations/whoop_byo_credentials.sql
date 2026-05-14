-- Whoop "bring your own dev credentials" model. Each user creates their own
-- Whoop developer app at developer.whoop.com, then pastes their client_id +
-- client_secret into /beta Settings. We no longer maintain a single GSD-owned
-- Whoop app, so the BETA_WHOOP_CLIENT_ID / BETA_WHOOP_CLIENT_SECRET env vars
-- are no longer used (safe to delete from Netlify).
--
-- client_id is a public OAuth value (appears in URLs); plaintext is fine.
-- client_secret is AES-256-GCM-encrypted with ADMIN_ENCRYPTION_KEY, same key
-- already used for the refresh tokens.
alter table public.user_profiles
  add column if not exists whoop_client_id          text,
  add column if not exists whoop_client_secret_enc  text;
