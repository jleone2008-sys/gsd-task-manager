# Cognitive Mode Switching — GSD build proposal

*Working planning doc. Source: `cognitive-switching-personal-brief.md` (on Desktop). Status: planning / not built. Resume from here.*

The one idea: most "can't focus / can't relax / wired / fried / stuck" moments are **switching failures**, not deficits. The trainable loop is **Notice → Name → Shift → Note** (15–90s, 0–10×/day). The unit of value is the **redirect, not a session** — no streaks, no nagging, the phone is the antagonist.

This doc folds the feature into GSD using what already exists (Oura → readiness/HRV/sleep, Home mood check-ins, the daily brief, tasks, tracked metrics).

---

## 1. The states — final set (research-backed)

**5 selectable states + a non-selectable Flow confirmation + a "Something else" escape hatch.** This is the floor *and* the ceiling: there are exactly 5 distinct intervention classes, and a state only earns a slot if its fix differs from every other state's.

| State | Feels like | Arousal × valence | Underlying mechanism | Intervention class |
|---|---|---|---|---|
| **Wired** | tense, racing, can't slow down | high / negative | over-arousal (right of Yerkes–Dodson peak) | **down-regulate** (parasympathetic breath) |
| **Scattered** | can't focus, tab-hopping, fragmented | high-mid / mixed | Salience Net can't *hold* the executive switch | **narrow attention** (one target, grounding) |
| **Stuck** | ruminating, frozen, looping | mid / negative-internal | DMN lock — won't release to executive | **pattern interrupt** (movement + environment) |
| **Spent** | exhausted, depleted, *after* pushing | low / negative | genuine resource depletion | **recover** (rest, permission to stop) |
| **Flat** | foggy, blank, unmotivated, *no* prior exertion | low / low engagement | reward-system under-activation | **activate** (tiny momentum action) — opposite of rest |
| *Flow* (not selectable) | locked in, going well | high / high (challenge≈skill) | none — functional | **protect + log the trigger** |
| *Something else* | catch-all | — | — | browse library |

### Key change vs the original brief
- The brief had **Locked in** as a tappable state. Research says **drop it from the chooser** (flow has no intervention; it just adds decision friction at the one moment you shouldn't be in the app) — keep it as a *positive confirmation outcome* only.
- **Add "Flat"** (low-arousal, low-engagement, no prior exertion). This is the under-arousal half of Yerkes–Dodson the original set was missing. Its fix is **behavioral activation** (a tiny activating act), the *opposite* of Spent's rest. Both feel "low," so they must be separate — resting a Flat person worsens them; activating a Spent person worsens them.
- **Scattered and Stuck stay separate** — same surface complaint ("not getting anything done"), opposite fixes: Scattered → *get into one thing and stop moving*; Stuck → *get out of your head and move*.

### One UX guardrail — the Spent/Flat disambiguation
Because Spent and Flat both read as "low" at tap-time, when the user taps either (or the predictor is torn between them), ask **one** follow-up: *"Did you just push hard / exert yourself?"* → Yes = **Spent** (rest), No = **Flat** (activate). This single question protects the most dangerous mis-route in the tool.

### Flow — how it's actually captured (the honest answer)
"Not selectable" was misleading. The real constraint: **the app cannot reliably distinguish "in flow" from "ignoring the tool" from "phone away, living life."** A long gap between check-ins is indistinguishable from a meeting, a nap, or disengagement — so we **never infer flow from silence**, and absence is **always neutral, never a failure** (no "you missed a check-in"). Flow is captured three honest ways instead:
1. **Objective signal = a completed focus block.** The two-mode timer is the instrument: deliberately starting a focus block and riding it to completion *is* a logged deep-work/flow period. Behavior records it — no self-report needed.
2. **Optional retro tag — only AFTER a block, never during.** On focus-block completion, a one-tap "Was that flow? what made it work?" logs the trigger ("no phone," "clear task," "morning"). This is the brief's "protect it + log what's working," moved to the non-interrupting moment.
3. **A quiet "Locked in — log it" affordance** in the modal *if the user happens to open it* — log-only, **never offers an intervention**, effectively says "get back to it."

So Flow is "selectable but log-only," and primarily *inferred from completed focus blocks*. The blind spot (flow with no timer running) stays a blind spot by design — that's the anti-engagement promise.

**Frameworks behind this:** Russell's circumplex (arousal×valence), Yerkes–Dodson (both over- and under-arousal dysfunctional, opposite fixes), triple-network model (Salience switches DMN↔CEN), flow channel model (apathy quadrant = Flat), behavioral activation (evidence-based fix for low-reward states).

---

## 2. The intervention library (research-backed, context-tagged)

Mode → a small curated set of tools, each tagged by evidence quality, duration, and **context requirements** so we never suggest the impossible (e.g. a walk before a meeting). Honesty in copy: only call something "evidence-backed" if it is.

| Intervention | Best for | Mechanism | Evidence | Duration | Context tags |
|---|---|---|---|---|---|
| **Physiological sigh** (double-inhale, long exhale ×3–5) | Wired | long exhale → vagal brake; offload CO₂ | **Strong** (Balban 2023, *Cell Reports Medicine*, Stanford — beat box breathing AND mindfulness for acute) | 30–60s | seated, silent/discreet |
| **Extended-exhale / box breathing** | Wired (slower) | paced slow breathing raises HRV/vagal tone | **Strong** class | 60–90s | seated, silent |
| **5-4-3-2-1 grounding** | Wired / reactive, spiraling | exteroceptive attention interrupts threat loop | **Moderate** (CBT standard; small RCTs) | 60–90s | seated, silent, needs surroundings |
| **"Park it" brain-dump** | Stuck / ruminating | externalize + defer the loop → frees working memory | **Moderate** (worry-postponement meta-analysis 2023; RCT 2024) | 60–90s | seated, silent, **needs writing surface** |
| **60–90s walk / brief movement** | Scattered, Stuck (generate), Flat (nudge up) | movement boosts divergent thinking + network switch | **Moderate** (Oppezzo & Schwartz 2014 — divergent only; may *hurt* focused tasks) | 60–90s | standing, leave-room ideal, not silent |
| **Eyes-closed rest / NSDR-style** | Spent / depleted | deliberate non-sleep rest restores attention | **Moderate→weak** for <2 min | **2–5 min** (not a true 90s tool) | seated, screen-free, private, eyes-closed |
| **Soft / panoramic gaze** | Wired (fallback only) | peripheral vision may lower amygdala arousal | **Weak/anecdotal** (Huberman-popularized, no human RCT) | 30–60s | seated, silent, needs open sightline |
| **Cold water on face** | Wired / acute spike | trigeminal → vagal bradycardia (dive reflex) | **Moderate-strong** mechanism, **safety caveat** | 15–30s | leave-room, needs sink, not discreet, **gate for heart conditions** |

### Library rules (from research)
- **Soft gaze** — never the headline suggestion; silent fallback only. Copy: "some practitioners use…", not "evidence-backed."
- **Cold water** — opt-in/advanced, gated behind privacy + a one-time safety acknowledgment (autonomic-conflict arrhythmia risk). Not in the auto-surface pool by default.
- **NSDR** — don't sell as a 30–90s tool; carve a separate "you have 5 min" recovery track for Spent.
- **Flat is the honest gap** — no single 90s act strongly lifts flat mood. Best fit is a behavioral-activation micro-act (a 2-minute starter task) or brief movement/light. Rate it *moderate* in-product; don't over-promise a state flip. (For Wired→acute-stress we legitimately *can* promise a real shift via the sigh; for Spent/Flat we can't — say so.)

### Context-fit filtering (answers "meeting soon → no walk")
Inputs: `minutesUntilNextEvent`, `isInPublic`, `canStand`, `hasPrivacy`. Hard gates remove any tool whose tags fail (e.g. `minutesUntilNextEvent < tool.minMinutes` → hide; `isInPublic` → hide non-silent; `!canStand` → hide standing/leave-room).

Three tiers:
1. **Tight** (`<5 min` to next event, or in public): only `{ physiological sigh, extended-exhale, 5-4-3-2-1, park-it (if surface), soft gaze (if sightline) }`. All seated/silent/≤90s. **Excludes walk, cold-water, NSDR.** ← the meeting-in-5 case.
2. **Medium** (`5–15 min`): add walk + cold-water *only if* can-stand + privacy.
3. **Open** (`≥15 min` + privacy): everything eligible, incl. NSDR (full 2–5 min).

**Tie-break by named state, not score:** Wired→sigh · Scattered→walk (if open+standing) else extended-exhale · Stuck→park-it (if surface) else walk · Spent→NSDR (if open) else eyes-closed · Flat→brief movement/activation micro-act.

So: **yes, the mode determines the activity**, drawn from this tagged library, **filtered by your real-time context**, and surfaced **best-fit-first** (usually one primary tool + a fallback).

---

## 3. Oura is stale most of the day — the prediction/fallback model

**Reality (from Joe):** Oura only syncs when its app is opened — typically once each morning. So at a 2pm check-in, Oura readiness/HRV/sleep is this-morning's snapshot, not live.

**Model: morning Oura = a daily baseline tilt; intra-day = fresh signals.**

- **Morning baseline (set once/day from Oura):** `readiness < 65` or `sleep_score < 70` → bias the whole day toward **Spent/Flat**. `hrv_ms` ≥ ~10% below 14-day baseline or `resting_hr` elevated → a **Wired** lean. This baseline's weight **decays** over the day (it's freshest at 8am, weak by 6pm).
- **Intra-day layer (the signals that ARE fresh):**
  - **Calendar density** — a dense back-to-back block just ended → Wired/Scattered/Spent lean; an imminent meeting → context for the *intervention filter*, not the state.
  - **Recent mood check-ins** (GSD already logs intra-day mood) — a recent low mood reinforces Spent/Flat; agitated → Wired.
  - **Recent workout logged** — just trained → transient Spent (good kind) / endorphin lift; no movement all day → Flat lean.
  - **Habits logged** — momentum signal (lots done → Locked-in/fine; nothing → Flat/Stuck).
  - **Time-of-day** — mid-afternoon dip → Spent/Flat; late-night → Wired.
  - **Last logged mode + recency** — trajectory (was Wired 2h ago, untreated → still Wired-leaning).
- **Best-effort opportunistic sync:** on app open we *can* nudge an Oura pull, but never block on it and never assume it returns newer data (Oura's cloud only has what the ring last synced). Treat Oura as **once-daily ground truth**, not a live sensor.

Output: a **soft** predicted state (pre-highlighted in the chooser) + a one-line "why" ("readiness 58 · HRV down · 3rd afternoon dip"). Confidence-gated: if signals conflict, highlight nothing and just show the neutral grid. **You always choose** — prediction is a nudge, never an auto-fill that locks.

---

## 4. The check-in UX — Variation B as a modal (Joe's pick)

A single **card** lives in/above the daily brief and moves through a lifecycle:

1. **Ask** — `How's your head right now?` with a soft predicted hint ("might be Spent") and a button. Calm, one line, ignorable.
2. **Tap → Modal** (Variation B): the 5-state grid (Wired · Scattered · Stuck · Spent · Flat) with the predicted state softly ringed + "Something else." Spent/Flat tap triggers the one disambiguation question.
3. **Select → modal closes → card becomes the Activity**: the context-filtered best-fit tool (e.g. "Meeting in 8 min — seated options. Physiological sigh ×3.") with `Start` and `Useful / OK / Didn't help`.
4. **Done → card clears**; a quiet line appears in the brief: `Last: Wired · 2:40pm — shift logged.`

### Trigger cadence — recommendation
Tie it to the philosophy (user-initiated, 0–10×/day, never the nagging phone):

- **Always present + always tappable.** The "How's your head?" card is a persistent, passive door so the instant you *notice* a shift, you can name it. This is the primary mechanism — self-initiated.
- **Do NOT auto-open the modal on app launch.** That's nagging / engagement-bait. The modal only opens on a deliberate tap.
- **Soft prediction, gently surfaced.** The card shows a predicted state only when confidence is reasonable; otherwise it's the neutral ask.
- **Light anchor-time emphasis, capped.** If no check-in has happened in ~3h *and* it's within waking hours, the card gets a subtle emphasis (slightly raised, a soft accent) at ~2–3 natural anchors (late-morning, mid-afternoon, early-evening) **or** right after a high-signal event (a dense meeting block just ended, a workout just logged). Emphasis = a visual nudge on a surface you're already looking at, **never** a push notification.
- **Only two real triggers ever** (per the brief): your scheduled check-in surfacing and the two-mode timer chime. No re-engagement notifications.

Net: it's **ambient and opt-in** — there when you notice, gently raised at a couple of natural beats, silent otherwise. That builds the Notice→Name→Shift habit without becoming the thing it's helping you escape.

---

## 5. Data model (additions)

- `mode_checkins` — `id, user_id, ts, predicted_state, confirmed_state, exerted_recently (bool, for Spent/Flat), source ('manual'|'anchor'|'context'), context_snapshot jsonb`.
- `mode_interventions` — `id, user_id, checkin_id, intervention_key, started_at, outcome ('useful'|'ok'|'no_help'|'skipped')`.
- `focus_blocks` / `diffuse_blocks` (two-mode timer) — `id, user_id, task_id?, started_at, ended_at, planned_min, phase ('focus'|'diffuse'), close_signal`.
- Intervention library = a **static JSON constant in the bundle** (~12–15 tools, tagged), not a DB table / CMS. Curate, don't build a 55-protocol library.
- Mode rollup for the brief/metrics = computed from `mode_checkins` + `focus/diffuse_blocks` (executive vs diffuse minutes), no new store.

All mirror the existing mood-checkin pattern (same RLS, same Home wiring).

---

## 6. Brief + tracked-metric integration

- **One brief line** — a new claim in `buildClaimSet` ("~6h fragmented executive, ~0 true diffuse; HRV down") + one rule-based insight ("no real diffuse block before noon in 4 days — try one tomorrow"). The missing-diffuse insight is the single highest-value output. Because the brief is now **fingerprint-gated**, this line only regenerates when mode data actually moves — no added cost.
- **Mode as a tracked chip** alongside sleep/protein/mood/alcohol (`🧠 mostly executive`).

---

## 6b. Learning, insights & personalization (the long-term value)

The raw loop is useful on day one, but the payoff compounds — and it plugs into machinery GSD already has: the **Insights/Patterns tab**, the **weekly-synthesis agent** (`beta-weekly-synthesis-background`, already does correlation/pattern detection with an n≥5 or |r|≥0.4 gate), and the **Phase-10 action-outcome evaluator** (`cron-evaluate-actions`, already scores whether brief recommendations worked over the following days). Mode efficacy reuses that same outcome-scoring spine.

**What it learns**
- **State clustering by time/day** — "Spent after 3pm (3rd time this week)," "Scattered every afternoon," and the #1 output "no real diffuse block before noon in 4 days."
- **Personal intervention efficacy** — the Useful/OK/Didn't-help signal per (state × intervention) → learns *your* best tool per state (e.g. "sigh fixes your Wired ~80%; 5-4-3-2-1 ~30%").
- **Predictor calibration** — predicted vs. confirmed state over time tunes the soft-prediction weights to you (maybe low readiness → Flat for you, not Spent).
- **Flow triggers** — from the retro tags on completed focus blocks ("mornings, no phone, one clear task").
- **Lever correlations** — tie mode to what GSD already tracks: "Wired mornings follow <6h sleep," "Flat days follow alcohol the night before," "Scattered drops on days you walked."

**What it adjusts**
1. **Re-ranks interventions** — surfaces your most-effective tool per state first (still within the context filter).
2. **Tunes the predictor** to your actual confirmations.
3. **Learns anchor times** — surfaces the check-in card when you actually tend to need it, not fixed 11/3/7.
4. **Feeds one line into the brief** — via the existing insight pipeline.

**Guardrails:** with one user's data, stay conservative — counts with a threshold before claiming a pattern (mirror the weekly-synthesis n≥5 / |r|≥0.4 gate). Every insight is **observational, never a score or a nag**. Personalization is transparent and overridable (you can always see + ignore the suggested tool).

**Where it lands in phasing:** raw logging + outcome signal in Phase 1 → rule-based clustering insights in Phase 2 (brief + Insights tab) → personalization (intervention re-rank, predictor calibration, anchor learning, lever correlations) in Phase 3+ once there's enough data to be honest.

## 7. Phasing (all same-day-buildable)

1. **Phase 1 — the loop.** `mode_checkins` table + the ask-card + B-modal + the ~12-tool context-filtered library + outcome capture. Delivers Notice→Name→Shift→Note on its own.
2. **Phase 2 — the brief line.** One claim + one insight rule (the missing-diffuse insight). Tiny, high value.
3. **Phase 3 — two-mode timer** wired to a GSD task + the executive/diffuse rollup + the tracked chip.

The predictor can start dumb in Phase 1 (Oura baseline + time-of-day) and gain the calendar/mood/workout signals incrementally — it degrades gracefully to "neutral grid, you choose."

---

## 8. Open decisions to confirm before building
- Exact anchor times for the soft emphasis (proposed: ~11am / ~3pm / ~7pm local) — or derive from the user's own check-in history.
- Whether Phase 1 ships the two-mode timer or defers it to Phase 3 (currently deferred).
- Whether "Flow" gets a tiny "protect this / log trigger" affordance in Phase 1 or later.
- Final curated list of ~12–15 interventions + their copy (honest evidence framing).

## Research sources
- Russell — Circumplex Model of Affect (arousal×valence).
- Yerkes–Dodson law (inverted-U; over/under-arousal, opposite fixes).
- Goulden et al. — Salience Network switches DMN↔CEN; DMN & rumination.
- Csikszentmihalyi — flow channel model (apathy quadrant = Flat).
- Behavioral activation evidence (Baker Center) — activation, not rest, for low-reward states.
- Balban et al. 2023, *Cell Reports Medicine* (Stanford) — physiological sigh beats box breathing + mindfulness for acute stress.
- Oppezzo & Schwartz 2014, *JEP:LMG* — walking boosts divergent (not convergent) thinking.
- Cold Face Test, *Scientific Reports* 2022; autonomic-conflict caveat, Shattock 2012, *J Physiol*.
- Worry-postponement meta-analysis (*IJCBT* 2023) + RCT 2024.
- Huberman Lab — physiological sigh / panoramic vision (rate panoramic weak).
