// Pattern template library — Phase 3 of docs/formulaic-first-and-brief-insights.md.
//
// The "content library we pick from when a condition is detected." Maps each
// tracked signal to plain-language phrasing, and renders a detected correlation
// into a clean, number-free brief line (the stats live in metadata, not the
// sentence). Pure + deterministic — no AI in the rendering path.

'use strict';

// domain: 'phys' (Oura physiology) | 'beh' (behavior the user does)
// condHigh: clause for "this signal is elevated that day" (used when the signal
//           is the CONDITION / x-axis)
// outcome:  noun phrase for "your <signal>" (used when the signal is the OUTCOME)
const SIGNAL_META = {
  // ── physiology ──
  hrv:         { domain: 'phys', condHigh: 'your HRV is higher',                 outcome: 'HRV' },
  rhr:         { domain: 'phys', condHigh: 'your resting heart rate is higher',  outcome: 'resting heart rate' },
  sleep_score: { domain: 'phys', condHigh: 'your sleep score is higher',         outcome: 'sleep score' },
  sleep_dur:   { domain: 'phys', condHigh: 'you sleep more',                     outcome: 'sleep' },
  deep_sleep:  { domain: 'phys', condHigh: 'you get more deep sleep',            outcome: 'deep sleep' },
  readiness:   { domain: 'phys', condHigh: 'your readiness is higher',           outcome: 'readiness' },
  activity:    { domain: 'phys', condHigh: "you're more active",                 outcome: 'activity' },
  steps:       { domain: 'phys', condHigh: 'you take more steps',                outcome: 'step count' },
  body_temp:   { domain: 'phys', condHigh: 'your body-temp deviation is higher', outcome: 'body-temp deviation' },
  stress:      { domain: 'phys', condHigh: 'you have more high-stress time',     outcome: 'high-stress time' },
  // ── behavior ──
  mood:        { domain: 'beh',  condHigh: 'your mood is higher',                outcome: 'mood' },
  habits_done: { domain: 'beh',  condHigh: 'you complete more habits',           outcome: 'habit completion' },
  workout:     { domain: 'beh',  condHigh: 'you work out',                       outcome: 'workout' },
  weight:      { domain: 'beh',  condHigh: 'your weight is higher',              outcome: 'weight' },
  cal_load:    { domain: 'beh',  condHigh: 'your calendar is busier',            outcome: 'calendar load' },
};

const SIGNAL_KEYS = Object.keys(SIGNAL_META);
const DOMAIN = Object.fromEntries(SIGNAL_KEYS.map(k => [k, SIGNAL_META[k].domain]));

function _truncate(s, n) {
  s = String(s || '').trim();
  return s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,;:.\-—]+$/, '') + '…';
}

// Render a detected correlation into { label, brief_line }.
//   a, b: signal keys.  direction: 'pos' | 'neg'.  lag: 0 (same day) | 1 (a today → b next day).
// Returns null if either signal is unknown.
function renderPattern({ a, b, direction, lag }) {
  const A = SIGNAL_META[a], B = SIGNAL_META[b];
  if (!A || !B) return null;
  const dirWord = direction === 'pos' ? 'higher' : 'lower';
  const lagPrefix = lag === 1 ? 'next-day ' : '';
  // "On days <A.condHigh>, your <lag>?<B.outcome> tends to be <dir>."
  const sentence = `On days ${A.condHigh}, your ${lagPrefix}${B.outcome} tends to be ${dirWord}.`;
  return {
    label:      _truncate(sentence, 80),
    brief_line: _truncate(sentence, 140),
  };
}

module.exports = { SIGNAL_META, SIGNAL_KEYS, DOMAIN, renderPattern };
