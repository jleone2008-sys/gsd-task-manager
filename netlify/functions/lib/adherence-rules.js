// Phase 10 — adherence inference for brief recommendations.
//
// Pure-function map: recommendation_signature → (row, downstream) =>
// { score, evidence }. Called from cron-evaluate-actions.js the night
// after a brief was generated, once downstream data (today's oura_daily,
// today's workout_sessions, today's habit_completions, today's
// journal_entries) has settled.
//
// score: 0.0–1.0 where 1.0 = clear adherence, 0.0 = clear non-adherence,
//        partial values represent partial follow-through.
// score: null when there's no behavioral signal that can prove or
//        disprove adherence for this signature (hydrate, weather framing).
//        Null-adherence rows are excluded from "followed vs ignored"
//        comparisons in v_user_action_efficacy; we still measure outcome
//        on them.
//
// evidence: free-form jsonb explaining what the rule looked at. Stored
//           on brief_action_outcomes.adherence_evidence for debugging
//           and so the weekly synthesis Opus call can quote the actual
//           numbers ("you went to bed at 10:42 PM, 72 minutes after the
//           suggested 9:30 PM").
//
// downstream is a pre-built object the cron passes in:
//   {
//     oura_today:    {date, sleep_score, total_sleep_min,
//                     sleep_midpoint_offset_min, ...} | null,
//     workouts_today:    [{exercise_name, set_index, actual_weight,
//                          actual_reps, is_bodyweight, ...}, ...]   // workout_sets joined
//     workout_sessions_today: [{id, session_date, day_type, ...}]   // workout_sessions
//     habit_completions_today: [{habit_id, completed_date}, ...]
//     habits_catalog:    [{id, name, emoji}, ...]
//     journal_today:     {entry_date, mood, ...} | null
//     baselines_7d:      {hrv_ms_median, total_sleep_min_median, ...} | null
//     recent_workout_avg_volume: number | null
//   }

// Convert a "9:30 PM" style time string to minutes since midnight.
// Returns null when unparseable.
function parseClockTime(timeStr) {
  if (!timeStr) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeStr).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// Oura's sleep_midpoint_offset_min is minutes from midnight to the
// midpoint of the night's sleep, positive = after midnight, negative =
// before. To recover an approximate bedtime: midpoint − (total_sleep / 2).
// Returns minutes since midnight (can be negative when bedtime is before
// midnight, in which case we shift back into the 0–1439 range as evening).
function inferBedtimeMinutes(ouraToday) {
  if (!ouraToday) return null;
  const mid = Number(ouraToday.sleep_midpoint_offset_min);
  const tot = Number(ouraToday.total_sleep_min);
  if (!Number.isFinite(mid) || !Number.isFinite(tot)) return null;
  // Bedtime ≈ midpoint − total/2. Add 1440 if negative (means evening of
  // prior day, which for adherence checking we treat as "yesterday's PM").
  let bt = mid - tot / 2;
  if (bt < 0) bt += 1440;
  return bt;
}

// Score how close actual bedtime was to suggested. ≤15 min late = 1.0,
// linear decay to 0 at 90+ min late. Going to bed early scores 1.0
// (overshooting the recommendation is still adherence).
function scoreBedtimeAdherence(suggestedMin, actualMin) {
  if (suggestedMin == null || actualMin == null) return null;
  // Handle wraparound: suggested 21:30 (1290), actual 00:30 (30 next day)
  // → diff = 180 not −1260. Normalize to [-720, +720].
  let diff = actualMin - suggestedMin;
  if (diff < -720) diff += 1440;
  if (diff > 720)  diff -= 1440;
  // Going to bed early (negative diff) = full adherence.
  if (diff <= 15) return 1.0;
  if (diff >= 90) return 0.0;
  // Linear between 15 and 90 minutes late.
  return Math.max(0, Math.min(1, 1.0 - (diff - 15) / 75));
}

// ── Per-signature rules ──────────────────────────────────────────────

// Bedtime target: bedtime_target:HH:MM
function ruleBedtimeTarget(row, downstream) {
  const suggested = signatureSuffix(row.recommendation_signature);   // "21:30"
  const m = /^(\d{2}):(\d{2})$/.exec(String(suggested || ''));
  if (!m) {
    return { score: null, evidence: { reason: 'unparseable_signature', signature: row.recommendation_signature } };
  }
  const suggestedMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const ouraToday = downstream.oura_today;
  const actualMin = inferBedtimeMinutes(ouraToday);
  if (actualMin == null) {
    return { score: null, evidence: { reason: 'no_oura_today', suggested } };
  }
  const score = scoreBedtimeAdherence(suggestedMin, actualMin);
  const actualHm = `${String(Math.floor(actualMin / 60)).padStart(2, '0')}:${String(Math.round(actualMin % 60)).padStart(2, '0')}`;
  return {
    score,
    evidence: {
      suggested,
      actual_bedtime: actualHm,
      delta_min:      Math.round(actualMin - suggestedMin),
      from:           'oura_midpoint_minus_half_total_sleep',
    },
  };
}

// Intensity reduce: did the user actually take it easy? 1.0 when no
// workout session was logged AND yesterday's activity is below 7d median.
// 0.5 if one of those.
function ruleIntensityReduce(row, downstream) {
  const sessions = downstream.workout_sessions_today || [];
  const noLift   = sessions.length === 0;
  const actScore = downstream.oura_today?.activity_score;
  const actMed   = downstream.baselines_7d?.activity_score_median;
  const lowAct   = (actScore != null && actMed != null && Number(actScore) < Number(actMed));
  const signals  = [noLift, lowAct].filter(Boolean).length;
  return {
    score: signals === 2 ? 1.0 : signals === 1 ? 0.5 : 0.0,
    evidence: {
      no_workout_logged:  noLift,
      activity_below_norm: lowAct,
      activity_score:      actScore ?? null,
      activity_median_7d:  actMed ?? null,
    },
  };
}

// Push workout: did a workout session land AND was it heavy enough?
// 1.0 when session exists + total volume ≥80% of recent average.
// 0.5 when session exists but volume below threshold.
// 0.0 when no session.
function rulePushWorkout(row, downstream) {
  const sessions = downstream.workout_sessions_today || [];
  if (sessions.length === 0) {
    return { score: 0.0, evidence: { no_session_logged: true } };
  }
  // Sum volume across all sets for today's session(s). workouts_today
  // contains all workout_sets for today's sessions (filtered by the
  // cron's downstream pre-fetch).
  const sets = downstream.workouts_today || [];
  let volume = 0;
  for (const s of sets) {
    if (s.is_bodyweight) continue;
    volume += (Number(s.actual_weight) || 0) * (Number(s.actual_reps) || 0);
  }
  const avg = downstream.recent_workout_avg_volume;
  const ratio = (avg && avg > 0) ? volume / avg : null;
  const heavy = ratio != null && ratio >= 0.8;
  return {
    score: heavy ? 1.0 : 0.5,
    evidence: {
      session_logged:  true,
      total_volume:    Math.round(volume),
      recent_avg:      avg ? Math.round(avg) : null,
      ratio:           ratio != null ? Number(ratio.toFixed(2)) : null,
    },
  };
}

// Protect sleep: did total_sleep_min beat 7d median by ≥20 min?
// Measured at the *next* night's sleep (T+1 from the brief's evening
// perspective), but since the cron runs on day T+1 it reads oura_today.
function ruleProtectSleep(row, downstream) {
  const totMin = downstream.oura_today?.total_sleep_min;
  const median = downstream.baselines_7d?.total_sleep_min_median;
  if (totMin == null || median == null) {
    return { score: null, evidence: { reason: 'no_sleep_data_or_baseline' } };
  }
  const delta = Number(totMin) - Number(median);
  // ≥20 min better than median = full adherence. Within ±20 = 0.5
  // (neutral). Worse than median by 20+ = 0.0.
  let score = 0.5;
  if (delta >= 20)  score = 1.0;
  if (delta <= -20) score = 0.0;
  return {
    score,
    evidence: {
      total_sleep_min:   totMin,
      median_7d:         median,
      delta_vs_median:   Math.round(delta),
    },
  };
}

// Habit focus: was the named habit completed on day T? Signature format
// is "habit_focus:<habit_name_or_id>".
function ruleHabitFocus(row, downstream) {
  const focus = signatureSuffix(row.recommendation_signature);
  if (!focus) return { score: null, evidence: { reason: 'no_habit_name' } };
  const completions = downstream.habit_completions_today || [];
  const catalog     = downstream.habits_catalog || [];
  const byId = {};
  for (const h of catalog) byId[h.id] = h;
  // Match against habit id OR name (case-insensitive). Lets the brief
  // function emit either depending on what's most natural in context.
  const focusLc = focus.toLowerCase();
  const done = completions.some(c => {
    const h = byId[c.habit_id];
    if (!h) return false;
    return c.habit_id === focus || String(h.name || '').toLowerCase() === focusLc;
  });
  return {
    score: done ? 1.0 : 0.0,
    evidence: {
      habit_focus:   focus,
      completed:     done,
      completions_today_count: completions.length,
    },
  };
}

// Hydrate / weather framing: no behavioral signal. Outcome still
// measured; adherence stays null so these don't pollute followed-vs-
// ignored comparisons.
function ruleNoSignal(row) {
  return {
    score: null,
    evidence: {
      reason: 'no_behavioral_signal_for_this_signature',
      signature: row.recommendation_signature,
    },
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────

function signaturePrefix(signature) {
  const colon = String(signature || '').indexOf(':');
  return colon === -1 ? String(signature || '') : signature.slice(0, colon);
}

function signatureSuffix(signature) {
  const colon = String(signature || '').indexOf(':');
  return colon === -1 ? '' : signature.slice(colon + 1);
}

// Map: signature prefix → rule function. Unknown prefixes return null
// adherence so we still capture outcomes without spuriously claiming the
// user "ignored" advice we don't know how to verify.
const RULES = {
  bedtime_target:   ruleBedtimeTarget,
  intensity_reduce: ruleIntensityReduce,
  push_workout:     rulePushWorkout,
  protect_sleep:    ruleProtectSleep,
  habit_focus:      ruleHabitFocus,
  hydrate:          ruleNoSignal,
  weather:          ruleNoSignal,
};

function computeAdherence(row, downstream) {
  const prefix = signaturePrefix(row.recommendation_signature);
  const rule   = RULES[prefix];
  if (!rule) return ruleNoSignal(row);
  try {
    return rule(row, downstream);
  } catch (err) {
    return {
      score: null,
      evidence: { reason: 'rule_threw', error: String(err && err.message || err) },
    };
  }
}

module.exports = {
  computeAdherence,
  signaturePrefix,
  signatureSuffix,
  // Exported for unit-testing in isolation:
  inferBedtimeMinutes,
  scoreBedtimeAdherence,
  parseClockTime,
};
