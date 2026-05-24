#!/usr/bin/env node
// Apply a single SQL file against Supabase via the Management API.
//
// Reads SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF from .env.local
// (no dependency on dotenv — we parse the file ourselves). Posts the SQL
// to /v1/projects/{ref}/database/query. Prints the SQL first so the
// human reviewing the run can see exactly what's about to execute.
//
// Usage:
//   node scripts/apply-migration.mjs supabase-migrations/workout_plans.sql
//   node scripts/apply-migration.mjs --query "select 1"
//
// Exit codes: 0 success, 1 missing config, 2 destructive op refused,
// 3 HTTP error, 4 SQL/Postgres error.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Load .env.local ────────────────────────────────────────────────────────
async function loadEnv() {
  const path = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(path)) {
    console.error('[apply-migration] missing .env.local at', path);
    process.exit(1);
  }
  const txt = await readFile(path, 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (line.trim().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// ── Safety filter ──────────────────────────────────────────────────────────
// Refuse to auto-run anything with broad destructive ops. The
// templates seed's "delete from workout_plans where is_template = true and
// user_id is null" is the one allowed exception — it's the idempotent
// re-seed pattern and is scoped narrowly.
function isDestructive(sql) {
  const allowedDelete = /delete\s+from\s+public\.workout_plans\s+where\s+is_template\s*=\s*true\s+and\s+user_id\s+is\s+null/is;
  // Strip the known-safe pattern, then check the remainder for dangerous verbs.
  const remainder = sql.replace(allowedDelete, '');
  const danger = /\b(drop\s+table|drop\s+schema|truncate|drop\s+database|delete\s+from)\b/i;
  return danger.test(remainder);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const env = await loadEnv();
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref   = env.SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    console.error('[apply-migration] SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must be set in .env.local');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let sql, label;
  if (args[0] === '--query') {
    sql   = args.slice(1).join(' ');
    label = '<inline query>';
  } else if (args[0]) {
    const path = resolve(REPO_ROOT, args[0]);
    sql   = await readFile(path, 'utf8');
    label = args[0];
  } else {
    console.error('Usage: node scripts/apply-migration.mjs <path.sql>  |  --query "select 1"');
    process.exit(1);
  }

  console.log(`\n── ${label} ─────────────────────────────────────`);
  console.log(sql.trim().split('\n').map(l => '  ' + l).join('\n'));
  console.log('───────────────────────────────────────────────────────\n');

  if (isDestructive(sql)) {
    console.error('[apply-migration] REFUSED: SQL contains a destructive operation that isn\'t on the safe-list. Run by hand in the Supabase SQL editor if you really want this.');
    process.exit(2);
  }

  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error(`[apply-migration] HTTP ${res.status} ${res.statusText}`);
    console.error(txt);
    process.exit(3);
  }

  // Management API returns either a JSON array of rows (for SELECTs)
  // or an empty array for DDL. Errors usually come back as 4xx with a
  // body; some Postgres errors leak through as 200 with an "error" key.
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    console.error('[apply-migration] Postgres error:', parsed.error);
    if (parsed.code) console.error('  code:', parsed.code);
    if (parsed.hint) console.error('  hint:', parsed.hint);
    process.exit(4);
  }
  console.log('[apply-migration] OK · response:', JSON.stringify(parsed).slice(0, 600));
}

main().catch(err => {
  console.error('[apply-migration] failed:', err.message);
  process.exit(99);
});
