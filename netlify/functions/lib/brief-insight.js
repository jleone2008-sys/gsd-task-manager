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

// Aligned with the sweep's |r| gate. The sweep also enforces p ≤ 0.01, so a
// stored pattern at |r| ≥ 0.4 is already statistically real (a moderate, honest
// "tends to be" effect) — no need for a higher second bar here.
const MIN_STRENGTH = 0.4;
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

  // Qualify (≥ MIN_STRENGTH, or null strength for binary/streak patterns) +
  // renderable. Then rank: ACTIONABLE patterns first (they involve a behavior
  // the user can change — more useful than a pure-physiology observation),
  // then strongest. Pure-physiology couplings are the fallback, not the lead.
  const qualifies = p => p &&
    (p.strength == null || Number(p.strength) >= MIN_STRENGTH) &&
    (p.label || (p.metadata && p.metadata.brief_line));
  const pick = patterns.filter(qualifies).slice().sort((a, b) => {
    const aAct = (a.metadata && a.metadata.actionable) ? 1 : 0;
    const bAct = (b.metadata && b.metadata.actionable) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return (Number(b.strength) || 0) - (Number(a.strength) || 0);
  })[0];
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
