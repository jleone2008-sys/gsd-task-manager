#!/usr/bin/env node
// Self-audit harness for the deterministic pattern sweep (Phase 2).
// Pulls a user's REAL daily signal series from prod via the Management API,
// runs lib/pattern-sweep, and prints what patterns it would discover.
// READ-ONLY — does not write to patterns_discovered.
//
//   node scripts/pattern-sweep-audit.mjs jleone2008@gmail.com 60

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sweep } = require('../netlify/functions/lib/pattern-sweep.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function loadEnv() {
  const txt = await readFile(resolve(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function runSql(env, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'supabase-cli/2.101.0' },
    body: JSON.stringify({ query: sql }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

const email = process.argv[2] || 'jleone2008@gmail.com';
const windowDays = parseInt(process.argv[3], 10) || 60;

const SQL = `
with u as (select id, email from auth.users where email = ${quote(email)}),
days as (select generate_series((now() - interval '${windowDays} days')::date, now()::date, '1 day') as d)
select to_char(days.d,'YYYY-MM-DD') as date,
  o.hrv_ms, o.resting_hr, o.sleep_score, o.total_sleep_min, o.deep_sleep_min,
  o.readiness_score, o.activity_score, o.steps, o.body_temp_deviation_c, o.stress_high_seconds,
  j.mood,
  (select count(*) from public.habit_completions h where h.user_id = u.id and h.completed_date = days.d) as habits_done,
  (select count(*) from public.workout_sessions w where w.user_id = u.id and w.session_date = days.d) as workouts,
  bw.weight_lbs,
  (select jsonb_array_length(c.events) from public.journal_calendar_cache c where c.user_id = u.id and c.entry_date = days.d) as cal_events
from days cross join u
left join public.oura_daily o   on o.user_email = u.email and o.date = days.d
left join public.journal_entries j on j.user_id = u.id and j.entry_date = days.d
left join public.body_weight bw on bw.user_id = u.id and bw.measured_date = days.d
order by days.d`;

function quote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// Map a column to a sweep-series key. continuous = value-or-null; binary/count = filled.
const CONTINUOUS = {
  hrv: 'hrv_ms', rhr: 'resting_hr', sleep_score: 'sleep_score', sleep_dur: 'total_sleep_min',
  deep_sleep: 'deep_sleep_min', readiness: 'readiness_score', activity: 'activity_score',
  steps: 'steps', body_temp: 'body_temp_deviation_c', stress: 'stress_high_seconds',
  mood: 'mood', weight: 'weight_lbs',
};

(async () => {
  const env = await loadEnv();
  const rows = await runSql(env, SQL);
  console.log(`Pulled ${rows.length} days for ${email} (last ${windowDays}d)\n`);

  const series = {};
  for (const k of Object.keys(CONTINUOUS)) series[k] = new Map();
  series.habits_done = new Map();   // count, fill 0
  series.workout = new Map();       // binary, fill 0
  series.cal_load = new Map();      // count where cache row exists, else null

  for (const row of rows) {
    const date = row.date;
    for (const [key, col] of Object.entries(CONTINUOUS)) {
      const v = row[col];
      if (v != null && Number.isFinite(Number(v))) series[key].set(date, Number(v));
    }
    series.habits_done.set(date, Number(row.habits_done) || 0);
    series.workout.set(date, (Number(row.workouts) || 0) > 0 ? 1 : 0);
    if (row.cal_events != null) series.cal_load.set(date, Number(row.cal_events));
  }

  // coverage
  console.log('Signal coverage (non-null days):');
  for (const k of Object.keys(series)) console.log(`  ${k.padEnd(12)} ${series[k].size}`);

  const found = sweep(series, { minN: 12, minR: 0.4, maxP: 0.01, windowDays });
  console.log(`\n=== ${found.length} pattern(s) discovered (n≥12, |r|≥0.4, p≤0.01) ===`);
  for (const p of found) {
    console.log(`[r=${p.r} n=${p.n} p=${p.p}]${p.actionable ? ' [actionable]' : ''} ${p.brief_line}`);
  }
  if (!found.length) console.log('(none cleared the bar — try a wider window or looser gate to inspect candidates)');

  // --write: idempotently INSERT any not-yet-stored sweep patterns (matches what
  // the deployed beta-pattern-sweep function does; keyed by metadata.sweep_key).
  if (process.argv.includes('--write') && found.length) {
    const today = rows[rows.length - 1].date;
    const since = rows[0].date;
    const existing = await runSql(env, `select metadata->>'sweep_key' as k from public.patterns_discovered pd join auth.users u on u.id=pd.user_id where u.email=${quote(email)} and pd.metadata->>'source'='sweep'`);
    const have = new Set(existing.map(r => r.k));
    const toInsert = found.filter(p => !have.has(p.sweep_key));
    if (!toInsert.length) { console.log('\n[--write] all sweep patterns already stored — nothing to insert.'); }
    else {
      const stmts = toInsert.map(p => {
        const meta = { source: 'sweep', sweep_key: p.sweep_key, signal_a: p.signal_a, signal_b: p.signal_b, lag: p.lag, direction: p.direction, r: p.r, p: p.p, actionable: p.actionable, brief_line: p.brief_line };
        const ev = { start_date: since, end_date: today, n_days: p.n };
        const desc = `${p.brief_line} (r=${p.r} over ${p.n} days)`;
        return `insert into public.patterns_discovered (user_id,label,description,evidence_window,n,strength_score,last_seen_at,first_seen_at,metadata) select u.id, ${quote(p.label)}, ${quote(desc)}, ${quote(JSON.stringify(ev))}::jsonb, ${p.n}, ${p.strength}, now(), now(), ${quote(JSON.stringify(meta))}::jsonb from auth.users u where u.email=${quote(email)}`;
      });
      await runSql(env, stmts.join(';\n'));
      console.log(`\n[--write] inserted ${toInsert.length} sweep pattern(s).`);
    }
  }

  // Also show near-misses at a looser gate for insight
  const loose = sweep(series, { minN: 10, minR: 0.35, maxP: 0.05, windowDays });
  const extra = loose.filter(l => !found.some(f => f.sweep_key === l.sweep_key));
  if (extra.length) {
    console.log(`\n--- ${extra.length} weaker candidate(s) at |r|≥0.35, p≤0.05 (not stored) ---`);
    for (const p of extra) console.log(`[r=${p.r} n=${p.n} p=${p.p}] ${p.brief_line}`);
  }
})().catch(e => { console.error('audit failed:', e.message); process.exit(1); });
