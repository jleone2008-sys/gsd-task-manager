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

const { moodLabel, MOOD_SCALE_NOTE } = require('./lib/mood-scale');

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
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Parse body ──────────────────────────────────────────────────────
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }
  const sessionId = body.session_id;
  if (!sessionId) return cors(json(400, { error: 'session_id_required' }));

  try {
    // ── Read session + sets ───────────────────────────────────────────
    const session = await fetchSession(sessionId, userId, serviceKey);
    if (!session) return cors(json(404, { error: 'session_not_found' }));
    const sets    = await fetchSets(sessionId, userId, serviceKey);

    // ── Comparison: last 3 prior sessions (same day_name) ─────────────
    const priorSessions = await fetchPriorSessions(userId, session, serviceKey);
    const priorSetsMap  = await fetchSetsForSessions(priorSessions.map(s => s.id), userId, serviceKey);

    // ── No API key → deterministic fallback ───────────────────────────
    if (!anthropicKey) {
      return cors(json(200, buildFallback(session, sets, priorSessions, priorSetsMap, 'no_anthropic_key')));
    }

    // ── Build context + call Claude ──────────────────────────────────
    const ctx = buildContext(session, sets, priorSessions, priorSetsMap);
    let result;
    try {
      result = await callClaude(ctx, anthropicKey);
    } catch (err) {
      console.error('[train-feedback] claude call failed:', err.message);
      result = buildFallback(session, sets, priorSessions, priorSetsMap, `claude_error: ${err.message}`);
    }
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

// ── Context build ───────────────────────────────────────────────────────
function buildContext(session, sets, priorSessions, priorSetsMap) {
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
