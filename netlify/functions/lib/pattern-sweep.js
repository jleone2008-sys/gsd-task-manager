// Deterministic pattern sweep — Phase 2 of docs/formulaic-first-and-brief-insights.md.
//
// Formulaic-first: this is a CODE statistics pass, not an AI judgment. It tests
// signal-pairs systematically, gates by n / |r| / p IN CODE, and emits clean
// templated patterns. No LLM decides what to test or whether to surface.
//
// Pure (no I/O). The Netlify function (beta-pattern-sweep) does the data pull +
// the patterns_discovered upsert; the node audit harness pulls real data and
// runs sweep() to verify discovery.

'use strict';

const { renderPattern, SIGNAL_KEYS, DOMAIN } = require('./pattern-templates');

// ── Stats ───────────────────────────────────────────────────────────────────

// Pearson r over [[a,b], ...].
function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return { r: 0, n };
  let mA = 0, mB = 0;
  for (const [a, b] of pairs) { mA += a; mB += b; }
  mA /= n; mB /= n;
  let num = 0, dA = 0, dB = 0;
  for (const [a, b] of pairs) {
    const da = a - mA, db = b - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  if (dA <= 0 || dB <= 0) return { r: 0, n };   // a constant series → undefined corr → treat as 0
  return { r: num / Math.sqrt(dA * dB), n };
}

// Regularized incomplete beta I_x(a,b) — Numerical Recipes continued fraction.
function _betacf(a, b, x) {
  const FPMIN = 1e-30;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-9) break;
  }
  return h;
}
function _gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(_gammaln(a + b) - _gammaln(a) - _gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * _betacf(a, b, x) / a;
  return 1 - bt * _betacf(b, a, 1 - x) / b;
}

// Two-tailed p-value for a Pearson r with n samples (Student t, df=n-2).
function pValueForR(r, n) {
  const df = n - 2;
  if (df <= 0) return 1;
  if (Math.abs(r) >= 1) return 0;
  const t2 = (r * r) * df / (1 - r * r);
  // P(|T|>t) = I_{df/(df+t^2)}(df/2, 1/2)
  return betai(df / 2, 0.5, df / (df + t2));
}

// ── Pairing ───────────────────────────────────────────────────────────────

// mapA/mapB: Map<'YYYY-MM-DD', number>. lag: B is taken `lag` days AFTER A.
function pairedSeries(mapA, mapB, lag) {
  const pairs = [];
  for (const [date, a] of mapA) {
    const key = lag === 0 ? date : _shift(date, lag);
    const b = mapB.get(key);
    if (b != null && Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  return pairs;
}
function _shift(ymd, d) {
  const dt = new Date(ymd + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}

// ── Which pairs to test ─────────────────────────────────────────────────────
// Cross-domain (behavior × physiology) same-day — the actionable space — plus a
// curated set of directional lagged pairs and a couple of within-physiology
// clinically-meaningful ones. Trivial within-domain auto-correlations (sleep
// score ↔ sleep duration, etc.) are deliberately NOT swept.
function buildPairList() {
  const phys = SIGNAL_KEYS.filter(k => DOMAIN[k] === 'phys');
  const beh  = SIGNAL_KEYS.filter(k => DOMAIN[k] === 'beh');
  const out = [];
  const seen = new Set();
  const push = (a, b, lag) => {
    if (a === b) return;
    const key = `${a}|${b}|${lag}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a, b, lag });
  };
  // same-day cross-domain (behavior × physiology)
  for (const b of beh) for (const p of phys) push(b, p, 0);
  // same-day behavior × behavior, but only vs mood (the outcome that matters)
  for (const b of beh) push(b, 'mood', 0);
  // curated within-physiology (the clinically real couplings)
  push('body_temp', 'hrv', 0);
  push('body_temp', 'rhr', 0);
  // directional lagged (today → tomorrow)
  push('sleep_dur', 'mood', 1);
  push('sleep_dur', 'readiness', 1);
  push('sleep_dur', 'hrv', 1);
  push('workout', 'hrv', 1);
  push('workout', 'rhr', 1);
  push('workout', 'readiness', 1);
  push('workout', 'mood', 1);
  push('cal_load', 'hrv', 1);
  push('cal_load', 'mood', 1);
  push('rhr', 'mood', 1);
  return out;
}

// ── The sweep ────────────────────────────────────────────────────────────────
// series: { [signalKey]: Map<dateStr, number> }. Returns gated, templated,
// de-duplicated patterns sorted by strength (|r|) desc.
function sweep(series, opts = {}) {
  const minN  = opts.minN  != null ? opts.minN  : 12;
  const minR  = opts.minR  != null ? opts.minR  : 0.4;
  const maxP  = opts.maxP  != null ? opts.maxP  : 0.01;   // strict — controls multiple-comparisons false positives
  const windowDays = opts.windowDays || null;

  const pairs = buildPairList();
  const found = [];
  for (const { a, b, lag } of pairs) {
    const mapA = series[a], mapB = series[b];
    if (!mapA || !mapB || !mapA.size || !mapB.size) continue;
    const ps = pairedSeries(mapA, mapB, lag);
    if (ps.length < minN) continue;
    const { r, n } = pearson(ps);
    if (!Number.isFinite(r) || Math.abs(r) < minR) continue;
    const p = pValueForR(r, n);
    if (p > maxP) continue;
    const direction = r >= 0 ? 'pos' : 'neg';
    const rendered = renderPattern({ a, b, direction, lag });
    if (!rendered) continue;
    // Actionable = involves at least one behavior signal (something the user
    // can change). The brief prefers these — a pure-physiology coupling (e.g.
    // body-temp↔HRV) is a health observation, not a lever.
    const actionable = DOMAIN[a] === 'beh' || DOMAIN[b] === 'beh';
    found.push({
      sweep_key:   `${a}|${b}|${lag}`,
      signal_a: a, signal_b: b, lag, direction,
      r: Number(r.toFixed(3)), n, p: Number(p.toExponential(2)),
      strength: Number(Math.abs(r).toFixed(3)),
      actionable,
      label: rendered.label,
      brief_line: rendered.brief_line,
      window_days: windowDays,
    });
  }
  found.sort((x, y) => y.strength - x.strength);
  return found;
}

module.exports = {
  pearson, betai, pValueForR, pairedSeries, buildPairList, sweep,
};
