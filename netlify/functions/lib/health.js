// Shared health-data constants.
//
// RECOVERY_STALE_HOURS: a wearable recovery/readiness row (Oura readiness or
// Whoop recovery, from the same nightly sync) is treated as "stale" once it's
// older than this. The daily brief and the train-session feedback both read
// that data and must use the SAME threshold — previously each defined its own
// 24 (brief called it OURA_STALE_HOURS, train called it RECOVERY_STALE_HOURS).
const RECOVERY_STALE_HOURS = 24;

module.exports = { RECOVERY_STALE_HOURS };
