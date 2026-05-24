-- Phase 4 — Storage bucket policies for progress pic uploads.
--
-- The 'progress-pics' bucket itself must be created in the Supabase
-- dashboard manually (Storage → Create new bucket → name: progress-pics,
-- public: OFF). This file only sets the RLS policies on storage.objects
-- so each user can only read/write their own folder.
--
-- Path convention enforced by the client:
--   progress-pics/{auth.uid()}/{captured_date}/front.jpg
--   progress-pics/{auth.uid()}/{captured_date}/side.jpg
--   progress-pics/{auth.uid()}/{captured_date}/back.jpg

drop policy if exists "progress_pics_storage_own_read" on storage.objects;
create policy "progress_pics_storage_own_read" on storage.objects for select
  using (
    bucket_id = 'progress-pics'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "progress_pics_storage_own_write" on storage.objects;
create policy "progress_pics_storage_own_write" on storage.objects for insert
  with check (
    bucket_id = 'progress-pics'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "progress_pics_storage_own_update" on storage.objects;
create policy "progress_pics_storage_own_update" on storage.objects for update
  using (
    bucket_id = 'progress-pics'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "progress_pics_storage_own_delete" on storage.objects;
create policy "progress_pics_storage_own_delete" on storage.objects for delete
  using (
    bucket_id = 'progress-pics'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
