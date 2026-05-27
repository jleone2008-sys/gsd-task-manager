// Deterministic recommendation rules. Pure functions, no AI. Outputs are
// stable across regenerations so the brief doesn't say "10pm" once and
// "10:30pm" the next.
//
// Future entries (e.g. recommendIntensity, recommendHydrationFlag) follow
// the same pattern: take context, return deterministic value.

// ── Sickness detection ───────────────────────────────────────────────
// Returns { severe, mild, count } based on logged Oura tags + body
// temperature deviation. The brief calls this from recommendSleepTarget;
// future flows (intensity recommendation, daily energy framing) can
// reuse the same primitive.
//
//   severe = wearable + tag agree on illness, or body temp clearly elevated
//   mild   = single isolated signal
//   count  = total signals fired (for downstream scoring / pills)
const SICK_TAG_RE = /sick|ill|fever|cold|flu|headache|nausea|sore|migraine|congest/i;
function detectSickness({ tags, activity } = {}) {
  const sickTags = (tags || []).filter(t =>
    SICK_TAG_RE.test(`${t.kind || ''} ${t.name || ''}`)
  );
  const tempDev = activity?.body_temp_deviation_c;
  const tempMild   = tempDev != null && Number(tempDev) > 0.3;
  const tempSevere = tempDev != null && Number(tempDev) > 0.5;
  const signals = [
    sickTags.length >= 1,
    tempMild,
  ].filter(Boolean).length;
  return {
    severe: tempSevere || sickTags.length >= 2 || (sickTags.length >= 1 && tempMild),
    mild:   signals === 1,
    count:  signals,
  };
}

// Sleep target — when to be in bed. Fully formulaic; no AI input is
// honored. Returns the same target string in both morning + evening
// modes (the brief surfaces it differently per mode — Today recap row
// in morning, wind-down row in evening).
//
// Rules (any single trigger → push to that tier; tiers are ordered
// most-aggressive first):
//
//   9:00 PM ← last night's total_sleep_min < 300 (under 5 hours).
//             Sleep-emergency override — beats sickness + recovery.
//
//   9:30 PM ← severe sickness (temp dev > +0.5°C, OR ≥2 sick tags, OR a
//             sick tag + mild temp elevation)
//          ← readiness ≤ 60
//          ← HRV < 70% of 7-day median
//
//   10:00 PM ← mild sickness (one sick tag OR temp dev > +0.3°C)
//            ← readiness ≤ 75
//
//   10:30 PM ← default
//
// 'mode' is kept in the signature for back-compat with existing callers.
// Old positional form (recovery, mode, baselines7d) is still accepted —
// new callers can pass an object: ({ recovery, activity, tags, baselines7d }).
function recommendSleepTarget(arg1, arg2, arg3) {
  // Two call shapes: object-form (preferred) or legacy positional.
  let recovery, activity, baselines7d, tags;
  if (arg1 && typeof arg1 === 'object' && ('recovery' in arg1 || 'activity' in arg1 || 'tags' in arg1)) {
    recovery    = arg1.recovery;
    activity    = arg1.activity;
    baselines7d = arg1.baselines7d;
    tags        = arg1.tags;
  } else {
    recovery    = arg1;
    baselines7d = arg3;
    activity    = undefined;
    tags        = undefined;
  }

  const readiness = recovery?.readiness_score;
  const hrv       = recovery?.hrv_ms;
  const hrvBase   = baselines7d?.hrv_ms_median;
  const hrvLow    = (hrv != null && hrvBase != null && Number(hrv) < 0.7 * Number(hrvBase));
  const totalSleepMin = recovery?.total_sleep_min;
  const shortSleep    = totalSleepMin != null && Number(totalSleepMin) < 300;   // < 5 hours
  const sick          = detectSickness({ tags, activity });

  // Critical tier — last night was a sleep emergency (<5 hr). Override
  // everything else and push to 9 PM.
  if (shortSleep) return '9:00 PM';

  // Severe tier
  if (sick.severe) return '9:30 PM';
  if (readiness != null && Number(readiness) <= 60) return '9:30 PM';
  if (hrvLow) return '9:30 PM';

  // Mild tier
  if (sick.mild) return '10:00 PM';
  if (readiness != null && Number(readiness) <= 75) return '10:00 PM';

  // Default
  return '10:30 PM';
}

module.exports = { recommendSleepTarget, detectSickness };
