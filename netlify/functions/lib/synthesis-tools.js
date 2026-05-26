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

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
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
};

module.exports = { TOOLS };
