// Deterministic recommendation rules. Pure functions, no AI. Outputs are
// stable across regenerations so the brief doesn't say "10pm" once and
// "10:30pm" the next.
//
// Future entries (e.g. recommendIntensity, recommendHydrationFlag) follow
// the same pattern: take context, return deterministic value.

// Sleep target — when to be in bed. Returns null for morning mode (the
// morning brief doesn't push a specific bedtime; subhead handles framing).
// Evening rules pivot on recovery:
//   readiness <= 60 OR HRV well below 7d median (< 70%) → 9:30 PM (push earlier)
//   readiness <= 75                                      → 10:00 PM
//   else                                                 → 10:30 PM (default)
function recommendSleepTarget(recovery, mode, baselines7d) {
  if (mode !== 'evening') return null;
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
