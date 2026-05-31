// Brief reformulation — the "verified claim set" approach.
//
// Instead of handing Claude a raw context dump ("reason from this, don't echo"),
// the server pre-computes a small, ordered list of TRUE, day-stamped, plain-
// language claims — the only facts the model may reference. The model composes
// the headline/subhead/insight by SELECTING and PHRASING from this set; it must
// not assert anything outside it. Every assertable fact is already correct and
// dated, which structurally eliminates the misattribution bugs (wrong day, wrong
// activity, "skipped", "lifted today") that prompt guards kept chasing.
//
// Numbers MAY appear in claim text (server-authored → always correct), so the
// model may use a number when it traces to a claim it used. validateAgainstClaims
// enforces that post-hoc.

// ── small label helpers ─────────────────────────────────────────────────────
const METRIC_LABEL = {
  hrv_ms: 'HRV', sleep_score: 'sleep', readiness_score: 'readiness',
  resting_hr: 'resting heart rate', activity_score: 'activity',
  total_sleep_min: 'sleep',
};
function labelMetric(m) { return METRIC_LABEL[m] || String(m || 'a metric'); }

function sessionPhrase(s) {
  const t = s?.day_type;
  const name = String(s?.day_name || '').toLowerCase();
  if (t === 'lift')   return 'a lift';
  if (t === 'cardio') return 'a cardio session';
  if (t === 'bonus')  return name.includes('walk') ? 'a walk' : 'a bonus session';
  if (t === 'rest')   return 'a rest day';
  return 'a workout';
}
function describeSessions(sessions) {
  const parts = (sessions || []).map(sessionPhrase);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
function planLabel(planned) {
  switch (planned?.type) {
    case 'lift':   return 'a lift day';
    case 'cardio': return 'cardio';
    case 'rest':   return 'a rest day';
    case 'bonus':  return 'a bonus session';
    default:       return 'a training day';
  }
}
function humanizeSignature(sig) {
  if (!sig) return 'that suggestion';
  if (sig.startsWith('bedtime_target')) return 'an earlier bedtime';
  return sig.split(':')[0].replace(/_/g, ' ');
}
const R = (v) => (v == null ? null : Math.round(Number(v)));
function durHM(min) { if (min == null) return null; const m = Math.round(Number(min)); return `${Math.floor(m / 60)}h ${m % 60}m`; }

// ── buildClaimSet(mode, ctx) → [{ id, day, kind, text, weight }] ─────────────
// Higher weight = more important to lead with. Sorted weight-desc. Every entry
// is null-guarded, so missing data simply omits a claim (the brief degrades to
// fewer claims, never to a wrong one).
function buildClaimSet(mode, ctx) {
  const claims = [];
  let seq = 0;
  const add = (day, kind, text, weight = 5) => { if (text) claims.push({ id: 'c' + (++seq), day, kind, text, weight }); };

  const rec = ctx.yesterday?.recovery || null;   // last night's sleep (ended this morning)
  const act = ctx.yesterday?.activity || null;    // yesterday's day
  const b7  = ctx.baselines_7d || {};

  // Anomalies lead.
  for (const a of (ctx.pending_anomalies || []).slice(0, 2)) {
    const dir = a.direction || (Number(a.z_score) < 0 ? 'below' : 'above');
    add('today', 'anomaly', `Your ${labelMetric(a.metric)} is well ${dir} your usual range.`, 10);
  }

  // Sleep + recovery (last night).
  if (rec) {
    const dur = durHM(rec.total_sleep_min), ss = R(rec.sleep_score), rs = R(rec.readiness_score);
    if (dur || ss != null) add('last_night', 'sleep', `You slept ${dur || '—'} last night${ss != null ? `, sleep score ${ss}` : ''}.`, 8);
    if (rs != null) add('last_night', 'recovery', `Readiness is ${rs} this morning.`, 8);
    if (rec.hrv_ms != null && b7.hrv_ms_median != null && Number(rec.hrv_ms) < 0.85 * Number(b7.hrv_ms_median)) {
      add('last_night', 'recovery', `Your HRV is running low this morning, under your usual.`, 9);
    }
    if (rec.resting_hr != null && b7.resting_hr_median != null && Number(rec.resting_hr) > Number(b7.resting_hr_median) + 4) {
      add('last_night', 'recovery', `Your resting heart rate is up a few beats from your norm.`, 7);
    }
  } else {
    add('today', 'data', `Last night's recovery data hasn't synced yet.`, 6);
  }

  // Activity (yesterday).
  if (act && act.steps != null) {
    add('yesterday', 'activity', `Yesterday you logged about ${R(act.steps).toLocaleString()} steps.`, 4);
  }

  // Training — mode-aware day mapping. THIS is the structural attribution fix:
  // today's training comes only from today's session list; yesterday's only
  // appears as 'yesterday'. The model can never pull a today-claim that the
  // data doesn't contain.
  const todaySessions = mode === 'evening'
    ? (ctx.today_recap?.train_sessions_today || [])
    : (ctx.today_plan?.workout?.logged_today_all || []);
  if (todaySessions.length) {
    add('today', 'training', `Today you did ${describeSessions(todaySessions)}.`, 7);
  } else if (mode === 'evening') {
    // No session logged today. Only call it "no workout logged" when one was
    // actually SCHEDULED — a planned rest day (or no plan at all) must NOT read
    // as a skipped workout.
    const plannedType = ctx.today_plan?.workout?.planned?.type;
    if (plannedType === 'rest') {
      add('today', 'training', `Today was a scheduled rest day.`, 4);
    } else if (ctx.today_plan?.workout?.planned) {
      add('today', 'training', `No workout logged today.`, 5);
    }
    // else: no active plan / nothing scheduled → say nothing about training.
  }
  if (mode === 'morning') {
    const yWk = ctx.yesterday?.workout_all || (ctx.yesterday?.workout ? [ctx.yesterday.workout] : []);
    if (yWk.length) add('yesterday', 'training', `Yesterday you did ${describeSessions(yWk)}.`, 4);
    const planned = ctx.today_plan?.workout?.planned;
    if (planned && !todaySessions.length) add('today', 'plan', `Today's plan is ${planLabel(planned)}.`, 6);
  }

  // Tasks. Suppressed on weekends — the brief copy stays task-free on Sat/Sun
  // so the model has no task facts to reference (no weekend task-nagging).
  if (!ctx.is_weekend) {
    const tc = (mode === 'evening' ? ctx.tomorrow_plan : ctx.today_plan)?.task_counts;
    const taskDay = mode === 'evening' ? 'tomorrow' : 'today';
    if (tc) {
      if (tc.overdue)  add(taskDay, 'tasks', `${tc.overdue} task${tc.overdue === 1 ? '' : 's'} overdue.`, 6);
      if (tc.priority) add(taskDay, 'tasks', `${tc.priority} priority task${tc.priority === 1 ? '' : 's'} on deck.`, 5);
    }
    if (mode === 'evening' && ctx.today_recap?.tasks_completed_today != null) {
      const n = ctx.today_recap.tasks_completed_today;
      add('today', 'tasks', `You finished ${n} task${n === 1 ? '' : 's'} today.`, 4);
    }
  }

  // Habits (morning only — today's count isn't finalized at evening).
  const hb = ctx.yesterday?.habits;
  if (mode === 'morning' && hb && hb.due) {
    add('yesterday', 'habits', `Yesterday you hit ${hb.done} of ${hb.due} habits.`, 4);
  }

  // Mood.
  const mood = mode === 'evening' ? ctx.today_recap?.mood_label : ctx.yesterday?.mood?.value_label;
  if (mood) add(mode === 'evening' ? 'today' : 'yesterday', 'mood', `Mood was ${String(mood).toLowerCase()} ${mode === 'evening' ? 'today' : 'yesterday'}.`, 3);

  // Sleep intent (morning, only when the settle time is notable).
  const si = ctx.yesterday?.sleep_intent;
  if (mode === 'morning' && si && si.settle_minutes != null && Number(si.settle_minutes) >= 25) {
    add('last_night', 'sleep', `It took you around ${R(si.settle_minutes)} minutes to fall asleep last night.`, 5);
  }

  // Weather (morning).
  if (mode === 'morning' && ctx.today_plan?.weather && ctx.today_plan.weather.temp_high_f != null) {
    const w = ctx.today_plan.weather;
    add('today', 'weather', `Today: ${w.condition || 'mild'}, around ${R(w.temp_high_f)}°.`, 3);
  }

  // Tomorrow plan (evening).
  if (mode === 'evening' && ctx.tomorrow_plan?.workout) {
    add('tomorrow', 'plan', `Tomorrow's plan is ${planLabel(ctx.tomorrow_plan.workout)}.`, 4);
  }

  // Learned pattern (for the optional insight line) — patterns first, then a
  // high-confidence "helps" efficacy entry.
  const pat = (ctx.recent_patterns || [])[0];
  if (pat && (pat.description || pat.label)) {
    add('trend', 'pattern', pat.description || pat.label, 5);
  } else {
    const eff = (ctx.efficacy_profile || []).find(e => e.direction === 'helps' && e.confidence === 'high');
    if (eff) add('trend', 'pattern', `${humanizeSignature(eff.signature)} has tended to help you lately.`, 4);
  }

  claims.sort((a, b) => b.weight - a.weight);
  return claims;
}

// ── Voice + composition prompt (V2) ─────────────────────────────────────────
const BANNED_TONE = [
  'no exclamation marks', 'no hype words ("amazing", "incredible", "crush it", "let\'s go", "you\'ve got this", "dominate")',
  'no motivational-poster lines', 'no toxic positivity (never spin bad data as great)', 'no emoji',
  'no statistics jargon (percentile/median/p25/p50/IQR), no "ms"/"milliseconds"',
];
function buildSystemPromptV2(mode, claims, { coldStart } = {}) {
  const claimLines = claims.map(c => `  ${c.id} [${c.day}] ${c.text}`).join('\n');
  const modeFraming = mode === 'morning'
    ? 'MORNING: look forward. Lead with the one thing that shapes today (a recovery signal, an anomaly, or the plan), then give a clear, doable play.'
    : 'EVENING: look back, then set up tomorrow. Recap what actually happened TODAY (use only today-stamped claims), then a calm landing for tonight / a nudge for tomorrow.';
  return [
    'You are the user\'s personal helper writing their daily brief — a sharp friend who happens to know their data. Warm, plainspoken, on their side, and honest. You speak to them as "you" and may refer to yourself as "I" ("I\'d skip the hard lift").',
    '',
    'VOICE: friendly but grounded — NOT a cheerleader. ' + BANNED_TONE.join('; ') + '. State hard facts plainly but kindly; never spin a rough day as a good one. Calm and dry-warm, like a good human assistant, never a chatbot gushing.',
    '',
    'THE CLAIM SET — these are the ONLY facts you may state. Each is already true and dated. Compose by SELECTING and PHRASING from them; you may rephrase and connect them, but you MUST NOT assert anything not supported by a claim here. Match the day label exactly (a [yesterday] fact is yesterday, never today).',
    claimLines || '  (no claims — keep it minimal and honest about limited data)',
    '',
    modeFraming,
    '',
    'FIELDS (call record_daily_brief exactly once):',
    '- headline: ≤30 chars, a friendly call ("Ease into it today.", "You\'re good to go today."). No greeting prefix.',
    '- subhead: 1-2 sentences, ≤180 chars. The play + the brief "why", drawn from the claims. A sharp one-sentence brief beats a padded two-sentence one.',
    '- insight: OPTIONAL ≤140 chars. Surface the single [trend] pattern claim, hedged, ONLY if one exists and it connects to today. Otherwise null. Most days: null.',
    '- evidence_pills: 0-3 tags ≤4 words, each tracing to a claim. Skip if nothing adds beyond the subhead.',
    '- hero_metric_key: null to accept the server pick, or one of sleep_score/readiness_score/activity_score.',
    '- confidence: ' + (coldStart ? '"low" (cold start — limited baseline).' : '"high"/"medium"/"low" by how complete the data is.'),
    '- used_claim_ids: the exact claim ids (e.g. ["c1","c4"]) you drew on for headline+subhead+insight. Required.',
    '',
    'NUMBERS: you may include a number ONLY if it appears in a claim you list in used_claim_ids. Never invent or estimate a number.',
    'MEDICAL: no diagnoses or medical claims; lab/illness signals stay qualitative and hedged ("usually a sign you\'re run down").',
  ].join('\n');
}

// ── validateAgainstClaims ────────────────────────────────────────────────────
// Post-hoc guard: every used_claim_id must be real, and every number in the
// prose must appear in a used claim's text. Returns { ok, reason }.
function validateAgainstClaims(out, claims) {
  const byId = new Map(claims.map(c => [c.id, c]));
  const used = Array.isArray(out.used_claim_ids) ? out.used_claim_ids.filter(id => byId.has(id)) : [];
  const usedText = used.map(id => byId.get(id).text).join(' ');
  const prose = [out.headline, out.subhead, out.insight].filter(Boolean).join(' ');
  // Numbers in prose (ignore a leading clock-less check — times like 10:30 are
  // matched as their digit groups). Each numeric run must appear in used claims.
  const nums = prose.match(/\d+/g) || [];
  const allowed = usedText.match(/\d+/g) || [];
  for (const n of nums) {
    if (!allowed.includes(n)) return { ok: false, reason: `number ${n} not in any used claim` };
  }
  return { ok: true, used };
}

module.exports = { buildClaimSet, buildSystemPromptV2, validateAgainstClaims };
