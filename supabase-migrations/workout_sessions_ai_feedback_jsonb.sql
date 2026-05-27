-- Fix workout_sessions.ai_feedback column type: text → jsonb.
--
-- The column was originally typed text and stored stringified JSON
-- (e.g. '{"status":"ok","insight":"..."}'). The writer in
-- beta-train-feedback.js POSTs a structured object via PostgREST, which
-- silently down-casts it to a JSON string for the text column.
--
-- The reader path in beta/src/06-train.js (renderHistoryRecapAI) treats
-- ai_feedback as an object and reads .insight / .observations. Strings
-- pass the truthiness check but fail property lookups, so every history
-- card with stored feedback rendered "No AI analysis on file" + a
-- "Run analysis" button — even though the data was right there.
--
-- The "Run analysis" path masked the bug: it uses the function's response
-- object directly (bypassing the DB read), so the modal showed correct
-- content until refresh. On every fresh page load it broke again.
--
-- The USING clause casts existing text values to jsonb. All existing
-- rows contain valid JSON (Claude tool-use output, server-validated),
-- so the cast succeeds without data loss. nullif handles any empty-string
-- rows that might have landed before the writer started returning JSON.
--
-- No code changes needed — the client already expects an object; the
-- writer already sends an object. Only the column type was wrong.

alter table public.workout_sessions
  alter column ai_feedback type jsonb
  using case
    when ai_feedback is null or ai_feedback = '' then null
    else ai_feedback::jsonb
  end;
