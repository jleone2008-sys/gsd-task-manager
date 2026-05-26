// Phase 7 — weekly synthesis (BACKGROUND function).
//
// Generates one weekly_briefs row per user per week using the agentic
// tool-use loop. Background function so the multi-iteration Opus run
// has the 15-minute timeout window (typical run: 30-90 seconds).
//
// Triggered two ways:
//   1. Cron (cron-weekly-synthesis.js, Sunday 18:00 user-local) —
//      iterates active users, fires this background fn per user.
//   2. Manual: POST from the Insights tab "Generate weekly brief"
//      affordance (Commit 7).
//
// POST body: { user_id, week_start_date? }
//   - week_start_date defaults to this Monday in UTC
//   - user_id required; auth header validated by the caller for
//     manual paths, or passed by the cron from a trusted env var
//
// Pipeline:
//   a. Upsert weekly_briefs row with status='processing'
//   b. Build initial context (cheap deterministic pulls — recent
//      baselines, week summary, list of existing patterns)
//   c. Run the agentic loop with synthesis-tools.TOOLS
//   d. Persist patterns Opus identifies as patterns_discovered rows
//      (or strengthen existing ones)
//   e. Update weekly_briefs row with structured + narrative +
//      patterns_discovered_ids + tool_calls_log + telemetry
//   f. Mark status='ready' or 'failed' with reason

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const KNOWLEDGE_MODEL = process.env.KNOWLEDGE_MODEL || 'claude-opus-4-7';
const SYNTHESIS_MAX_TOKENS = 4096;
const SYNTHESIS_MAX_ITER   = 12;

const { TOOLS } = require('./lib/synthesis-tools');
const { runAgenticLoop } = require('./lib/agentic-loop');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const cronSecret   = process.env.CRON_SECRET || '';
  if (!serviceKey)   return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!anthropicKey) return cors(json(500, { error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY' }));

  // ── Authenticate (JWT for manual; cron secret for cron) ────────
  let userId = null;
  let userEmail = null;
  let isCronPath = false;
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer === cronSecret) {
    // Cron path — must pass user_id in the body
    isCronPath = true;
    let body;
    try { body = event.body ? JSON.parse(event.body) : {}; }
    catch (e) { return cors(json(400, { error: 'invalid_json' })); }
    userId = String(body.user_id || '');
    userEmail = String(body.user_email || '');
    if (!userId) return cors(json(400, { error: 'user_id_required' }));
  } else if (bearer) {
    // JWT path — resolve user from token
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
    });
    if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
    const userJson = await ur.json();
    userId = userJson.id;
    userEmail = userJson.email || null;
  } else {
    return cors(json(401, { error: 'missing_token' }));
  }
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Body ───────────────────────────────────────────────────────
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { /* already parsed above for cron path */ }

  // week_start_date resolution. Three cases:
  //   1. Explicit week_start_date in body → use it (caller pinned the week)
  //   2. Cron path with no week_start_date → this week's Monday
  //      (cron fires Sun 22:00 UTC which is end-of-this-week, so the
  //      current Monday IS the week that just ended)
  //   3. JWT manual path with no week_start_date → LAST completed Monday
  //      (user clicking 'Generate' mid-week wants the week that finished,
  //      not the partial in-progress week — Opus called this out on
  //      first run)
  let weekStart = String(body.week_start_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    weekStart = isCronPath ? mondayOfThisWeek() : mondayOfLastCompletedWeek();
  }
  const weekEnd = shiftDate(weekStart, +6);

  // ── Upsert processing row ──────────────────────────────────────
  try {
    await dbUpsert(`${SUPABASE_URL}/rest/v1/weekly_briefs?on_conflict=user_id,week_start_date`, {
      user_id:         userId,
      week_start_date: weekStart,
      status:          'processing',
      model:           KNOWLEDGE_MODEL,
      generated_at:    new Date().toISOString(),
    }, serviceKey);
  } catch (e) {
    console.error('[weekly-synthesis] row upsert failed:', e.message);
    return cors(json(500, { error: 'row_upsert_failed', detail: e.message }));
  }

  try {
    // ── Initial context (cheap deterministic pulls) ─────────────
    // We give Opus a starter snapshot so it doesn't have to call
    // 10 tools just to orient. Tools handle deeper investigation.
    const hdr = () => ({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });

    const [existingPatterns, lastWeeksBrief] = await Promise.all([
      // Existing active patterns — Opus should know what's already been
      // identified to avoid re-discovering them.
      fetchJson(`${SUPABASE_URL}/rest/v1/patterns_discovered?user_id=eq.${userId}&dismissed_by_user=eq.false&select=id,label,description,strength_score,last_seen_at,n&order=last_seen_at.desc&limit=20`, hdr()),
      // Last week's brief for "what did we cover last time" context.
      fetchJson(`${SUPABASE_URL}/rest/v1/weekly_briefs?user_id=eq.${userId}&week_start_date=lt.${weekStart}&status=eq.ready&select=week_start_date,structured,narrative&order=week_start_date.desc&limit=1`, hdr()),
    ]);

    const ctxSnapshot = {
      week_start_date: weekStart,
      week_end_date:   weekEnd,
      existing_active_patterns: (existingPatterns || []).map(p => ({
        id: p.id, label: p.label, strength_score: p.strength_score, n: p.n, last_seen_at: p.last_seen_at,
      })),
      last_weeks_brief: lastWeeksBrief?.[0] ? {
        week_start_date: lastWeeksBrief[0].week_start_date,
        headline:        lastWeeksBrief[0].structured?.headline || null,
      } : null,
    };

    const systemPrompt = buildSystemPrompt(weekStart, weekEnd);
    const initialMessage = buildInitialMessage(ctxSnapshot);

    // ── Run the agentic loop ───────────────────────────────────
    const tool_ctx = { userId, userEmail, openaiKey, hdr };
    const result = await runAgenticLoop({
      anthropicKey,
      model: KNOWLEDGE_MODEL,
      max_tokens: SYNTHESIS_MAX_TOKENS,
      system_prompt: systemPrompt,
      initial_user_message: initialMessage,
      tools: TOOLS,
      tool_ctx,
      max_iterations: SYNTHESIS_MAX_ITER,
    });

    if (result.status !== 'ok' || !result.final_text) {
      throw new Error(result.error || `loop_status_${result.status}`);
    }

    // ── Parse the final synthesis ───────────────────────────────
    // Claude returns text; we expect it to be JSON wrapped in a
    // fenced code block OR direct JSON. Parse robustly.
    const synthesis = parseSynthesisOutput(result.final_text);
    if (!synthesis) throw new Error('synthesis_parse_failed');

    // ── Persist patterns Opus identified ───────────────────────
    const patternIds = await persistPatterns(synthesis.patterns || [], userId, weekStart, weekEnd, serviceKey);

    // ── Finalize weekly_briefs row ─────────────────────────────
    await dbPatch(`${SUPABASE_URL}/rest/v1/weekly_briefs?user_id=eq.${userId}&week_start_date=eq.${weekStart}`, {
      structured:              synthesis.structured || null,
      narrative:               synthesis.narrative  || null,
      patterns_discovered_ids: patternIds,
      tool_calls_log:          (result.tool_calls_log || []).slice(-50),
      confidence:              synthesis.confidence || 'medium',
      status:                  'ready',
      prompt_tokens:           result.prompt_tokens,
      completion_tokens:       result.completion_tokens,
      total_iterations:        result.iterations,
    }, serviceKey);

    return cors(json(200, { status: 'ready', week_start_date: weekStart, iterations: result.iterations, patterns: patternIds.length }));
  } catch (err) {
    console.error('[weekly-synthesis] pipeline failed:', err.message);
    await dbPatch(`${SUPABASE_URL}/rest/v1/weekly_briefs?user_id=eq.${userId}&week_start_date=eq.${weekStart}`, {
      status:         'failed',
      failure_reason: String(err.message || err).slice(0, 500),
    }, serviceKey).catch(() => {});
    return cors(json(200, { status: 'failed', error: err.message }));
  }
};

// ── Prompts ────────────────────────────────────────────────────────
function buildSystemPrompt(weekStart, weekEnd) {
  return [
    `You are the user's weekly synthesis partner. Today you are looking back at the week of ${weekStart} through ${weekEnd}.`,
    '',
    'YOUR JOB:',
    '1. Use the available tools to investigate the week\'s data. Pull baselines, query daily rows, search prior patterns, search the user\'s knowledge base when relevant, and compute correlations when you have a real hypothesis.',
    '2. Identify recurring patterns. Examples: "Sleep score drops on rest days after heavy lift weeks", "Mood lags HRV by 1 day", "Late-night Fridays kill Saturday recovery". A pattern is worth surfacing when: n >= 5 paired observations OR correlation |r| >= 0.4 OR a clear binary streak.',
    '3. Avoid re-discovering existing patterns — the initial context lists active ones. If you re-confirm one, set reconfirms_pattern_id on that entry so the server bumps its last_seen_at instead of creating a duplicate.',
    '4. DEDUPE YOUR OWN OUTPUT: No two entries in your patterns[] array may describe the same underlying finding. If two analyses point at the same correlation, observation, or insight (e.g. "body temp tracks HRV" and "body temp inversely correlates with HRV" are the same pattern in different words), pick ONE — the better-worded version — and drop the other. Same correlation r-value + same evidence window + same metrics ≈ same pattern. Lean toward fewer, higher-quality patterns rather than padding the list.',
    '4. Synthesize into a weekly brief: headline, 2-3 short sections, and a long-form narrative.',
    '',
    'OUTPUT FORMAT: When you have enough evidence, respond with a single JSON object (NO surrounding prose, NO markdown fences) in this shape:',
    '{',
    '  "structured": {',
    '    "headline": "<10-30 chars verb-first>",',
    '    "subhead":  "<short framing of the week, ≤120 chars>",',
    '    "sections": [',
    '      { "label": "RECOVERY",  "body": "<2-3 sentences>" },',
    '      { "label": "TRAINING",  "body": "<2-3 sentences>" },',
    '      { "label": "MOOD",      "body": "<2-3 sentences>" }',
    '    ]',
    '  },',
    '  "narrative": "<400-700 word long-form synthesis>",',
    '  "patterns": [',
    '    { "label": "<≤80 chars>",',
    '      "description": "<1-3 sentences explaining the pattern + evidence>",',
    '      "evidence_window": { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "n_days": N },',
    '      "n": <integer sample size>,',
    '      "strength_score": <0..1>,',
    '      "reconfirms_pattern_id": "<uuid if this strengthens an existing pattern, else omit>",',
    '      "metadata": { ... optional pattern-specific extras ... }',
    '    }',
    '  ],',
    '  "confidence": "high" | "medium" | "low"',
    '}',
    '',
    'STYLE:',
    '- Specific, not vague. "Sleep score averaged 78, down 6 from prior week" beats "you didn\'t sleep great".',
    '- Frame causally only when you have evidence (correlation, repeated co-occurrence). Otherwise just describe.',
    '- No medical claims. No prescriptions. No supplement advice.',
    '- No emojis.',
    '- The narrative is read directly by the user — write it for them, in second person.',
  ].join('\n');
}

function buildInitialMessage(ctxSnapshot) {
  return [
    `Week to synthesize: ${ctxSnapshot.week_start_date} through ${ctxSnapshot.week_end_date}.`,
    '',
    'Existing active patterns (do not re-discover; you may strengthen with reconfirms_pattern_id):',
    JSON.stringify(ctxSnapshot.existing_active_patterns, null, 0),
    '',
    ctxSnapshot.last_weeks_brief
      ? `Last week's headline: ${JSON.stringify(ctxSnapshot.last_weeks_brief)}`
      : 'No prior weekly brief on file.',
    '',
    'Start by calling query_baselines to ground the "what is normal" baseline, then query_daily_rows for the week\'s oura_daily + journal_entries + workout_sessions. Investigate any anomalies via compute_correlation or search_knowledge as warranted. Once you have enough evidence to write a synthesis, respond with the JSON output described in the system prompt.',
  ].join('\n');
}

// ── Output parsing ─────────────────────────────────────────────────
function parseSynthesisOutput(text) {
  if (!text) return null;
  // Strip code fences if present
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    // Try to extract the first {...} block
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
  }
}

// ── Pattern persistence ───────────────────────────────────────────
// Opus sometimes emits two patterns in one run that describe the same
// finding with slightly different wording (the "Body temp tracks HRV"
// vs "Body temp inversely tracks HRV" dupe Joe caught after the first
// run). We defend against this two ways:
//   1. Fetch the user's existing un-dismissed patterns ONCE at the
//      start of this run.
//   2. For each candidate pattern, compare against existing patterns
//      AND against ones we've already inserted THIS run. Treat
//      matches as reconfirms (strengthen) instead of insert.
//   3. The match criterion is a simple distinctive-token overlap:
//      ≥3 shared non-stopword tokens between the new pattern's
//      label+description and the existing pattern's label+description,
//      AND evidence-window overlap of ≥50% if both have windows.
async function persistPatterns(patterns, userId, weekStart, weekEnd, serviceKey) {
  const ids = [];
  // Load existing un-dismissed patterns for dedupe check.
  let existing = [];
  try {
    existing = await fetchJson(
      `${SUPABASE_URL}/rest/v1/patterns_discovered`
        + `?user_id=eq.${userId}&dismissed_by_user=eq.false`
        + `&select=id,label,description,evidence_window&limit=200`,
      { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    );
  } catch (_) { existing = []; }

  // Track what we've inserted/touched this run so two candidates with
  // the same finding within ONE run collapse to one row.
  const touchedThisRun = [];

  for (const p of (patterns || [])) {
    if (!p?.label || !p?.description) continue;
    try {
      // Pre-existing match: model said reconfirms OR we fuzzy-match
      const dupeId = p.reconfirms_pattern_id
        || findDuplicateId(p, existing, weekStart, weekEnd)
        || findDuplicateId(p, touchedThisRun, weekStart, weekEnd);
      if (dupeId) {
        // Strengthen existing
        await dbPatch(
          `${SUPABASE_URL}/rest/v1/patterns_discovered?id=eq.${encodeURIComponent(dupeId)}&user_id=eq.${userId}`,
          {
            last_seen_at:   new Date().toISOString(),
            strength_score: typeof p.strength_score === 'number' ? p.strength_score : undefined,
            n:              typeof p.n === 'number' ? p.n : undefined,
            evidence_window: p.evidence_window || undefined,
          },
          serviceKey,
        );
        if (!ids.includes(dupeId)) ids.push(dupeId);
      } else {
        // Insert new
        const row = await dbInsertReturning(`${SUPABASE_URL}/rest/v1/patterns_discovered`, {
          user_id:        userId,
          label:          String(p.label).slice(0, 200),
          description:    String(p.description).slice(0, 1000),
          evidence_window: p.evidence_window || { start_date: weekStart, end_date: weekEnd },
          n:              typeof p.n === 'number' ? p.n : null,
          strength_score: typeof p.strength_score === 'number' ? p.strength_score : null,
          metadata:       p.metadata || null,
        }, serviceKey);
        if (row?.id) {
          ids.push(row.id);
          touchedThisRun.push({
            id:              row.id,
            label:           row.label,
            description:     row.description,
            evidence_window: row.evidence_window,
          });
        }
      }
    } catch (e) {
      console.warn('[weekly-synthesis] pattern persist failed:', e.message);
    }
  }
  return ids;
}

// Find an existing pattern that's effectively a duplicate of the
// candidate. Returns the matching id, or null. See persistPatterns
// header for the matching rules.
const _STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'he','her','his','i','in','is','it','its','of','on','or','our','she',
  'so','that','the','their','them','they','this','to','was','were','will',
  'with','you','your','my','me','we','us','also','than','then','these',
  'those','here','there','about','across','after','before','between',
  'into','over','through','during','can','could','should','would','may',
  'might','do','does','did','done','goes','went','more','most','very',
  'much','some','any','all','only','same','vs','via','per',
]);
function tokenize(s) {
  return Array.from(new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !_STOPWORDS.has(t)),
  ));
}
function findDuplicateId(candidate, pool, weekStart, weekEnd) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const candTokens = new Set(tokenize((candidate.label || '') + ' ' + (candidate.description || '')));
  if (candTokens.size === 0) return null;
  const candEW = candidate.evidence_window || { start_date: weekStart, end_date: weekEnd };
  for (const existing of pool) {
    const existTokens = tokenize((existing.label || '') + ' ' + (existing.description || ''));
    const overlap = existTokens.filter(t => candTokens.has(t)).length;
    if (overlap < 3) continue;
    if (!windowsOverlap(candEW, existing.evidence_window, 0.5)) continue;
    return existing.id;
  }
  return null;
}
function windowsOverlap(a, b, minFraction) {
  if (!a?.start_date || !a?.end_date || !b?.start_date || !b?.end_date) return true; // permissive
  const aS = Date.parse(a.start_date + 'T00:00:00Z');
  const aE = Date.parse(a.end_date   + 'T00:00:00Z');
  const bS = Date.parse(b.start_date + 'T00:00:00Z');
  const bE = Date.parse(b.end_date   + 'T00:00:00Z');
  if (!aS || !aE || !bS || !bE) return true;
  const overlap = Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  const aLen = Math.max(1, aE - aS);
  const bLen = Math.max(1, bE - bS);
  const fracA = overlap / aLen;
  const fracB = overlap / bLen;
  return Math.max(fracA, fracB) >= minFraction;
}

// ── Date helpers ──────────────────────────────────────────────────
function mondayOfThisWeek() {
  const d = new Date();
  const dow = d.getUTCDay();       // 0 = Sun, 1 = Mon, ...
  const delta = (dow === 0) ? -6 : (1 - dow);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function mondayOfLastCompletedWeek() {
  // Last completed Mon-Sun = the Monday 7 days before this week's Monday.
  return shiftDate(mondayOfThisWeek(), -7);
}
function shiftDate(ymd, deltaDays) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ── DB helpers ────────────────────────────────────────────────────
async function dbUpsert(url, row, serviceKey) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db_upsert_${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function dbInsertReturning(url, row, serviceKey) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db_insert_${r.status}: ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  return arr?.[0] || null;
}
async function dbPatch(url, patch, serviceKey) {
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
  if (!r.ok) throw new Error(`db_patch_${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function fetchJson(url, hdrObj) {
  const r = await fetch(url, { headers: hdrObj });
  if (!r.ok) throw new Error(`fetch_${r.status}`);
  return await r.json();
}

// ── HTTP ───────────────────────────────────────────────────────────
function json(statusCode, payload) { return { statusCode, body: JSON.stringify(payload) }; }
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
