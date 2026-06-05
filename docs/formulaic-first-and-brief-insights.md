# Formulaic-first AI + brief pattern-insights — spec & build plan

**Status:** Part A (principle) = standing rule. Part B Phase 1 = building now. Phases 2–3 = planned.
**Why this doc exists:** the user explicitly asked for a durable, precise spec so that across sessions/compaction the build does **not** drift to lower quality. **On resume: re-read this file, check the Phase checklist (Part E), restate what's NOT done, then continue. Keep the checkboxes current — they are the source of truth.**

---

## Part A — The standing principle: formulaic-first, AI for novelty only

**Rule:** Anything that can be decided by a clear rule MUST be code, not AI. Reserve AI for genuinely open-ended phrasing/synthesis. **Never let AI make a deterministic decision** — AI has an omission/brevity bias, so "mention X only if it matters" reliably degrades to "never mentions X," and the feature silently dies even when the data is screaming.

**Decision rubric** (apply to every AI surface):
| The task is… | Then… |
|---|---|
| A threshold / gate / selection with a clear rule | **Code.** (e.g. "is there a strong pattern? which one? show it") |
| Choosing *whether* to surface something | **Code.** Never an AI judgment buried in a prompt. |
| Filling known slots in a known shape | **Template** (backend content library), slots from data. |
| Repeated themes AI keeps generating | **Templatize** — that repetition *is* the signal it's formulaic. Pick from a backend library keyed to the detected condition. |
| Genuinely novel, cross-domain narrative; nuanced phrasing where templates read robotic | **AI** — but it fills slots / picks among options, it doesn't gate. |

**Why:** deterministic = cheaper, testable, reproducible, faster, and **can't silently fail**. This is the same direction as the brief fingerprint-gating cost work (less AI, more determinism). When unsure, default to formulaic; escalate to AI only when a rule genuinely can't express it.

**Audit target (later):** sweep other AI surfaces (train feedback, brief recap, weekly synthesis gating) for the same anti-pattern — "AI gating a deterministic decision."

---

## Part B — Brief pattern-insight: current → target

### The bug we're fixing
The brief's "pattern callout" line (`structured.insight`, rendered in `05-brief.js:832` as `.brief-insight`) is currently **written by the AI model** and is `null` in 100% of the user's live briefs. Three compounding causes:
1. The model is instructed `insight: OPTIONAL … ONLY if it connects to today. Most days: null` (`lib/brief-claims.js:203`) → omission bias → ~never fires.
2. The model's output is dropped if it contains a 2–3 digit number or stats jargon (`beta-daily-brief.js:1168-1175`) → and the user's real patterns are numeric/physiological → always dropped.
3. So a real, data-driven pattern (the user HAS 3 active in `patterns_discovered`) never reaches the screen.

This is the Part-A anti-pattern exactly: a deterministic decision ("strong pattern exists → show it") was handed to AI.

### Detection limitation (context for Phase 2)
Pattern *detection* is an agentic Opus loop (`beta-weekly-synthesis-background.js`): the model **chooses which signal-pairs to test** via `compute_correlation` and **judges** what's worth surfacing ("lean toward fewer patterns"). It is **not** a systematic sweep. The user's behavioral data is dense (mood 42/45 d, habits 44/45 d), so the missing behavioral patterns (sleep→mood, alcohol→recovery, calendar→focus) are almost certainly real but **never tested** — not absent. Thresholds (n≥5, |r|≥0.4) are *prompt instructions*, not enforced code.

### Data model (existing — reuse, don't rebuild)
`patterns_discovered` (`supabase-migrations/patterns_discovered.sql`): `label` (≤80-char clean headline — **the field we surface**), `description` (technical), `strength_score` (|r| or count/window, 0–1), `n`, `last_seen_at`, `dismissed_by_user`, `metadata` jsonb (r/p-value, source metrics, room for a future `brief_line`).

### Target architecture
- **Detection** (Phase 2): a deterministic correlation sweep over ALL tracked signal-pairs, gated in CODE (n / |r| / p), writes clean candidates to `patterns_discovered`. AI may add narrative on top but never gates discovery.
- **Selection** (Phase 1): a pure-code `selectPatternInsight(ctx)` picks the pattern to show today by rule. No AI.
- **Rendering** (Phase 1 minimal → Phase 3 library): template the line from the pattern (`metadata.brief_line` if present, else `label`). Numbers ARE allowed here (it's a data fact, separate from the brief's prose voice). Phase 3 = a per-kind template library.

---

## Part C — Phase 1 spec (DECOUPLE — building now)

**Goal:** the insight line is **selected and rendered by code**, fires deterministically whenever a qualifying pattern exists, and the AI model is no longer responsible for it.

### Changes
1. **New `netlify/functions/lib/brief-insight.js`**
   - `selectPatternInsight(ctx)` → `{ text, label, strength } | null`.
   - Rule: from `ctx.recent_patterns` (already top-3 non-dismissed by `strength_score` desc), take the strongest with `strength >= MIN_STRENGTH` (**0.5**). If none qualify → `null`.
   - Render: `text = pattern.metadata?.brief_line || pattern.label`, soft-truncated to 140 chars. (Phase 3 enriches with per-kind templates; Phase 1 surfaces the clean `label`.)
   - Pure function, no I/O, no AI. Unit-testable.
2. **`beta-daily-brief.js`**
   - Fetch: add `metadata` to the `patterns_discovered` select (~line 721) and to the `recent_patterns` map (~724) so the renderer can use a future `brief_line`.
   - Structured assembly (~line 1232): set `insight: selectPatternInsight(ctx)?.text || null`. **Remove** the AI-insight parse/validate block (1168-1175) — the model no longer supplies it.
   - Tool schema (`briefToolSchema`, ~1076): **remove the `insight` field** so the model isn't asked to write it (saves tokens, removes the dead path).
   - **Fingerprint:** include the selected pattern signature so a pattern change forces a regen. Add `ctx.recent_patterns?.[0]?.label || null` (+ its strength) into `computeBriefFingerprint`'s payload. (Brief regens daily anyway; this guarantees correctness if only patterns changed.)
3. **`lib/brief-claims.js`**
   - Remove the `insight` field instruction (line 203) and the `[trend] pattern` claim (lines 167-173) — patterns are now consumed deterministically, not by the model. Update the comment + `used_claim_ids` wording that references "insight".
4. **`05-brief.js`** — render unchanged (already reads `structured.insight` at line 832). It will now be non-null when a pattern qualifies.

### Acceptance criteria (Phase 1) — self-audit against these
- [ ] A user with ≥1 non-dismissed pattern at `strength ≥ 0.5` gets a **non-null** `structured.insight` equal to the templated pattern line, with **zero AI involvement** (the model's tool has no `insight` field).
- [ ] No qualifying pattern → `insight` is `null` (graceful, no crash).
- [ ] The brief still generates headline/subhead/recap/etc. correctly with the `insight` field removed from the tool.
- [ ] `selectPatternInsight` is a pure function (no fetch/AI), covered by a standalone test.
- [ ] Verified against **jleone2008's real patterns**: insight = the strongest pattern's label (the body-temp/HRV pattern), non-null.
- [ ] Fingerprint changes when the top pattern changes (new pattern → next regen surfaces it).
- [ ] Number/jargon are NOT stripped from this line (it's a data fact, intentionally exempt from the brief's no-numbers prose rule).

### Anti-deviation guardrails (Phase 1 — do NOT)
- ❌ Do NOT re-introduce any "AI decides whether to show the insight" path.
- ❌ Do NOT route the insight text back through the brief's no-numbers/banned-prose validator.
- ❌ Do NOT add new tables — reuse `patterns_discovered`.
- ❌ Do NOT touch the weekly-synthesis detection in Phase 1 (that's Phase 2).

---

## Part D — Phase 2 & 3 (planned, not building yet)

**Phase 2 — deterministic correlation sweep (fixes "not catching every pattern").**
- A code pass (in the weekly synthesis, or a sibling job) that systematically tests ALL tracked signal-pairs — Oura (HRV/RHR/sleep/readiness/body-temp/activity) × behavioral (mood, habit-completion rate, workout flags, alcohol tag, calendar density, body weight) — over a 30–60d window.
- Gate in CODE: `n ≥ N_MIN` (e.g. 10), `|r| ≥ 0.4`, `p ≤ 0.05`. Write each passer to `patterns_discovered` with a clean templated `label` + `metadata` (r, p, n, signal_a, signal_b, direction, window).
- AI optional: a narrative layer for genuinely novel cross-domain links — but it never gates which correlations are tested or stored.
- Acceptance: behavioral patterns that exist in the data (given dense logging) actually get discovered and stored; thresholds enforced in code, not prose.

**Phase 3 — pattern template library (rendering quality).**
- A backend map: `pattern_kind → template` with slots (`{signal_a} {direction} {signal_b}`, time-of-day, action). Number-aware. `metadata.brief_line` written at detection time from the template so Phase 1's renderer surfaces clean lines automatically.
- This is the "content library we pick from when a condition is detected" — the formalization of Part A for repeated themes.

---

## Part E — Build checklist (source of truth; keep current)

**Phase 0 — docs/principle**
- [x] Write this spec doc.
- [x] Add the formulaic-first principle to project `CLAUDE.md`.

**Phase 1 — decouple the insight line (formulaic)**
- [x] `lib/brief-insight.js` — `selectPatternInsight(ctx)` (pure, rule-based, templated render; `metadata.brief_line` || `label`; MIN_STRENGTH 0.5).
- [x] `beta-daily-brief.js` — fetch `metadata`; set `insight` from selector; removed AI-insight parse/validate; removed `insight` from tool schema; added `patternSig` to fingerprint.
- [x] `lib/brief-claims.js` — removed insight instruction + `[trend]` claim; excluded insight from `validateAgainstClaims`; fixed wording.
- [x] Verify: standalone test of `selectPatternInsight` passed (real jleone2008 pattern → body-temp label non-null; weak/empty → null; `brief_line` override works; null-strength binary allowed). Render side already confirmed in mock. **Live full-generation verification is post-deploy** (next regen; fingerprint changed so all briefs regen once).
- [ ] Update knowledge-bank changelog; commit; (ask before push).

**Phase 1 acceptance criteria — audited:** ✅ non-null deterministic insight for a ≥0.5 pattern with zero AI (tool has no `insight` field) · ✅ null when nothing qualifies · ✅ pure standalone-tested selector · ✅ verified vs real data · ✅ fingerprint includes pattern sig · ✅ insight exempt from no-numbers/claim validation. ⏳ live brief still generates correctly = post-deploy check (insight not in tool `required`, syntax clean — high confidence).

**Phase 2 — deterministic sweep** — [ ] (not started)
**Phase 3 — template library** — [ ] (not started)

---

## Part F — Open decisions
- `MIN_STRENGTH` = 0.5 for Phase 1 (tune later).
- Repetition control: Phase 1 surfaces the single strongest pattern (may repeat day-to-day). If it feels stale, add rotation/"don't repeat within K days" — deferred, noted here.
- Phase 2 `N_MIN` / p-value exact values — TBD when building Phase 2.
