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
  const place = (weather.location || '').split(',')[0].trim();
  const core  = place ? `${temps} · ${place}` : temps;
  const tempsBlock = mode === 'evening' ? `Tmrw ${core}` : core;
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

// Build the stats list (Sleep, Activity, Resting HR, HRV) — exclude the hero
// metric. All numbers from raw recovery/activity rows. Deltas computed against
// the 7-day baseline. Special notes for sleep score, HRV banding, RHR elevation.
function buildStats(heroKey, ctx) {
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

  if (heroKey !== 'sleep_score' && (r.total_sleep_min != null || r.sleep_score != null)) {
    const dur = formatMinutes(r.total_sleep_min);
    const dd  = fmtDelta(r.total_sleep_min, b7.total_sleep_min_median);
    rows.push({
      label:     'Sleep',
      value:     dur || (r.sleep_score != null ? String(r.sleep_score) : '—'),
      delta:     dd.text,
      delta_dir: tagDir('Sleep', dd.signed),
      note:      (dur && r.sleep_score != null) ? `score ${r.sleep_score}` : null,
    });
  }

  // Activity row: score as value, steps as note — UNLESS score and steps
  // disagree (high score on low-step day = Oura's "rest day credit"), in
  // which case show a qualifier instead so the row doesn't look broken.
  if (heroKey !== 'activity_score' && (a.activity_score != null || a.steps != null)) {
    let note = null;
    if (a.activity_score != null && a.steps != null && a.activity_score >= 80 && a.steps < 4000) {
      note = 'low-movement day';
    } else if (a.steps != null) {
      note = `${a.steps.toLocaleString()} steps · yesterday`;
    }
    const dd = fmtDelta(a.activity_score, b7.activity_score_median);
    rows.push({
      label:     'Activity',
      value:     a.activity_score != null ? String(a.activity_score) : '—',
      delta:     dd.text,
      delta_dir: tagDir('Activity', dd.signed),
      note,
    });
  }

  if (heroKey !== 'readiness_score' && r.readiness_score != null) {
    const dd = fmtDelta(r.readiness_score, b7.readiness_score_median);
    rows.push({
      label:     'Readiness',
      value:     String(r.readiness_score),
      delta:     dd.text,
      delta_dir: tagDir('Readiness', dd.signed),
      note:      null,
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

  return rows.slice(0, 4);
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

  // Compact Train summary for a recap column. Cardio/bonus get one stat;
  // lifts get name only — the full breakdown lives on History.
  const trainSummary = (session) => {
    if (!session) return null;
    const t = session.day_type;
    const name = session.day_name || (t === 'cardio' ? 'Cardio' : t === 'bonus' ? 'Bonus' : 'Lift');
    if (t === 'cardio' || t === 'bonus') {
      const ex = (session.exercises && session.exercises[0]) || null;
      const mins = ex?.top_reps || 0;          // cardio parks minutes in reps
      return { label: name, detail: mins ? `${mins} min` : null };
    }
    return { label: name, detail: null };
  };

  // Planned (not-yet-logged) Train row.
  const plannedSummary = (planned) => {
    if (!planned) return null;
    const t = planned.type;
    if (t === 'rest') return { label: 'Rest day', detail: null };
    if (t === 'cardio') return { label: planned.name || 'Cardio', detail: null };
    return { label: planned.name || 'Lift', detail: null };
  };

  // Morning: left = yesterday, right = today.
  // Evening: left = today (recap), right = tomorrow.
  if (mode === 'morning') {
    const left = {
      label:       'Yesterday',
      habits:      habitsPct(ctx.yesterday?.habits),
      tasks_done:  ctx.yesterday?.tasks_completed_count ?? null,
      bedtime:     computeBedtime(ctx.yesterday?.recovery),
      mood_label:  ctx.yesterday?.mood?.value_label ?? null,
      train:       trainSummary(ctx.yesterday?.workout),
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
  buildStats,
  computeBedtime,
  buildRecap,
  buildPlayRows,
  buildTaskCountsRow,
};
