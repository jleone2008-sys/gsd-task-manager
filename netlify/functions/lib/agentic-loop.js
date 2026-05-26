// Phase 7 — agentic tool-use loop driver.
//
// Generic multi-turn Claude+tools runner. Phase 7's weekly synthesis
// uses this directly; Phase 8's chat will too.
//
// How it works:
//   1. Call Claude with the system prompt, initial user message, and
//      tool definitions.
//   2. If the response contains tool_use blocks, dispatch each to its
//      handler (from synthesis-tools.js TOOLS map). Collect results.
//   3. Append the tool results as a new user-role message and call
//      Claude again.
//   4. Repeat until Claude returns a non-tool response (stop_reason !=
//      'tool_use') OR we hit max_iterations.
//   5. Return the final assistant message + the full tool_calls_log
//      for debugging.
//
// The loop is bounded by:
//   - max_iterations (default 12) — hard ceiling on rounds
//   - per-tool-call timeout via the handler's own logic (no global
//     timer here — Netlify background functions have 15min total)
//   - max_tokens per Claude call (passed through opts)
//
// Errors:
//   - If a tool handler throws, we send Claude a tool_result with
//     is_error=true + the error message. Claude can choose to retry
//     a different approach or proceed without that tool's data.
//   - If Claude itself errors (anthropic_http_*), the loop bails
//     with status='failed' and the error propagates up.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ── Main entry point ────────────────────────────────────────────────
//
// runAgenticLoop({
//   anthropicKey,    string  - required
//   model,           string  - 'claude-opus-4-7' typical
//   max_tokens,      number  - per-call output cap
//   system_prompt,   string  - persistent system message
//   initial_user_message, string - what kicks the conversation off
//   tools,           object  - TOOLS-style map { name: { def, handler } }
//   tool_ctx,        object  - opaque, passed to every handler invocation
//   max_iterations,  number  - default 12
// })
//
// Returns: {
//   status: 'ok' | 'failed' | 'max_iterations',
//   final_text: string | null,            // last assistant text block
//   final_content: array,                 // full last content array
//   tool_calls_log: [ { iter, name, args, result | error } ],
//   iterations: number,
//   prompt_tokens: number | null,
//   completion_tokens: number | null,
//   error: string | undefined,
// }
async function runAgenticLoop(opts) {
  const {
    anthropicKey,
    model,
    max_tokens = 4096,
    system_prompt,
    initial_user_message,
    tools,
    tool_ctx,
    max_iterations = 12,
  } = opts;

  if (!anthropicKey) throw new Error('anthropicKey_required');
  if (!model)        throw new Error('model_required');
  if (!tools)        throw new Error('tools_required');

  // Convert TOOLS map to Anthropic's tool definition array.
  const toolDefs = Object.values(tools).map(t => t.def);

  // Running conversation. Anthropic Messages API takes user+assistant
  // turns; tool_use blocks come from the assistant; tool_result blocks
  // are sent back in a user-role message (per Anthropic's tool-use spec).
  const messages = [
    { role: 'user', content: initial_user_message },
  ];

  const tool_calls_log = [];
  let lastResponse = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  // Prompt caching — Anthropic caches a prefix of (system + tools)
  // for 5 minutes when cache_control is set, giving 90% discount on
  // hits. The agentic loop re-sends system + tools every iteration
  // (typical run: 5-12 iters for synthesis, 1-3 iters for chat),
  // so caching is a meaningful cost win — and the prefix is
  // identical run-to-run for the same user, so cross-run hits
  // happen too when calls come close together.
  //
  // We wrap:
  //   - system_prompt as a single text content block with cache_control
  //   - tools array: cache_control on the LAST tool definition (the
  //     Anthropic API caches everything up to and including that block)
  const cachedSystem = [{
    type: 'text',
    text: system_prompt,
    cache_control: { type: 'ephemeral' },
  }];
  const cachedTools = toolDefs.length
    ? [
        ...toolDefs.slice(0, -1),
        { ...toolDefs[toolDefs.length - 1], cache_control: { type: 'ephemeral' } },
      ]
    : toolDefs;

  for (let iter = 0; iter < max_iterations; iter++) {
    const reqBody = {
      model,
      max_tokens,
      system: cachedSystem,
      tools: cachedTools,
      messages,
    };

    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(reqBody),
    });
    const j = await r.json();
    if (!r.ok) {
      return {
        status: 'failed',
        final_text: null,
        final_content: null,
        tool_calls_log,
        iterations: iter,
        prompt_tokens: totalPromptTokens || null,
        completion_tokens: totalCompletionTokens || null,
        cache_creation_tokens: cacheCreationTokens || null,
        cache_read_tokens: cacheReadTokens || null,
        error: `anthropic_${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`,
      };
    }

    lastResponse = j;
    if (j.usage?.input_tokens)  totalPromptTokens     += j.usage.input_tokens;
    if (j.usage?.output_tokens) totalCompletionTokens += j.usage.output_tokens;
    // Prompt-caching telemetry. cache_creation_input_tokens are full-price
    // (the run that warmed the cache); cache_read_input_tokens are the
    // 90%-off hits. Sum both for visibility.
    if (j.usage?.cache_creation_input_tokens) cacheCreationTokens += j.usage.cache_creation_input_tokens;
    if (j.usage?.cache_read_input_tokens)     cacheReadTokens     += j.usage.cache_read_input_tokens;

    const content = j.content || [];
    const toolUses = content.filter(b => b.type === 'tool_use');

    // Terminal: Claude responded without calling any tools.
    if (toolUses.length === 0) {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return {
        status: 'ok',
        final_text: text || null,
        final_content: content,
        tool_calls_log,
        iterations: iter + 1,
        prompt_tokens: totalPromptTokens || null,
        completion_tokens: totalCompletionTokens || null,
        cache_creation_tokens: cacheCreationTokens || null,
        cache_read_tokens: cacheReadTokens || null,
      };
    }

    // Append the assistant turn (with its tool_use blocks) verbatim.
    messages.push({ role: 'assistant', content });

    // Execute each tool call sequentially. (Parallel would be nice
    // but tools may have side effects in future; sequential keeps
    // ordering predictable for the debug log.)
    const toolResults = [];
    for (const tu of toolUses) {
      const entry = { iter, name: tu.name, args: tu.input };
      const tool = tools[tu.name];
      if (!tool) {
        entry.error = 'unknown_tool';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Unknown tool: ${tu.name}`,
        });
      } else {
        try {
          const result = await tool.handler(tu.input || {}, tool_ctx);
          entry.result = result;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        } catch (e) {
          entry.error = String(e?.message || e);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `Error: ${entry.error}`,
          });
        }
      }
      tool_calls_log.push(entry);
    }

    // Send all tool results back as a single user message.
    messages.push({ role: 'user', content: toolResults });
  }

  // Ran out of iterations without Claude settling on a non-tool answer.
  return {
    status: 'max_iterations',
    final_text: null,
    final_content: lastResponse?.content || null,
    tool_calls_log,
    iterations: max_iterations,
    prompt_tokens: totalPromptTokens || null,
    completion_tokens: totalCompletionTokens || null,
    error: `exceeded max_iterations=${max_iterations}`,
  };
}

module.exports = { runAgenticLoop };
