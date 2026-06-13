-- ── Per-user background wallpaper storage ──────────────────────────────────
-- One image per user at {auth.uid()}/wallpaper.jpg in a PRIVATE bucket.
-- Mirrors journal-photos / progress-pics: bucket created here, own-folder RLS
-- on storage.objects so a user can only read/write/delete files under their own
-- uid-prefixed folder. The app reads it back via a signed URL (private bucket).

insert into storage.buckets (id, name, public)
values ('user-wallpapers', 'user-wallpapers', false)
on conflict (id) do nothing;

drop policy if exists "user_wallpapers own read" on storage.objects;
create policy "user_wallpapers own read" on storage.objects for select
  using (bucket_id = 'user-wallpapers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user_wallpapers own insert" on storage.objects;
create policy "user_wallpapers own insert" on storage.objects for insert
  with check (bucket_id = 'user-wallpapers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user_wallpapers own update" on storage.objects;
create policy "user_wallpapers own update" on storage.objects for update
  using (bucket_id = 'user-wallpapers' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-wallpapers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "user_wallpapers own delete" on storage.objects;
create policy "user_wallpapers own delete" on storage.objects for delete
  using (bucket_id = 'user-wallpapers' and (storage.foldername(name))[1] = auth.uid()::text);
