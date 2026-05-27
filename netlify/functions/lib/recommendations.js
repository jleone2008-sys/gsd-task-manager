// Deterministic recommendation rules. Pure functions, no AI. Outputs are
// stable across regenerations so the brief doesn't say "10pm" once and
// "10:30pm" the next.
//
// Phase 10 — some recommendations now have A/B variants. When conditions
// fall in an ambiguous band where the rule could plausibly recommend
// either option, pickVariant() randomly selects between arms, seeded
// deterministically by (user_id, date, signature) so regenerating the
// same brief picks the same variant. brief_action_outcomes records the
// variant chosen; the efficacy view aggregates by (signature, variant_id)
// so we can compare arms within matched conditions over time.
//
// Future entries (e.g. recommendIntensity, recommendHydrationFlag) follow
// the same pattern: take context, return {value, variant_id} where
// variant_id is null for fully-deterministic outputs.

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

// ── pickVariant ──────────────────────────────────────────────────────
// Deterministically pick one of N variants using a seed that's stable
// for a given user + date + signature combination. Same brief regen
// always picks the same variant so the user doesn't see the bedtime
// flicker between regens within a single day. Next day's seed is
// different so the choice changes over time, producing the A/B sample.
//
// Returns { value, variant_id } where variant_id is the variant's key
// in the choices object (e.g. 'early', 'standard'). The value is whatever
// the choice maps to.
//
// Choices format: { early: '9:30 PM', standard: '10:00 PM' }
function pickVariant(seed, choices) {
  const keys = Object.keys(choices);
  if (keys.length === 0) return { value: null, variant_id: null };
  // FNV-1a 32-bit hash — deterministic, no crypto dependency. Good
  // enough distribution for picking between 2-4 buckets.
  let h = 0x811c9dc5;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const idx = h % keys.length;
  const key = keys[idx];
  return { value: choices[key], variant_id: key };
}

// Sleep target — when to be in bed. Fully formulaic; no AI input is
// honored. Returns { value, variant_id, signature, conditions } so the
// brief function can record an outcome stub for Phase 10 tracking.
//
// signature embeds the chosen time so identical recommendations
// aggregate cleanly in the efficacy view. variant_id is non-null only
// when pickVariant fired — that flags the row as part of an A/B run.
// conditions captures the inputs (readiness, hrv ratio, sickness) so
// downstream analysis can match like-with-like.
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
//            ← readiness 76–80 (just-below-default)
//
//   A/B band (readiness 61–75) ← randomized between 9:30 PM ('early')
//                                and 10:00 PM ('standard'). Generates
//                                the Phase 10 sample for measuring which
//                                bedtime actually moves sleep_score
//                                more in this user.
//
//   10:30 PM ← default (readiness > 80)
//
// 'mode' is kept in the signature for back-compat with existing callers.
// Old positional form (recovery, mode, baselines7d) is still accepted —
// new callers can pass an object: ({ recovery, activity, tags,
// baselines7d, seed }).
//
// LEGACY RETURN SHAPE: callers that haven't been updated to read
// {value, variant_id, ...} still receive a plain string via the
// Symbol.toPrimitive coercion on the returned object. New callers
// should destructure { value } explicitly.
function recommendSleepTarget(arg1, arg2, arg3) {
  // Two call shapes: object-form (preferred) or legacy positional.
  let recovery, activity, baselines7d, tags, seed;
  if (arg1 && typeof arg1 === 'object' && ('recovery' in arg1 || 'activity' in arg1 || 'tags' in arg1)) {
    recovery    = arg1.recovery;
    activity    = arg1.activity;
    baselines7d = arg1.baselines7d;
    tags        = arg1.tags;
    seed        = arg1.seed || '';
  } else {
    recovery    = arg1;
    baselines7d = arg3;
    activity    = undefined;
    tags        = undefined;
    seed        = '';
  }

  const readiness = recovery?.readiness_score;
  const hrv       = recovery?.hrv_ms;
  const hrvBase   = baselines7d?.hrv_ms_median;
  const hrvLow    = (hrv != null && hrvBase != null && Number(hrv) < 0.7 * Number(hrvBase));
  const totalSleepMin = recovery?.total_sleep_min;
  const shortSleep    = totalSleepMin != null && Number(totalSleepMin) < 300;   // < 5 hours
  const sick          = detectSickness({ tags, activity });

  // Conditions snapshot captured on every recommendation. Used by
  // cron-evaluate-actions to populate brief_action_outcomes.conditions_snapshot.
  const conditions = {
    readiness_score: readiness ?? null,
    hrv_ms:          hrv ?? null,
    hrv_baseline:    hrvBase ?? null,
    hrv_low:         hrvLow,
    total_sleep_min: totalSleepMin ?? null,
    short_sleep:     shortSleep,
    sick_severe:     sick.severe,
    sick_mild:       sick.mild,
  };

  const result = (value, variant_id, regime) => withLegacyString({
    value,
    variant_id,
    signature: `bedtime_target:${shortTime(value)}`,
    regime,
    conditions,
  });

  // Critical tier — last night was a sleep emergency (<5 hr). Override
  // everything else and push to 9 PM.
  if (shortSleep) return result('9:00 PM', null, 'sleep_emergency');

  // Severe tier
  if (sick.severe) return result('9:30 PM', null, 'severe');
  if (readiness != null && Number(readiness) <= 60) return result('9:30 PM', null, 'severe');
  if (hrvLow) return result('9:30 PM', null, 'severe');

  // Mild sickness still deterministic — that's a separate clinical signal
  // from "ambiguous recovery" and the user expects the system to react
  // consistently to sickness tags.
  if (sick.mild) return result('10:00 PM', null, 'mild_sick');

  // A/B band: readiness 61–75. Either 9:30 or 10:00 is defensible; pick
  // an arm and record which one fired. Outcomes accumulate over weeks,
  // efficacy view tells us which arm actually moves sleep_score more for
  // this user.
  if (readiness != null && Number(readiness) >= 61 && Number(readiness) <= 75) {
    const pick = pickVariant(`${seed}|bedtime_target|ambiguous`, {
      early:    '9:30 PM',
      standard: '10:00 PM',
    });
    return result(pick.value, pick.variant_id, 'ambiguous_ab');
  }

  // 76–80 deterministic mild range — readiness is just below default
  // but not in the ambiguous A/B band.
  if (readiness != null && Number(readiness) <= 80) return result('10:00 PM', null, 'mild');

  // Default
  return result('10:30 PM', null, 'default');
}

// Compact HH:MM the signature uses. "9:30 PM" → "21:30", "10:00 PM" → "22:00".
function shortTime(timeStr) {
  if (!timeStr) return 'none';
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeStr).trim());
  if (!m) return String(timeStr);
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// Back-compat shim: callers that treat the return value as a string
// ("In bed by ${sleepTarget}") still see the time string via valueOf /
// Symbol.toPrimitive / toString. New callers destructure { value, variant_id }.
function withLegacyString(obj) {
  return {
    ...obj,
    toString:           () => obj.value,
    valueOf:            () => obj.value,
    [Symbol.toPrimitive]: () => obj.value,
  };
}

module.exports = { recommendSleepTarget, detectSickness, pickVariant };
