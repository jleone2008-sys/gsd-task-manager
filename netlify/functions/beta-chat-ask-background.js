// Phase 8 — Ask chat background function.
//
// Receives one user message, runs the agentic-loop with the same
// toolset as the weekly synthesis (synthesis-tools.TOOLS), persists
// the user message + the assistant response into chat_messages.
//
// Reuses everything from Phase 7:
//   - lib/agentic-loop.js   — multi-turn runner
//   - lib/synthesis-tools.js — query_baselines / query_daily_rows /
//                              search_patterns / search_knowledge /
//                              compute_correlation
//
// JWT-authenticated POST:
//   { thread_date, content, client_msg_id, assistant_msg_id }
//
// Both message IDs come from the client (so the UI can render
// optimistically before the server round-trip).
//
// Pipeline:
//   a. Insert the user message row (status='complete') with the
//      client-supplied client_msg_id.
//   b. Insert an assistant PLACEHOLDER row with id=assistant_msg_id
//      and status='streaming' — client polls this id for updates.
//   c. Load conversation history for this thread (ordered ASC) +
//      a chunk of recent daily briefs + last week's weekly brief as
//      conversation seed.
//   d. Build the system prompt + initial message + tool list.
//      Conversation history goes in as alternating user/assistant
//      turns; the new user message is the last user turn.
//   e. Run the agentic loop.
//   f. Patch the assistant placeholder row with:
//        content = final_text
//        status = 'complete' | 'failed'
//        model, prompt_tokens, completion_tokens, iterations,
//        tool_calls_log
//   g. Return 202 to caller — client polls the assistant_msg_id row.

const SUPABASE_URL = 'https://dmuwncwptvnnlizuxhta.supabase.co';
const KNOWLEDGE_MODEL = process.env.KNOWLEDGE_MODEL || 'claude-opus-4-7';
const CHAT_MAX_TOKENS = 2048;
const CHAT_MAX_ITER   = 10;

const { TOOLS } = require('./lib/synthesis-tools');
const { runAgenticLoop } = require('./lib/agentic-loop');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 204, body: '' });
  if (event.httpMethod !== 'POST')    return cors(json(405, { error: 'method_not_allowed' }));

  const serviceKey   = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  if (!serviceKey)   return cors(json(500, { error: 'server_misconfigured', detail: 'SUPABASE_SERVICE_KEY' }));
  if (!anthropicKey) return cors(json(500, { error: 'server_misconfigured', detail: 'ANTHROPIC_API_KEY' }));

  // ── Auth (JWT only — no cron path) ──────────────────────────────
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return cors(json(401, { error: 'missing_token' }));
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) return cors(json(401, { error: 'invalid_token' }));
  const userJson = await ur.json();
  const userId = userJson.id;
  const userEmail = userJson.email || null;
  if (!userId) return cors(json(401, { error: 'invalid_token' }));

  // ── Body ─────────────────────────────────────────────────────────
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (e) { return cors(json(400, { error: 'invalid_json' })); }

  const threadDate = String(body.thread_date || '').trim();
  const content    = String(body.content || '').trim();
  const assistantMsgId = String(body.assistant_msg_id || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(threadDate)) return cors(json(400, { error: 'thread_date_required' }));
  if (!content)         return cors(json(400, { error: 'content_required' }));
  if (content.length > 4000) return cors(json(400, { error: 'content_too_long' }));
  if (!isUuid(assistantMsgId)) return cors(json(400, { error: 'assistant_msg_id_required' }));

  // Phase 8 — Both message rows are written by the CLIENT via
  // PostgREST (RLS-protected) BEFORE this function is called. The
  // function only patches the assistant placeholder after the loop
  // finishes. This sidesteps the on_conflict + partial-unique-index
  // edge case the previous version hit.

  try {
    // ── Load conversation history ─────────────────────────────────
    const hdr = () => ({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });

    // Pull this thread's messages so far (excluding the placeholder).
    const historyUrl = `${SUPABASE_URL}/rest/v1/chat_messages`
      + `?user_id=eq.${userId}&thread_date=eq.${threadDate}`
      + `&role=in.(user,assistant)`
      + `&status=eq.complete`
      + `&select=role,content,created_at`
      + `&order=created_at.asc&limit=40`;
    const history = await fetchJson(historyUrl, hdr());

    // Pull recent context: last 7 daily briefs + last weekly brief.
    // These ground Claude's answers in what's been observed lately.
    const [recentBriefs, weeklyBrief] = await Promise.all([
      fetchJson(`${SUPABASE_URL}/rest/v1/daily_briefs?user_id=eq.${userId}&select=brief_date,mode,structured,narrative&order=brief_date.desc&limit=7`, hdr()),
      fetchJson(`${SUPABASE_URL}/rest/v1/weekly_briefs?user_id=eq.${userId}&status=eq.ready&select=week_start_date,structured,narrative&order=week_start_date.desc&limit=1`, hdr()),
    ]);

    // ── Step d: prompt + initial message ─────────────────────────
    const systemPrompt = buildSystemPrompt({ threadDate, recentBriefs, weeklyBrief });

    // Conversation history. Each row becomes a Messages-API turn.
    // The latest user message is the LAST entry; older history is
    // included verbatim so Claude maintains conversational context.
    // Note: history already includes prior assistant turns since the
    // SELECT pulled role IN (user, assistant) WHERE status=complete.
    const messages = (history || []).map(m => ({
      role:    m.role,           // 'user' or 'assistant'
      content: m.content || '',
    })).filter(m => m.content);

    // If the latest user content isn't already in history (it usually
    // isn't because we just inserted it — PostgREST default isolation
    // makes the read miss it depending on timing), append it.
    if (!messages.length || messages[messages.length - 1].role !== 'user' ||
        messages[messages.length - 1].content !== content) {
      messages.push({ role: 'user', content });
    }

    // The agentic loop takes initial_user_message; everything else
    // we pre-bake into the messages array. Simulate by passing the
    // last user turn as the initial and pre-seeding via system.
    // Actually the loop only takes ONE initial user message — we
    // need to wedge conversation history INTO the system prompt
    // or refactor the loop. Simplest path: include history as a
    // pre-amble inside the initial user message.
    const initial = messages.length === 1
      ? content
      : conversationPreamble(messages.slice(0, -1)) + '\n\n--- CURRENT QUESTION ---\n' + content;

    // ── Step e: run agentic loop ────────────────────────────────
    const result = await runAgenticLoop({
      anthropicKey,
      model: KNOWLEDGE_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system_prompt: systemPrompt,
      initial_user_message: initial,
      tools: TOOLS,
      tool_ctx: { userId, userEmail, openaiKey, hdr },
      max_iterations: CHAT_MAX_ITER,
    });

    // ── Step f: patch assistant row ─────────────────────────────
    const patch = (result.status === 'ok')
      ? {
          content:           result.final_text || '',
          status:            'complete',
          tool_calls_log:    (result.tool_calls_log || []).slice(-50),
          model:             KNOWLEDGE_MODEL,
          prompt_tokens:     result.prompt_tokens,
          completion_tokens: result.completion_tokens,
          iterations:        result.iterations,
        }
      : {
          content:           null,
          status:            'failed',
          failure_reason:    String(result.error || result.status).slice(0, 500),
          tool_calls_log:    (result.tool_calls_log || []).slice(-50),
          iterations:        result.iterations,
        };
    await dbPatch(`${SUPABASE_URL}/rest/v1/chat_messages?id=eq.${assistantMsgId}`, patch, serviceKey);

    return cors(json(200, { status: patch.status, assistant_msg_id: assistantMsgId }));
  } catch (err) {
    console.error('[chat-ask] pipeline failed:', err.message);
    // Mark the placeholder failed if it exists
    await dbPatch(`${SUPABASE_URL}/rest/v1/chat_messages?id=eq.${assistantMsgId}`, {
      status: 'failed',
      failure_reason: String(err.message || err).slice(0, 500),
    }, serviceKey).catch(() => {});
    return cors(json(200, { status: 'failed', error: err.message }));
  }
};

// ── System prompt ─────────────────────────────────────────────────
function buildSystemPrompt({ threadDate, recentBriefs, weeklyBrief }) {
  const briefSummary = (recentBriefs || []).slice(0, 7).map(b => {
    const s = b.structured || {};
    return `- ${b.brief_date} (${b.mode}): ${s.headline || ''} — ${s.subhead || ''}`;
  }).join('\n');

  const weekly = weeklyBrief?.[0];
  const weeklyLine = weekly
    ? `Last weekly synthesis (${weekly.week_start_date}): ${weekly.structured?.headline || ''} — ${weekly.structured?.subhead || ''}`
    : 'No weekly synthesis yet.';

  return [
    `You are the user's personal data partner. Today is ${threadDate}.`,
    '',
    'YOUR JOB:',
    '- Answer the user\'s questions about their own data: workouts, sleep, mood, journal entries, calendar, knowledge base uploads, baselines, patterns.',
    '- Use the available tools whenever a question requires data you don\'t already have. Don\'t guess — query.',
    '- When you make a claim, ground it in specific data: dates, values, sample size, correlation strength. Vague answers (\'usually\', \'often\') are useless.',
    '- When the user asks about an article / lab / document, call search_knowledge to pull the relevant chunks.',
    '- For correlations, use compute_correlation rather than estimating by eye.',
    '',
    'STYLE:',
    '- Direct. Conversational. No corporate filler.',
    '- No medical claims. No prescriptions. No supplement advice. Frame as observations, not directives.',
    '- Use the user\'s second person voice.',
    '- Short paragraphs over long ones. Bullets when listing.',
    '- No emojis unless the user uses them first.',
    '',
    'CONTEXT:',
    briefSummary ? 'Recent daily briefs:\n' + briefSummary : 'No recent daily briefs.',
    '',
    weeklyLine,
    '',
    'When you have a complete answer, respond with plain prose — no tool_use blocks. The conversation ends when you reply without calling a tool.',
  ].join('\n');
}

function conversationPreamble(prior) {
  return ['--- PRIOR CONVERSATION ---', ...prior.map(m => `${m.role.toUpperCase()}: ${m.content}`)].join('\n\n');
}

// ── Helpers ───────────────────────────────────────────────────────
function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
}

async function dbInsert(url, row, serviceKey, mergeOnConflict) {
  const headers = {
    'Content-Type':  'application/json',
    apikey:          serviceKey,
    Authorization:   `Bearer ${serviceKey}`,
    Prefer:          mergeOnConflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`db_insert_${r.status}: ${(await r.text()).slice(0, 200)}`);
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

// ── HTTP ──────────────────────────────────────────────────────────
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
