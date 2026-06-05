// Brief pattern-insight — DETERMINISTIC selection + rendering.
//
// Formulaic-first (see docs/formulaic-first-and-brief-insights.md + CLAUDE.md):
// the brief's "pattern callout" line is NOT written or gated by AI. This pure
// function picks the single strongest non-dismissed pattern the weekly
// synthesis has stored and renders a line from it. It fires deterministically
// whenever a qualifying pattern exists — no model omission-bias, no
// no-numbers prose rule (this is a data fact, not the brief's voice).
//
// Input: ctx.recent_patterns — already non-dismissed + strength-desc, each
//   { label, description, strength, n, metadata }.
// Output: { text, label, strength } | null  (null = nothing qualifies; graceful).

'use strict';

const MIN_STRENGTH = 0.5;   // surface only reasonably-confident patterns
const MAX_LEN      = 140;

function softTruncate(s, n) {
  s = String(s == null ? '' : s).trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-—]+$/, '') + '…';
}

function selectPatternInsight(ctx) {
  const patterns = (ctx && Array.isArray(ctx.recent_patterns)) ? ctx.recent_patterns : [];
  if (!patterns.length) return null;

  // recent_patterns is already non-dismissed + strength-desc (nulls last), so
  // the first one clearing the bar is the strongest. A null strength is allowed
  // (binary/streak patterns may omit it); we just require a renderable string.
  const pick = patterns.find(p =>
    p && (p.strength == null || Number(p.strength) >= MIN_STRENGTH) && (p.label || (p.metadata && p.metadata.brief_line))
  );
  if (!pick) return null;

  // Prefer a clean templated line written at detection time (Phase 3), else the
  // pattern's clean ≤80-char label.
  const raw = (pick.metadata && pick.metadata.brief_line) || pick.label;
  const text = softTruncate(raw, MAX_LEN);
  if (!text) return null;

  return {
    text,
    label: pick.label || null,
    strength: pick.strength != null ? Number(pick.strength) : null,
  };
}

module.exports = { selectPatternInsight, MIN_STRENGTH };
