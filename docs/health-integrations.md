# Health integrations — data inventory & feature scoping

Last updated: 2026-05-14

This document is the canonical reference for **what health data GSD has
access to**, **where it lives in Supabase**, and **how we plan to use it**.
It is meant to be edited in place as the integrations evolve.

Related:
- [supabase-migrations/health_integrations.sql](../supabase-migrations/health_integrations.sql) — base schema
- [supabase-migrations/health_integrations_v2_oura_full.sql](../supabase-migrations/health_integrations_v2_oura_full.sql) — full Oura schema
- [netlify/functions/cron-health-sync.js](../netlify/functions/cron-health-sync.js) — the nightly sync that populates these tables
- [beta/src/02-settings.js](../beta/src/02-settings.js) — per-user OAuth connect

---

## 1. Integration status

| Provider | Connect UI | OAuth | Nightly sync | Auth model |
|---|---|---|---|---|
| **Oura** | ✅ live in /beta Settings | ✅ | ✅ daily 04:00 UTC | **GSD-owned app** — shared client_id, all users authorize against one app at cloud.ouraring.com. |
| **Whoop** | ✅ live in /beta Settings | ✅ | ✅ daily 04:00 UTC | **Bring-your-own-credentials (BYO)** — each user creates their own Whoop dev app and pastes their client_id + secret into Settings. |

**Why Whoop uses BYO:** GSD doesn't maintain a Whoop developer account (the
owner isn't a Whoop member, and Whoop's dev terms historically required
membership). Each end-user has their own developer app under their own
Whoop login. The trade-off is one-time setup friction per user; the upside
is zero Whoop dev-account dependencies on GSD's side and independent rate
quotas per user.

When a user connects:
1. **Oura:** click **Connect Oura** → redirected to cloud.ouraring.com to authorize → callback stores encrypted refresh token in `user_profiles.oura_refresh_token_enc`.
2. **Whoop (BYO):** user follows the in-app instructions to create their own dev app at developer.whoop.com, registers our callback URL, pastes client_id + client_secret into the Settings form. Credentials are saved via `beta-whoop-creds` (secret AES-256-GCM-encrypted into `user_profiles.whoop_client_secret_enc`). Then they click **Authorize Whoop** → standard OAuth flow with their own client_id → refresh token stored in `user_profiles.whoop_refresh_token_enc`.
3. Either way, a 30-day backfill kicks off immediately so the user has history without waiting for tomorrow's scheduled run.
4. Nightly cron pulls a rolling 3-day window for everyone connected. Old data is upserted (so Oura's day-end recalcs and Whoop's late-arriving recoveries are picked up).

---

## 2. Oura — data inventory

All Oura V2 endpoints exposed to personal-tier apps. Tables live in the
public Supabase schema. RLS is on with no policies — reads happen via our
own Netlify functions using the service key.

### `oura_daily` — one row per user per day

Daily summary fields rolled up into a single wide row for fast charting.

| Column | Source endpoint | Range | Meaning |
|---|---|---|---|
| **Readiness** | | | |
| `readiness_score` | daily_readiness | 0–100 | Oura's headline readiness score |
| `readiness_activity_balance` | daily_readiness.contributors | 0–100 | how well recent activity balances recovery |
| `readiness_body_temperature` | " | 0–100 | body temp contributor (illness signal) |
| `readiness_hrv_balance` | " | 0–100 | HRV vs 14-day baseline |
| `readiness_previous_day_activity` | " | 0–100 | |
| `readiness_previous_night` | " | 0–100 | previous night's sleep impact |
| `readiness_recovery_index` | " | 0–100 | overnight HR/HRV recovery |
| `readiness_resting_hr` | " | 0–100 | resting HR vs baseline |
| `readiness_sleep_balance` | " | 0–100 | total sleep vs need |
| **Sleep (denormalized longest sleep of the day)** | | | |
| `sleep_score` | daily_sleep | 0–100 | overall sleep score |
| `sleep_timing_score` | daily_sleep.contributors | 0–100 | bedtime consistency |
| `sleep_restfulness_score` | daily_sleep.contributors | 0–100 | restlessness contributor |
| `total_sleep_min` | sleep | int | total time asleep |
| `rem_sleep_min` | sleep | int | |
| `deep_sleep_min` | sleep | int | |
| `light_sleep_min` | sleep | int | |
| `awake_min` | sleep | int | time awake during the period |
| `sleep_latency_min` | sleep | int | how long to fall asleep |
| `sleep_midpoint_offset_min` | sleep | int | offset from local midnight |
| `sleep_efficiency_pct` | sleep | numeric | asleep / in-bed |
| `average_breathing_rate` | sleep | numeric | |
| `lowest_hr` | sleep | int | nighttime low HR |
| `average_hr` | sleep | int | average sleep HR |
| `resting_hr` | sleep | int | (alias of lowest_hr for cross-provider compat) |
| `hrv_ms` | sleep | numeric | RMSSD-equivalent HRV |
| **Body signals** | | | |
| `body_temp_deviation_c` | daily_readiness | numeric | nightly temp deviation from baseline |
| `temperature_trend_deviation_c` | daily_readiness | numeric | trend deviation |
| `spo2_percent` | daily_spo2 | numeric | average overnight SpO2 |
| `stress_high_seconds` | daily_stress | int | time in "high stress" |
| `stress_recovery_seconds` | daily_stress | int | time in "recovery" |
| `stress_day_summary` | daily_stress | text | restored / normal / stressful |
| `resilience_level` | daily_resilience | text | limited → exceptional (5 levels) |
| `cardiovascular_age` | daily_cardiovascular_age | int | estimated CV age in years |
| `vo2_max` | vO2_max | numeric | workout-derived VO2 max |
| **Activity** | | | |
| `activity_score` | daily_activity | 0–100 | |
| `steps` | daily_activity | int | |
| `active_calories` | daily_activity | int | |
| `total_calories` | daily_activity | int | including BMR |
| `activity_total_seconds` | daily_activity | int | total tracked active time |
| `high_activity_seconds` | daily_activity | int | |
| `medium_activity_seconds` | daily_activity | int | |
| `low_activity_seconds` | daily_activity | int | |
| `sedentary_seconds` | daily_activity | int | |
| `non_wear_seconds` | daily_activity | int | ring off the finger |
| `target_calories` / `target_meters` | daily_activity | int | daily goals |
| `equivalent_walking_distance_meters` | daily_activity | int | activity normalized to walking distance |
| `inactivity_alerts` | daily_activity | int | |
| `met_average` | daily_activity | numeric | average MET for the day |
| `raw` | jsonb | | full vendor responses for every endpoint above |

### `oura_sleep_periods` — every detected sleep period

One row per main sleep + per nap + per rest period. Use this when a feature
needs nap-level granularity (e.g., "did a nap correlate with worse sleep
that night?").

Key fields: `oura_id`, `day`, `type` (long_sleep / sleep / late_nap / rest),
`bedtime_start`, `bedtime_end`, all duration columns in **seconds**,
`hrv_average`, `hr_lowest`, `respiratory_rate`, `hypnogram_5min` (compressed
per-5-minute stage map), `movement_30_sec` (compressed per-30-second
movement). Full payload in `raw`.

### `oura_workouts` — one row per workout

Auto-detected + manual + confirmed workouts. Fields: `activity` (string code:
"running", "cycling", "yoga", etc.), `source`, `start_time`, `end_time`,
`duration_min`, `intensity` (easy/moderate/hard), `load`, `average_hr`,
`max_hr`, `calories`, `distance_m`, `label`.

### `oura_sessions` — meditation / breathing / relaxation

Fields: `type` (meditation/breathing/relaxation/rest/body_status), `mood`,
`start_time`, `end_time`, `duration_min`.

### `oura_tags` — user-applied tags

Each row is a tag the user logged in the Oura app. `tag_type_code` is Oura's
internal code (e.g. `caffeine`, `alcohol`, `late_meal`, `stressful_event`).
Users can also create `custom_name` tags. Tags span `start_day` → `end_day`
(can be multi-day for things like "sick"). Comments allowed.

### `oura_heartrate` — 5-min HR samples

Only yesterday's samples are stored nightly (~288 rows/user/day) to keep
storage bounded. Backfill mode does not currently expand this window —
expand if a feature needs deeper history. Fields: `ts`, `bpm`, `source`
(awake / asleep / rest / workout / live).

### `oura_ring_config` — ring hardware/firmware

Rarely changes. Useful for cohort segmentation (gen3 vs gen4) and for
displaying "your ring" details to the user.

---

## 3. Whoop — data inventory + BYO credentials

Pulled from Whoop V1 developer API. Single table since Whoop's surface is
narrower than Oura's.

### Per-user credential storage

The BYO model adds three columns to `user_profiles`:

| Column | Type | Notes |
|---|---|---|
| `whoop_client_id` | text | User's own Whoop dev app client_id. Public per OAuth spec, stored plaintext. |
| `whoop_client_secret_enc` | text | AES-256-GCM-encrypted with `ADMIN_ENCRYPTION_KEY` (same key as refresh tokens). |
| `whoop_refresh_token_enc` | text | Stored after OAuth completes. Whoop rotates this on every exchange; cron re-stores. |

User-facing endpoints:

- `POST beta-whoop-creds {action:'status'}` → `{configured, client_id, connected, whoop_account_email}`
- `POST beta-whoop-creds {action:'set', client_id, client_secret}` → encrypts secret, stores both
- `POST beta-whoop-creds {action:'clear'}` → wipes creds **and** any existing refresh token

When the user clicks Disconnect (vs Clear credentials), only the refresh
token is nulled — saved credentials remain so they can re-authorize without
re-entering client_id/secret.

The cron sync, OAuth callback, and disconnect endpoint all read the
per-user client_id + secret from `user_profiles` instead of env vars. No
shared `BETA_WHOOP_CLIENT_*` env vars exist.

### Setup flow shown in beta Settings UI

The Whoop card walks the user through:
1. Sign in at developer.whoop.com.
2. Create an app (any name).
3. Add the exact redirect URI shown in the card (`https://<host>/.netlify/functions/beta-whoop-auth`).
4. Check scopes: `offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement`.
5. Paste Client ID + Client Secret into the form → click **Save & Authorize** → OAuth flow runs.

### `whoop_daily` — one row per cycle (≈ one per day)

| Column | Source | Meaning |
|---|---|---|
| `cycle_id` | /v1/cycle | Whoop cycle id (cycles cross midnight) |
| `recovery_score` | /v1/recovery | 0–100 |
| `hrv_ms` | /v1/recovery | RMSSD |
| `resting_hr` | /v1/recovery | |
| `spo2_percent` | /v1/recovery | overnight |
| `skin_temp_c` | /v1/recovery | |
| `strain` | /v1/cycle | 0–21 day strain |
| `sleep_duration_min` | /v1/activity/sleep | longest non-nap |
| `sleep_performance` | /v1/activity/sleep | 0–100 |
| `sleep_efficiency` | /v1/activity/sleep | 0–100 |
| `sleep_consistency` | /v1/activity/sleep | 0–100 |
| `sleep_respiratory_rate` | /v1/activity/sleep | |
| `raw` | jsonb | full cycle + recovery + sleep responses |

**Not yet pulled** (sized down for v1 — easy add later if useful):
- `/v1/activity/workout` — individual workouts
- Whoop body measurements (height/weight/max HR)
- Whoop journal entries (the daily questionnaire Whoop users fill out — could be a great signal source)

---

## 4. Feature scoping — what we can build

Grouped by where the feature most naturally lives in the app.

### A. Journal enrichment (highest priority — was the original motivation)

The journal page already has a daily entry. We can passively decorate each
day with the matching health row(s) so the user sees physiological context
alongside what they wrote.

1. **Daily health strip** — a compact bar above each journal entry showing
   readiness score, sleep score, strain (Whoop) or activity (Oura), and a
   sparkline of HRV/RHR. One row per day, pulled from `oura_daily` /
   `whoop_daily` by `entry_date`.
2. **Auto-tag low-recovery days** — when readiness < 70 (Oura) or recovery
   < 67% (Whoop), surface a subtle "rough recovery" badge on that journal
   day. User can dismiss or roll up into stats.
3. **Sleep-vs-mood correlation** — once journal entries have a mood field,
   compute Pearson r between mood and total_sleep_min over the user's
   history. Show as "your sleep correlates with your mood at r=0.42 (95%
   CI …)". Wait until ≥30 days of data.
4. **Tag-event annotations** — overlay Oura tags (caffeine, alcohol, late
   meal) directly onto the journal day. Especially powerful for surfacing
   "this is your 4th alcohol entry in the past 14 days" type observations.

### B. Habits

Habits already track recurring routines. Health data can both gate and
reward them.

1. **Conditional habits** — "10-min walk if my readiness is < 75". The
   habit prompt only fires when the morning sync confirms low readiness.
   Implementation: habit row gets an optional `condition` jsonb; the
   habits-core checks against `oura_daily` for today.
2. **Strain-aware workout suggestions** — for users who track a "workout"
   habit, suppress the prompt when yesterday's Whoop strain was >18 or
   Oura activity load was high. Soft prompt to active recovery instead.
3. **Sleep target visibility** — show current sleep streak alongside the
   sleep habit (e.g., "12 nights ≥ 7h"). Data is already in oura_daily.

### C. Tasks

Less obvious fit, but a few high-signal interventions:

1. **Cognitive-load throttling** — on days where `readiness_score < 60`
   AND `hrv_ms < user's 30-day floor`, demote the auto-suggested top task
   from "deep work" to "admin". Soft suggestion only, not forced.
2. **Schedule sensitive tasks at peak times** — users on Oura can see
   their sleep midpoint and Stress; we can recommend deep-work blocks
   2–4 hours after typical wake.

### D. Insights tab (new)

A dashboard specifically for "what is my body doing?" — separate from
the productivity tabs. This is the natural home for the eventual
AI-driven overall-life-view feature.

1. **Trend cards** — 7/30/90-day rolling charts for readiness, sleep,
   HRV, RHR, steps, stress. Direct read from `oura_daily`.
2. **Personal baselines** — display each user's 60-day median for HRV
   and RHR with current-day deviation. (Oura's app already does this but
   we want it co-located with productivity context.)
3. **Weekly recap** — Sunday email/notification: "this week your average
   readiness was 78 (↑3 from last week), you slept 7h12m on average
   (↓18m), you logged 4 alcohol tags." Driven by a separate weekly cron.
4. **Recovery debt indicator** — running 7-day sum of (target − actual)
   for sleep and rest. Visualized as a debt bar.

### E. AI / overall-life view (long horizon)

Once Dropbox photo+file context, calendar, and health data are all
flowing, the planned weekly AI sync can join them:

- "You slept poorly on the 3 nights after that big client meeting on
  Tuesday — your HRV has dropped 11% since."
- "Every time you tag alcohol on Oura, your readiness drops ~14 points
  the next day. The effect is twice as strong on weeknights."
- "Your highest-scoring workouts (by Oura load) consistently happen on
  days where you logged a journal entry the night before. Correlation
  isn't causation, but worth a 2-week test."

These require: (a) Oura data flowing (done), (b) Whoop wired (pending),
(c) Dropbox sync running (done — admin browse already live), (d) the
weekly AI prompt itself (not yet built).

### F. Admin tools

For ops:

1. **Per-user health connection dashboard** — admin tab showing which
   users are connected to which providers, last sync timestamp, last
   error from `health_sync_log`. Cheap to build.
2. **Sync retry** — admin button to force-resync a specific user's
   provider when their sync errored.

---

## 5. Data quality + edge cases to watch

- **Time zones**. Both Oura and Whoop normalize "day" to the user's local
  timezone. We store the resulting date as-is. Cross-provider comparisons
  (e.g. "Whoop strain vs Oura activity on same day") will be consistent
  for a single user but care is needed if a user travels mid-day.
- **Late-arriving recoveries** (Whoop). Whoop's morning recovery can
  arrive hours after the cycle ends. Our 3-day rolling window catches this.
- **Day-end recalcs** (Oura). Oura updates activity scores up to several
  hours after the day ends. Same rolling-window catches this.
- **Scope rejections**. If Oura rejects a particular scope at app review,
  the sync function tolerates the 403 silently and the corresponding
  fields stay null. No user-facing error.
- **Whoop refresh-token rotation**. Whoop rotates the refresh token on
  every exchange; our sync function re-encrypts and re-stores. A failure
  mid-sync would leave the stored token stale — guard with idempotent
  re-encryption (already implemented).
- **Storage cost**. `oura_heartrate` is the heaviest table — yesterday-only
  on nightly = ~290 rows/day/user ≈ 100k rows/year/user. Acceptable for
  beta but worth revisiting at scale (consider partitioning by month).

---

## 6. Roadmap (rough order)

1. **Now** — Oura connect + sync live. Whoop client_id + secret to land
   when ready. SQL migrations applied.
2. **Next** — Daily health strip on journal entries (Feature A.1). This is
   the smallest piece of user-visible value and validates that data is
   flowing correctly.
3. **Then** — Trends/Insights tab v0 (Feature D.1, D.2). Builds the
   "this app understands me" muscle.
4. **Then** — Sleep-vs-mood correlation cards (A.3) and tag overlays
   (A.4). Both require ≥30 days of data so naturally land later.
5. **Long horizon** — weekly AI sync joining health + Dropbox + calendar +
   journal into the overall life-view. Wait until E's prerequisites all
   ship.
