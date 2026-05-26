-- Phase 2 audit — move journal photos out of inline data-URLs and into
-- the Supabase Storage 'journal-photos' bucket.
--
-- Background: journal_entries.photos is a JSONB array that stored each
-- photo as a base64 data-URL inline. With image sizes of 500KB-2MB
-- each, a typical 7-day journal load was pulling 5-15MB of image data
-- through the JSON row payload — measured at ~1100ms for 7 rows even
-- though only a handful had photos. PostgreSQL TOAST decompression
-- plus the over-the-wire JSON serialization both contribute.
--
-- The fix mirrors progress_pics_storage.sql exactly: photos live in a
-- private bucket, the table row stores per-user object paths only, the
-- client requests signed URLs to display them. Browser caches the
-- signed URLs so the second view of a card is free.
--
-- Path convention enforced by the client:
--   journal-photos/{auth.uid()}/{entry_date}/{uuid}.jpg
--
-- Bucket must be created manually in the Supabase dashboard:
--   Storage → Create new bucket → name: journal-photos, public: OFF.
-- This file only sets the RLS policies on storage.objects and adds
-- the photo_paths column to journal_entries (additive — coexists with
-- the legacy photos[] column during the migration window so existing
-- entries keep rendering until the backfill runs).

-- ── New column ────────────────────────────────────────────────────────
-- photo_paths is text[] of relative object names within the bucket
-- (e.g. {"<user_uuid>/2026-05-26/abc123.jpg", ...}). NULL or empty
-- means "no Storage-hosted photos yet — fall back to the legacy
-- photos[] data-URL column if present".
alter table public.journal_entries
  add column if not exists photo_paths text[];

-- ── RLS policies on storage.objects ──────────────────────────────────
-- Same own-folder pattern as progress-pics. The folder prefix
-- enforcement (foldername[1] == auth.uid()) prevents cross-user reads
-- even if someone tries to guess paths.

drop policy if exists "journal_photos_storage_own_read" on storage.objects;
create policy "journal_photos_storage_own_read" on storage.objects for select
  using (
    bucket_id = 'journal-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal_photos_storage_own_write" on storage.objects;
create policy "journal_photos_storage_own_write" on storage.objects for insert
  with check (
    bucket_id = 'journal-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal_photos_storage_own_update" on storage.objects;
create policy "journal_photos_storage_own_update" on storage.objects for update
  using (
    bucket_id = 'journal-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal_photos_storage_own_delete" on storage.objects;
create policy "journal_photos_storage_own_delete" on storage.objects for delete
  using (
    bucket_id = 'journal-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
