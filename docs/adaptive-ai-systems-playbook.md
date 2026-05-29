# Adaptive AI Systems — A Practical Playbook

Patterns for building **trustworthy generative features** and **self-improving,
per-user learning loops** on top of an LLM.

This is a portable playbook. It was distilled from a production personal-health
app, but nothing here depends on that app — every pattern is explained from
first principles and the domain examples are labeled. Copy this file into any
project. If you're reaching for an LLM to generate user-facing output, or you
want a feature that *gets better for each user over time without asking them to
rate anything*, this is the menu.

**Who it's for:** any developer wiring an LLM into a product surface — a daily
summary, a recommendation, a coach, an assistant, an insights feed.

**How to read it:** Parts 1–2 are about making generation *trustworthy and
useful today*. Part 3 is the differentiator — turning a static feature into a
**closed feedback loop** that learns. Part 4 is the operational stuff that
silently breaks these systems in production. Part 5 shows how they compose.

Throughout, **"Origin example"** callouts show the concrete shipped form. They
illustrate; they aren't requirements.

---

## Part 0 — Two mental models

Everything below is an application of two ideas.

### Model 1: Deterministic core, generative veneer

An LLM is excellent at *phrasing, synthesis, and judgment under ambiguity* and
unreliable at *arithmetic, consistency, and not making things up*. So split
every feature in two:

- **The core** computes all facts, numbers, thresholds, and decisions with
  plain deterministic code. It is testable, stable across reruns, and cheap.
- **The veneer** is the only part the model writes: the human phrasing, the
  framing, the "so what." The model is handed the facts and forbidden from
  inventing new ones.

This single split is responsible for most of the reliability you'll get. A
feature that lets the model do math will eventually tell a user their resting
heart rate is 420.

### Model 2: The closed loop

A static feature *emits* and forgets. An adaptive feature closes the loop:

```
   suggest  ──▶  observe behavior  ──▶  measure outcome  ──▶  adapt next suggestion
      ▲                                                              │
      └──────────────────────────────────────────────────────────────┘
```

The magic is that **observation and measurement can be passive** — inferred from
data the product already collects — so the user never fills out a survey. Over
weeks the system accumulates a personal evidence file and the generative veneer
leans into what has actually worked *for this specific user*. Part 3 is how.

---

## Part 1 — Generation patterns (trustworthy output today)

### Pattern 1 — Deterministic core, generative veneer

**Problem.** You want natural, varied copy, but you can't have the model
miscount tasks, drift a recommended value between runs, or hallucinate a stat.

**Pattern.** Compute every factual block in code. Pass them to the model as
read-only context. Constrain the model to produce *only* synthesis text.

**Mechanics.**
- Build the facts first: counts, deltas, thresholds, the recommended action.
- Give the model the numbers "for reasoning only," and explicitly instruct it
  **not to echo specific numbers/names** in its prose — the UI renders those
  from the deterministic layer, so the model restating them only creates a
  chance to get them wrong.
- Keep deterministic outputs **stable across regenerations.** If the same
  inputs can produce "10:00 PM" one run and "10:30 PM" the next, downstream
  tracking and the user's trust both break. Pure functions, seeded randomness
  (see Pattern 11), no model input honored for the decision itself.

> **Origin example.** A daily "brief" renders a hero metric, stat rows, and a
> recommended bedtime — *all computed in code*. The model writes only a
> ≤30-char headline and a ≤80-char subhead. The recommended bedtime comes from a
> pure function, not the model, so it never flickers between runs.

**When to use.** Always, for any feature that mixes numbers/decisions with prose.

---

### Pattern 2 — Tool-use as a structured-output contract

**Problem.** Free-form completions are hard to parse and easy to derail. You
want the model to return *exactly* the fields you'll render, validated.

**Pattern.** Use the model's tool-calling / structured-output mode to force the
response into a JSON schema. The "tool" is your output contract: a few typed
fields with length limits and enums. The model fills the schema; you never
parse prose.

**Mechanics.**
- Define the schema with tight constraints: `maxLength`, enums for confidence
  levels, small arrays with item limits.
- Validate on receipt anyway — schemas constrain but don't guarantee semantics.
- Treat the schema as the API between the model and your renderer.

> **Origin example.** The brief's model call exposes one structured output:
> `{ headline, subhead, evidence_pills[0..3], confidence: low|med|high }`.
> Server builds everything else.

**When to use.** Any time the model's output feeds a UI or another system rather
than being shown raw.

---

### Pattern 3 — Output guardrails + regeneration fallback

**Problem.** Even constrained, models produce banned styles (jargon, filler,
forbidden claims), over-long strings, or mid-word truncations.

**Pattern.** Run cheap deterministic validators over the model's output. On
violation, either **regenerate** or **fall back** to a safe deterministic
template. Never ship unvalidated model text to a user.

**Mechanics.**
- **Banned-phrase / banned-pattern regex.** Maintain a list of phrases and
  patterns the output must never contain (statistics jargon, hype filler,
  domain-forbidden claims like specific medical values). A single match triggers
  the fallback path.
- **Word-safe truncation.** If you must cap length, never hard-slice mid-word.
  Cut at the last word boundary that leaves a reasonable length; only hard-cut
  if no good boundary exists. Extract it once as a helper and reuse it for every
  capped field.
- **Deterministic fallback.** Keep a boring, always-correct template the system
  can emit when the model output is rejected or the model call fails. The
  feature degrades to plain-but-right, never to broken.

> **Origin example.** A regex rejects responses containing percentile/median
> jargon or recap filler; rejected outputs fall back to a deterministic brief.
> A `softTruncate(str, max)` helper caps the headline (30) and subhead (100) at
> word boundaries — added after a brief shipped "…tomorrow's li" from a naive
> `slice(0, 80)`.

**When to use.** Every model→user surface. The validators are cheap insurance.

---

### Pattern 4 — Tiered regeneration (cheap realtime patch + scheduled warmer)

**Problem.** Regenerating with the model on every interaction is slow and
expensive; regenerating only on a schedule makes the UI feel stale after the
user does something.

**Pattern.** Two tiers.
- **Tier 1 (realtime, deterministic):** when the user acts, recompute only the
  *deterministic* blocks client-side and patch the view instantly. No model
  call.
- **Tier 2 (scheduled, generative):** a background job periodically regenerates
  the model copy so the prose stays current as the day's context evolves.

**Mechanics.**
- The deterministic/veneer split (Pattern 1) is what makes this possible — Tier
  1 can update the facts without touching the prose.
- Make Tier 2 writes idempotent (Pattern 16) so repeated runs don't pile up
  rows.

> **Origin example.** Checking off a task instantly recomputes the brief's task
> counts (Tier 1); an hourly job refreshes the model-written headline (Tier 2).

---

## Part 2 — Agentic patterns (let the model investigate)

When a single prompt isn't enough — the model needs to *look things up* and
decide what to look at — you give it tools and let it drive.

### Pattern 5 — The bounded agentic tool loop

**Problem.** Some questions ("why did X regress?") require the model to query
data, see results, and decide the next query. A one-shot prompt can't.

**Pattern.** A small driver loop: call the model with a tool registry; if it
requests tool calls, execute them, feed the results back, and call again;
repeat until it answers without calling a tool — or until a hard iteration cap.

**Mechanics (the whole driver is ~150 lines):**
1. Maintain a running message list. Send `system + tools + messages` each turn.
2. If the response contains tool-call blocks, dispatch each to its handler,
   collect results, append them as the next turn, loop.
3. **Terminal condition:** the model responds with no tool calls → that's the
   answer.
4. **Hard ceiling:** `max_iterations` (≈12 for analysis, ≈3 for chat). Return a
   distinct `max_iterations` status so you can tell "settled" from "ran out."
5. **Errors as data:** if a tool handler throws, send the model a
   `tool_result` with `is_error: true` and the message. The model can retry a
   different approach or proceed without that data — far more robust than
   crashing the loop.
6. Log every tool call (`{iter, name, args, result|error}`) for debugging.

**When to use.** Investigation, multi-step reasoning over your data, chat
assistants. Overkill for fixed single-shot generation (use Part 1 instead).

---

### Pattern 6 — Read-only, whitelisted, user-scoped tools

**Problem.** Tools are an attack/footgun surface — the model picks the args.

**Pattern.** Treat tool handlers like untrusted-input endpoints.

**Mechanics.**
- **Whitelist, don't interpolate.** Validate table names against an allow-map;
  sanitize/whitelist column names; reject malformed dates. Never string-build a
  query straight from model-supplied args.
- **Scope every query to the user** server-side. The loop has already
  authenticated the user; tools take a trusted `userId` from context, never
  from the model's args.
- **Return JSON-serializable, flat results** sized for the next prompt (cap row
  counts; the model doesn't need 10k rows).
- **Naming convention:** `snake_case` `verb_object` (`query_baselines`,
  `compute_correlation`) so the model picks sensibly and your logs read well.

**Registry shape** that keeps definitions and handlers together:
```js
const TOOLS = {
  query_baselines: {
    def: { name, description, input_schema },  // sent to the model
    handler: async (args, ctx) => { /* validated, user-scoped query */ },
  },
  // ...
};
```
The same registry can back multiple surfaces (a weekly analysis job *and* a
chat feature share one toolset).

---

### Pattern 7 — Prompt caching for loops

**Problem.** An agentic loop re-sends the (large, identical) system prompt +
tool defs every iteration. That's the bulk of your token cost.

**Pattern.** Mark the stable prefix (system prompt, tool definitions) as
cacheable. Hits are ~90% cheaper. The prefix is identical iteration-to-iteration
*and* run-to-run for the same configuration, so you get both in-loop and
cross-run cache hits.

**Mechanics.**
- Put `cache_control` on the system block and on the **last** tool definition
  (the provider caches everything up to and including the marked block).
- Track cache-creation vs cache-read tokens in telemetry so you can see the hit
  rate.
- Keep the prefix byte-stable — any change busts the cache.

---

## Part 3 — Learning patterns (the system gets smarter per user)

This is the part most teams skip and the part that compounds. The goal: a
feature whose suggestions are shaped by *this user's actual response history*,
with **zero extra user effort** — no ratings, no dismiss buttons, no surveys.

### Pattern 8 — Intervention fingerprinting (signatures)

**Problem.** To learn whether a suggestion worked, you must be able to group
"the same kind of suggestion" across time.

**Pattern.** Give every suggestion a stable **signature** string the moment you
emit it, and log a row. The signature encodes the suggestion's identity (and
its key parameter) so identical suggestions aggregate cleanly later.

**Mechanics.**
- Signature = `type:param`, e.g. `bedtime_target:21:30`, `push_workout`,
  `habit_focus:posture`.
- On emit, write a row capturing: signature, the **target metric** the
  suggestion is meant to move, the **current baseline** of that metric, and a
  **conditions snapshot** (the inputs that led to this suggestion) so later
  analysis can compare like-with-like.
- Keep signatures coarse enough to accumulate samples, specific enough to be
  meaningful.

---

### Pattern 9 — Passive adherence inference (no buttons)

**Problem.** Did the user actually follow the advice? Asking them kills the
experience and biases the data.

**Pattern.** A scheduled job infers adherence from **downstream data the product
already has**, scoring each emitted suggestion 0–1 (or `null` when nothing can
prove it).

**Mechanics.**
- One pure scoring function **per signature type**: `(loggedSuggestion,
  downstreamData) => { score, evidence }`.
- Score `1.0` = clear adherence, `0.0` = clear non-adherence, partials for
  partial follow-through, **`null` when there's no behavioral signal** that can
  prove or disprove it (those rows are excluded from "followed vs ignored"
  comparisons but you still measure their outcome).
- Store an `evidence` blob explaining what the rule looked at — invaluable for
  debugging and for letting a later analysis step quote real numbers.

> **Origin example.** "Bedtime 9:30 PM" adherence = compare the wearable's
> detected sleep midpoint to the suggested time (within 15 min → 1.0, decaying
> to 0 by 90+ min late). "Take it easy" = no workout logged + below-norm
> activity → 1.0. The user clicked nothing.

---

### Pattern 10 — Delayed outcome capture + quasi-control

**Problem.** A suggestion's effect shows up *later*, and you need to separate
"the advice helped" from background noise.

**Pattern.** On the same logged row, fill in the target metric at **T+1 and
T+3** (or whatever horizon fits). Then compare the metric's change **when the
advice was followed vs. when it wasn't** — the ignored occasions are your
natural control group.

**Mechanics.**
- The scheduled job (Pattern 9) also reads the target metric on later days and
  writes `value_at_t_plus_1`, `value_at_t_plus_3`, and a `computed_at` stamp.
- "Followed vs ignored, under matched conditions" is a quasi-experimental
  contrast that isolates the advice from noise far better than raw before/after.
- **Adherence × efficacy is more diagnostic than either alone:**

  | Adherence | Efficacy | Meaning |
  |---|---|---|
  | High | High | Works *and* they do it → double down |
  | High | Low | They do it, it doesn't help → wrong advice, reframe |
  | Low | High | Works when done, rarely done → fix timing/framing |
  | Low | Low | Stop suggesting this |

---

### Pattern 11 — Single-subject A/B via deterministic variant seeding

**Problem.** "Followed vs ignored" is correlational. To claim *causation* for an
individual, you need to randomize.

**Pattern.** When the deterministic rule hits an **ambiguous band** where two
options are both defensible, *randomly pick one* and record which arm fired.
Over weeks this is a continuous A/B test with a sample size of one — the user.

**Mechanics.**
- Randomize **only in the gray zone.** Clear-cut conditions stay deterministic;
  ambiguity is where experimentation is free.
- **Seed the choice deterministically** by `(user, date, signature)` so
  regenerating the *same* output picks the *same* arm (no flicker within a day),
  but a different day yields a fresh draw (that's the sampling). A tiny hash
  (e.g. FNV-1a) over the seed string → pick a bucket. No crypto, no stored RNG
  state.
- Record `variant_id` on the outcome row; aggregate by `(signature, variant_id)`
  so arms are compared only within matched conditions.

```js
function pickVariant(seed, choices) {            // choices: { early:'9:30 PM', standard:'10:00 PM' }
  let h = 0x811c9dc5;                            // FNV-1a 32-bit, deterministic
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = (h * 0x01000193) >>> 0; }
  const key = Object.keys(choices)[h % Object.keys(choices).length];
  return { value: choices[key], variant_id: key };
}
```

> **Origin example.** Recovery score in the 61–75 "gray zone" → randomize a
> 9:30 vs 10:00 PM bedtime, seeded by user+date. After ~30 samples per arm under
> matched conditions, you have *causal* evidence of which bedtime moves *this
> person's* sleep score more.

---

### Pattern 12 — The efficacy feedback loop (close it)

**Problem.** You've measured what works. Now the system has to *act* on it.

**Pattern.** Roll the outcomes up into a per-user efficacy summary, and **feed
that summary back into the generative prompt.** The model then leans into what's
worked and de-emphasizes what hasn't — invisibly.

**Mechanics.**
- A materialized view / aggregate rolls up by `(user, signature, variant)`:
  mean metric delta when followed vs ignored, sample size, variance.
- The generation step injects a compact block into the system prompt:
  *"`bedtime_target:21:30` — n=18, +6.2 when followed, −0.4 when ignored, high
  confidence."* Instruct the model to lean into positive signatures and
  deprioritize negative ones, and **never to surface this to the user.**
- The loop is now closed: suggest → infer adherence → measure outcome →
  summarize efficacy → bias next suggestion.
- **Bad advice self-prunes.** No dismiss button needed: a suggestion that
  produces ~0 delta over many occasions shows up as low-efficacy and the model
  emits it less.

---

### Pattern 13 — Cold-start suppression & confidence gating

**Problem.** Early on you have almost no data; acting on n=2 is worse than not
acting.

**Pattern.** Gate every learned behavior behind a minimum sample size, and
attach an explicit confidence level derived from n and variance.

**Mechanics.**
- Don't surface an efficacy signal until a signature has ≥ N outcomes (e.g. 5
  for prompt-biasing, ~30 per arm for causal A/B claims). Below threshold, the
  feature behaves like its non-learning baseline.
- Compute `confidence: low | med | high` from sample size and spread; pass it
  through so weak signal is never presented (or acted on) as strong.
- Be honest about confounders: noisy real-world data means wide intervals. Say
  so in the data model, not just the UI.

> **Origin example.** Efficacy block is hidden until a signature has ≥5 scored
> outcomes; full causal language waits for ~30/arm. ~6-week cold start is
> expected and fine — the feature just works as its static version meanwhile.

---

### Pattern 14 — Pattern discovery, dedup, and decay

**Problem.** A periodic "analyst" pass (often an agentic loop, Part 2) surfaces
insights — but it will rediscover the same insight worded slightly differently
every run, and stale insights linger.

**Pattern.** Persist discovered patterns with **dedup on emit**, **strength on
reconfirm**, and **decay/suppression on dismiss**.

**Mechanics.**
- **Dedup:** before writing a "new" pattern, check for an existing one sharing
  enough distinctive tokens (e.g. 3+) — treat as the same finding.
- **Reconfirm:** when the same pattern resurfaces, bump its strength/confidence
  rather than inserting a duplicate.
- **Decay/dismiss:** a dismissed pattern gets a suppression window (e.g. 60
  days) before it can resurface, so the user isn't nagged.

---

## Part 4 — Operational lessons (the stuff that bites in production)

These are cheap to get right and expensive to discover the hard way.

### 15 — Await your persists (fire-and-forget loses writes)

In serverless/Lambda-style runtimes, a promise you don't await
(`persist(...).catch()`) can be **torn down when the execution context is
recycled**, silently dropping the write. Always `await` your database writes
inside a `try/catch` so the response still ships even if the write fails. For
genuinely long writes, move to a background function rather than detaching a
promise.

> **Origin example.** A model-generated analysis was computed correctly but
> intermittently never saved — a fire-and-forget persist that got reaped. The
> fix was a single `await`.

### 16 — Idempotent upserts + stable keys

Scheduled regenerators and retried jobs *will* run more than once. Make writes
idempotent: upsert on a stable composite key (e.g. `(user, date, mode)`) so
reruns update one row instead of accumulating duplicates. Pick the natural key
deliberately and enforce it with a DB unique constraint.

### 17 — Per-user scheduling on one global cron

You rarely need per-user schedulers. Run **one** hourly job and have it filter
to the users for whom it's currently the right *local* hour (read each user's
timezone). One cron expression covers every timezone for "do X at 6am local" or
"at 11pm local."

### 18 — Centralize model IDs and shared config

Put the model identifier (and embedding model, key thresholds, time constants)
in **one module** that every function imports, with an env-var override. When you
migrate model versions you change one line, not twenty. The same goes for any
constant duplicated across the codebase — a single source prevents drift.

### 19 — Use `jsonb`, not text, for structured columns

Many data layers silently down-cast an object to its string form when the column
is text — you write `{a:1}` and read back `'{"a":1}'`. Store structured data in a
real JSON column type. The corruption is invisible on write and breaks the read
path later.

### 20 — Keep the model out of auth and money decisions

The model writes phrasing and ranks options. It must never be the thing that
grants access, moves money, or decides a hard constraint. Those stay in
deterministic code with server-side validation — even when a model "proposes" an
action, validate the proposal against hard rules before applying it, and record
rejected proposals (they're signal too).

> **Origin example.** A monthly "tuner" lets the model *propose* changes to a
> plan, but a server-side validator rejects any proposal that violates hard
> limits (max changes, capped magnitude, locked items); valid proposals enter an
> explicit accept/decline/revert lifecycle. The model never mutates state
> directly.

---

## Part 5 — How it composes

A mature adaptive feature is these patterns stacked:

```
            ┌────────────────────── generation step ──────────────────────┐
 inputs ──▶ │ deterministic core (facts, decision, signature)  [P1, P8]    │
            │      │                                                        │
            │      ├─ ambiguous? → deterministic variant pick   [P11]       │
            │      ▼                                                        │
            │ generative veneer: tool-use schema  [P2]                      │
            │      + efficacy summary injected into prompt  [P12]           │
            │      + guardrails / fallback on output  [P3]                  │
            └──────────────┬───────────────────────────────────────────────┘
                           │ emit + log outcome row (signature, baseline,
                           │ conditions, variant)                  [P8]
                           ▼
            ┌────────── scheduled evaluator (nightly) ─────────────┐
            │ infer adherence from downstream data  [P9]           │
            │ fill T+1 / T+3 outcomes  [P10]                       │
            │ refresh efficacy rollup (gated by n)  [P13]          │
            └──────────────┬───────────────────────────────────────┘
                           │
                           ▼
            ┌────────── periodic analyst (agentic) ────────────────┐
            │ tool loop investigates  [P5,P6,P7]                    │
            │ writes deduped patterns  [P14]                        │
            └───────────────────────────────────────────────────────┘
                           │
                           └──▶ feeds back into the next generation step
```

### Suggested build order

1. **Ship the static feature first** with the deterministic/veneer split (P1),
   structured output (P2), and guardrails (P3). This alone is a solid feature.
2. **Add tiered regeneration** (P4) once you have interactions worth reflecting.
3. **Start logging** every suggestion with a signature + baseline + conditions
   (P8) — *before* you build anything that reads it. Data accumulates while you
   build the consumer. Cheap to add, and the cold-start clock starts now.
4. **Add the nightly evaluator** (P9, P10): passive adherence + delayed
   outcomes.
5. **Close the loop** (P12): roll up efficacy, inject into the prompt, gated by
   confidence (P13).
6. **Add A/B seeding** (P11) in ambiguous bands once the loop works, to upgrade
   correlation to causation.
7. **Add the agentic analyst** (P5–7, P14) last — it's the visible "insights"
   layer on top of data the rest of the system already produces.

Steps 1–3 are a week of work and pay off immediately. Steps 4–7 are where the
feature becomes something competitors can't copy by reading your UI, because the
value lives in the per-user data and the loop, not the screens.

---

## Quick-reference checklist

**Generation**
- [ ] Facts/decisions in deterministic code; model writes only prose (P1)
- [ ] Model output forced into a validated schema (P2)
- [ ] Banned-pattern + length guardrails with a deterministic fallback (P3)
- [ ] Word-safe truncation, extracted once (P3)
- [ ] Deterministic outputs stable across reruns (P1)

**Agentic**
- [ ] Bounded loop with a hard iteration cap + distinct exhausted-status (P5)
- [ ] Tool errors returned to the model as `is_error` results, not throws (P5)
- [ ] Tools whitelisted, user-scoped server-side, JSON-serializable (P6)
- [ ] System + tools marked cacheable (P7)

**Learning**
- [ ] Every suggestion fingerprinted + logged with baseline & conditions (P8)
- [ ] Adherence inferred passively; `null` when unprovable (P9)
- [ ] Outcomes captured at a delay; followed-vs-ignored control (P10)
- [ ] Randomize only in ambiguous bands; seed deterministically (P11)
- [ ] Efficacy rolled up and injected back into the prompt (P12)
- [ ] Everything gated by sample size + confidence (P13)
- [ ] Discovered patterns deduped / strengthened / decayed (P14)

**Operational**
- [ ] `await` all persists; long writes → background jobs (P15)
- [ ] Idempotent upserts on a stable composite key (P16)
- [ ] One global cron filtering by per-user local hour (P17)
- [ ] Model IDs / shared constants centralized (P18)
- [ ] `jsonb` (not text) for structured columns (P19)
- [ ] Model never decides auth/money/hard-constraints; proposals validated (P20)

---

## Glossary

- **Signature** — a stable string identifying a kind of suggestion
  (`type:param`), used to group occurrences across time.
- **Adherence** — 0–1 (or null) measure of whether the user followed a
  suggestion, inferred passively from downstream data.
- **Efficacy** — the average movement of a suggestion's target metric, compared
  followed-vs-ignored, per user per signature/variant.
- **Conditions snapshot** — the inputs present when a suggestion fired, stored so
  later analysis compares like-with-like.
- **Variant / arm** — one option in an ambiguous-band A/B; recorded per outcome.
- **Quasi-control** — the occasions a suggestion was ignored, used as a
  comparison group without a formal experiment.
- **Cold start** — the early period with too little data to act on; the feature
  runs as its non-learning baseline until thresholds are met.
</content>
