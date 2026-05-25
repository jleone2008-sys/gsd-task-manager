// Phase 4 commit 6 — AI narrative for a just-submitted Train session.
//
// JWT-authenticated POST: { session_id }. The endpoint reads the session +
// its sets via the service key (RLS-bypass — the JWT just identifies which
// user is asking; the function then enforces user_id match server-side
// before reading anything). For comparison it also pulls the user's last
// 3 sessions with the same day_name (or day_type for bonus/cardio without
// a stable day_name) so Claude can call out PRs, regressions and trends.
//
// Returns structured JSON:
//   { status: 'ok' | 'fallback',
//     insight: "1-2 sentences",
//     observations: ["short bullet", ...],
//     model, prompt_tokens, completion_tokens }
//
// Sits on top of the deterministic stats — never replaces them. If the AI
// call fails for any reason, we return a tiny deterministic fallback so the
// client can still show *something* without blocking the submit flow.

const SUPABASE_URL  = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL      = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 600;
const RECOVERY_STALE_HOURS = 24;   // mirrors brief's OURA_STALE_HOURS

const { moodLabel, MOOD_SCALE_NOTE } = require('./lib/mood-scale');

// Map weekdayInTz output to the 3-letter codes workout_plans.day_template uses.
const DOW3 = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));

  // ── Authenticate (JWT only — no cron path here) ─────────────────────
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId   = userJson.id;
  const userEmail = userJson.email || null;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Parse body ──────────────────────────────────────────────────────
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }
  const sessionId = body.session_id;
  if (!sessionId) return cors(json(400, { error: 'session_id_required' }));

  try {
    // ── Read session (needed first — date + day_name gate later fetches) ─
    const session = await fetchSession(sessionId, userId, serviceKey);
    if (!session) return cors(json(404, { error: 'session_not_found' }));

    // ── Parallel batch of independent fetches ─────────────────────────
    // Pattern mirrors beta-daily-brief.js's buildContext Promise.all. Any
    // individual fetch returning null/[] is non-fatal — the context is
    // assembled defensively below so a missing wearable / plan / goal
    // doesn't break the AI call.
    const [
      sets,
      priorSessions,
      healthSource,
      activePrescription,
      weeklyLoadCount,
      activeGoal,
    ] = await Promise.all([
      fetchSets(sessionId, userId, serviceKey).catch(err => { console.warn('[train-feedback] sets fetch failed:', err.message); return []; }),
      fetchPriorSessions(userId, session, serviceKey).catch(err => { console.warn('[train-feedback] prior sessions fetch failed:', err.message); return []; }),
      fetchHealthSource(userId, serviceKey).catch(err => { console.warn('[train-feedback] health_source fetch failed:', err.message); return null; }),
      fetchActivePrescription(userId, session, serviceKey).catch(err => { console.warn('[train-feedback] active prescription fetch failed:', err.message); return null; }),
      fetchWeeklyLoad(userId, sessionId, session.session_date, serviceKey).catch(err => { console.warn('[train-feedback] weekly load fetch failed:', err.message); return 0; }),
      fetchActiveGoal(userId, serviceKey).catch(err => { console.warn('[train-feedback] active goal fetch failed:', err.message); return null; }),
    ]);

    // ── Dependent follow-ups (run in parallel) ───────────────────────
    const [priorSetsMap, recovery] = await Promise.all([
      fetchSetsForSessions(priorSessions.map(s => s.id), userId, serviceKey).catch(err => { console.warn('[train-feedback] prior sets fetch failed:', err.message); return {}; }),
      (healthSource && userEmail)
        ? fetchRecoveryForDate(userEmail, healthSource, session.session_date, serviceKey).catch(err => { console.warn('[train-feedback] recovery fetch failed:', err.message); return null; })
        : Promise.resolve(null),
    ]);

    // ── No API key → deterministic fallback ───────────────────────────
    if (!anthropicKey) {
      return cors(json(200, buildFallback(session, sets, priorSessions, priorSetsMap, 'no_anthropic_key')));
    }

    // ── Build context + call Claude ──────────────────────────────────
    const ctx = buildContext(session, sets, priorSessions, priorSetsMap, {
      recovery,
      prescribed:   activePrescription,
      weekly_load:  { sessions_last_7d: weeklyLoadCount || 0 },
      goal:         activeGoal,
    });
    let result;
    try {
      result = await callClaude(ctx, anthropicKey);
    } catch (err) {
      console.error('[train-feedback] claude call failed:', err.message);
      result = buildFallback(session, sets, priorSessions, priorSetsMap, `claude_error: ${err.message}`);
    }
    // Persist the AI feedback to workout_sessions.ai_feedback so the
    // History tab can read it back without re-spending tokens. Best-effort
    // — log + continue on failure, the client still gets the result.
    persistAiFeedback(sessionId, userId, result, serviceKey)
      .catch(err => console.warn('[train-feedback] persist failed:', err.message));
    return cors(json(200, result));
  } catch (err) {
    console.error('[train-feedback] handler error:', err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// ── Data layer ──────────────────────────────────────────────────────────
async function fetchSession(sessionId, userId, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/workout_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${userId}&select=id,session_date,day_name,day_type,feel,session_notes,plan_id,submitted_at`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`session_fetch_${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}

async function fetchSets(sessionId, userId, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/workout_sets?session_id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${userId}&select=exercise_name,set_index,actual_weight,actual_reps,is_bodyweight&order=set_index.asc`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`sets_fetch_${r.status}`);
  return await r.json();
}

async function fetchPriorSessions(userId, session, serviceKey) {
  // Match by day_name when present (most planned sessions have stable
  // names like "FBA"). For sessions without a stable day_name, fall back
  // to day_type. Limit 3 most recent before the current session.
  const filterName = session.day_name
    ? `day_name=eq.${encodeURIComponent(session.day_name)}`
    : `day_type=eq.${encodeURIComponent(session.day_type)}`;
  const url = `${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${userId}&${filterName}&id=neq.${encodeURIComponent(session.id)}&session_date=lte.${session.session_date}&select=id,session_date,day_name,day_type,feel&order=session_date.desc&limit=3`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`prior_sessions_fetch_${r.status}`);
  return await r.json();
}

async function fetchSetsForSessions(sessionIds, userId, serviceKey) {
  if (!sessionIds.length) return {};
  const ids = sessionIds.map(id => `"${id}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/workout_sets?session_id=in.(${ids})&user_id=eq.${userId}&select=session_id,exercise_name,set_index,actual_weight,actual_reps,is_bodyweight&order=set_index.asc`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`prior_sets_fetch_${r.status}`);
  const rows = await r.json();
  const out = {};
  for (const row of rows) {
    if (!out[row.session_id]) out[row.session_id] = [];
    out[row.session_id].push(row);
  }
  return out;
}

// ── Wider-context fetchers (recovery / prescription / weekly load / goal) ─
//
// Each fetcher is best-effort: failures are caught at the call site and
// fall through to null/[]/0 so a missing integration doesn't tank the
// whole feedback call. Pattern mirrors beta-daily-brief.js.

// Reads the user's chosen recovery source from user_settings.integrations.
// Defaults to 'oura' when no preference is set (matches client default in
// beta/src/02-settings.js getHealthSource()).
async function fetchHealthSource(userId, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}&select=integrations`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`user_settings_fetch_${r.status}`);
  const rows = await r.json();
  const src = rows?.[0]?.integrations?.health_source;
  if (src === 'whoop' || src === 'oura') return src;
  return 'oura';   // default
}

// Reads the wearable snapshot for the session date and normalizes the
// shape so the prompt sees one consistent object regardless of source.
// Stale flag follows the brief's 24h threshold.
async function fetchRecoveryForDate(userEmail, source, dateStr, serviceKey) {
  if (!userEmail || !dateStr) return null;
  const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  if (source === 'whoop') {
    const url = `${SUPABASE_URL}/rest/v1/whoop_daily?user_email=eq.${encodeURIComponent(userEmail)}&date=eq.${dateStr}&select=date,recovery_score,hrv_ms,resting_hr,strain,sleep_duration_min,updated_at`;
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) throw new Error(`whoop_daily_fetch_${r.status}`);
    const row = (await r.json())?.[0];
    if (!row) return null;
    const stale = !row.updated_at
      || (Date.now() - new Date(row.updated_at).getTime()) > RECOVERY_STALE_HOURS * 3600_000;
    return {
      source:       'whoop',
      score:        row.recovery_score ?? null,
      hrv_ms:       row.hrv_ms         ?? null,
      resting_hr:   row.resting_hr     ?? null,
      sleep_min:    row.sleep_duration_min ?? null,
      strain:       row.strain         ?? null,
      stale,
    };
  }
  // Oura (default). Note: oura_daily's "recovery" is yesterday's sleep
  // scored against today — for a session logged on the same day, this
  // row reflects how recovered the user *started* the day.
  const url = `${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(userEmail)}&date=eq.${dateStr}&select=date,readiness_score,sleep_score,hrv_ms,resting_hr,total_sleep_min,updated_at`;
  const r = await fetch(url, { headers: hdr });
  if (!r.ok) throw new Error(`oura_daily_fetch_${r.status}`);
  const row = (await r.json())?.[0];
  if (!row) return null;
  const stale = !row.updated_at
    || (Date.now() - new Date(row.updated_at).getTime()) > RECOVERY_STALE_HOURS * 3600_000;
  return {
    source:      'oura',
    score:       row.readiness_score ?? null,
    sleep_score: row.sleep_score     ?? null,
    hrv_ms:      row.hrv_ms          ?? null,
    resting_hr:  row.resting_hr      ?? null,
    sleep_min:   row.total_sleep_min ?? null,
    stale,
  };
}

// Pulls the user's active workout_plans row and finds the day_template
// entry that matches the just-submitted session. Match strategy:
//   1) Exact match on session.day_name (most planned sessions).
//   2) Fall back to DOW match using the session_date (catches sessions
//      where day_name was edited at submit time).
// Returns null for bonus / cardio / unprogrammed sessions or when no
// active plan exists.
async function fetchActivePrescription(userId, session, serviceKey) {
  if (!session) return null;
  const url = `${SUPABASE_URL}/rest/v1/workout_plans?user_id=eq.${userId}&is_active=eq.true&is_template=eq.false&select=id,name,day_template&limit=1`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`workout_plans_fetch_${r.status}`);
  const plan = (await r.json())?.[0];
  if (!plan || !Array.isArray(plan.day_template)) return null;

  let match = null;
  if (session.day_name) {
    match = plan.day_template.find(d => d.name === session.day_name) || null;
  }
  if (!match && session.session_date) {
    // Compute DOW from session_date (UTC). The day_template uses 3-letter
    // codes; weekdayInTz isn't available here so use UTC weekday — close
    // enough since sessions are stored as DATE without tz.
    const d = new Date(session.session_date + 'T12:00:00Z');
    const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
    const dow3 = DOW3[weekday];
    match = plan.day_template.find(d => d.dow === dow3) || null;
  }
  if (!match) return null;
  return {
    name:      match.name || null,
    type:      match.type || null,
    exercises: Array.isArray(match.exercises) ? match.exercises.map(ex => ({
      name:       ex.name || null,
      sets:       ex.sets ?? null,
      reps:       ex.reps ?? null,
      rest_s:     ex.rest_s ?? null,
      bodyweight: !!ex.bodyweight,
    })) : [],
  };
}

// Count of workout_sessions in the trailing 7 days, excluding the current
// session. Single integer — drives streak / "5th lift this week" framing.
async function fetchWeeklyLoad(userId, sessionId, sessionDate, serviceKey) {
  if (!sessionDate) return 0;
  const d = new Date(sessionDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  const since = d.toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${userId}&session_date=gte.${since}&session_date=lte.${sessionDate}&id=neq.${encodeURIComponent(sessionId)}&select=id`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`weekly_load_fetch_${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length : 0;
}

// Active body composition goal. Direction inferred from target vs start
// so the prompt can frame volume-up as on-plan for bulk, etc.
async function fetchActiveGoal(userId, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/body_comp_goals?user_id=eq.${userId}&is_active=eq.true&select=kind,start_value,target_value,start_date,end_date&order=created_at.desc&limit=1`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`body_comp_goals_fetch_${r.status}`);
  const row = (await r.json())?.[0];
  if (!row) return null;
  const start  = Number(row.start_value);
  const target = Number(row.target_value);
  let direction = 'maintain';
  if (Number.isFinite(start) && Number.isFinite(target)) {
    if (target > start)      direction = 'bulk';
    else if (target < start) direction = 'cut';
  }
  return {
    kind:         row.kind,
    direction,
    start_value:  row.start_value,
    target_value: row.target_value,
    end_date:     row.end_date,
  };
}

// Persist the generated feedback onto workout_sessions.ai_feedback so
// the History tab (and any future surface) can read it back without
// re-spending tokens.
async function persistAiFeedback(sessionId, userId, result, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/workout_sessions?id=eq.${encodeURIComponent(sessionId)}&user_id=eq.${userId}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify({ ai_feedback: result }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── Context build ───────────────────────────────────────────────────────
function buildContext(session, sets, priorSessions, priorSetsMap, extras) {
  extras = extras || {};
  // Per-exercise summary for this session: max weight × reps, total volume,
  // and best comparison: prior session's matching exercise.
  const exMap = {};
  for (const s of sets) {
    if (!exMap[s.exercise_name]) exMap[s.exercise_name] = [];
    exMap[s.exercise_name].push(s);
  }
  const exercises = Object.entries(exMap).map(([name, setList]) => {
    const totalSets = setList.length;
    let topWeight = 0, topReps = 0, volume = 0;
    for (const x of setList) {
      const w = Number(x.actual_weight) || 0;
      const r = Number(x.actual_reps) || 0;
      if (w > topWeight) topWeight = w;
      if (r > topReps) topReps = r;
      if (!x.is_bodyweight) volume += w * r;
    }
    return { name, sets: totalSets, top_weight: topWeight, top_reps: topReps, volume };
  });

  const priors = priorSessions.map(p => {
    const psets = priorSetsMap[p.id] || [];
    const exMapP = {};
    for (const s of psets) {
      if (!exMapP[s.exercise_name]) exMapP[s.exercise_name] = [];
      exMapP[s.exercise_name].push(s);
    }
    const summary = Object.entries(exMapP).map(([name, setList]) => {
      let topWeight = 0, topReps = 0, volume = 0;
      for (const x of setList) {
        const w = Number(x.actual_weight) || 0;
        const r = Number(x.actual_reps) || 0;
        if (w > topWeight) topWeight = w;
        if (r > topReps) topReps = r;
        if (!x.is_bodyweight) volume += w * r;
      }
      return { name, sets: setList.length, top_weight: topWeight, top_reps: topReps, volume };
    });
    return {
      session_date: p.session_date,
      feel:         p.feel,
      feel_label:   moodLabel(p.feel),   // explicit label so Claude doesn't have to interpret the int
      exercises:    summary,
    };
  });

  return {
    today: {
      session_date:  session.session_date,
      day_name:      session.day_name,
      day_type:      session.day_type,
      feel:          session.feel,
      feel_label:    moodLabel(session.feel),
      session_notes: session.session_notes,
      exercises,
    },
    prior_sessions: priors,
    // Wider context (may be null when integrations / plan / goal absent).
    recovery:    extras.recovery    || null,
    prescribed:  extras.prescribed  || null,
    weekly_load: extras.weekly_load || { sessions_last_7d: 0 },
    goal:        extras.goal        || null,
  };
}

// ── Claude call (tool-use schema enforces shape) ────────────────────────
async function callClaude(ctx, anthropicKey) {
  const model     = process.env.TRAIN_FEEDBACK_MODEL || DEFAULT_MODEL;
  const maxTokens = parseInt(process.env.TRAIN_FEEDBACK_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS;

  const isFirstSession = (ctx.prior_sessions || []).length === 0;

  const systemPrompt = [
    'You are a strength + conditioning coach reviewing a single workout the user just submitted.',
    '',
    `SCALES: ${MOOD_SCALE_NOTE} The session payload includes both the raw integer (\`feel\`) and the matching label (\`feel_label\`) — read the label, don't infer from the number.`,
    '',
    'CONTEXT YOU SEE (for reasoning, not for echoing):',
    '- today / prior_sessions = the workout just submitted + up to 3 prior matching sessions.',
    '- recovery = wearable read for the session date (oura readiness OR whoop recovery, picked from the user\'s chosen source). Use to frame fatigue: a hard session at score 55 reads very differently than at 85. When recovery.stale=true, downgrade your confidence in that signal. recovery may be null — that\'s fine, just don\'t reference it.',
    '- prescribed = the active plan\'s prescription for this day. When present, you can call out off-script choices, skipped exercises, or under/over the rep target. When null, treat as an unprogrammed / bonus session.',
    '- weekly_load.sessions_last_7d = how many sessions the user has logged in the past 7 days (excluding this one). Enables streak / recovery-day framing.',
    '- goal = the user\'s active body-comp goal. direction=\'bulk\' means volume up is on-plan; direction=\'cut\' means a hard session in a deficit is impressive; direction=\'maintain\' means consistency is the win. Null means no active goal — omit goal framing.',
    '',
    'DO NOT echo specific numbers from these fields (readiness=62, hrv=42, etc) — read them, then frame in prose. The deterministic stats grid is the single source of truth for numeric data.',
    '',
    'YOUR JOB: produce a short, plain-English insight (1-2 sentences) plus 1-3 observation bullets.',
    'You are RIGHT NEXT TO a deterministic stats grid (sets, volume, duration, PR detection) — do NOT restate those numbers verbatim. Add the WHY and the NEXT MOVE.',
    '',
    'STYLE:',
    '- Direct. Verb-first when possible. No filler ("Great job!", "Worth noting").',
    '- No medical claims, no prescriptions ("you should take creatine").',
    '- No emojis.',
    '- Talk to the user in second person ("you").',
    '- Compare to prior sessions ONLY when prior sessions exist. Don\'t invent baselines.',
    isFirstSession ? 'This is the first logged session of this kind — focus on encouragement to repeat the pattern next time, not on comparisons.' : '',
    '',
    'GOOD insight examples:',
    '- "Volume up across the board on the second set — keep the rest periods tight next week."',
    '- "Bench dropped a rep but bodyweight rows climbed. Likely fatigue from the higher squat load — expected, not a regression."',
    '- "Good cardio session at this duration. Push the distance to 3.5 next time if pace held."',
    '',
    'BAD (will be rejected):',
    '- Restating the volume number from the stats grid.',
    '- "Great workout!" (filler, no signal).',
    '- "Make sure to stretch." (generic).',
    '- Anything claiming injury risk, diagnosis, or supplement advice.',
    '',
    'Always call record_train_feedback with the structured fields. Never reply in free text.',
  ].filter(Boolean).join('\n');

  const tool = {
    name: 'record_train_feedback',
    description: 'Record the coach-style feedback for the just-submitted workout.',
    input_schema: {
      type: 'object',
      properties: {
        insight: {
          type: 'string',
          description: '1-2 sentence plain-English coach insight. ≤280 chars.',
        },
        observations: {
          type: 'array',
          description: '0-3 short observation bullets, each ≤120 chars. Skip the array if you have nothing the stats grid isn\'t already saying.',
          items: { type: 'string' },
          maxItems: 3,
        },
      },
      required: ['insight'],
    },
  };

  const body = {
    model:      model,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages: [
      { role: 'user', content: `Today's session + prior comparison data:\n\n${JSON.stringify(ctx, null, 0)}` },
    ],
    tools:       [tool],
    tool_choice: { type: 'tool', name: 'record_train_feedback' },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic_http_${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_train_feedback');
  if (!block) throw new Error(`no_tool_use_in_response: stop_reason=${j.stop_reason}`);

  const raw = block.input || {};
  const insight = String(raw.insight || '').trim().slice(0, 280);
  const observations = Array.isArray(raw.observations)
    ? raw.observations.slice(0, 3).map(o => String(o).trim().slice(0, 140)).filter(Boolean)
    : [];

  return {
    status:            'ok',
    insight,
    observations,
    model:             j.model || model,
    prompt_tokens:     j.usage?.input_tokens || null,
    completion_tokens: j.usage?.output_tokens || null,
  };
}

// ── Deterministic fallback (no API key / Claude failed) ─────────────────
function buildFallback(session, sets, priorSessions, priorSetsMap, reason) {
  // Tiny deterministic note so the client still shows something. The
  // formulaic stats card already carries the numbers; this is just an
  // honest one-liner. Tagged so the UI can dim it.
  const exCount = new Set(sets.map(s => s.exercise_name)).size;
  let insight;
  if (session.day_type === 'cardio') {
    const set = sets[0] || {};
    insight = `Cardio session logged${set.actual_reps ? ` (${set.actual_reps} min)` : ''}.`;
  } else if (session.day_type === 'bonus') {
    const set = sets[0] || {};
    insight = `Bonus session logged${set.exercise_name ? ` — ${set.exercise_name}` : ''}.`;
  } else {
    insight = `Lift session logged across ${exCount} exercise${exCount === 1 ? '' : 's'}.`;
  }
  return { status: 'fallback', insight, observations: [], fallback_reason: reason };
}

// ── HTTP helpers ────────────────────────────────────────────────────────
function json(statusCode, payload) {
  return { statusCode, body: JSON.stringify(payload) };
}
function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Content-Type':                 'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  };
}
