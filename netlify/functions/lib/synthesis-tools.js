// Phase 7 — toolset for the weekly synthesis agentic loop.
//
// Each export here is the SERVER-SIDE handler that runs when Claude
// calls a tool by name. The agentic-loop driver (lib/agentic-loop.js)
// passes user context (userId, userEmail, serviceKey) + the tool's
// args (validated client-side by Claude against input_schema) and
// expects a JSON-serializable result back.
//
// These same tools become available to the Phase 8 agentic chat
// surface — anything Claude can call here, it can call there too.
//
// Tool naming convention: snake_case verb_object. Each tool returns
// a flat object (or array of objects) suitable to be JSON-stringified
// into Claude's next-turn context.
//
// All DB access goes through the service key with explicit user_id
// enforcement on every query. The agentic loop has already validated
// the calling user; tools trust the userId param.

const { SUPABASE_URL } = require('./supabase');
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';

// ── query_baselines ──────────────────────────────────────────────────
// Returns user baselines from the materialized view that matches the
// requested window (7d or 30d). Used for "what's normal for me" reads.
//
// Args: { window: '7d' | '30d' }
// Returns: the matching baselines row, or null if not yet computed.

async function query_baselines({ window }, ctx) {
  const view = (window === '7d') ? 'v_user_baselines_7d' : 'v_user_baselines_30d';
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${view}?user_id=eq.${ctx.userId}&select=*`,
    { headers: ctx.hdr() },
  );
  if (!r.ok) throw new Error(`baselines_${window}_fetch_${r.status}`);
  const rows = await r.json();
  return rows?.[0] || null;
}

// ── query_daily_rows ─────────────────────────────────────────────────
// Pulls raw daily-grain rows from one of the user's time-series
// tables for the given window. Used when Opus needs to look at
// individual days rather than aggregates.
//
// Args:
//   table: 'oura_daily' | 'journal_entries' | 'workout_sessions' |
//          'journal_habit_summary'
//   start_date, end_date: 'YYYY-MM-DD'
//   columns: array of column names (subset of the table's columns)
//
// Returns: array of rows, ordered date ASC.

const TABLE_DATE_COL = {
  oura_daily:             { dateCol: 'date',         userMatch: 'email' },
  journal_entries:        { dateCol: 'entry_date',   userMatch: 'id' },
  workout_sessions:       { dateCol: 'session_date', userMatch: 'id' },
  journal_habit_summary:  { dateCol: 'entry_date',   userMatch: 'id' },
  habit_completions:      { dateCol: 'completed_date', userMatch: 'id' },
};

async function query_daily_rows({ table, start_date, end_date, columns }, ctx) {
  const meta = TABLE_DATE_COL[table];
  if (!meta) throw new Error(`unknown_table: ${table}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    throw new Error('invalid_date_format');
  }
  // Whitelist columns — only allow the dateCol + a sensible default
  // set per table to avoid arbitrary column reads. Caller's columns
  // is treated as a hint; we always include the date column.
  const safeColumns = Array.isArray(columns) && columns.length
    ? Array.from(new Set([meta.dateCol, ...columns.map(c => String(c).replace(/[^a-z_]/gi, ''))]))
    : ['*'];
  const userFilter = meta.userMatch === 'email'
    ? `user_email=eq.${encodeURIComponent(ctx.userEmail)}`
    : `user_id=eq.${ctx.userId}`;
  const url = `${SUPABASE_URL}/rest/v1/${table}`
    + `?${userFilter}`
    + `&${meta.dateCol}=gte.${start_date}`
    + `&${meta.dateCol}=lte.${end_date}`
    + `&select=${encodeURIComponent(safeColumns.join(','))}`
    + `&order=${meta.dateCol}.asc`
    + `&limit=400`;
  const r = await fetch(url, { headers: ctx.hdr() });
  if (!r.ok) throw new Error(`${table}_fetch_${r.status}`);
  return await r.json();
}

// ── search_patterns ──────────────────────────────────────────────────
// Full-text search across the user's existing patterns. Used by the
// weekly synthesis to: (a) avoid re-discovering the same pattern,
// (b) strengthen recurring patterns by bumping last_seen_at.
//
// Args: { query: string, include_dismissed?: bool }
// Returns: array of matching patterns (top 10 by relevance).

async function search_patterns({ query, include_dismissed }, ctx) {
  // Use the GIN tsvector index from patterns_discovered.sql via
  // PostgREST's full-text search operator.
  const userFilter = `user_id=eq.${ctx.userId}`;
  const dismissedFilter = include_dismissed ? '' : '&dismissed_by_user=eq.false';
  // PostgREST 'fts' operator runs to_tsquery
  const q = String(query || '').slice(0, 200).replace(/[^a-z0-9\s]/gi, ' ').trim().split(/\s+/).filter(Boolean).join(' & ');
  if (!q) return [];
  const url = `${SUPABASE_URL}/rest/v1/patterns_discovered`
    + `?${userFilter}${dismissedFilter}`
    + `&select=id,label,description,evidence_window,n,strength_score,last_seen_at,dismissed_by_user`
    + `&or=(label.ilike.*${encodeURIComponent(q.replace(/ & /g, '*'))}*,description.ilike.*${encodeURIComponent(q.replace(/ & /g, '*'))}*)`
    + `&limit=10`;
  const r = await fetch(url, { headers: ctx.hdr() });
  if (!r.ok) throw new Error(`patterns_search_${r.status}`);
  return await r.json();
}

// ── search_knowledge ─────────────────────────────────────────────────
// Semantic search against the user's RAG corpus (knowledge_chunks).
// Same path the beta-knowledge-search Netlify function exposes —
// reused here so the weekly synthesis can pull relevant bloodwork /
// articles / notes when reasoning.
//
// Args: { query: string, top_k?: number }
// Returns: array of chunks with parent document context.

async function search_knowledge({ query, top_k }, ctx) {
  const text = String(query || '').trim();
  if (!text) return [];
  if (!ctx.openaiKey) throw new Error('openai_key_missing');
  const k = Math.min(10, Math.max(1, parseInt(top_k, 10) || 5));

  // Embed the query via OpenAI text-embedding-3-small (1536-dim) —
  // must match the model used by knowledge_ingest so the cosine
  // distance is comparable.
  const embedRes = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ctx.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
  });
  const embedJson = await embedRes.json();
  if (!embedRes.ok) throw new Error(`openai_embed_${embedRes.status}`);
  const queryVec = embedJson.data?.[0]?.embedding;
  if (!Array.isArray(queryVec) || queryVec.length !== 1536) throw new Error('embed_bad_shape');
  const queryVecLit = '[' + queryVec.map(v => v.toFixed(6)).join(',') + ']';

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge_chunks`, {
    method: 'POST',
    headers: { ...ctx.hdr(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_user_id: ctx.userId,
      query_embedding: queryVecLit,
      match_count: k,
    }),
  });
  if (!rpcRes.ok) throw new Error(`rpc_search_${rpcRes.status}`);
  const chunks = await rpcRes.json();
  // Annotate each chunk with age_days so Claude can frame freshness.
  const now = Date.now();
  return (chunks || []).map(c => ({
    ...c,
    // We don't have document uploaded_at in the RPC return shape — that
    // would need a small RPC tweak. For now the document_kind and
    // similarity score guide Claude's relevance judgment.
  }));
}

// ── compute_correlation ──────────────────────────────────────────────
// Pearson correlation between two daily-grain metrics across a window.
// Server-side computation so Opus doesn't have to do arithmetic.
//
// Args:
//   metric_a, metric_b: { table, column } — uses query_daily_rows under
//                       the hood for each
//   start_date, end_date: 'YYYY-MM-DD'
//   lag_days?: int — shift metric_b by N days (e.g. compare today's
//              sleep with tomorrow's mood)
//
// Returns: { r, n, p_approx, sample_size_warning? }

async function compute_correlation({ metric_a, metric_b, start_date, end_date, lag_days }, ctx) {
  if (!metric_a?.table || !metric_a?.column || !metric_b?.table || !metric_b?.column) {
    throw new Error('metric_a and metric_b each require {table, column}');
  }
  const lag = parseInt(lag_days, 10) || 0;
  const [rowsA, rowsB] = await Promise.all([
    query_daily_rows({ table: metric_a.table, start_date, end_date, columns: [metric_a.column] }, ctx),
    query_daily_rows({ table: metric_b.table, start_date, end_date, columns: [metric_b.column] }, ctx),
  ]);
  const metaA = TABLE_DATE_COL[metric_a.table];
  const metaB = TABLE_DATE_COL[metric_b.table];
  const mapA = new Map(rowsA.map(r => [r[metaA.dateCol], Number(r[metric_a.column])]).filter(([, v]) => Number.isFinite(v)));
  const mapB = new Map(rowsB.map(r => [r[metaB.dateCol], Number(r[metric_b.column])]).filter(([, v]) => Number.isFinite(v)));

  const pairs = [];
  for (const [date, a] of mapA) {
    const targetDate = lag === 0 ? date : shiftDate(date, lag);
    const b = mapB.get(targetDate);
    if (b != null && Number.isFinite(a) && Number.isFinite(b)) {
      pairs.push([a, b]);
    }
  }
  if (pairs.length < 5) {
    return { r: null, n: pairs.length, p_approx: null, sample_size_warning: 'fewer_than_5_pairs' };
  }
  const n = pairs.length;
  const meanA = pairs.reduce((s, [a]) => s + a, 0) / n;
  const meanB = pairs.reduce((s, [, b]) => s + b, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (const [a, b] of pairs) {
    const da = a - meanA, db = b - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const r = (denA > 0 && denB > 0) ? num / Math.sqrt(denA * denB) : 0;
  // Approximate two-tailed p via t-distribution. Good enough for the
  // "is this real" judgment Opus needs; precise stats would import
  // a t-table.
  const t = Math.abs(r) * Math.sqrt((n - 2) / Math.max(1e-9, 1 - r * r));
  const p_approx = t > 4 ? 0.001 : t > 3 ? 0.005 : t > 2 ? 0.05 : t > 1.5 ? 0.15 : 0.3;
  return { r: Number(r.toFixed(3)), n, p_approx };
}

function shiftDate(ymd, deltaDays) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ── get_action_efficacy ──────────────────────────────────────────────
// Phase 10. Pulls the user's per-signature, per-variant efficacy stats
// from v_user_action_efficacy. Filter by signature (or signature prefix)
// to zoom in; omit to get the full profile.
//
// Returns rows shaped:
//   { signature, variant_id, source_metric, n_observations, mean_adherence,
//     n_followed, n_ignored,
//     mean_delta_t1_when_followed, mean_delta_t1_when_ignored,
//     mean_delta_t3_when_followed, mean_delta_t3_when_ignored,
//     stddev_delta_t1_when_followed, last_seen_at }
//
// Use to determine whether a recommendation type is actually helping
// the user. n_followed >= 10 AND signed difference between followed
// and ignored is the "real signal" threshold. Variants of the same
// signature compete head-to-head (e.g. bedtime_target:21:30/early vs
// bedtime_target:22:00/standard).

async function get_action_efficacy({ signature, signature_prefix, min_n }, ctx) {
  let filter = `user_id=eq.${ctx.userId}`;
  if (signature)        filter += `&recommendation_signature=eq.${encodeURIComponent(signature)}`;
  else if (signature_prefix) filter += `&recommendation_signature=like.${encodeURIComponent(signature_prefix + '%')}`;
  if (min_n != null)    filter += `&n_observations=gte.${parseInt(min_n, 10) || 1}`;
  const url = `${SUPABASE_URL}/rest/v1/v_user_action_efficacy?${filter}&select=*&order=n_observations.desc&limit=50`;
  const r = await fetch(url, { headers: ctx.hdr() });
  if (!r.ok) throw new Error(`efficacy_fetch_${r.status}`);
  return await r.json();
}

// ── get_raw_outcomes ─────────────────────────────────────────────────
// Phase 10. Pulls raw brief_action_outcomes rows for deeper inspection
// when the aggregate in v_user_action_efficacy looks anomalous. Use to
// answer questions like "why is the followed-vs-ignored delta zero —
// is it because adherence varies by day-of-week, or because outcome
// variance swamps the signal?"
//
// Args: { signature, last_n_days? }
// Returns: array of outcome rows (cap 100), ordered brief_date DESC.

async function get_raw_outcomes({ signature, last_n_days }, ctx) {
  if (!signature) throw new Error('signature_required');
  const days = parseInt(last_n_days, 10) || 60;
  const start = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  })();
  const url = `${SUPABASE_URL}/rest/v1/brief_action_outcomes`
    + `?user_id=eq.${ctx.userId}`
    + `&recommendation_signature=eq.${encodeURIComponent(signature)}`
    + `&brief_date=gte.${start}`
    + `&select=brief_date,brief_mode,variant_id,baseline_value,value_at_t_plus_1,value_at_t_plus_3,adherence_score,adherence_evidence,conditions_snapshot,computed_at`
    + `&order=brief_date.desc&limit=100`;
  const r = await fetch(url, { headers: ctx.hdr() });
  if (!r.ok) throw new Error(`raw_outcomes_${r.status}`);
  return await r.json();
}

// ── get_plan_tune_efficacy ───────────────────────────────────────────
// Phase 11. Aggregates workout_plan_tunes by signature → accept rate,
// revert rate, and (when a NEXT progress pic exists ≥14 days later)
// whether the focus area was resolved on that next pic. Because plan-
// tune outcomes have a different shape than brief outcomes (no T+1/T+3
// metric delta — the outcome is ordinal: was the focus_area still
// flagged?), they don't fit v_user_action_efficacy and need this
// dedicated tool.
//
// Inputs: { signature_prefix? }  — defaults to 'plan_tune:' (all tunes
//   except rejected ones, which use 'plan_tune:rejected:').
//
// Output rows shape:
//   { signature, n_proposed, n_accepted, n_declined, n_reverted,
//     n_expired, accept_rate, revert_rate, focus_areas_addressed[],
//     n_resolved_on_next_pic, n_with_next_pic, focus_resolution_rate,
//     last_proposed_at }
//
// Use to answer:
//   - Which tune kinds is the user actually accepting?
//   - Which ones did they accept and immediately revert (signal that
//     the tune was wrong, not just unwanted)?
//   - For accepted tunes that had a follow-up pic, did the targeted
//     focus area drop off the needs_work list? (= the proposal worked)
async function get_plan_tune_efficacy({ signature_prefix }, ctx) {
  const prefix = signature_prefix || 'plan_tune:';
  // 1. Pull all tunes matching prefix.
  const tunesUrl = `${SUPABASE_URL}/rest/v1/workout_plan_tunes`
    + `?user_id=eq.${ctx.userId}`
    + `&recommendation_signature=like.${encodeURIComponent(prefix + '%')}`
    + `&select=id,recommendation_signature,status,proposed_at,focus_areas_addressed,progress_pic_id`
    + `&order=proposed_at.asc`
    + `&limit=200`;
  const tunesRes = await fetch(tunesUrl, { headers: ctx.hdr() });
  if (!tunesRes.ok) throw new Error(`tunes_fetch_${tunesRes.status}`);
  const tunes = await tunesRes.json();
  if (!Array.isArray(tunes) || tunes.length === 0) return [];

  // 2. For each accepted tune, look up the NEXT progress_pics row
  //    captured >= 14 days after the tune's proposed_at — that's the
  //    earliest follow-up that can plausibly show body response. Pull
  //    its ai_analysis.needs_work to check whether the addressed focus
  //    areas are still flagged.
  //    Done in one batch fetch: collect all (proposed_at, focus_areas)
  //    pairs that need lookup, then one query for the user's pics in
  //    that window. Match in memory.
  const accepted = tunes.filter(t => t.status === 'accepted');
  let resolvedMap = new Map();   // tune_id → true/false (or undefined if no follow-up)
  if (accepted.length > 0) {
    const earliestProposed = accepted.reduce((acc, t) =>
      (!acc || t.proposed_at < acc) ? t.proposed_at : acc, null);
    const startDate = new Date(new Date(earliestProposed).getTime() + 14 * 86400_000).toISOString().slice(0, 10);
    const picsUrl = `${SUPABASE_URL}/rest/v1/progress_pics`
      + `?user_id=eq.${ctx.userId}`
      + `&captured_date=gte.${startDate}`
      + `&ai_analysis=not.is.null`
      + `&select=id,captured_date,ai_analysis`
      + `&order=captured_date.asc&limit=50`;
    const picsRes = await fetch(picsUrl, { headers: ctx.hdr() });
    if (picsRes.ok) {
      const pics = await picsRes.json();
      for (const tune of accepted) {
        const cutoff = new Date(new Date(tune.proposed_at).getTime() + 14 * 86400_000).toISOString().slice(0, 10);
        const nextPic = (pics || []).find(p => p.captured_date >= cutoff);
        if (!nextPic) continue;
        const needsWork = Array.isArray(nextPic.ai_analysis?.needs_work) ? nextPic.ai_analysis.needs_work.map(s => String(s).toLowerCase()) : [];
        const focus = (tune.focus_areas_addressed || []).map(s => String(s).toLowerCase());
        // Resolved when NONE of the addressed focus areas appear in the
        // next pic's needs_work. Partial-overlap counts as not-resolved.
        const resolved = focus.length > 0 && !focus.some(f => needsWork.some(n => n.includes(f) || f.includes(n)));
        resolvedMap.set(tune.id, resolved);
      }
    }
  }

  // 3. Aggregate by signature.
  const bySig = {};
  for (const t of tunes) {
    const sig = t.recommendation_signature;
    if (!bySig[sig]) {
      bySig[sig] = {
        signature:                sig,
        n_proposed:               0,
        n_accepted:               0,
        n_declined:               0,
        n_reverted:               0,
        n_expired:                0,
        focus_areas_addressed:    new Set(),
        n_resolved_on_next_pic:   0,
        n_with_next_pic:          0,
        last_proposed_at:         t.proposed_at,
      };
    }
    const b = bySig[sig];
    b.n_proposed++;
    if (t.status === 'accepted') b.n_accepted++;
    if (t.status === 'declined') b.n_declined++;
    if (t.status === 'reverted') b.n_reverted++;
    if (t.status === 'expired')  b.n_expired++;
    if (t.proposed_at > b.last_proposed_at) b.last_proposed_at = t.proposed_at;
    for (const fa of (t.focus_areas_addressed || [])) b.focus_areas_addressed.add(fa);
    if (resolvedMap.has(t.id)) {
      b.n_with_next_pic++;
      if (resolvedMap.get(t.id)) b.n_resolved_on_next_pic++;
    }
  }

  // 4. Compute rates + flatten.
  return Object.values(bySig).map(b => ({
    signature:               b.signature,
    n_proposed:              b.n_proposed,
    n_accepted:              b.n_accepted,
    n_declined:              b.n_declined,
    n_reverted:              b.n_reverted,
    n_expired:               b.n_expired,
    accept_rate:             b.n_proposed > 0 ? Number((b.n_accepted / b.n_proposed).toFixed(2)) : 0,
    revert_rate:             b.n_accepted > 0 ? Number((b.n_reverted / b.n_accepted).toFixed(2)) : 0,
    focus_areas_addressed:   Array.from(b.focus_areas_addressed),
    n_with_next_pic:         b.n_with_next_pic,
    n_resolved_on_next_pic:  b.n_resolved_on_next_pic,
    focus_resolution_rate:   b.n_with_next_pic > 0 ? Number((b.n_resolved_on_next_pic / b.n_with_next_pic).toFixed(2)) : null,
    last_proposed_at:        b.last_proposed_at,
  })).sort((a, b) => b.n_proposed - a.n_proposed);
}

// ── Tool registry exposed to the agentic loop ────────────────────────
// Each entry: { def: Anthropic tool definition, handler: async fn }

const TOOLS = {
  query_baselines: {
    def: {
      name: 'query_baselines',
      description: 'Returns the user\'s baseline statistics (medians, etc.) for the requested window. Use to ground "is this normal for me" judgments.',
      input_schema: {
        type: 'object',
        properties: {
          window: { type: 'string', enum: ['7d', '30d'] },
        },
        required: ['window'],
      },
    },
    handler: query_baselines,
  },
  query_daily_rows: {
    def: {
      name: 'query_daily_rows',
      description: 'Pulls raw daily-grain rows for inspection. Use when aggregates aren\'t enough and you need to see individual days.',
      input_schema: {
        type: 'object',
        properties: {
          table:      { type: 'string', enum: Object.keys(TABLE_DATE_COL) },
          start_date: { type: 'string', description: 'YYYY-MM-DD' },
          end_date:   { type: 'string', description: 'YYYY-MM-DD' },
          columns:    { type: 'array', items: { type: 'string' }, description: 'Subset of columns to return. Date column is always included.' },
        },
        required: ['table', 'start_date', 'end_date'],
      },
    },
    handler: query_daily_rows,
  },
  search_patterns: {
    def: {
      name: 'search_patterns',
      description: 'Search the user\'s previously-discovered patterns by label/description. Use to avoid re-discovering known patterns and to strengthen recurring ones.',
      input_schema: {
        type: 'object',
        properties: {
          query:             { type: 'string' },
          include_dismissed: { type: 'boolean', description: 'Default false. Pass true to also see patterns the user has dismissed.' },
        },
        required: ['query'],
      },
    },
    handler: search_patterns,
  },
  search_knowledge: {
    def: {
      name: 'search_knowledge',
      description: 'Semantic search across the user\'s knowledge base (uploaded PDFs, articles, notes, lab panels). Use when investigating a hypothesis where a specific document may have relevant context (e.g. "what does my recent bloodwork say about CV risk").',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
    handler: search_knowledge,
  },
  compute_correlation: {
    def: {
      name: 'compute_correlation',
      description: 'Compute Pearson correlation between two daily-grain metrics across a date range. Optional lag_days lets you check "today\'s X vs tomorrow\'s Y" effects.',
      input_schema: {
        type: 'object',
        properties: {
          metric_a:   { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' } }, required: ['table', 'column'] },
          metric_b:   { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' } }, required: ['table', 'column'] },
          start_date: { type: 'string' },
          end_date:   { type: 'string' },
          lag_days:   { type: 'integer', description: 'Default 0. Positive = metric_b shifted later (e.g. lag=1 = today\'s A vs tomorrow\'s B).' },
        },
        required: ['metric_a', 'metric_b', 'start_date', 'end_date'],
      },
    },
    handler: compute_correlation,
  },
  get_action_efficacy: {
    def: {
      name: 'get_action_efficacy',
      description: 'Phase 10 — read the user\'s response profile to past brief recommendations. Each row gives n_observations + mean_adherence + mean source_metric delta when the user followed (adherence >= 0.7) vs ignored (<= 0.3) the suggestion. Use to judge which recommendation TYPES are actually helping this user, to identify A/B variant winners, and to surface findings to patterns_discovered when one variant clearly beats another (n_followed >= 10 per arm).',
      input_schema: {
        type: 'object',
        properties: {
          signature:        { type: 'string', description: 'Exact match on recommendation_signature (e.g. "bedtime_target:21:30").' },
          signature_prefix: { type: 'string', description: 'Prefix match on recommendation_signature (e.g. "bedtime_target" to get all bedtime variants).' },
          min_n:            { type: 'integer', description: 'Filter to signatures with at least this many observations. Defaults to no filter.' },
        },
      },
    },
    handler: get_action_efficacy,
  },
  get_raw_outcomes: {
    def: {
      name: 'get_raw_outcomes',
      description: 'Phase 10 — pull raw brief_action_outcomes rows for one signature so you can inspect specific days when the aggregate looks anomalous. Returns conditions_snapshot per row so you can check whether efficacy varies by readiness band, day of week, etc.',
      input_schema: {
        type: 'object',
        properties: {
          signature:    { type: 'string', description: 'Exact recommendation_signature.' },
          last_n_days:  { type: 'integer', description: 'Default 60.' },
        },
        required: ['signature'],
      },
    },
    handler: get_raw_outcomes,
  },
  get_plan_tune_efficacy: {
    def: {
      name: 'get_plan_tune_efficacy',
      description: 'Phase 11 — read the user\'s acceptance + outcome track record on AI-proposed monthly workout-plan tweaks (workout_plan_tunes). Each signature is "plan_tune:add_for_hamstrings" / "plan_tune:swap_for_chest" style. Returns per-signature: n_proposed, accept_rate, revert_rate, focus_resolution_rate (did the targeted needs_work area drop off the next progress pic). Use to identify which tune kinds actually help — high accept + high resolution = working; high accept + low resolution = wrong angle; high accept + high revert = user felt it was bad in practice.',
      input_schema: {
        type: 'object',
        properties: {
          signature_prefix: { type: 'string', description: 'Prefix match on recommendation_signature. Default "plan_tune:" pulls every tune (except rejected ones, which use the "plan_tune:rejected:" namespace). Pass e.g. "plan_tune:add" to narrow to addition-only tunes.' },
        },
      },
    },
    handler: get_plan_tune_efficacy,
  },
};

module.exports = { TOOLS };
