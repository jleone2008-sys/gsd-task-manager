-- Persist Claude's session feedback on workout_sessions so the History
-- tab can show the AI summary alongside the deterministic stats without
-- re-spending tokens or losing the result when the page reloads.
--
-- Until now, AI feedback lived in client memory only via
-- _trainTodayState.aiFeedback — fine for the post-submit feedback view,
-- but the moment the user closed it the result was gone. The new
-- History tab needs to read it back for any past session, hence this
-- column.
--
-- JSONB shape (matches the netlify function's response):
--   { status, insight, observations[], model, prompt_tokens, completion_tokens, fallback_reason }
--
-- The netlify function (beta-train-feedback.js) is updated to write
-- this column at the end of generation. Existing sessions stay NULL
-- until the user opens them in History and taps "Run analysis"
-- (a lazy re-fetch path that hits the same function).

alter table public.workout_sessions
  add column if not exists ai_feedback jsonb;
