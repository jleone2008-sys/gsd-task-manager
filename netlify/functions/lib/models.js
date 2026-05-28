// Single source of truth for AI model identifiers.
//
// Why this exists: the base Claude model string ('claude-opus-4-7') was
// hardcoded in ~8 functions. A base-model bump (or a known-bad model id like
// the sonnet 404 we hit) meant editing every file and hoping none were missed.
// Centralizing the NAME makes that a one-line change.
//
// What stays per-function (intentionally NOT centralized): max_tokens. Output
// size legitimately varies by task — a daily brief wants ~1500, a one-line
// workout insight ~600, knowledge summarization ~8000 — so each call site keeps
// its own max_tokens next to the prompt it belongs to. Per-function model env
// overrides (BRIEF_MODEL, TRAIN_FEEDBACK_MODEL, KNOWLEDGE_MODEL, …) also still
// win; they fall back to these shared defaults instead of a hardcoded literal.
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL    || 'claude-opus-4-7';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

module.exports = { CLAUDE_MODEL, EMBEDDING_MODEL };
