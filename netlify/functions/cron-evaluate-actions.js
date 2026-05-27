// Phase 10 — per-user nightly evaluator for brief recommendations.
//
// Hourly cron with local-hour filter (same pattern as cron-daily-brief /
// cron-weather-snapshot). Each user fires once at 23:00 local. Per user
// per fire, three jobs:
//
//   1) Score adherence for outcomes from yesterday's brief
//      (brief_date = T-1, adherence_score IS NULL). Reads downstream
//      tables for "today" (oura_daily.date = T, workout_sessions,
//      habit_completions, journal_entries) and dispatches to
//      lib/adherence-rules.js by signature.
//
//   2) Fill T+1 outcome: for brief_date = T-1 rows, read source_metric
//      from the same downstream-today snapshot. For bedtime_target the
//      metric is sleep_score from oura_daily.date = T — which IS the
//      sleep that resulted from the bedtime recommendation given the
//      night before.
//
//   3) Fill T+3 outcome + set computed_at: for brief_date = T-3 rows,
//      read source_metric from oura_daily.date = T (or wherever the
//      metric lives). Once computed_at is non-null, the row counts
//      toward v_user_action_efficacy.
//
// After all users processed, refresh the materialized view. Concurrent
// refresh keeps it readable during the operation.
//
// Schedule: registered in netlify.toml at `0 * * * *`. The function
// filters by user-local hour, so a user in PT sees one fire at ~23:00
// PT and a user in ET sees one fire at ~23:00 ET.
//
// Cost: ~6 Supabase reads per user per fire + 1 view refresh per day.
// Effectively free at single-tenant scale.

const { SUPABASE_URL } = require('./lib/supabase');
const { computeAdherence, signaturePrefix } = require('./lib/adherence-rules');

// Only do work at this local hour. Late enough that today's sleep data
// from Oura should have settled (Oura typically finalizes a few hours
// after wake), early enough that the user hasn't gone to bed yet for
// tonight's recommendation — important because the T+1/T+3 reads for
// today's brief shouldn't fire until tomorrow's cron.
const EVALUATE_LOCAL_HOUR = 23;

exports.handler = async () => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    console.error('cron-evaluate-actions: missing SUPABASE_SERVICE_KEY');
    return { statusCode: 500, body: 'misconfigured' };
  }

  // Pull users + timezones, same pattern as cron-daily-brief.
  let users;
  try {
    const [profRes, prefRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=email,supabase_user_id&supabase_user_id=not.is.null`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/user_preferences?select=user_id,timezone`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      ),
    ]);
    const profiles = await profRes.json();
    const prefs    = await prefRes.json();
    if (!Array.isArray(profiles) || !Array.isArray(prefs)) {
      console.error('cron-evaluate-actions: bad user list shape');
      return { statusCode: 500, body: 'bad_user_list' };
    }
    const tzByUserId = {};
    for (const p of prefs) tzByUserId[p.user_id] = p.timezone || null;
    users = profiles.map(row => ({
      email:    row.email,
      user_id:  row.supabase_user_id,
      timezone: tzByUserId[row.supabase_user_id] || 'America/New_York',
    }));
  } catch (err) {
    console.error('cron-evaluate-actions: user list fetch failed:', err.message);
    return { statusCode: 500, body: err.message };
  }

  const now = new Date();
  const summary = {
    eligible: 0, skipped: 0, errors: 0,
    adherence_scored: 0, t1_filled: 0, t3_filled: 0,
  };
  let didWork = false;

  // Sleep intent pass runs EVERY tick (not gated to 23:00) so the
  // user's "last night's bedtime tap" gets matched against Oura's
  // detected onset within ~hours, not within a day. Cheap: one SELECT +
  // possibly one UPDATE per user per tick, only firing when there's a
  // pending intent older than 10 hours.
  summary.sleep_intents_filled = 0;
  for (const u of users) {
    try {
      const filled = await evaluateSleepIntentsForUser(u, serviceKey);
      summary.sleep_intents_filled += filled;
    } catch (err) {
      summary.errors++;
      console.error(`cron-evaluate-actions sleep-intent: ${u.email} failed:`, err.message);
    }
  }

  for (const u of users) {
    const hour = localHour(now, u.timezone);
    if (hour !== EVALUATE_LOCAL_HOUR) {
      summary.skipped++;
      continue;
    }
    summary.eligible++;
    try {
      const counts = await evaluateUser(u, now, serviceKey);
      summary.adherence_scored += counts.adherence_scored;
      summary.t1_filled        += counts.t1_filled;
      summary.t3_filled        += counts.t3_filled;
      if (counts.adherence_scored || counts.t1_filled || counts.t3_filled) {
        didWork = true;
      }
    } catch (err) {
      summary.errors++;
      console.error(`cron-evaluate-actions: ${u.email} failed:`, err.message);
    }
  }

  // Only refresh the view when at least one row changed. Saves a no-op
  // refresh on hours where no user fired or no user had pending work.
  if (didWork) {
    try {
      await refreshEfficacyView(serviceKey);
    } catch (err) {
      console.error('cron-evaluate-actions: view refresh failed:', err.message);
      summary.errors++;
    }
  }

  console.log('cron-evaluate-actions summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ── Sleep intent evaluator ────────────────────────────────────────────────
// For each pending sleep_intents row (intent_at > 10h ago, computed_at
// null), back-compute Oura's detected sleep onset from the next-morning
// oura_daily row and store the delta.
//
// Onset derivation: oura_daily.sleep_midpoint_offset_min is minutes from
// local midnight (of the date the sleep ENDED on) to the midpoint of
// sleep. Onset = midpoint - total_sleep_min/2. Converting that local
// timestamp to UTC requires the user's timezone — same tz we already
// have for the per-user iteration. The resulting onset_at is compared
// to the user's intent_at (a UTC timestamptz from the tap).
//
// "10 hours" gate: most people sleep 6-9h. Wait 10h post-tap before
// trying to fill so Oura has had time to score the sleep and our cron-
// health-sync has had a tick to pull it.
async function evaluateSleepIntentsForUser(user, serviceKey) {
  const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const cutoffIso = new Date(Date.now() - 10 * 3600_000).toISOString();
  const pending = await fetchJson(
    `${SUPABASE_URL}/rest/v1/sleep_intents?user_id=eq.${user.user_id}&computed_at=is.null&intent_at=lt.${encodeURIComponent(cutoffIso)}&select=id,intent_at&order=intent_at.asc&limit=10`,
    hdr,
  );
  if (!Array.isArray(pending) || pending.length === 0) return 0;

  let filled = 0;
  const tz = user.timezone || 'America/New_York';

  for (const row of pending) {
    // The date the sleep "ends on" — Oura's date convention. Add 12h to
    // intent_at and take the local date; handles both pre-midnight taps
    // (10pm → next day) and post-midnight taps (1am → same day).
    const sleepEndsLocalDate = localDate(new Date(new Date(row.intent_at).getTime() + 12 * 3600_000), tz);
    const ouraRows = await fetchJson(
      `${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${sleepEndsLocalDate}&select=date,sleep_midpoint_offset_min,total_sleep_min,sleep_score`,
      hdr,
    );
    const ora = ouraRows?.[0];
    // Skip silently when Oura hasn't landed yet — next tick will retry.
    if (!ora || ora.sleep_score == null
        || ora.sleep_midpoint_offset_min == null
        || ora.total_sleep_min == null) {
      continue;
    }

    // Onset local timestamp: midnight of sleepEndsLocalDate + midpoint -
    // total_sleep/2 minutes. midnight in user-local for sleepEndsLocalDate
    // is the UTC moment representing 00:00 of that local date.
    const midnightLocalUtcMs = localDayStartUtcMs(sleepEndsLocalDate, tz);
    const onsetMinFromMidnight = Number(ora.sleep_midpoint_offset_min) - Number(ora.total_sleep_min) / 2;
    const onsetUtcMs = midnightLocalUtcMs + onsetMinFromMidnight * 60_000;
    const onsetIso   = new Date(onsetUtcMs).toISOString();

    const intentMs = new Date(row.intent_at).getTime();
    const deltaMin = (onsetUtcMs - intentMs) / 60_000;

    await patchRow(row.id, {
      oura_detected_onset_at: onsetIso,
      oura_intent_delta_min:  Number(deltaMin.toFixed(1)),
      computed_at:            new Date().toISOString(),
    }, serviceKey, 'sleep_intents');
    filled++;
  }
  return filled;
}

// Convert a YYYY-MM-DD local date to the UTC milliseconds of that date's
// 00:00 local. Uses the localDate helper to verify match in a small window
// around the naive UTC interpretation. Same technique as the brief's
// localDayStartUtcMs, duplicated here so this file stays self-contained.
function localDayStartUtcMs(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessMs   = Date.UTC(y, m - 1, d);
  for (let h = -12; h <= 14; h++) {
    const ms = guessMs + h * 3600_000;
    if (localDate(new Date(ms), tz) === dateStr) {
      // Walk back one minute at a time to find the boundary.
      let lo = ms - 3600_000;
      while (lo >= guessMs - 24 * 3600_000 && localDate(new Date(lo), tz) === dateStr) lo -= 60_000;
      return lo + 60_000;
    }
  }
  return guessMs;
}

// ── Per-user evaluator ────────────────────────────────────────────────────
async function evaluateUser(user, now, serviceKey) {
  const tz   = user.timezone;
  const today = localDate(now, tz);              // T
  const yday  = shiftDate(today, -1);            // T-1
  const t3    = shiftDate(today, -3);            // T-3
  const hdr   = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // Fetch ALL pending rows for this user in one shot — both yesterday
  // (adherence + T+1) and 3 days ago (T+3).
  const pendingUrl = `${SUPABASE_URL}/rest/v1/brief_action_outcomes`
    + `?user_id=eq.${user.user_id}`
    + `&or=(and(brief_date.eq.${yday},adherence_score.is.null),`
    +     `and(brief_date.eq.${yday},value_at_t_plus_1.is.null),`
    +     `and(brief_date.eq.${t3},value_at_t_plus_3.is.null))`
    + `&select=*`;
  const pending = await fetchJson(pendingUrl, hdr);
  const counts = { adherence_scored: 0, t1_filled: 0, t3_filled: 0 };
  if (!Array.isArray(pending) || pending.length === 0) return counts;

  // Pre-fetch downstream data needed to score adherence + read outcomes.
  // Today's oura_daily provides sleep_score / total_sleep_min /
  // sleep_midpoint_offset_min for both adherence (bedtime check) and
  // outcome (sleep_score is the source_metric).
  const downstream = await buildDownstream(user, today, hdr);

  // Process rows in three buckets. A row can land in adherence + t1 in
  // the same fire (both come from the same downstream snapshot).
  const adherenceRows = pending.filter(r => r.brief_date === yday && r.adherence_score == null);
  const t1Rows        = pending.filter(r => r.brief_date === yday && r.value_at_t_plus_1 == null);
  const t3Rows        = pending.filter(r => r.brief_date === t3  && r.value_at_t_plus_3 == null);

  // ── Adherence ─────────────────────────────────────────────────────
  for (const row of adherenceRows) {
    const result = computeAdherence(row, downstream);
    if (result.score == null && (!result.evidence || result.evidence.reason === 'no_oura_today')) {
      // No data yet — leave for the next nightly attempt. Don't mark
      // computed since downstream may settle later.
      continue;
    }
    await patchRow(row.id, {
      adherence_score:    result.score,
      adherence_evidence: result.evidence || null,
    }, serviceKey);
    counts.adherence_scored++;
  }

  // ── T+1 ─────────────────────────────────────────────────────────────
  for (const row of t1Rows) {
    const { numeric, text } = readMetric(row.source_metric, downstream);
    if (numeric == null && text == null) continue;
    await patchRow(row.id, {
      value_at_t_plus_1:      numeric,
      value_at_t_plus_1_text: text,
    }, serviceKey);
    counts.t1_filled++;
  }

  // ── T+3 (and computed_at) ───────────────────────────────────────────
  for (const row of t3Rows) {
    const { numeric, text } = readMetric(row.source_metric, downstream);
    if (numeric == null && text == null) {
      // T+3 with no data is still a completed row from the system's
      // perspective — the metric just isn't tracked. Mark computed_at
      // so we don't keep re-attempting forever.
      await patchRow(row.id, { computed_at: new Date().toISOString() }, serviceKey);
      counts.t3_filled++;
      continue;
    }
    await patchRow(row.id, {
      value_at_t_plus_3:      numeric,
      value_at_t_plus_3_text: text,
      computed_at:            new Date().toISOString(),
    }, serviceKey);
    counts.t3_filled++;
  }

  return counts;
}

// ── Downstream snapshot ────────────────────────────────────────────────────
// Single pre-fetch of everything any adherence rule or metric reader
// might need. All keyed to user + today (where today = the cron's
// run-day, i.e. the day AFTER the brief whose adherence we're scoring).
async function buildDownstream(user, today, hdr) {
  const [
    ouraToday, sessionsTodayWithSets, habitCompletions, habitsCatalog,
    journalToday, baselines7, recentSessionsForVolume,
  ] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${today}&select=*`, hdr),
    // Embed workout_sets so we pull sessions + their sets in one round
    // trip. PostgREST doesn't support sub-selects with IN — the embed
    // is the clean way.
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${user.user_id}&session_date=eq.${today}&select=id,session_date,day_type,day_name,feel,session_notes,workout_sets(exercise_name,set_index,actual_weight,actual_reps,is_bodyweight)`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/habit_completions?user_id=eq.${user.user_id}&completed_date=eq.${today}&select=habit_id,completed_date`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/habits?user_id=eq.${user.user_id}&archived=eq.false&select=id,name,emoji`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=eq.${today}&select=entry_date,mood`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_7d?user_id=eq.${user.user_id}&select=*`, hdr),
    // Recent sessions for volume normalization. Last 10 prior sessions
    // with sets embedded — same shape as today's pull so the sum logic
    // below works identically.
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${user.user_id}&session_date=lt.${today}&order=session_date.desc&limit=10&select=id,session_date,workout_sets(actual_weight,actual_reps,is_bodyweight)`, hdr),
  ]);

  // Flatten today's sessions + their embedded sets into the shape the
  // adherence rules expect: workout_sessions_today (one row per session)
  // and workouts_today (one row per set).
  const workoutSessions = sessionsTodayWithSets || [];
  const workoutSets = [];
  for (const s of workoutSessions) {
    const sets = Array.isArray(s.workout_sets) ? s.workout_sets : [];
    for (const set of sets) workoutSets.push({ ...set, session_id: s.id });
  }

  // Recent average volume (excludes bodyweight sets, matches what
  // rulePushWorkout uses for "heavy enough" comparison).
  let avgVolume = null;
  if (Array.isArray(recentSessionsForVolume) && recentSessionsForVolume.length > 0) {
    let total = 0;
    let count = 0;
    for (const s of recentSessionsForVolume) {
      const sets = Array.isArray(s.workout_sets) ? s.workout_sets : [];
      let v = 0;
      for (const set of sets) {
        if (set.is_bodyweight) continue;
        v += (Number(set.actual_weight) || 0) * (Number(set.actual_reps) || 0);
      }
      if (v > 0) { total += v; count++; }
    }
    if (count > 0) avgVolume = total / count;
  }

  return {
    oura_today:                ouraToday?.[0] || null,
    workout_sessions_today:    workoutSessions || [],
    workouts_today:            workoutSets || [],
    habit_completions_today:   habitCompletions || [],
    habits_catalog:            habitsCatalog || [],
    journal_today:             journalToday?.[0] || null,
    baselines_7d:              baselines7?.[0] || null,
    recent_workout_avg_volume: avgVolume,
  };
}

// ── Source-metric reader ───────────────────────────────────────────────────
// Returns {numeric, text} — exactly one is non-null per metric (numeric
// for scores, text for ordinal labels like mood). Adding a new
// source_metric means adding a case here.
function readMetric(metric, downstream) {
  switch (metric) {
    case 'sleep_score':
      return { numeric: numOrNull(downstream.oura_today?.sleep_score), text: null };
    case 'readiness_score':
      return { numeric: numOrNull(downstream.oura_today?.readiness_score), text: null };
    case 'hrv_ms':
      return { numeric: numOrNull(downstream.oura_today?.hrv_ms), text: null };
    case 'activity_score':
      return { numeric: numOrNull(downstream.oura_today?.activity_score), text: null };
    case 'total_sleep_min':
      return { numeric: numOrNull(downstream.oura_today?.total_sleep_min), text: null };
    case 'mood_label': {
      const m = downstream.journal_today?.mood;
      if (m == null) return { numeric: null, text: null };
      // Mood scale is 1=Bad ... 5=Great after invert_mood_scale migration.
      // Store the integer as numeric AND the label as text so consumers
      // can choose whichever framing they need.
      const labels = ['Bad', 'Low', 'Okay', 'Good', 'Great'];
      const label  = labels[Number(m) - 1] || null;
      return { numeric: Number(m), text: label };
    }
    case 'habits_done_pct': {
      // Not stored; would need journal_habit_summary lookup. Defer.
      return { numeric: null, text: null };
    }
    default:
      return { numeric: null, text: null };
  }
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Row patch ─────────────────────────────────────────────────────────────
async function patchRow(rowId, patch, serviceKey, table = 'brief_action_outcomes') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${rowId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`patch_${table}_${r.status}: ${text.slice(0, 200)}`);
  }
}

// ── Materialized view refresh ──────────────────────────────────────────────
// Concurrent refresh keeps the view available to the brief function
// during the operation. Uses the Supabase Management API the same way
// scripts/apply-migration.mjs does — except we don't have the user's
// access token here. Instead, use the postgrest RPC fallback:
// run a tiny function created server-side, OR fall back to a plain
// REFRESH via the SQL pseudo-RPC.
//
// Simplest: PostgREST supports `?` on a SQL function. We define a
// security-definer wrapper in a one-off migration and call it here.
// For now use a synchronous-call via Supabase Management API token if
// SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF are set; otherwise log
// a warning and skip — the view's just slightly stale until the next
// run after those are configured.
async function refreshEfficacyView(serviceKey) {
  // Preferred path: call the SQL function refresh_efficacy_view()
  // (security-definer wrapper) via PostgREST RPC. The function is
  // created in supabase-migrations/v_user_action_efficacy_refresh_fn.sql.
  const url = `${SUPABASE_URL}/rest/v1/rpc/refresh_efficacy_view`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
    },
    body: '{}',
  });
  if (!r.ok) {
    const text = await r.text();
    // 404 likely means the RPC wrapper isn't deployed yet — soft-fail.
    if (r.status === 404) {
      console.warn('cron-evaluate-actions: refresh_efficacy_view RPC missing; run v_user_action_efficacy_refresh_fn migration');
      return;
    }
    throw new Error(`refresh_efficacy_view_${r.status}: ${text.slice(0, 200)}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function fetchJson(url, hdr) {
  try {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) {
      console.warn(`evaluate-actions: fetch ${url.slice(0, 120)} HTTP ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (err) {
    console.warn(`evaluate-actions: fetch failed: ${err.message}`);
    return [];
  }
}

function localHour(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const h = parseInt(fmt.format(date), 10);
  return h === 24 ? 0 : h;
}

function localDate(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
