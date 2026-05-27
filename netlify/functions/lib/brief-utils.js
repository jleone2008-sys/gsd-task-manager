// Small pure helpers used by the daily-brief generation pipeline.
// Extracted from beta-daily-brief.js so the handler stays thin and
// these utilities are reachable from other functions (e.g. tests,
// future cron handlers that need the same date math).

async function fetchJson(url, hdr) {
  try {
    const r = await fetch(url, { headers: hdr });
    if (!r.ok) { console.warn(`brief: fetch ${url} HTTP ${r.status}`); return []; }
    return await r.json();
  } catch (err) {
    console.warn(`brief: fetch ${url} failed: ${err.message}`);
    return [];
  }
}

function stripUpdatedAt(row) {
  const { updated_at, ...rest } = row;
  return rest;
}

function localDate(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

function yesterdayLocal(tz) {
  const today = localDate(new Date(), tz);
  return shiftDate(today, -1);
}

// "10:23 PM" style clock time in the user's timezone for an ISO timestamp.
// Returns null on bad input so callers can guard. Used to render
// sleep_intent times in the brief context payload.
function formatLocalClockTime(iso, tz) {
  if (!iso) return null;
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(dt);
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function localDayStartUtcMs(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessMs   = Date.UTC(y, m - 1, d);
  for (let h = -12; h <= 14; h++) {
    const ms = guessMs + h * 3600_000;
    if (localDate(new Date(ms), tz) === dateStr && new Date(ms).getUTCHours() % 24 !== undefined) {
      let lo = ms - 3600_000;
      while (lo >= guessMs - 24 * 3600_000 && localDate(new Date(lo), tz) === dateStr) lo -= 60_000;
      return lo + 60_000;
    }
  }
  return guessMs;
}

function hourInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const h = parseInt(fmt.format(date), 10);
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
}

module.exports = {
  fetchJson,
  stripUpdatedAt,
  localDate,
  yesterdayLocal,
  formatLocalClockTime,
  shiftDate,
  localDayStartUtcMs,
  hourInTz,
};
