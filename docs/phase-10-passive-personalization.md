# Phase 10 — Passive Personalization with Single-Subject A/B

A learning layer that sits underneath the daily brief. Every suggestion the brief gives is tracked: was it followed (inferred from downstream data, no button to click), and did the metric it targeted move (measured at T+1 and T+3). Over weeks this builds a personal evidence file of which kinds of advice work for *you*, and the brief leans into what's worked. To go from "things correlate" to "we caused this," the recommendations library deliberately randomizes between plausible options when conditions are ambiguous, turning the system into a continuous A/B test on a sample size of one.

## How it works

**Every brief suggestion gets fingerprinted and logged.** When the brief emits "9:30 PM bedtime", a row is written to `brief_action_outcomes` capturing the signature (`bedtime_target:21:30`), the target metric (`sleep_score`), and the current baseline.

**A nightly cron infers adherence from your data.** At 11 PM local, it reads downstream tables and scores each suggestion 0–1:

| Suggestion type | How adherence is inferred |
|---|---|
| Bedtime target | Compare Oura sleep midpoint to suggested time. Within 15 min = 1.0, drops off to 0 at 90+ min late |
| "Take it easy" | No workout logged + activity score below norm = 1.0 |
| "Push your lift" | Workout session logged + volume ≥80% of recent average = 1.0 |
| "Protect tonight's sleep" | Tomorrow's total sleep beats 7-day median by 20+ min = 1.0 |
| Habit focus (e.g. "posture") | That habit got checked off that day = 1.0 |

**The cron also fills in outcomes.** Reads the target metric on day T+1 and T+3, stores them on the same row.

**A materialized view rolls everything up.** `v_user_action_efficacy` aggregates by signature and variant, computing the average metric change when the advice was followed versus when it wasn't — a quasi-control comparison that isolates the advice from background noise.

**The brief reads its own report card.** When Claude generates tomorrow's brief, the system prompt includes a small block: *"bedtime_target:21:30 — n=18, delta +6.2 sleep_score when followed, −0.4 when ignored, high confidence."* Claude leans into what's worked, deprioritizes what hasn't. The user sees none of this; they just notice the brief getting sharper.

**A/B testing fires in ambiguous bands.** When recovery is 65–75 (the gray zone where either 9:30 or 10:00 PM bedtime is defensible), the system randomly picks one and records `variant_id`. After ~30 samples per arm under similar baseline conditions, there's causal evidence — not just correlation — for which variant moves *your* sleep score more.

**Sunday Opus runs the analyst pass.** Weekly synthesis can call `get_action_efficacy` and `get_raw_outcomes` to investigate ("why are push_workout suggestions not landing — is it adherence or efficacy?") and write findings to `patterns_discovered`. This is where the loop becomes visible, as a noticed pattern.

## What you get

**1. The brief gets quietly personalized.** Today every user gets the same recommendation engine. After 6 weeks of Phase 10, the brief is shaped by actual response history. Someone whose sleep responds dramatically to bedtime sees bedtime suggestions emphasized; someone whose sleep is dominated by stress sees those de-emphasized in favor of evening-stress framing.

**2. Bad advice self-prunes.** No dismiss button. If "push workout on high-readiness days" is followed by zero readiness lift the next morning across 10 occasions, the efficacy view shows ~0 delta, the brief context flags it as low-performing, and Claude generates it less often.

**3. Causal evidence for lifestyle decisions.** Most lifestyle apps tell you generic things ("aim for 8 hours"). Phase 10 produces statements like:

> *"Across 34 ambiguous-readiness evenings, your 9:30 PM bedtime suggestions produced an average sleep_score gain of +7.1 vs +2.3 for 10:00 PM under matched conditions. Effect is robust (stddev 4.8, n=17 vs 17)."*

That's a personal, evidence-based fact about how your body works — unreachable from any wearable's stock app.

**4. Adherence-versus-efficacy is more diagnostic than either alone.**

| Adherence | Efficacy | Meaning |
|---|---|---|
| High | High | The advice works *and* you follow it. Double down. |
| High | Low | You follow it but it doesn't help. The advice is wrong for you — reframe or replace. |
| Low | High | When you do follow it, it works — but you usually don't. Maybe timing or framing is off. |
| Low | Low | Stop suggesting this. |

Without Phase 10 the brief sees none of this. With it, the brief becomes a feedback-controlled system.

## Concrete example over 8 weeks

**Week 1**: Brief suggests `"9:30 PM bedtime"` on a low-recovery evening. Row written: `bedtime_target:21:30`, baseline `sleep_score = 68`.
**Day after**: Cron sees actual bedtime was 9:42. Adherence = 0.92. Tomorrow's sleep_score = 79. Delta = +11.
**Week 2**: A randomized 10:00 PM suggestion goes out on a similar evening. Bedtime 10:11. Adherence = 0.95. Sleep_score = 71. Delta = +3.
**Weeks 3–6**: Pattern repeats across many similar evenings. Some evenings the suggestion gets ignored entirely — those rows become the control group.
**Week 7**: Efficacy view shows `9:30 PM variant: +7.1 mean delta, n=12 followed`; `10:00 PM variant: +2.3 mean delta, n=11 followed`. Claude's morning brief prompt now carries this. Suggestions on similar evenings default to 9:30.
**Week 8**: Sunday weekly synthesis reads the same data, writes a pattern: *"On low-recovery evenings, a 30-minute earlier bedtime target consistently outperforms standard for your sleep recovery."* Surfaces in the Patterns subtab.

No surveys, no dismissals, no ratings. The system watched, learned, and adjusted.

## Cost and risk

- **No new user-facing UI** (efficacy stats stay internal). Add a dashboard later if wanted.
- **6-week cold start** — no signal until enough outcomes accumulate. Brief works as today until then.
- **Confounder honesty** — lifestyle data is noisy. 95% CI on a 30-sample-per-arm comparison is wide. System reports `confidence: low/med/high` based on n and variance so weak signal isn't treated as strong.
- **Compute** — cron is a few hundred Supabase reads per night. Materialized view refresh is sub-second at current data volume. Effectively free.

## End state

A brief that knows what works for *this user* specifically, based on actual evidence from *this user's* body's response, with no extra effort from the user.
