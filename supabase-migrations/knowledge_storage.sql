-- Phase 6 — Storage bucket policies for the knowledge base.
--
-- Bucket name: 'knowledge' (private, off-public).
-- Path convention enforced by the client:
--   knowledge/{auth.uid()}/{document_id}/{filename}
--
-- Same own-folder RLS pattern as the existing 'journal-photos' bucket
-- (see supabase-migrations/journal_photos_storage.sql). Each user
-- reads + writes only files whose first path segment matches their
-- auth.uid().
--
-- Bucket creation is below via insert-on-conflict. Idempotent.

insert into storage.buckets (id, name, public)
values ('knowledge', 'knowledge', false)
on conflict (id) do nothing;

drop policy if exists "knowledge_storage_own_read" on storage.objects;
create policy "knowledge_storage_own_read" on storage.objects for select
  using (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "knowledge_storage_own_write" on storage.objects;
create policy "knowledge_storage_own_write" on storage.objects for insert
  with check (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "knowledge_storage_own_update" on storage.objects;
create policy "knowledge_storage_own_update" on storage.objects for update
  using (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "knowledge_storage_own_delete" on storage.objects;
create policy "knowledge_storage_own_delete" on storage.objects for delete
  using (
    bucket_id = 'knowledge'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
