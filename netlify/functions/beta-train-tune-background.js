// Phase 11 (Workout Tuner) — monthly AI-driven refinement of the active
// workout plan, triggered after a fresh progress pic + weight land.
//
// Background function (long-running, returns 202 immediately). Invoked
// from beta-progress-pic-analysis.js via fire-and-forget POST. The
// progress-pic function doesn't know whether the tuner will act — this
// function owns the eligibility check, so the caller is dumb.
//
// Flow:
//   1. Eligibility gate — bail cheaply when no work to do (≥28d gate,
//      active plan exists, latest pic has actionable focus_areas, no
//      pending proposal already, not in back-off after consecutive
//      declines).
//   2. Build context in one Promise.all (plan, pics, sessions, recovery,
//      goal, prior tunes).
//   3. Claude (Opus 4.7) tool-use call — structured proposal.
//   4. Server-side validation — reject if primaries touched, volume jump
//      outside ±20%, day saturated, etc. Persist 'expired' row on
//      rejection so the audit trail is honest.
//   5. Persist 'pending' row + set workout_plans.last_plan_tune_at so the
//      28-day window closes regardless of acceptance (avoids hammering on
//      every pic upload).
//
// Acceptance / decline / revert happens later via beta-plan-tune-action.js.

const { json, cors, preflight } = require('./lib/http');
const { SUPABASE_URL } = require('./lib/supabase');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL      = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 1500;

// 28-day gate — long enough that the tuner produces meaningfully-spaced
// suggestions but short enough that someone uploading monthly pics gets a
// tune on every one. A user uploading more frequently sees the second+
// uploads silently skip.
const TUNE_MIN_DAYS = 28;

// Hard limit on changes the tuner is allowed to propose in one cycle.
// Three is enough to address a focus area + add one balancing accessory;
// more risks "this is a reset" feel.
const MAX_CHANGES = 3;

// Volume guardrail: the projected weekly working-set total must stay
// within this band of the prior plan's total. ±20% loosely tracks RP's
// MEV → MRV envelope without requiring per-muscle MRV modeling.
const VOLUME_DELTA_MAX = 0.20;

// Per-day saturation guard — don't pile accessories onto a day that's
// already long. Skipped workouts hurt more than incomplete ones.
const PER_DAY_EXERCISE_CAP = 8;

const { isCompoundPrimary, weeklyVolumeByGroup, countExercises, totalWeeklySets } = require('./lib/exercise-taxonomy');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const internal     = process.env.INTERNAL_FN_SECRET;
  if (!serviceKey)   return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!internal)     return cors(json(500, { error: 'server_misconfigured', detail: 'INTERNAL_FN_SECRET' }));
  if (!anthropicKey) return cors(json(500, { error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY' }));

  // Internal auth — only the progress-pic function (or a manual debug call
  // with the right header) can trigger this.
  const got = event.headers['x-internal-auth'] || event.headers['X-Internal-Auth'] || '';
  if (got !== internal) return cors(json(403, { error: 'forbidden' }));

  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }
  const userId       = body.user_id;
  const progressPicId = body.progress_pic_id || null;
  if (!userId) return cors(json(400, { error: 'user_id_required' }));

  try {
    const result = await tuneOne(userId, progressPicId, serviceKey, anthropicKey);
    console.log(`[train-tune] user=${userId.slice(0,8)} result=${result.status} reason=${result.reason || ''}`);
    return cors(json(200, result));
  } catch (err) {
    console.error(`[train-tune] user=${userId} failed:`, err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// ── Per-user evaluator ────────────────────────────────────────────────────
async function tuneOne(userId, progressPicId, serviceKey, anthropicKey) {
  const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // ── Eligibility gate (cheap reads first) ─────────────────────────────
  const planRows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/workout_plans?user_id=eq.${userId}&is_active=eq.true&is_template=eq.false&select=*&limit=1`,
    hdr,
  );
  const plan = planRows?.[0];
  if (!plan) return { status: 'skipped', reason: 'no_active_plan' };

  // 28-day gate
  if (plan.last_plan_tune_at) {
    const days = (Date.now() - new Date(plan.last_plan_tune_at).getTime()) / 86400_000;
    if (days < TUNE_MIN_DAYS) {
      return { status: 'skipped', reason: `last_tune_${Math.floor(days)}d_ago` };
    }
  }

  // No stacking — don't run while a pending proposal exists.
  const pendingRows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/workout_plan_tunes?user_id=eq.${userId}&plan_id=eq.${plan.id}&status=eq.pending&select=id&limit=1`,
    hdr,
  );
  if (pendingRows?.length) return { status: 'skipped', reason: 'pending_proposal_exists' };

  // Back off after two consecutive declines (latest two rows for this plan).
  const recentTunes = await fetchJson(
    `${SUPABASE_URL}/rest/v1/workout_plan_tunes?user_id=eq.${userId}&plan_id=eq.${plan.id}&status=in.(accepted,declined,reverted)&select=status,proposed_at&order=proposed_at.desc&limit=2`,
    hdr,
  );
  if (Array.isArray(recentTunes) && recentTunes.length === 2 && recentTunes.every(r => r.status === 'declined')) {
    return { status: 'skipped', reason: 'back_off_after_two_declines' };
  }

  // Latest progress pic with ai_analysis. progressPicId trusted (caller is
  // the analysis function), but verify it belongs to this user.
  const picRows = await fetchJson(
    progressPicId
      ? `${SUPABASE_URL}/rest/v1/progress_pics?id=eq.${progressPicId}&user_id=eq.${userId}&select=id,captured_date,weight_lbs,body_fat_pct,ai_analysis,ai_compared_to&limit=1`
      : `${SUPABASE_URL}/rest/v1/progress_pics?user_id=eq.${userId}&ai_analysis=not.is.null&select=id,captured_date,weight_lbs,body_fat_pct,ai_analysis,ai_compared_to&order=captured_date.desc&limit=1`,
    hdr,
  );
  const pic = picRows?.[0];
  if (!pic || !pic.ai_analysis) return { status: 'skipped', reason: 'no_pic_with_analysis' };

  // Confidence + actionable content checks.
  const ai = pic.ai_analysis || {};
  if (ai.confidence === 'low') return { status: 'skipped', reason: 'pic_confidence_low' };
  const needsWork = Array.isArray(ai.needs_work) ? ai.needs_work.filter(Boolean) : [];
  const focusAreas = Array.isArray(ai.focus_areas) ? ai.focus_areas.filter(f => f && f.title) : [];
  if (needsWork.length === 0 && focusAreas.length === 0) {
    return { status: 'skipped', reason: 'no_actionable_focus' };
  }

  // ── Build context (parallel batch) ───────────────────────────────────
  const nowISO = new Date().toISOString();
  const sessionsSince = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [recentSessions, oura7, oura30, whoop7, goalRows, priorTunes] = await Promise.all([
    fetchJson(
      `${SUPABASE_URL}/rest/v1/workout_sessions?user_id=eq.${userId}&session_date=gte.${sessionsSince}&select=id,session_date,day_name,day_type,feel,session_notes,workout_sets(exercise_name,actual_weight,actual_reps,rpe,is_bodyweight)&order=session_date.desc`,
      hdr,
    ),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_7d?user_id=eq.${userId}&select=*`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/v_user_baselines_30d?user_id=eq.${userId}&select=*`, hdr),
    // Whoop baselines aren't in the user_baselines views (those are Oura-
    // sourced). Pull last 7 whoop_daily rows directly so the tuner sees
    // recovery/strain medians for users on Whoop.
    fetchJson(`${SUPABASE_URL}/rest/v1/whoop_daily?user_email=eq.${encodeURIComponent(await emailForUser(userId, hdr))}&date=gte.${sessionsSince}&select=date,recovery_score,strain,sleep_performance&order=date.desc&limit=14`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/body_comp_goals?user_id=eq.${userId}&is_active=eq.true&select=goal_type,target_weight_lbs,target_pace,start_date,target_date&limit=1`, hdr),
    fetchJson(`${SUPABASE_URL}/rest/v1/workout_plan_tunes?user_id=eq.${userId}&plan_id=eq.${plan.id}&select=id,status,proposed_at,changes,rationale,focus_areas_addressed&order=proposed_at.desc&limit=3`, hdr),
  ]);

  // Phase 11 follow-up — enrich prior accepted tunes with their downstream
  // outcomes so Claude can decide whether to escalate (focus area still
  // flagged → add more volume), pivot (user didn't train added exercises
  // → wrong exercise selection), or move on (focus area resolved → look
  // elsewhere). This is the learning loop in the absence of a dedicated
  // brief_action_outcomes pipeline.
  const enrichedPriorTunes = await Promise.all((priorTunes || []).map(async (t) => {
    if (t.status !== 'accepted') return t;
    // Window: 30 days after the tune was accepted (or now if more recent).
    const windowStart = t.proposed_at;
    const windowEnd   = new Date(Math.min(Date.now(), new Date(t.proposed_at).getTime() + 30 * 86400_000)).toISOString();
    const addedNames  = (t.changes || [])
      .filter(c => c.op === 'add' || c.op === 'swap')
      .map(c => c.exercise?.name)
      .filter(Boolean);
    if (addedNames.length === 0) return { ...t, _outcome: { reason: 'no_adds' } };
    // Check workout_sets for any session of any added exercise in window.
    // PostgREST `in.()` with names quoted; conservative URL length.
    const namesIn = addedNames.map(n => `"${String(n).replace(/"/g, '')}"`).join(',');
    const trainedRows = await fetchJson(
      `${SUPABASE_URL}/rest/v1/workout_sets?exercise_name=in.(${encodeURIComponent(namesIn)})&select=session_id,exercise_name`,
      hdr,
    );
    const trainedCount = Array.isArray(trainedRows) ? trainedRows.length : 0;
    // Did the focus_area_addressed STILL appear in the latest pic's needs_work?
    const focusStillFlagged = (t.focus_areas_addressed || []).some(fa =>
      needsWork.some(nw => String(nw).toLowerCase().includes(String(fa).toLowerCase()))
    );
    return {
      ...t,
      _outcome: {
        added_exercises:    addedNames,
        trained_sets_count: trainedCount,
        adherence:          trainedCount >= 4 ? 'high' : trainedCount > 0 ? 'partial' : 'none',
        focus_still_flagged_in_latest_pic: focusStillFlagged,
      },
    };
  }));

  // Flatten sets across all sessions for volume rollup.
  const allSets = [];
  for (const s of (recentSessions || [])) {
    if (Array.isArray(s.workout_sets)) allSets.push(...s.workout_sets);
  }
  const last30dVolumeByGroup = weeklyVolumeByGroup(allSets);
  const plannedWeeklyTotal = totalWeeklySets(plan.day_template);

  // Whoop baseline (median) — only computed when health source is Whoop.
  const whoopMedians = (whoop7 && whoop7.length >= 3) ? {
    recovery_median:  median(whoop7.map(r => r.recovery_score).filter(v => v != null)),
    strain_median:    median(whoop7.map(r => r.strain).filter(v => v != null)),
    sleep_perf_median: median(whoop7.map(r => r.sleep_performance).filter(v => v != null)),
  } : null;

  const ctx = {
    user: { id: userId },
    active_plan: {
      id:            plan.id,
      name:          plan.name,
      days_per_week: plan.days_per_week,
      day_template:  plan.day_template,
      total_weekly_sets: plannedWeeklyTotal,
      total_exercises:   countExercises(plan.day_template),
    },
    latest_pic: {
      captured_date:  pic.captured_date,
      weight_lbs:     pic.weight_lbs,
      body_fat_pct:   pic.body_fat_pct,
      ai_analysis:    ai,
    },
    actual_training_last_30d: {
      sessions_logged: (recentSessions || []).length,
      sets_logged:     allSets.length,
      volume_by_group: last30dVolumeByGroup,
    },
    recovery: {
      oura_baselines_7d:  oura7?.[0] || null,
      oura_baselines_30d: oura30?.[0] || null,
      whoop_medians_7d:   whoopMedians,
    },
    goal: goalRows?.[0] || null,
    prior_tunes: enrichedPriorTunes.map(t => ({
      proposed_at:           t.proposed_at,
      status:                t.status,
      focus_areas_addressed: t.focus_areas_addressed,
      changes_summary:       Array.isArray(t.changes)
        ? t.changes.map(c => `${c.op || '?'} ${c.exercise?.name || c.replaces_exercise_name || ''}`.trim()).join('; ')
        : '',
      outcome:               t._outcome || null,
    })),
    constraints: {
      max_changes:           MAX_CHANGES,
      volume_delta_max_pct:  Math.round(VOLUME_DELTA_MAX * 100),
      per_day_exercise_cap:  PER_DAY_EXERCISE_CAP,
      compound_primaries_locked: true,
    },
  };

  // ── Claude call ──────────────────────────────────────────────────────
  let claudeResult;
  try {
    claudeResult = await callClaude(ctx, anthropicKey);
  } catch (err) {
    console.error('[train-tune] claude call failed:', err.message);
    // No proposal persisted in this case — we want to leave the gate open
    // so the next pic gets another shot. (Server-side validation rejections
    // do persist 'expired' rows; pure API errors do not.)
    return { status: 'failed', reason: `claude_error: ${err.message}` };
  }

  // Abstain path — record the audit row but no UI surface.
  if (claudeResult.abstain) {
    await insertTuneRow({
      user_id:                  userId,
      plan_id:                  plan.id,
      progress_pic_id:          pic.id,
      prior_day_template:       plan.day_template,
      proposed_day_template:    plan.day_template,
      changes:                  [],
      rationale:                claudeResult.abstain_reason || null,
      focus_areas_addressed:    [],
      status:                   'expired',
      status_changed_at:        nowISO,
      declined_reason:          `claude_abstained: ${claudeResult.abstain_reason || 'no_reason'}`,
      recommendation_signature: 'plan_tune:abstain',
      conditions_snapshot:      { volume_by_group: last30dVolumeByGroup, needs_work: needsWork },
      model:                    claudeResult.model,
      prompt_tokens:            claudeResult.prompt_tokens,
      completion_tokens:        claudeResult.completion_tokens,
      confidence:               claudeResult.confidence || 'low',
      input_snapshot:           ctx,
    }, serviceKey);
    await markPlanTuneTimestamp(plan.id, null, serviceKey);
    return { status: 'abstained', reason: claudeResult.abstain_reason || 'no_reason' };
  }

  // ── Server-side validation ───────────────────────────────────────────
  const validation = validateProposal(claudeResult, plan);
  if (!validation.ok) {
    const tuneId = await insertTuneRow({
      user_id:                  userId,
      plan_id:                  plan.id,
      progress_pic_id:          pic.id,
      prior_day_template:       plan.day_template,
      proposed_day_template:    plan.day_template,   // policy violation → no actual change
      changes:                  claudeResult.changes || [],
      rationale:                claudeResult.rationale || null,
      focus_areas_addressed:    claudeResult.focus_areas_addressed || [],
      status:                   'expired',
      status_changed_at:        nowISO,
      declined_reason:          `policy_violation: ${validation.reason}`,
      recommendation_signature: `plan_tune:rejected:${validation.code}`,
      conditions_snapshot:      { volume_by_group: last30dVolumeByGroup, needs_work: needsWork },
      model:                    claudeResult.model,
      prompt_tokens:            claudeResult.prompt_tokens,
      completion_tokens:        claudeResult.completion_tokens,
      confidence:               claudeResult.confidence || 'low',
      input_snapshot:           ctx,
    }, serviceKey);
    await markPlanTuneTimestamp(plan.id, tuneId, serviceKey);
    return { status: 'rejected', reason: validation.reason };
  }

  // ── Persist 'pending' proposal ───────────────────────────────────────
  const signature = buildSignature(claudeResult.changes);
  const tuneId = await insertTuneRow({
    user_id:                  userId,
    plan_id:                  plan.id,
    progress_pic_id:          pic.id,
    prior_day_template:       plan.day_template,
    proposed_day_template:    validation.proposed_day_template,
    changes:                  claudeResult.changes,
    rationale:                claudeResult.rationale || null,
    focus_areas_addressed:    claudeResult.focus_areas_addressed || [],
    status:                   'pending',
    status_changed_at:        null,
    declined_reason:          null,
    recommendation_signature: signature,
    conditions_snapshot:      { volume_by_group: last30dVolumeByGroup, needs_work: needsWork, prior_total_sets: plannedWeeklyTotal, proposed_total_sets: validation.projected_total_sets },
    model:                    claudeResult.model,
    prompt_tokens:            claudeResult.prompt_tokens,
    completion_tokens:        claudeResult.completion_tokens,
    confidence:               claudeResult.confidence || 'low',
    input_snapshot:           ctx,
  }, serviceKey);
  await markPlanTuneTimestamp(plan.id, tuneId, serviceKey);

  return { status: 'proposed', tune_id: tuneId, signature, change_count: claudeResult.changes.length };
}

// ── Claude call ───────────────────────────────────────────────────────────
async function callClaude(ctx, anthropicKey) {
  const model = process.env.TRAIN_TUNE_MODEL || DEFAULT_MODEL;
  const tool = {
    name: 'record_plan_tune',
    description: 'Propose a small set of accessory changes (or abstain).',
    input_schema: {
      type: 'object',
      properties: {
        abstain: { type: 'boolean', description: 'True if no tune is warranted this cycle. Use when the active plan already addresses focus areas, recovery is too low to add volume, or no change would meaningfully improve outcomes. Set abstain=false to propose changes.' },
        abstain_reason: { type: 'string', description: 'Required if abstain=true. One sentence ≤160 chars.' },
        rationale: { type: 'string', description: 'Required if abstain=false. ≤400 chars. One paragraph the user reads — the "why" behind the proposed changes, framed around the body feedback. No medical claims. No "I think" filler.' },
        focus_areas_addressed: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
          description: 'Which entries from latest_pic.ai_analysis.needs_work or .focus_areas[].title the proposed changes are aimed at. Verbatim strings from the input.',
        },
        changes: {
          type: 'array',
          minItems: 0,
          maxItems: 3,
          description: 'The tweaks to the active plan. 1–3 entries. Empty array only when abstain=true. Each entry must target an accessory exercise (NOT a compound primary — see constraints.compound_primaries_locked).',
          items: {
            type: 'object',
            properties: {
              op:        { type: 'string', enum: ['add', 'swap', 'remove'] },
              day_name:  { type: 'string', description: 'Matches an existing day in active_plan.day_template[].name (case-sensitive).' },
              exercise: {
                type: 'object',
                properties: {
                  name:    { type: 'string' },
                  sets:    { type: 'number' },
                  reps:    { type: 'string' },
                  rest_s:  { type: 'number' },
                  notes:   { type: 'string' },
                  bodyweight: { type: 'boolean' },
                },
                required: ['name', 'sets', 'reps'],
                description: 'For op=add/swap: the NEW exercise. For op=remove: the field is ignored (use replaces_exercise_name).',
              },
              replaces_exercise_name: { type: 'string', description: 'For op=swap or op=remove: the existing exercise name to replace/remove.' },
              reason: { type: 'string', description: '≤160 chars. The specific weak-area rationale ("hamstrings lagging from side pose" — not "for variety").' },
              focus_area_addressed: { type: 'string', description: 'Which entry from latest_pic.ai_analysis this change targets.' },
            },
            required: ['op', 'day_name', 'reason'],
          },
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['abstain', 'confidence'],
    },
  };

  const systemPrompt = buildSystemPrompt(ctx);

  const body = {
    model:       model,
    max_tokens:  DEFAULT_MAX_TOKENS,
    system:      systemPrompt,
    messages:    [{ role: 'user', content: `Propose a monthly accessory-level tune for this user, or abstain.\n\n${JSON.stringify(ctx, null, 0)}` }],
    tools:       [tool],
    tool_choice: { type: 'tool', name: 'record_plan_tune' },
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
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_plan_tune');
  if (!block) throw new Error(`no_tool_use_in_response: stop_reason=${j.stop_reason}`);
  const raw = block.input || {};

  return {
    abstain:               !!raw.abstain,
    abstain_reason:        raw.abstain_reason || null,
    rationale:             raw.rationale || null,
    focus_areas_addressed: Array.isArray(raw.focus_areas_addressed) ? raw.focus_areas_addressed : [],
    changes:               Array.isArray(raw.changes) ? raw.changes : [],
    confidence:            ['high','medium','low'].includes(raw.confidence) ? raw.confidence : 'low',
    model:                 j.model || model,
    prompt_tokens:         j.usage?.input_tokens || null,
    completion_tokens:     j.usage?.output_tokens || null,
  };
}

function buildSystemPrompt(ctx) {
  return [
    'You are a strength-coach AI proposing a SMALL monthly refinement to the user\'s active workout plan. Your job is to make the plan grow with the user — slight refinements, NEVER a reset.',
    '',
    'LITERATURE BACKING (use as constraints, not as quotes):',
    '- Schoenfeld 2017 dose-response meta-analysis: hypertrophy scales with weekly per-muscle sets; ~10 sets/week is the minimum effective dose, diminishing returns past ~20.',
    '- Renaissance Periodization MEV/MRV framework: stay within ±20% of the current plan\'s total weekly working sets so recovery doesn\'t erode the new stimulus.',
    '- Helms (Muscle & Strength Pyramids): keep compound primaries (bench, squat, deadlift, overhead press, rows, pull-ups) intact — they drive systemic adaptation. Address weak points via accessory frequency and isolation.',
    '- Specificity: an accessory chosen to address a weak area must train that muscle as a PRIMARY mover. Romanian deadlift for hamstrings — yes. Conventional deadlift for hamstrings — no, that\'s already in primaries.',
    '- Mesocycle variation: accessory rotation every 4–8 weeks reduces staleness and overuse without disrupting strength curves.',
    '',
    'HARD RULES (your output is server-validated against these; violations are silently rejected):',
    '- Maximum 3 changes total (constraints.max_changes).',
    '- NEVER propose adding, swapping, or removing a compound primary. The server-side check uses a substring match against ["bench press","incline bench","incline db press","incline dumbbell press","overhead press","military press","push press","dips","deadlift","romanian deadlift","pendlay row","barbell row","pull-up","pullup","chin-up","chinup","lat pulldown","back squat","front squat","high-bar squat","low-bar squat","safety bar squat","hack squat"]. Any change whose exercise.name OR replaces_exercise_name matches one of those phrases is REJECTED.',
    '- Projected total weekly sets must stay within ±20% of active_plan.total_weekly_sets.',
    '- No day in proposed_day_template may contain more than 8 exercises.',
    '- For op="add" or op="swap", exercise.sets must be 2-5 and exercise.reps must be a string like "8-12" or "15-20". Programming should land in the 8-16 sets/week range per added focus area, distributed across 1-2 sessions.',
    '',
    'DECIDE WHETHER TO ABSTAIN. Set abstain=true with abstain_reason when:',
    '- The active plan already directly addresses every needs_work group with appropriate volume (≥8 weekly sets per group).',
    '- Recovery is poor (oura_baselines_7d.readiness_score_median < 60 OR whoop_medians_7d.recovery_median < 50) and adding volume would compound the problem.',
    '- The latest pic has confidence != "high" AND prior_tunes show recent declines — pattern of mis-targeting, back off.',
    '- No proposed change would meaningfully move the body forward — vague tweaks for the sake of tweaking are worse than nothing.',
    '',
    'PROPOSE 1-3 CHANGES when abstaining isn\'t warranted. Order matters — most impactful first. Each change\'s `reason` field must be specific (cite the focus area or weak group), ≤160 chars, no filler.',
    '',
    'AVAILABLE OPERATIONS:',
    '- "add": insert a new accessory into a specific day. Use for: introducing a new isolation movement targeting a needs_work group when the day has room.',
    '- "swap": replace an existing accessory with a different one. Use for: when an accessory is well-targeted but the user is responding poorly (low ratio in volume_by_group despite frequent prescription), or when a different exercise hits the focus area more directly.',
    '- "remove": delete an accessory. Use sparingly — only when a day is saturated AND a clearly redundant accessory exists.',
    '',
    'REFERENCE PRIOR TUNES (ctx.prior_tunes). Each prior_tune carries an `outcome` object for accepted tunes:',
    '  - outcome.adherence ∈ {high, partial, none}: did the user actually train the added/swapped exercises across the next 30 days? `none` means the user accepted the proposal then ignored it — that\'s a stronger negative signal than declining; do NOT propose the same exercise again. Try a different exercise targeting the same area, or a more accessible variation.',
    '  - outcome.focus_still_flagged_in_latest_pic: true means the focus area is still showing up as a needs_work group on the current pic. Combined with high adherence → ESCALATE volume (add a second exercise for the same group, or bump sets) because the dose is below MEV. Combined with low adherence → the recommendation type isn\'t landing; switch exercise.',
    '  - If a focus area resolved (was addressed previously, NOT flagged in latest pic), do NOT keep tuning it — look for a different needs_work group.',
    'For DECLINED tunes, don\'t propose the same change. For REVERTED tunes (accepted then rolled back), treat as a strong negative — the user actively undid it; the exercise/timing was wrong for them.',
    '',
    'VOICE: the rationale is read directly by the user. Direct, concrete, no medical claims, no "I think" filler. Frame around the body feedback. Example: "Hamstrings flagged from your side pose; current plan has 3 weekly sets of hip-hinge work. Adding Romanian deadlift on Pull A and Lying leg curl on Legs B brings posterior chain volume into the effective range without crowding any single day."',
  ].join('\n');
}

// ── Server-side validation ────────────────────────────────────────────────
function validateProposal(claudeResult, plan) {
  const changes = claudeResult.changes || [];
  if (changes.length === 0) return { ok: false, reason: 'no_changes_proposed', code: 'empty' };
  if (changes.length > MAX_CHANGES) return { ok: false, reason: `too_many_changes:${changes.length}`, code: 'too_many' };

  // Apply the changes to a deep copy of the day_template and validate.
  const proposed = JSON.parse(JSON.stringify(plan.day_template || []));
  const dayByName = new Map(proposed.map(d => [d.name, d]));

  for (const ch of changes) {
    if (!ch || !ch.op || !ch.day_name) return { ok: false, reason: 'change_missing_op_or_day', code: 'shape' };
    const day = dayByName.get(ch.day_name);
    if (!day) return { ok: false, reason: `unknown_day:${ch.day_name}`, code: 'unknown_day' };
    if (!Array.isArray(day.exercises)) day.exercises = [];

    if (ch.op === 'add') {
      const ex = ch.exercise || {};
      if (!ex.name) return { ok: false, reason: 'add_missing_name', code: 'shape' };
      if (isCompoundPrimary(ex.name)) return { ok: false, reason: `add_compound_primary:${ex.name}`, code: 'primary_locked' };
      day.exercises.push({
        name:       String(ex.name).slice(0, 80),
        sets:       Number(ex.sets) || 3,
        reps:       String(ex.reps || '8-12').slice(0, 20),
        rest_s:     Number(ex.rest_s) || 90,
        notes:      ex.notes ? String(ex.notes).slice(0, 120) : undefined,
        bodyweight: !!ex.bodyweight,
      });
    } else if (ch.op === 'swap') {
      const replaceName = ch.replaces_exercise_name || '';
      if (!replaceName)  return { ok: false, reason: 'swap_missing_replaces', code: 'shape' };
      if (isCompoundPrimary(replaceName)) return { ok: false, reason: `swap_replaces_primary:${replaceName}`, code: 'primary_locked' };
      const idx = day.exercises.findIndex(e => e.name === replaceName);
      if (idx === -1) return { ok: false, reason: `swap_target_not_found:${replaceName}@${ch.day_name}`, code: 'unknown_exercise' };
      const ex = ch.exercise || {};
      if (!ex.name) return { ok: false, reason: 'swap_missing_new_name', code: 'shape' };
      if (isCompoundPrimary(ex.name)) return { ok: false, reason: `swap_new_compound_primary:${ex.name}`, code: 'primary_locked' };
      day.exercises[idx] = {
        name:       String(ex.name).slice(0, 80),
        sets:       Number(ex.sets) || day.exercises[idx].sets || 3,
        reps:       String(ex.reps || day.exercises[idx].reps || '8-12').slice(0, 20),
        rest_s:     Number(ex.rest_s) || day.exercises[idx].rest_s || 90,
        notes:      ex.notes ? String(ex.notes).slice(0, 120) : undefined,
        bodyweight: !!ex.bodyweight,
      };
    } else if (ch.op === 'remove') {
      const removeName = ch.replaces_exercise_name || ch.exercise?.name || '';
      if (!removeName) return { ok: false, reason: 'remove_missing_target', code: 'shape' };
      if (isCompoundPrimary(removeName)) return { ok: false, reason: `remove_compound_primary:${removeName}`, code: 'primary_locked' };
      const idx = day.exercises.findIndex(e => e.name === removeName);
      if (idx === -1) return { ok: false, reason: `remove_target_not_found:${removeName}@${ch.day_name}`, code: 'unknown_exercise' };
      day.exercises.splice(idx, 1);
    } else {
      return { ok: false, reason: `unknown_op:${ch.op}`, code: 'shape' };
    }

    if (day.exercises.length > PER_DAY_EXERCISE_CAP) {
      return { ok: false, reason: `day_saturated:${ch.day_name}_${day.exercises.length}`, code: 'saturated' };
    }
  }

  // Volume guardrail.
  const priorTotal     = totalWeeklySets(plan.day_template);
  const projectedTotal = totalWeeklySets(proposed);
  const deltaRatio     = priorTotal > 0 ? Math.abs(projectedTotal - priorTotal) / priorTotal : 0;
  if (deltaRatio > VOLUME_DELTA_MAX) {
    return { ok: false, reason: `volume_delta_${Math.round(deltaRatio * 100)}pct_exceeds_${Math.round(VOLUME_DELTA_MAX*100)}pct`, code: 'volume' };
  }

  return { ok: true, proposed_day_template: proposed, projected_total_sets: projectedTotal };
}

// ── Persistence helpers ───────────────────────────────────────────────────
async function insertTuneRow(row, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/workout_plan_tunes`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`workout_plan_tunes insert ${r.status}: ${text.slice(0, 200)}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0]?.id : rows?.id;
}

// Stamp the plan with the latest tune timestamp + id, even when the proposal
// was abstained or rejected. This is what closes the 28-day gate.
async function markPlanTuneTimestamp(planId, tuneId, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/workout_plans?id=eq.${planId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          'return=minimal',
    },
    body: JSON.stringify({
      last_plan_tune_at: new Date().toISOString(),
      last_plan_tune_id: tuneId || null,
    }),
  });
  if (!r.ok) {
    console.warn('[train-tune] markPlanTuneTimestamp failed:', r.status);
  }
}

// Stable signature for the proposal, used downstream by Phase 10 efficacy
// rollups. We include the focus areas + operation summary so the signature
// captures "what kind of tune this was" (e.g. "add_for_hamstrings_glutes")
// without being so specific that variants don't aggregate.
function buildSignature(changes) {
  const focusBits = new Set();
  const opBits    = new Set();
  for (const c of (changes || [])) {
    if (c.focus_area_addressed) focusBits.add(slug(c.focus_area_addressed));
    if (c.op) opBits.add(c.op);
  }
  const focus = Array.from(focusBits).sort().join('+') || 'general';
  const ops   = Array.from(opBits).sort().join('+')    || 'change';
  return `plan_tune:${ops}_for_${focus}`;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

// ── Misc helpers ──────────────────────────────────────────────────────────
async function emailForUser(userId, hdr) {
  const rows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/user_profiles?supabase_user_id=eq.${userId}&select=email&limit=1`,
    hdr,
  );
  return rows?.[0]?.email || '';
}

async function fetchJson(url, hdr) {
  try {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) {
      console.warn(`[train-tune] fetch ${url.slice(0,120)} HTTP ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (err) {
    console.warn(`[train-tune] fetch failed: ${err.message}`);
    return [];
  }
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => Number(a) - Number(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (Number(sorted[mid - 1]) + Number(sorted[mid])) / 2 : Number(sorted[mid]);
}

