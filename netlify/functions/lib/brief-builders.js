// Deterministic builders for the daily brief.
//
// Everything factual lives here, not in Claude. Claude contributes ONLY
// headline, subhead, evidence_pills, and an optional hero_metric_key
// override. Numbers, names, counts, task titles, event titles, bedtime,
// stat-row deltas — all computed here from raw data via pure functions
// (Phase 1.7 fix-pass; bedtime moved to fully formulaic post-launch).
//
// Extracted from beta-daily-brief.js so the handler stays focused on
// the orchestration flow (fetch context, call Claude, normalize, store).

const { localDayStartUtcMs } = require('./brief-utils');

// ── Constants ───────────────────────────────────────────────────────────────
const HERO_METRIC_KEYS = ['sleep_score', 'readiness_score', 'activity_score'];
const HERO_METRIC_LABELS = {
  sleep_score:     'SLEEP',
  readiness_score: 'READINESS',
  activity_score:  'ACTIVITY',
};
// Metrics where a LOWER value is better. The stat-row builder uses this set
// to label the delta direction so the client renders RHR ↓4 (good) green and
// RHR ↑4 (bad) red — the inverse of the default mapping.
const LOWER_IS_BETTER_METRICS = new Set(['Resting HR', 'Stress', 'Sleep latency']);
const DEFAULT_TIMEZONE = 'America/New_York';

// ── Small formatters ───────────────────────────────────────────────────────
function weekdayInTz(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(dt);
}

// Count completed tasks whose completed_at epoch ms falls within the given
// user-local day. Reuses the localDayStartUtcMs helper.
function countTasksInLocalDay(tasksAll, dateStr, tz) {
  if (!Array.isArray(tasksAll) || !tasksAll.length) return 0;
  const start = localDayStartUtcMs(dateStr, tz);
  const end   = start + 86400_000;
  return tasksAll.filter(t => t.completed_at && t.completed_at >= start && t.completed_at < end).length;
}

// Tally open tasks into priority/due_today/overdue buckets relative to a
// date string (YYYY-MM-DD). Uses the user-local date the caller supplies so
// "due today" is honest regardless of UTC vs local boundaries.
function computeTaskCounts(openTasks, refDate) {
  const arr = Array.isArray(openTasks) ? openTasks : [];
  let priority = 0, due_today = 0, overdue = 0;
  for (const t of arr) {
    const isOver = !!(t.due && t.due < refDate);
    const isToday = !!(t.due && t.due === refDate);
    if (isOver) overdue++;
    else if (isToday) due_today++;
    if (t.top3) priority++;
  }
  return { priority, due_today, overdue, total_open: arr.length };
}

function formatMinutes(m) {
  if (m == null) return null;
  const n = Math.round(Number(m));
  if (!Number.isFinite(n) || n < 0) return null;
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

function formatEventTime(iso, allDay, tz) {
  if (allDay) return 'All day';
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d).replace(/\s*AM/, 'a').replace(/\s*PM/, 'p');
}

function inferEventIcon(summary) {
  const s = String(summary || '').toLowerCase();
  if (/(walk|run|gym|workout|lift|yoga|hike|bike|swim|exercise|cardio|stretch)/i.test(s)) return 'walk';
  if (/(lunch|dinner|breakfast|coffee|meal|brunch|drinks?)/i.test(s)) return 'meal';
  if (/(meeting|sync|call|review|standup|interview|client|1\:1|check[\s-]?in|catchup|catch-up)/i.test(s)) return 'work';
  return 'other';
}

// Examples:
//   morning: "☀️ 53°/51° · Pelham"
//   evening: "☀️ Tmrw 53°/51° · Pelham"
// Showing both high and low removes the "is that the high or low?" ambiguity
// users hit when only one number is shown. The condition emoji is prefixed
// to make the chip scannable at a glance.
function buildWeatherChip(weather, mode) {
  if (!weather || weather.temp_high_f == null) return null;
  const high  = `${Math.round(weather.temp_high_f)}°`;
  const low   = weather.temp_low_f != null ? `${Math.round(weather.temp_low_f)}°` : null;
  const temps = low ? `${high}/${low}` : high;
  // City callout removed 2026-05-29 — the chip is now a tappable affordance
  // that opens a detail modal (which shows location), so it stays compact
  // (temps only). Evening shows tomorrow's range.
  const tempsBlock = mode === 'evening' ? `Tmrw ${temps}` : temps;
  const emoji = weather.weather_emoji;
  return emoji ? `${emoji} ${tempsBlock}` : tempsBlock;
}

// Oura scores (sleep/readiness/activity) are 1-100 in practice. A literal 0
// means Oura hasn't finalized the day yet — common in the early-morning sync
// window. Treat 0 as "not yet finalized" so we render "—" instead of misleading "0".
function sanitizeScores(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['sleep_score', 'readiness_score', 'activity_score']) {
    if (out[k] === 0) out[k] = null;
  }
  return out;
}

// ── Hero + stats ───────────────────────────────────────────────────────────
function buildHeroMetric(claudeKey, ctx) {
  const allowed = HERO_METRIC_KEYS.includes(claudeKey) ? claudeKey : (ctx.hero_hint || 'readiness_score');
  const r  = sanitizeScores(ctx.yesterday?.recovery || {});
  const a  = sanitizeScores(ctx.yesterday?.activity || {});
  const b7 = ctx.baselines_7d || {};
  let value = null, baseline = null;
  if (allowed === 'sleep_score')     { value = r.sleep_score;     baseline = b7.sleep_score_median; }
  if (allowed === 'readiness_score') { value = r.readiness_score; baseline = b7.readiness_score_median; }
  if (allowed === 'activity_score')  { value = a.activity_score;  baseline = b7.activity_score_median; }
  const delta = (value != null && baseline != null) ? Math.round(Number(value) - Number(baseline)) : 0;
  return {
    key: allowed,
    value: value == null ? null : Math.round(Number(value)),     // null lets UI render "—"
    label: HERO_METRIC_LABELS[allowed] || allowed.toUpperCase(),
    delta_vs_7d: delta,
  };
}

// Build the rotating hero set: all three Oura scores (readiness, sleep,
// activity) for the state circle to cycle through. Each item mirrors the
// buildHeroMetric shape so the client renders + animates them identically.
// Metrics with no data are dropped.
function buildRotation(ctx) {
  const r  = sanitizeScores(ctx.yesterday?.recovery || {});
  const a  = sanitizeScores(ctx.yesterday?.activity || {});
  const b7 = ctx.baselines_7d || {};
  const src = [
    { key: 'readiness_score', value: r.readiness_score, baseline: b7.readiness_score_median },
    { key: 'sleep_score',     value: r.sleep_score,     baseline: b7.sleep_score_median },
    { key: 'activity_score',  value: a.activity_score,  baseline: b7.activity_score_median },
  ];
  return src.filter(m => m.value != null).map(m => ({
    key: m.key,
    value: Math.round(Number(m.value)),
    label: HERO_METRIC_LABELS[m.key],
    delta_vs_7d: (m.baseline != null) ? Math.round(Number(m.value) - Number(m.baseline)) : 0,
  }));
}

// ── Sleep Debt (formulaic, research-grounded) ──────────────────────────────
// A deterministic sleep-debt estimate, since Oura's own Sleep Debt is app-only
// and not exposed by the API. Design (see docs/sleep-debt.md):
//   • Personal sleep NEED from the 85th percentile of the user's own nights
//     over ~90 days — optimal sleep duration is revealed by rebound/extended
//     sleep, not the (debt-suppressed) mean (Kitamura 2016, Sci Reports).
//     Clamped to the physiological adult range 6.5h–9.5h.
//   • Recency-weighted cumulative deficit over the last 14 nights with an
//     exponential 4-day half-life — sleep pressure (Process S) dissipates
//     exponentially (Borbély two-process model); recent loss dominates.
//   • Catch-up sleep REPAYS debt (signed nightly deficit), but capped at
//     90 min/night because recovery is slow & partial (~1h debt ≈ 4 days).
//   • Gated entirely in CODE (no AI): needs ≥21 baseline nights, ≥5 of the last
//     14 nights, and ≥30 effective minutes — else returns null (hidden).
// Returns { minutes, need, tier } or null. Pure + deterministic.
const SLEEP_DEBT = {
  BASELINE_NIGHTS:   90,   // window for estimating personal need
  MIN_BASELINE:      21,   // need this many valid nights before we estimate need
  NEED_PCTL:         85,   // upper percentile ≈ optimal sleep duration
  NEED_MIN:          390,  // clamp floor (6.5h)
  NEED_MAX:          570,  // clamp ceil (9.5h)
  WINDOW_NIGHTS:     14,   // acute debt window (sleep-science standard)
  HALF_LIFE_DAYS:    4,    // Process-S decay; recency weight
  SURPLUS_CAP:       90,   // one long night repays at most 90 min of debt
  MIN_WINDOW_NIGHTS: 5,    // need ≥5 valid nights within the 14-night window
  SHOW_THRESHOLD:    30,   // hide under 30 effective minutes ("None")
  MIN_CALIBRATION_PAIRS: 7, // logged Oura actuals needed before calibrating
};

// Linear-interpolated percentile of an ascending-sorted numeric array.
function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// history: [{ date:'YYYY-MM-DD', total_sleep_min:Number }] (any order).
// todayStr: the brief's local "today" (the date last night's sleep is filed under).
// calibration: optional multiplier (from sleepDebtCalibration) nudging the
//   estimate toward the user's logged Oura actuals; defaults to 1 (no change).
function computeSleepDebt(history, todayStr, calibration) {
  if (!Array.isArray(history) || !todayStr) return null;
  // Dedupe by date; keep only valid (positive) sleep nights.
  const byDate = new Map();
  for (const h of history) {
    const v = Number(h && h.total_sleep_min);
    if (h && h.date && Number.isFinite(v) && v > 0) byDate.set(h.date, v);
  }
  if (byDate.size < SLEEP_DEBT.MIN_BASELINE) return null; // cold-start gate

  // Personal sleep need = P85 of the last ~90 valid nights, clamped.
  const datesAsc = [...byDate.keys()].sort();
  const baseVals = datesAsc.slice(-SLEEP_DEBT.BASELINE_NIGHTS)
    .map(d => byDate.get(d)).sort((a, b) => a - b);
  let need = _percentile(baseVals, SLEEP_DEBT.NEED_PCTL);
  if (need == null) return null;
  need = Math.max(SLEEP_DEBT.NEED_MIN, Math.min(SLEEP_DEBT.NEED_MAX, need));

  // Recency-weighted cumulative deficit over the last WINDOW_NIGHTS nights.
  const todayMs = Date.parse(todayStr + 'T00:00:00Z');
  if (!Number.isFinite(todayMs)) return null;
  let sum = 0, windowNights = 0;
  for (const [d, sleep] of byDate) {
    const ms = Date.parse(d + 'T00:00:00Z');
    if (!Number.isFinite(ms)) continue;
    const age = Math.round((todayMs - ms) / 86400000); // nights ago (0 = last night)
    if (age < 0 || age >= SLEEP_DEBT.WINDOW_NIGHTS) continue;
    windowNights++;
    const w = Math.pow(0.5, age / SLEEP_DEBT.HALF_LIFE_DAYS);
    const delta = Math.max(need - sleep, -SLEEP_DEBT.SURPLUS_CAP); // surplus repays, capped
    sum += w * delta;
  }
  if (windowNights < SLEEP_DEBT.MIN_WINDOW_NIGHTS) return null; // not enough recent signal

  const rawMin = Math.max(0, Math.round(sum));
  const k = (Number.isFinite(calibration) && calibration > 0) ? calibration : 1;
  const minutes = Math.max(0, Math.round(rawMin * k));          // calibrated toward Oura
  if (minutes < SLEEP_DEBT.SHOW_THRESHOLD) return null;         // below the floor → hide
  const tier = minutes >= 180 ? 'high' : minutes >= 90 ? 'moderate' : 'mild';
  return { minutes, raw_min: rawMin, need: Math.round(need), tier, calibrated: k !== 1 };
}

// Deterministic calibration: nudge the raw estimate toward the user's logged
// Oura actuals. Factor = median(actual / raw-estimate) over paired observations
// (estimate ≥ 30 min to avoid divide-by-noise), clamped to [0.5, 2.0]. Until
// MIN_CALIBRATION_PAIRS pairs exist it returns 1 (no correction). Median (not
// mean) so a single odd night can't swing it. Pure + deterministic.
function sleepDebtCalibration(pairs) {
  if (!Array.isArray(pairs)) return 1;
  const ratios = pairs
    .filter(p => p && Number(p.estimate_min) >= 30 && Number.isFinite(Number(p.actual_min)))
    .map(p => Number(p.actual_min) / Number(p.estimate_min))
    .sort((a, b) => a - b);
  if (ratios.length < SLEEP_DEBT.MIN_CALIBRATION_PAIRS) return 1;
  const n = ratios.length;
  const med = n % 2 ? ratios[(n - 1) / 2] : (ratios[n / 2 - 1] + ratios[n / 2]) / 2;
  return Math.max(0.5, Math.min(2.0, med));
}

// Build the stats list shown beside the rotating circle. The three Oura SCORES
// (sleep / readiness / activity) now live in the rotating circle, so they're
// NOT repeated here: only Sleep DURATION (with its difference vs baseline),
// Resting HR, and HRV remain. Steps move to the recap "Yesterday" column.
function buildStats(ctx) {
  const r  = sanitizeScores(ctx.yesterday?.recovery || {});
  const a  = sanitizeScores(ctx.yesterday?.activity || {});
  const b7 = ctx.baselines_7d || {};
  const fmtDelta = (today, base) => {
    if (today == null || base == null) return { text: null, signed: 0 };
    const d = Math.round(Number(today) - Number(base));
    if (d === 0) return { text: null, signed: 0 };
    return {
      text:   d > 0 ? `↑${d}` : `↓${Math.abs(d)}`,
      signed: d,
    };
  };
  const tagDir = (label, signed) => {
    if (!signed) return null;
    const lowerBetter = LOWER_IS_BETTER_METRICS.has(label);
    if (lowerBetter) return signed < 0 ? 'good' : 'bad';
    return signed > 0 ? 'good' : 'bad';
  };
  const rows = [];

  // Sleep DURATION row (the sleep SCORE now rotates in the circle, so it's
  // not repeated here). The difference vs the 7-day baseline is formatted in
  // h/m — "↑22m", "↓1h22m" — instead of a bare minute count.
  const fmtMinDelta = (today, base) => {
    if (today == null || base == null) return { text: null, signed: 0 };
    const d = Math.round(Number(today) - Number(base));
    if (d === 0) return { text: null, signed: 0 };
    const mins = Math.abs(d), h = Math.floor(mins / 60), m = mins % 60;
    return { text: (d > 0 ? '↑' : '↓') + (h > 0 ? `${h}h${m}m` : `${m}m`), signed: d };
  };
  if (r.total_sleep_min != null) {
    const dd = fmtMinDelta(r.total_sleep_min, b7.total_sleep_min_median);
    rows.push({
      label:     'Sleep',
      value:     formatMinutes(r.total_sleep_min) || '—',
      delta:     dd.text,
      delta_dir: tagDir('Sleep', dd.signed),
      note:      null,
    });
  }

  // Activity + Readiness score rows removed — both scores now live in the
  // rotating circle, and steps moved to the recap "Yesterday" column.

  // Sleep Debt: formulaic (computeSleepDebt) — only renders when there's enough
  // history AND ≥30 effective minutes of debt. h/m value like the Sleep row; no
  // delta (it's already a cumulative figure). Sits directly below Sleep.
  const sdCal = sleepDebtCalibration(ctx.sleep_debt_pairs);
  const sd = computeSleepDebt(ctx.sleep_history, ctx.today, sdCal);
  if (sd) {
    rows.push({
      label:     'Sleep Debt',
      value:     formatMinutes(sd.minutes) || '—',
      delta:     null,
      delta_dir: null,
      note:      sd.tier === 'mild' ? null : sd.tier, // surface moderate/high
      // Fields the brief client uses for the tap-to-log + calibration loop
      // (ignored by the generic stat renderer except on this Sleep Debt row).
      loggable:  true,
      debt_min:  sd.raw_min,   // RAW (pre-calibration) estimate — what we store to learn from
      need_min:  sd.need,
      calibrated: sd.calibrated,
    });
  }

  // Resting HR: lower is better — negative delta renders green, positive red.
  if (r.resting_hr != null) {
    const diff = b7.resting_hr_median != null ? Math.round(r.resting_hr - Number(b7.resting_hr_median)) : null;
    let note = null;
    if (diff != null && diff > 5) note = 'elevated';
    else if (diff != null && diff < -5) note = 'low';
    const dd = fmtDelta(r.resting_hr, b7.resting_hr_median);
    rows.push({
      label:     'Resting HR',
      value:     String(Math.round(r.resting_hr)),
      delta:     dd.text,
      delta_dir: tagDir('Resting HR', dd.signed),
      note,
    });
  }

  // HRV: number as value (no "ms" per voice rules), banding note vs baseline
  if (r.hrv_ms != null) {
    let note = null;
    if (b7.hrv_ms_median != null) {
      const pct = Number(r.hrv_ms) / Number(b7.hrv_ms_median);
      if (pct < 0.7) note = 'well below norm';
      else if (pct < 0.9) note = 'below norm';
      else if (pct > 1.2) note = 'above norm';
    }
    const dd = fmtDelta(r.hrv_ms, b7.hrv_ms_median);
    rows.push({
      label:     'HRV',
      value:     String(Math.round(r.hrv_ms)),
      delta:     dd.text,
      delta_dir: tagDir('HRV', dd.signed),
      note,
    });
  }

  return rows.slice(0, 5); // Sleep, Sleep Debt (conditional), Resting HR, HRV
}

// Compute the time the user got into bed from Oura's sleep midpoint and total
// sleep duration. Returns "10:45 PM" / "11:20 PM" / null. Oura's
// sleep_midpoint_offset_min is signed minutes from midnight of the date col
// (the day the sleep ENDED): negative = before midnight, positive = after.
// Bed-time offset = midpoint − duration/2. Normalize to 0-1439 then format.
function computeBedtime(recovery) {
  if (!recovery) return null;
  const mid = recovery.sleep_midpoint_offset_min;
  const dur = recovery.total_sleep_min;
  if (mid == null || dur == null) return null;
  let minOfDay = Math.round(Number(mid) - Number(dur) / 2);
  while (minOfDay < 0)     minOfDay += 1440;
  while (minOfDay >= 1440) minOfDay -= 1440;
  const h   = Math.floor(minOfDay / 60);
  const m   = minOfDay % 60;
  const pm  = h >= 12;
  const h12 = ((h + 11) % 12) + 1;        // 0→12, 13→1, …
  return `${h12}:${String(m).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
}

// ── Recap (Yesterday/Today or Today/Tomorrow pair) ─────────────────────────
function buildRecap(mode, ctx, sleepTargetTime) {
  const habitsPct = (h) => {
    if (!h || !h.due) return null;
    const done = Number(h.done) || 0;
    const due  = Number(h.due);
    return { pct: Math.round((done / due) * 100), done, due };
  };

  // Compact Train summary for a recap column. Label is derived
  // deterministically from day_type — we DO NOT echo session.day_name
  // because plan templates can contain composite names like
  // "Cardio / Rest" that, when surfaced as the brief's column, read as
  // garbage. Prior bandaid fixes special-cased specific names; the
  // root cause is that the recap column needs a canonical type label,
  // not a user-entered plan-day name. The full plan name still lives
  // on the Train tab and in the brief's train_recent comparison block.
  const typeLabel = (type) => {
    switch (type) {
      case 'cardio': return 'Cardio';
      case 'bonus':  return 'Bonus';
      case 'rest':   return 'Rest day';
      default:       return 'Lift';
    }
  };

  const trainSummary = (session) => {
    if (!session) return null;
    const t = session.day_type;
    const label = typeLabel(t);
    if (t === 'cardio' || t === 'bonus') {
      const ex = (session.exercises && session.exercises[0]) || null;
      const mins = ex?.top_reps || 0;          // cardio parks minutes in reps
      return { label, detail: mins ? `${mins} min` : null };
    }
    return { label, detail: null };
  };

  // Planned (not-yet-logged) Train row. Same deterministic-type rule
  // as trainSummary — no echoing of planned.name.
  const plannedSummary = (planned) => {
    if (!planned) return null;
    return { label: typeLabel(planned.type), detail: null };
  };

  // Morning: left = yesterday, right = today.
  // Evening: left = today (recap), right = tomorrow.
  if (mode === 'morning') {
    // Yesterday's canonical 5 stats: habits, steps, tasks (hidden when 0 on the
    // client), sleep DURATION, mood. (No bedtime / train here.)
    const left = {
      label:          'Yesterday',
      habits:         habitsPct(ctx.yesterday?.habits),
      tasks_done:     ctx.yesterday?.tasks_completed_count ?? null,
      steps:          sanitizeScores(ctx.yesterday?.activity || {}).steps ?? null,
      sleep_duration: formatMinutes(ctx.yesterday?.recovery?.total_sleep_min),
      mood_label:     ctx.yesterday?.mood?.value_label ?? null,
    };
    const right = {
      label:        'Today',
      events:       (ctx.today_plan?.calendar_events || []).length,
      task_counts:  ctx.today_plan?.task_counts || null,
      habits_today: null,        // client recomputes from live habitsArr (Tier 1)
      sleep_target: sleepTargetTime,
      train:        trainSummary(ctx.today_plan?.workout?.logged_today)
                 || plannedSummary(ctx.today_plan?.workout?.planned),
    };
    return { left, right };
  }
  // Evening
  const left = {
    label:       'Today',
    habits:      habitsPct(ctx.yesterday?.habits),    // habits don't finalize until midnight
    tasks_done:  ctx.today_recap?.tasks_completed_today ?? null,
    // No steps in the evening recap: only yesterday's activity is in context,
    // so showing it under "Today" would be misleading. (The morning Yesterday
    // column still shows steps, which genuinely IS yesterday.)
    steps:       null,
    bedtime:     null,           // yesterday's bedtime is stale by evening
    mood_label:  ctx.today_recap?.mood_label ?? null,
    train:       trainSummary(ctx.today_recap?.train_session_today),
    // Sleep target lives under TODAY (tonight's bedtime, not tomorrow's).
    sleep_target: sleepTargetTime,
  };
  const right = {
    label:        'Tomorrow',
    events:       (ctx.tomorrow_plan?.calendar_events || []).length,
    task_counts:  ctx.tomorrow_plan?.task_counts || null,
    habits_today: null,
    train:        plannedSummary(ctx.tomorrow_plan?.workout),
  };
  return { left, right };
}

// ── Play rows ──────────────────────────────────────────────────────────────
// Build the play list deterministically from facts. Morning shows today's plan
// (events + persistent priority tasks + yesterday's habit-snapshot + sleep
// target). Evening shows TOMORROW's plan + a one-line today-recap.
function buildPlayRows(mode, ctx, sleepTargetTime) {
  const rows = [];
  const tz   = ctx.user?.timezone || DEFAULT_TIMEZONE;

  if (mode === 'morning') {
    // Today's calendar events (first 2)
    const events = (ctx.today_plan?.calendar_events || []).slice(0, 2);
    for (const e of events) {
      const title = String(e.summary || '').trim();
      if (!title) continue;
      rows.push({
        icon:    inferEventIcon(title),
        scope:   formatEventTime(e.start, e.allDay, tz) || 'Today',
        content: title,
      });
    }
    // Tasks: count summary rather than titles — the brief and the Tasks
    // card stopped duplicating each other when this changed.
    const tcRow = buildTaskCountsRow(ctx.today_plan?.task_counts);
    if (tcRow) rows.push(tcRow);
    // Yesterday's habit snapshot
    const habits = ctx.yesterday?.habits;
    if (habits && habits.due > 0) {
      const done = habits.done ?? 0;
      const due  = habits.due;
      rows.push({
        icon:    'habits',
        scope:   `Y'day ${done}/${due}`,
        content: done >= due ? 'All habits closed yesterday' : 'Set up today\'s habits',
      });
    }
    // Sleep target
    rows.push({
      icon:    'sleep',
      scope:   'Sleep',
      content: sleepTargetTime ? `In bed by ${sleepTargetTime}` : 'Protect tonight\'s sleep',
    });
  } else {
    // EVENING: one-line today recap, then tonight + tomorrow forward.
    // Recap exists so the evening brief feels like a hand-off, not a doom-loop.
    const recap = ctx.today_recap;
    if (recap) {
      const parts = [];
      if (recap.mood_label) parts.push(`Mood: ${recap.mood_label}`);
      if (recap.workouts_today?.length) {
        const w = recap.workouts_today[0];
        const verb = (w.activity || 'workout').toLowerCase();
        parts.push(`${verb} done`);
      }
      if (recap.tasks_completed_today > 0) {
        parts.push(`${recap.tasks_completed_today} task${recap.tasks_completed_today === 1 ? '' : 's'} done`);
      }
      if (recap.open_priority_tasks > 0) {
        parts.push(`${recap.open_priority_tasks} priority left`);
      }
      if (parts.length > 0) {
        rows.push({
          icon:    'other',
          scope:   'Today',
          content: parts.join(' · '),
        });
      }
    }
    // Tonight's sleep (most immediate action)
    rows.push({
      icon:    'sleep',
      scope:   'Tonight',
      content: sleepTargetTime ? `In bed by ${sleepTargetTime}` : 'Wind down for the night',
    });
    // Tomorrow's calendar events (first 2)
    const tEvents = (ctx.tomorrow_plan?.calendar_events || []).slice(0, 2);
    for (const e of tEvents) {
      const title = String(e.summary || '').trim();
      if (!title) continue;
      rows.push({
        icon:    inferEventIcon(title),
        scope:   formatEventTime(e.start, e.allDay, tz) || 'Tomorrow',
        content: title,
      });
    }
    // Tasks: count summary reckoned against tomorrow's date frame
    const tcRow2 = buildTaskCountsRow(ctx.tomorrow_plan?.task_counts);
    if (tcRow2) rows.push(tcRow2);
  }

  return rows.slice(0, 5);
}

// Tasks play-row from a task_counts block. Returns null when nothing worth
// surfacing. Format: "3 priority · 2 due today · 1 overdue" (zero buckets omitted).
function buildTaskCountsRow(counts) {
  if (!counts || !counts.total_open) return null;
  const parts = [];
  if (counts.priority   > 0) parts.push(`${counts.priority} priority`);
  if (counts.due_today  > 0) parts.push(`${counts.due_today} due today`);
  if (counts.overdue    > 0) parts.push(`${counts.overdue} overdue`);
  if (parts.length === 0)    parts.push(`${counts.total_open} open`);
  return {
    icon:    'tasks',
    scope:   `${counts.total_open} open`,
    content: parts.join(' · '),
  };
}

module.exports = {
  HERO_METRIC_KEYS,
  HERO_METRIC_LABELS,
  weekdayInTz,
  countTasksInLocalDay,
  computeTaskCounts,
  formatMinutes,
  formatEventTime,
  inferEventIcon,
  buildWeatherChip,
  sanitizeScores,
  buildHeroMetric,
  buildRotation,
  buildStats,
  computeSleepDebt,
  sleepDebtCalibration,
  computeBedtime,
  buildRecap,
  buildPlayRows,
  buildTaskCountsRow,
};
