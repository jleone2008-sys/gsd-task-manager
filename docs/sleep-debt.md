# Sleep Debt (daily brief metric)

A **formulaic, research-grounded** sleep-debt estimate shown in the daily brief's
stat list (below **Sleep**, above **Resting HR**, h/mm format, hidden when not
meaningful). Lives entirely server-side in `netlify/functions/lib/brief-builders.js`
(`computeSleepDebt`), wired into the brief context by `beta-daily-brief.js`.

## Why we compute our own
Oura's **Sleep Debt** is an app-only computed insight — it is **not exposed by
the Oura API** (verified against the v2 OpenAPI spec and a live sandbox call:
zero `debt`/`deficit`/sleep-need fields across `daily_sleep`, `sleep`,
`daily_readiness`). The only API-accessible sleep-vs-need signal is the
`sleep_balance` readiness *contributor*, a 0–100 score — not minutes. So to put a
Sleep-Debt number in the brief we compute an equivalent from data we already
store (`oura_daily.total_sleep_min`). It is a faithful research-based estimate,
**not** Oura's exact number (their need model + weighting are proprietary).

## The formula
Given the user's nightly sleep history (`{date, total_sleep_min}`) and the
brief's local `today`:

1. **Personal sleep need `N`** — the 85th percentile of the user's own
   `total_sleep_min` over the last **90 valid nights**, clamped to **6.5h–9.5h**
   (390–570 min). Optimal sleep duration is revealed by a person's *rebound /
   extended* nights, not their (debt-suppressed) mean — so the upper percentile
   approximates need. This is why a consistent short-sleeper shows **no phantom
   debt** (their `N` settles at their own level), the key flaw in a flat-8h model.

2. **Recency-weighted cumulative deficit** over the last **14 nights**:
   ```
   wᵢ  = 0.5^(ageᵢ / 4)                 // 4-day half-life: last night 1.0, 4d ago 0.5, 14d ago ≈ 0.09
   δᵢ  = max( N − sleepᵢ , −90 )        // catch-up sleep repays debt, capped at 90 min/night
   SleepDebt = max( 0, Σ wᵢ · δᵢ )      // floored at 0; rendered in h/mm
   ```
   Sleep pressure (homeostatic Process S) **dissipates exponentially**, so recent
   loss dominates and old debt fades — hence the exponential recency weight.
   Catch-up sleep genuinely repays debt, so a night above need contributes a
   *negative* deficit — but recovery is slow & partial (~1h of debt takes ~4 days
   to clear), so a single long night's credit is capped at 90 min.

## Gates (all deterministic, in code — per the formulaic-first principle)
The metric returns `null` (row hidden) unless **all** hold:
- **≥21 valid nights** of history (so `N` is trustworthy) — cold-start gate.
- **≥5 of the last 14 nights** have data (enough recent signal).
- **SleepDebt ≥ 30 effective minutes** — below this reads as "None."

## Tiers (for the row note; lower-is-better)
`None <30m · Mild 30m–1h30 · Moderate 1h30–3h · High >3h` — roughly mirroring
Oura's app tiers. "moderate"/"high" surface as the stat-row note; "mild" shows no note.

## Parameters (single source of truth: `SLEEP_DEBT` const in `brief-builders.js`)
| Param | Value | Rationale |
|---|---|---|
| Need percentile | 85th | upper tail ≈ optimal sleep duration |
| Need clamp | 6.5h–9.5h | physiological adult range |
| Baseline window | 90 nights | stable personal-need estimate |
| Debt window | 14 nights | standard acute sleep-debt horizon |
| Recency half-life | 4 days | Process-S decay + ~1h/4d recovery rate |
| Surplus cap | 90 min/night | recovery is slow & partial |
| Min baseline | 21 nights | cold-start guard |
| Min window nights | 5 | enough recent signal |
| Show threshold | 30 min | hide noise / "None" |

## Data source & scope
- Reads `oura_daily.total_sleep_min` (keyed by `user_email`). **Oura-only** for
  now — Whoop-only users have no `oura_daily` history, so the metric simply gates
  off (returns `null`). A Whoop fallback (`whoop_daily.sleep_duration_min`) is a
  possible follow-up.
- Verified end-to-end in unit tests: cold-start/well-rested/short-sleeper →
  hidden; chronic −30/−60m → moderate/high; catch-up + surplus-cap behave;
  renders as `Sleep → Sleep Debt → Resting HR → HRV`.

## Research
- Kitamura et al. 2016, *Scientific Reports* — *Estimating individual optimal
  sleep duration and potential sleep debt* (need from rebound/extended sleep;
  PSD; ~1h debt ≈ 4 days to recover). https://www.nature.com/articles/srep35812
- Borbély — two-process model of sleep regulation; Process S exponential
  build/dissipation. https://onlinelibrary.wiley.com/doi/10.1111/jsr.13598
- Chronic sleep-restriction dose-response — average need ≈ 8.16h (population
  anchor for the clamp).
- Sleep Foundation — sleep debt & catch-up sleep; rolling ~14-day horizon.
  https://www.sleepfoundation.org/how-sleep-works/sleep-debt-and-catch-up-sleep
