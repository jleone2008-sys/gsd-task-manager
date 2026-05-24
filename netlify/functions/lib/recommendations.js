// Deterministic recommendation rules. Pure functions, no AI. Outputs are
// stable across regenerations so the brief doesn't say "10pm" once and
// "10:30pm" the next.
//
// Future entries (e.g. recommendIntensity, recommendHydrationFlag) follow
// the same pattern: take context, return deterministic value.

// Sleep target — when to be in bed. Returns a target for BOTH modes now:
// the morning brief surfaces it in the Today recap ("Tonight 10:30 PM"),
// the evening brief surfaces it in the wind-down row ("In bed by 10:30 PM").
// Rules pivot on the most recent recovery read:
//   readiness <= 60 OR HRV well below 7d median (< 70%) → 9:30 PM (push earlier)
//   readiness <= 75                                      → 10:00 PM
//   else                                                 → 10:30 PM (default)
// mode is kept in the signature for back-compat with existing callers and so
// future variants (e.g. weekend defaults) can branch on it without an API
// change.
function recommendSleepTarget(recovery, mode, baselines7d) {
  if (!recovery) return '10:30 PM';
  const readiness = recovery.readiness_score;
  const hrv       = recovery.hrv_ms;
  const hrvBase   = baselines7d?.hrv_ms_median;
  const hrvLow    = (hrv != null && hrvBase != null && Number(hrv) < 0.7 * Number(hrvBase));
  if ((readiness != null && Number(readiness) <= 60) || hrvLow) return '9:30 PM';
  if (readiness != null && Number(readiness) <= 75) return '10:00 PM';
  return '10:30 PM';
}

module.exports = { recommendSleepTarget };
