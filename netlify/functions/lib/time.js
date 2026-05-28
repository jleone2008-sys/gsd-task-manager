// Time-unit constants in milliseconds. These were written by hand dozens of
// times across functions (86400_000, 3600_000, multiplier chains) — identical
// values, but easy to fat-finger. Import from here instead.
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS   = 60 * MINUTE_MS;        // 3_600_000
const DAY_MS    = 24 * HOUR_MS;          // 86_400_000
const WEEK_MS   = 7 * DAY_MS;            // 604_800_000

module.exports = { SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS };
