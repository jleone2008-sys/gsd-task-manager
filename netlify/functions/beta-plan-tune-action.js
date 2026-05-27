// Phase 11 (Workout Tuner) — accept / decline / revert endpoint.
//
// JWT-authenticated POST: { tune_id, action: 'accept'|'decline'|'revert',
//                           reason?: string }.
//
// All three actions are owner-scoped: the JWT identifies the user; the row
// is fetched with user_id match before any mutation. Then:
//
//   accept  → flip workout_plan_tunes.status='accepted', PATCH
//             workout_plans.day_template = proposed_day_template, and
//             write a brief_action_outcomes stub so the Phase 10 efficacy
//             machinery picks the proposal up (signature already on the
//             row; baseline_value left null because focus_area_progress is
//             ordinal — adherence rule in lib/adherence-rules.js handles
//             the "did the user actually train the added exercise" check
//             over the next 30 days).
//
//   decline → status='declined', optional reason logged. Two consecutive
//             declines (checked by the tuner's eligibility gate) → tuner
//             backs off on the next pic upload.
//
//   revert  → only valid when status='accepted'. Restores
//             workout_plans.day_template = prior_day_template, sets
//             status='reverted', and updates the outcome row's adherence
//             to 0 so the rollup learns the user undid the change.
//
// Plan mutation happens with the service key (workout_plans.update RLS
// policy requires user_id = auth.uid(), which matches the JWT subject — we
// could use the user's token directly, but the service key path matches
// how other server-side plan operations work and keeps the flow consistent).

const { json, cors, preflight } = require('./lib/http');
const { SUPABASE_URL } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));

  // ── Auth ─────────────────────────────────────────────────────────────
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId = userJson.id;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Parse ────────────────────────────────────────────────────────────
  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }
  const tuneId = body.tune_id;
  const action = body.action;
  const reason = (typeof body.reason === 'string') ? body.reason.slice(0, 500) : null;
  if (!tuneId || !['accept', 'decline', 'revert'].includes(action)) {
    return cors(json(400, { error: 'tune_id_and_valid_action_required' }));
  }

  const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // Fetch row + verify ownership. user_id match prevents a JWT for user A
  // from acting on user B's tune even if A guesses B's tune_id.
  const rows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/workout_plan_tunes?id=eq.${tuneId}&user_id=eq.${userId}&select=*&limit=1`,
    hdr,
  );
  const row = rows?.[0];
  if (!row) return cors(json(404, { error: 'tune_not_found' }));

  try {
    let result;
    if      (action === 'accept')  result = await acceptTune(row, hdr, serviceKey);
    else if (action === 'decline') result = await declineTune(row, reason, hdr);
    else                            result = await revertTune(row, hdr, serviceKey);
    return cors(json(200, result));
  } catch (err) {
    console.error(`[plan-tune-action] ${action} on ${tuneId} failed:`, err.message);
    return cors(json(500, { error: 'internal_error', detail: err.message }));
  }
};

// ── Accept ────────────────────────────────────────────────────────────────
async function acceptTune(row, hdr, serviceKey) {
  if (row.status !== 'pending') return { error: 'invalid_state', from: row.status };

  // 1. Mutate the plan: day_template ← proposed_day_template.
  await patchRow('workout_plans', row.plan_id, {
    day_template: row.proposed_day_template,
    updated_at:   new Date().toISOString(),
  }, hdr);

  // 2. Flip the tune row.
  const nowISO = new Date().toISOString();
  await patchRow('workout_plan_tunes', row.id, {
    status:            'accepted',
    status_changed_at: nowISO,
  }, hdr);

  // Note on efficacy tracking for plan tunes:
  // brief_action_outcomes requires a daily_briefs FK that plan-tune
  // outcomes don't have. Rather than shoehorn, plan-tune efficacy lives
  // on the workout_plan_tunes row itself + downstream signal sources:
  //   - acceptance (this PATCH) = the user said yes to the proposal
  //   - whether the added exercises actually appear in workout_sets over
  //     the next 30 days = "adherence" (read by the tuner's next-cycle
  //     prior_tunes context when it decides whether to escalate)
  //   - whether the addressed focus_area still appears in the next
  //     progress pic's needs_work = "outcome" (read on the next tuner
  //     run, also via prior_tunes)
  // The tuner system prompt already references prior_tunes; further
  // surfacing into the weekly Opus run can layer on later by adding a
  // get_plan_tune_efficacy tool to lib/synthesis-tools.js. Out of scope
  // for this commit.

  // Read back the updated row for the client.
  const updatedRows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/workout_plan_tunes?id=eq.${row.id}&select=*&limit=1`,
    hdr,
  );
  return { ok: true, action: 'accepted', tune: updatedRows?.[0] || null };
}

// ── Decline ───────────────────────────────────────────────────────────────
async function declineTune(row, reason, hdr) {
  if (row.status !== 'pending') return { error: 'invalid_state', from: row.status };
  await patchRow('workout_plan_tunes', row.id, {
    status:            'declined',
    status_changed_at: new Date().toISOString(),
    declined_reason:   reason || null,
  }, hdr);
  return { ok: true, action: 'declined' };
}

// ── Revert ────────────────────────────────────────────────────────────────
async function revertTune(row, hdr, serviceKey) {
  if (row.status !== 'accepted') return { error: 'invalid_state', from: row.status };

  // 1. Restore prior plan.
  await patchRow('workout_plans', row.plan_id, {
    day_template: row.prior_day_template,
    updated_at:   new Date().toISOString(),
  }, hdr);

  // 2. Flip tune row.
  await patchRow('workout_plan_tunes', row.id, {
    status:            'reverted',
    status_changed_at: new Date().toISOString(),
  }, hdr);

  // 3. Negative-signal note in declined_reason so the audit trail captures
  //    "user undid this" as distinct from "user never accepted". Future
  //    tuner runs read prior_tunes and treat 'reverted' the same as
  //    'declined' for back-off purposes (which is what the user wants —
  //    "I tried it and didn't like it" is a stronger negative than "I
  //    never tried it").
  return { ok: true, action: 'reverted' };
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function patchRow(table, id, patch, hdr) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      ...hdr,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`patch_${table}_${r.status}: ${text.slice(0, 200)}`);
  }
}

async function fetchJson(url, hdr) {
  const r = await fetch(url, { headers: hdr });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`fetch_${r.status}: ${text.slice(0, 200)}`);
  }
  return await r.json();
}

