// User-facing + cron-callable endpoint that generates and stores the daily
// brief at the top of the Home tab. The brief is a per-user, per-local-day
// row in `public.daily_briefs` with a narrative recap, computed highlights,
// 0-2 suggested actions, and a confidence rating produced by Claude via
// forced tool_use.
//
// Modes:
//   GET ?date=YYYY-MM-DD                  — client read for a specific local
//                                           date. Returns the existing row or
//                                           404 if not generated yet. (Note:
//                                           the Home tab can also read briefs
//                                           directly via PostgREST + RLS — this
//                                           endpoint is for explicit re-fetch.)
//   POST {force?: bool, date?: YYYY-MM-DD} — generate (or regenerate). Client
//                                           auth: Bearer JWT → user derived
//                                           from /auth/v1/user. Cron auth:
//                                           X-Internal-Auth header + body
//                                           {user_email, user_id} → user passed
//                                           in directly.
//
// Storage: writes go through the service key (bypasses RLS). Reads from the
// client also work via this endpoint, but the Home tab is expected to read
// `daily_briefs` directly with its own JWT (RLS policy `daily_briefs_select_own`).
//
// Claude call: forced tool_use on `record_daily_brief`. Single structured
// response. No streaming (brief is small + we want the full object before
// writing to DB). Adaptive thinking is OFF for daily briefs — the structured
// synthesis is simple enough that effort=low + thinking disabled is the right
// cost/latency tradeoff. The user can override the model via BRIEF_MODEL.
//
// Failure modes:
//   - Anthropic 5xx / timeout / rate limit  → fallback row with deterministic
//                                              narrative, status='fallback'
//   - Yesterday's oura_daily missing/stale  → status='preliminary', UI shows
//                                              refresh affordance
//   - <14 days of baseline data             → confidence='low', UI hides actions

const SUPABASE_URL    = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';

// Defaults — overridable via env vars.
const DEFAULT_MODEL       = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS  = 1500;
const DEFAULT_TIMEZONE    = 'America/New_York';

// Freshness window for Oura: if the row for yesterday is missing OR was last
// fetched >24h ago, the brief is flagged 'preliminary' and the UI shows a
// "still syncing — tap to retry" affordance. This addresses the Oura sync
// lag pattern (Oura sometimes won't surface a finalized day-end until the
// user opens the phone app the next morning).
const OURA_STALE_HOURS = 24;

// GSD mood scale: 1=best, 5=worst. We send labels (not integers) to Claude so
// it can't reverse the orientation (which it did on first launch — reported
// "Mood at 1" as a concerning low when it was actually the best score).
const MOOD_LABELS = { 1: 'Great', 2: 'Good', 3: 'Okay', 4: 'Low', 5: 'Bad' };
const MOOD_SCALE_NOTE = 'GSD mood scale: 1=Great (best), 2=Good, 3=Okay, 4=Low, 5=Bad (worst). Lower numbers are better.';
function moodLabel(v) {
  if (v == null) return null;
  const k = Math.round(Number(v));
  return MOOD_LABELS[k] || `Unknown(${v})`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anthropic  = process.env.ANTHROPIC_API_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));

  // ── Authenticate ────────────────────────────────────────────────────────
  let user;   // { email, user_id, timezone }
  let isCron = false;
  try {
    if (event.headers['x-internal-auth'] || event.headers['X-Internal-Auth']) {
      // Cron path: shared-secret + passed-in identity
      const expected = process.env.INTERNAL_FN_SECRET || '';
      const got      = event.headers['x-internal-auth'] || event.headers['X-Internal-Auth'] || '';
      if (!expected || got !== expected) return cors(json(403, { error: 'forbidden' }));
      const body = event.body ? JSON.parse(event.body) : {};
      if (!body.user_email || !body.user_id) {
        return cors(json(400, { error: 'cron_path_requires_user_email_and_user_id' }));
      }
      user = await resolveUser({ email: body.user_email, user_id: body.user_id }, serviceKey);
      isCron = true;
    } else {
      // Client path: Supabase JWT
      const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!bearer) return cors(json(401, { error: 'missing_token' }));
      const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
      });
      if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
      const u = await ur.json();
      user = await resolveUser({ email: u.email, user_id: u.id }, serviceKey);
    }
  } catch (err) {
    console.error('daily-brief auth error:', err.message);
    return cors(json(401, { error: 'auth_failed', detail: err.message }));
  }

  try {
    // ── GET: read existing brief for a specific date ──────────────────────
    if (event.httpMethod === 'GET') {
      const date = event.queryStringParameters?.date || yesterdayLocal(user.timezone);
      const brief = await fetchBrief(user.user_id, date, serviceKey);
      if (!brief) return cors(json(404, { error: 'not_found', brief_date: date }));
      return cors(json(200, brief));
    }

    if (event.httpMethod !== 'POST') return cors(json(405, { error: 'method_not_allowed' }));

    // ── POST: generate (or regenerate) ────────────────────────────────────
    const body  = event.body ? JSON.parse(event.body) : {};
    const force = !!body.force;
    const date  = body.date || yesterdayLocal(user.timezone);

    // Idempotency: existing row wins unless force=true
    if (!force) {
      const existing = await fetchBrief(user.user_id, date, serviceKey);
      if (existing) return cors(json(200, { ...existing, _from_cache: true }));
    }

    if (!anthropic) {
      // No Claude key available — write a fallback row so the UI has something
      const fallback = buildFallback({ reason: 'no_anthropic_key' });
      const stored   = await storeBrief(user, date, fallback, serviceKey);
      return cors(json(200, stored));
    }

    // Build context payload + freshness check
    const ctx = await buildContext(user, date, serviceKey);

    // Call Claude (or build fallback on failure)
    let result;
    try {
      result = await callClaude(ctx, anthropic);
    } catch (err) {
      console.error('daily-brief claude call failed:', err.message);
      result = buildFallback({ reason: `claude_error: ${err.message}`, context: ctx });
    }

    // Status: preliminary if Oura was stale, fallback if Claude failed, else ok
    if (ctx._oura_stale && result.status === 'ok') {
      result.status = 'preliminary';
      result.fallback_reason = 'oura_data_stale_at_generation';
    }

    const stored = await storeBrief(user, date, result, serviceKey);
    return cors(json(200, stored));
  } catch (err) {
    console.error('daily-brief handler error:', err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// ── User resolution ────────────────────────────────────────────────────────
async function resolveUser({ email, user_id }, serviceKey) {
  // access_status will be added in Phase 3 (allowlist gate); not selected today.
  const sel = 'supabase_user_id,email,timezone';
  const url = email
    ? `${SUPABASE_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=${sel}`
    : `${SUPABASE_URL}/rest/v1/user_profiles?supabase_user_id=eq.${user_id}&select=${sel}`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`user_profile_lookup_failed: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) {
    throw new Error(`user_profile_lookup_unexpected: ${JSON.stringify(rows).slice(0, 200)}`);
  }
  const row = rows[0];
  if (!row) throw new Error(`user_profile_not_found_for_${email || user_id}`);
  return {
    email:    row.email,
    user_id:  row.supabase_user_id || user_id,
    timezone: row.timezone || DEFAULT_TIMEZONE,
  };
}

// ── Read existing brief ────────────────────────────────────────────────────
async function fetchBrief(user_id, brief_date, serviceKey) {
  const url = `${SUPABASE_URL}/rest/v1/daily_briefs`
    + `?user_id=eq.${user_id}&brief_date=eq.${brief_date}`
    + `&select=id,brief_date,generated_at,model,tldr,narrative,highlights,actions,confidence,status,fallback_reason`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ── Context packager ───────────────────────────────────────────────────────
// Assembles the JSON payload sent to Claude. Three layers per the plan:
//   1. Yesterday raw snapshot (~20 cols of oura_daily + tags + workouts +
//      mood + completed tasks + calendar agenda + habit summary)
//   2. 7-day rolling per-day arrays (compact)
//   3. 30-day baselines from v_user_baselines_30d (medians + IQR + n)
async function buildContext(user, brief_date, serviceKey) {
  const yday = brief_date;                            // already 'yesterday' in user-local
  const win7 = shiftDate(yday, -6);                   // last 7 calendar days ending yesterday
  const hdr  = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // --- Yesterday snapshot
  const ouraCols = [
    'date','readiness_score','sleep_score','activity_score','total_sleep_min',
    'hrv_ms','resting_hr','sleep_efficiency_pct','sleep_midpoint_offset_min',
    'stress_high_seconds','stress_day_summary','steps','active_calories',
    'body_temp_deviation_c','resilience_level','updated_at',
  ].join(',');

  const [ouraY, whoopY, oTagsY, oWorkoutsY, journalY, tasksY, calY, habitsY, baselines] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${yday}&select=${ouraCols}`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/whoop_daily?user_email=eq.${encodeURIComponent(user.email)}&date=eq.${yday}&select=date,recovery_score,hrv_ms,resting_hr,strain,sleep_duration_min,sleep_performance,updated_at`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_tags?user_email=eq.${encodeURIComponent(user.email)}&start_day=eq.${yday}&select=tag_type_code,custom_name,start_time`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_workouts?user_email=eq.${encodeURIComponent(user.email)}&day=eq.${yday}&select=activity,duration_min,intensity,load,average_hr,calories`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=mood,reflections`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${user.user_id}&done=eq.true&select=text,completed_at&order=completed_at.desc&limit=30`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_calendar_cache?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=events`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_habit_summary?user_id=eq.${user.user_id}&entry_date=eq.${yday}&select=due_count,done_count`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_30d?user_id=eq.${user.user_id}&select=*`, hdr),
  ]);

  // --- 7-day rolling (compact arrays)
  const [oura7, journal7, habits7, tags7] = await Promise.all([
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_daily?user_email=eq.${encodeURIComponent(user.email)}&date=gte.${win7}&date=lte.${yday}&select=date,sleep_score,readiness_score,activity_score,total_sleep_min,hrv_ms&order=date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_entries?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,mood&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/journal_habit_summary?user_id=eq.${user.user_id}&entry_date=gte.${win7}&entry_date=lte.${yday}&select=entry_date,due_count,done_count&order=entry_date.asc`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/oura_tags?user_email=eq.${encodeURIComponent(user.email)}&start_day=gte.${win7}&start_day=lte.${yday}&select=tag_type_code,start_day`, hdr),
  ]);

  // Filter completed tasks to yesterday in user-local TZ (table has bigint epoch ms; we
  // overfetched up to 30 recent, now narrow client-side to the local-day window).
  const yStart = localDayStartUtcMs(yday, user.timezone);
  const yEnd   = yStart + 86400_000;
  const tasksYesterday = (tasksY || []).filter(t => t.completed_at && t.completed_at >= yStart && t.completed_at < yEnd);

  // Oura freshness check
  const ouraRow = ouraY?.[0] || null;
  const ouraStale = !ouraRow
    || !ouraRow.updated_at
    || (Date.now() - new Date(ouraRow.updated_at).getTime()) > OURA_STALE_HOURS * 3600_000;

  // Tag rollup for the week
  const tagCounts = {};
  for (const t of (tags7 || [])) {
    const k = t.tag_type_code || 'unknown';
    tagCounts[k] = (tagCounts[k] || 0) + 1;
  }

  // Pull recent reflection text but cap to 500 chars (per plan)
  const reflection = (journalY?.[0]?.reflections || '').slice(0, 500);

  // Mood scale translation: replace numeric mood with labels so Claude can't
  // get the direction wrong. See MOOD_LABELS / MOOD_SCALE_NOTE comments above.
  const yMood = journalY?.[0]?.mood ?? null;
  const moodWeek = (journal7 || []).map(d => ({
    entry_date: d.entry_date,
    mood_label: moodLabel(d.mood),
  })).filter(d => d.mood_label != null);

  const baseline = baselines?.[0] ? { ...baselines[0] } : null;
  if (baseline) {
    // Replace numeric mood baselines with labels (round to nearest scale value).
    // Keep the n_days_mood count as-is — it's a count, not a score.
    baseline.mood_label_median = moodLabel(baseline.mood_median);
    baseline.mood_label_p25    = moodLabel(baseline.mood_p25);
    baseline.mood_label_p75    = moodLabel(baseline.mood_p75);
    delete baseline.mood_median;
    delete baseline.mood_p25;
    delete baseline.mood_p75;
  }

  const ctx = {
    user: {
      timezone: user.timezone,
    },
    scales: {
      mood: MOOD_SCALE_NOTE,
    },
    brief_date: brief_date,
    yesterday: {
      oura: ouraRow ? stripUpdatedAt(ouraRow) : null,
      whoop: whoopY?.[0] ? stripUpdatedAt(whoopY[0]) : null,
      tags: (oTagsY || []).map(t => ({ kind: t.tag_type_code, name: t.custom_name, at: t.start_time })),
      workouts: oWorkoutsY || [],
      mood: yMood == null ? null : { value_label: moodLabel(yMood) },
      reflection: reflection || null,
      tasks_completed_count: tasksYesterday.length,
      tasks_completed_sample: tasksYesterday.slice(0, 10).map(t => t.text).filter(Boolean),
      calendar_events: ((calY?.[0]?.events) || []).slice(0, 8).map(e => ({
        summary: e.summary, start: e.start, allDay: !!e.isAllDay,
      })),
      habits: habitsY?.[0] ? { due: habitsY[0].due_count, done: habitsY[0].done_count } : null,
    },
    last_7_days: {
      oura: oura7 || [],
      mood: moodWeek,
      habits: habits7 || [],
      tag_counts: tagCounts,
    },
    baselines_30d: baseline,
    // Internal flags — stripped before sending to Claude
    _oura_stale: ouraStale,
  };

  return ctx;
}

// ── Claude call (forced tool_use) ─────────────────────────────────────────
async function callClaude(ctx, anthropicKey) {
  const model       = process.env.BRIEF_MODEL || DEFAULT_MODEL;
  const maxTokens   = parseInt(process.env.BRIEF_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS;

  // Cold-start gate: if we have <14 days of baseline data, force low confidence
  // and tell Claude to suppress comparative claims.
  const n_sleep    = ctx.baselines_30d?.n_days_sleep || 0;
  const n_mood     = ctx.baselines_30d?.n_days_mood || 0;
  const baselineN  = Math.max(n_sleep, n_mood);
  const coldStart  = baselineN < 14;

  const systemPrompt = [
    'You are the user\'s calm operations partner. Direct, no fluff. No emojis. No exclamation points. No medical claims.',
    'Lead with a single-sentence TL;DR (the `tldr` field). Do not write a narrative — the TL;DR is the only prose the user reads. Make it count.',
    'Use second person. Never say "low" or "high" in absolute terms — only "below your norm of X" or "above your norm of X" using the baselines provided.',
    'Action cap: 0 to 2 actions. If no action is genuinely warranted today, return an empty actions array. Silence beats noise.',
    'Anchor every claim to a specific metric the user can verify. If a metric is missing, do not infer it.',
    'Voice anchor: matches the user\'s brand "Stop managing your list. Start finishing it." Imperative verbs, concrete numbers, no validation.',
    `Mood uses GSD's scale where 1=Great (best) and 5=Bad (worst). Lower numbers indicate a better mood. ${MOOD_SCALE_NOTE} Mood values are sent to you as labels (Great/Good/Okay/Low/Bad), never as numbers — treat the label directly.`,
    'Highlights are EXTRAS beyond the rings. The Home rings already show Sleep score, Readiness score, and Activity score — do NOT repeat these in highlights. Use highlights for HRV, Total sleep (as time), Mood, Tasks completed, Habits done %, Resting HR.',
    'Time values must use compact format: "Xh Ym" (e.g. "5h 58m") or "X.Yh" (e.g. "6.0h"). Never raw minutes like "358 min".',
    coldStart
      ? `Cold-start mode: only ${baselineN} days of baseline data. Narrate yesterday plainly in the TL;DR. Do NOT make comparative claims ("vs your norm"). Set confidence="low" and return an empty actions array.`
      : 'Set confidence based on data quality and n: "high" when baselines have n>=30 and yesterday\'s data is complete; "medium" when n=14-29 or one major signal is missing; "low" when n<14 or yesterday is missing.',
  ].join(' ');

  // Strip internal flags before sending
  const { _oura_stale, ...payload } = ctx;

  const body = {
    model: model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      { role: 'user', content: 'Yesterday\'s data and your 30-day baselines below. Generate the brief using the record_daily_brief tool.\n\n' + JSON.stringify(payload, null, 0) },
    ],
    tools: [{
      name: 'record_daily_brief',
      description: 'Record the daily brief for the user. Always called exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          tldr: {
            type: 'string',
            description: 'Single takeaway sentence, MAX 120 characters, voice-matched. This is the headline — the user may not read anything else. State the most important thing about yesterday and what it means for today. No period required.',
          },
          highlights: {
            type: 'array',
            description: '3-5 metric highlights for the chips row. EXTRAS BEYOND THE RINGS: do not include sleep score, readiness score, or activity score (those are the rings). Use HRV, Total sleep (as time like "5h 58m"), Mood (label form), Tasks completed, Habits done %, Resting HR.',
            items: {
              type: 'object',
              properties: {
                label:           { type: 'string',  description: 'Short metric name. Allowed: "HRV", "Total sleep", "Mood", "Tasks completed", "Habits done", "Resting HR".' },
                value_today:     { type: ['number', 'string', 'null'], description: 'Yesterday\'s value. Time values use compact format like "5h 58m" or "6.0h". Mood as label like "Great". Never raw minutes.' },
                baseline:        { type: ['number', 'string', 'null'], description: '30-day median or comparable baseline (same format as value_today).' },
                direction:       { type: 'string',  enum: ['up', 'down', 'flat', 'unknown'], description: 'Today vs baseline. For mood (where lower=better), "up" means mood IMPROVED (numerically lower), "down" means mood worsened.' },
                percent_change:  { type: ['number', 'null'], description: 'Optional percent vs baseline.' },
              },
              required: ['label', 'direction'],
            },
          },
          actions: {
            type: 'array',
            description: '0 to 2 specific, single-day actions. Empty array is valid and preferred when no action is warranted.',
            maxItems: 2,
            items: {
              type: 'object',
              properties: {
                title:         { type: 'string', description: 'Imperative verb, specific. e.g. "Block 30 minutes for deep work before noon"' },
                why:           { type: 'string', description: 'One sentence anchored to a metric the user can verify' },
                area:          { type: 'string', enum: ['sleep', 'recovery', 'activity', 'work', 'mood', 'habits', 'nutrition', 'other'] },
                est_minutes:   { type: ['number', 'null'], description: 'Rough minute estimate or null' },
                source_metric: { type: 'string', description: 'The metric this action targets, e.g. "sleep_score", "readiness_score", "habit_done_pct"' },
              },
              required: ['title', 'why', 'area', 'source_metric'],
            },
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'See system prompt for confidence rules. Low confidence MUST have empty actions array.',
          },
        },
        required: ['tldr', 'highlights', 'actions', 'confidence'],
      },
    }],
    tool_choice: { type: 'tool', name: 'record_daily_brief' },
  };

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) {
    throw new Error(`anthropic_http_${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
  }

  const toolUseBlock = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_daily_brief');
  if (!toolUseBlock) {
    throw new Error(`no_tool_use_in_response: stop_reason=${j.stop_reason}`);
  }

  const out = toolUseBlock.input || {};
  // Defensive: cold-start guarantees no actions, regardless of model output
  if (coldStart && Array.isArray(out.actions) && out.actions.length > 0) {
    out.actions = [];
  }

  return {
    status:            'ok',
    tldr:              (out.tldr || '').slice(0, 200),     // hard cap on length
    narrative:         null,                                // no longer used (kept in row for back-compat schema)
    highlights:        Array.isArray(out.highlights) ? out.highlights : [],
    actions:           Array.isArray(out.actions) ? out.actions : [],
    confidence:        out.confidence || 'low',
    model:             j.model || model,
    prompt_tokens:     j.usage?.input_tokens || null,
    completion_tokens: j.usage?.output_tokens || null,
    input_snapshot:    payload,
    fallback_reason:   null,
  };
}

// ── Fallback (deterministic template when Claude is unavailable) ──────────
function buildFallback({ reason, context }) {
  // Build the simplest possible TL;DR from whatever raw signals we have.
  const o = context?.yesterday?.oura;
  let tldr;
  if (o) {
    const sleep = o.sleep_score != null ? `sleep ${o.sleep_score}` : null;
    const rd    = o.readiness_score != null ? `readiness ${o.readiness_score}` : null;
    const act   = o.activity_score != null ? `activity ${o.activity_score}` : null;
    const parts = [sleep, rd, act].filter(Boolean);
    tldr = parts.length ? `Yesterday — ${parts.join(', ')}.` : 'Brief generation unavailable.';
  } else {
    tldr = 'No wearable data available for yesterday.';
  }
  return {
    status:            'fallback',
    tldr:              tldr,
    narrative:         null,
    highlights:        [],
    actions:           [],
    confidence:        'low',
    model:             null,
    prompt_tokens:     null,
    completion_tokens: null,
    input_snapshot:    context ? (() => { const { _oura_stale, ...p } = context; return p; })() : null,
    fallback_reason:   reason,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────
async function storeBrief(user, brief_date, result, serviceKey) {
  const row = {
    user_id:           user.user_id,
    brief_date:        brief_date,
    generated_at:      new Date().toISOString(),
    model:             result.model,
    prompt_tokens:     result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    tldr:              result.tldr || null,
    narrative:         result.narrative,           // null on new rows; preserved for back-compat
    highlights:        result.highlights,
    actions:           result.actions,
    confidence:        result.confidence,
    status:            result.status,
    fallback_reason:   result.fallback_reason,
    input_snapshot:    result.input_snapshot,
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/daily_briefs`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`daily_briefs upsert failed: ${r.status} ${text}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function fetchJson(url, hdr) {
  try {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) {
      console.warn(`brief: fetch ${url} HTTP ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (err) {
    console.warn(`brief: fetch ${url} failed: ${err.message}`);
    return [];
  }
}

function stripUpdatedAt(row) {
  const { updated_at, ...rest } = row;
  return rest;
}

// 'YYYY-MM-DD' representing yesterday in the user's local timezone.
function yesterdayLocal(tz) {
  const today = localDate(new Date(), tz);
  return shiftDate(today, -1);
}

// Local date string in tz, format 'YYYY-MM-DD'.
function localDate(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

// Shift a 'YYYY-MM-DD' string by N days (calendar arithmetic, ignores TZ).
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// UTC ms timestamp of the start of `dateStr` in tz. Used to bound the
// per-user-local-day completed-task window. Implementation: compare a
// candidate UTC moment's local date against the target — adjust until the
// candidate falls on midnight of the target local day.
function localDayStartUtcMs(dateStr, tz) {
  // Start with UTC midnight of dateStr, then probe ±12h until the local date
  // formats back to dateStr. Single pass suffices for any standard tz.
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessMs   = Date.UTC(y, m - 1, d);
  for (let h = -12; h <= 14; h++) {
    const ms = guessMs + h * 3600_000;
    if (localDate(new Date(ms), tz) === dateStr && new Date(ms).getUTCHours() % 24 !== undefined) {
      // Refine: walk back to the first ms whose local-date is dateStr
      let lo = ms - 3600_000;
      while (lo >= guessMs - 24 * 3600_000 && localDate(new Date(lo), tz) === dateStr) lo -= 60_000;
      return lo + 60_000;
    }
  }
  return guessMs;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Internal-Auth',
    },
  };
}
