-- Phase 2 audit — final cleanup after the journal-photos Storage
-- migration. Nulls out the legacy photos[] column for any row whose
-- photo_paths[] has been populated by the client-side backfill.
--
-- After this runs:
--   - photo_paths[] is the only source of truth for journal photos
--   - photos[] is NULL on every backfilled row → row payload is tiny
--   - any unmigrated row (theoretical, since backfill processed all
--     user rows) keeps its photos[] intact and the client's dual-read
--     fallback still renders them
--
-- Safe to re-run. The condition gates on photo_paths being non-empty,
-- so it won't touch unmigrated rows.

-- photos is JSONB NOT NULL DEFAULT '[]', so we can't NULL it. Setting
-- it to an empty JSONB array gives us the same payload size (a few
-- bytes) without violating the constraint.
update public.journal_entries
   set photos = '[]'::jsonb
 where photo_paths is not null
   and array_length(photo_paths, 1) > 0
   and (photos is not null and jsonb_array_length(photos) > 0);
