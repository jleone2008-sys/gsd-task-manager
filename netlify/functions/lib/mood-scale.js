// Shared mood-scale helpers for all Netlify functions that surface
// mood / feel / energy values to Claude.
//
// The scale matches the conventional 1-5 rating direction:
//   1 = Bad   (worst)
//   2 = Low
//   3 = Okay
//   4 = Good
//   5 = Great (best)
//
// Historical note: an earlier version had the scale inverted (1=best),
// which LLMs trained on standard ratings consistently mis-read. The
// invert_mood_scale.sql migration flipped every stored value via
// new = 6 - old; this module's labels and the client emoji arrays
// were re-ordered to match.
//
// EVERY Claude-bound payload that includes a mood/feel/energy field
// should still:
//   1. Use moodLabel() to attach a human label ("Good") alongside the
//      raw integer
//   2. Include MOOD_SCALE_NOTE in the system prompt's scales section
//
// The label + note are belt-and-suspenders — they make the scale
// explicit so a future LLM trained on a non-conventional rating
// system can't regress this behavior.

const MOOD_LABELS = {
  1: 'Bad',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

// Designed to be embedded in the system prompt's scales block.
const MOOD_SCALE_NOTE = 'GSD mood scale: 1=Bad (worst), 2=Low, 3=Okay, 4=Good, 5=Great (best). Higher numbers are better.';

function moodLabel(v) {
  if (v == null) return null;
  const k = Math.round(Number(v));
  return MOOD_LABELS[k] || `Unknown(${v})`;
}

// Replaces a raw `feel` integer on a session-shaped object with both
// the original number AND a `feel_label` so Claude can read either.
// Pure — returns a new object, doesn't mutate.
function withFeelLabel(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.feel == null) return obj;
  return { ...obj, feel_label: moodLabel(obj.feel) };
}

module.exports = { MOOD_LABELS, MOOD_SCALE_NOTE, moodLabel, withFeelLabel };
