#!/usr/bin/env node
// Auto-apply NEW or CHANGED supabase-migrations/*.sql to the prod Supabase
// project via the Management API. Designed to run from the Stop hook so that
// finishing a phase auto-pushes any pending SQL — no more "here's the SQL, go
// run it" hand-offs.
//
// How it stays safe + idempotent:
//   • Tracks already-applied files by CONTENT HASH in scripts/.migrations-applied.json
//     (gitignored, local state). A file applies only when it's new or its hash
//     changed ("added or updated").
//   • BOOTSTRAP: if the ledger doesn't exist yet, it assumes every migration
//     currently in the folder is already in prod — it seeds the ledger and
//     applies NOTHING. So installing this hook never retroactively re-runs the
//     whole history; only migrations added/edited AFTER install get applied.
//   • Refuses destructive SQL (drop table/schema/database, truncate, delete
//     from) — those must be run by hand.
//   • No-ops silently (exit 0) when nothing is pending, or when the Management
//     API creds aren't present (e.g. CI, a machine without .env.local).
//   • ALWAYS exits 0 so it can never block the Stop hook / disrupt a session.
//
// Migrations must be written idempotently (the repo convention already is:
// `create table if not exists`, `drop policy if exists` + `create policy`,
// `insert ... on conflict do nothing`) so a re-apply on edit is safe.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MIG_DIR   = resolve(REPO_ROOT, 'supabase-migrations');
const LEDGER    = resolve(__dirname, '.migrations-applied.json');

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function loadEnv() {
  const path = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// Same refusal set as scripts/apply-migration.mjs.
function isDestructive(sql) {
  return /\b(drop\s+table|drop\s+schema|drop\s+database|truncate|delete\s+from)\b/i.test(sql);
}

async function applyOne(sql, token, ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query: sql }),
  });
  const txt = await res.text();
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  if (!res.ok || (parsed && typeof parsed === 'object' && parsed.error)) {
    const msg = (parsed && parsed.error) ? parsed.error : `HTTP ${res.status} ${txt.slice(0, 200)}`;
    return { ok: false, msg };
  }
  return { ok: true };
}

async function main() {
  if (!existsSync(MIG_DIR)) return; // nothing to do

  const files = (await readdir(MIG_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const hashes = {};
  for (const f of files) hashes[f] = sha(await readFile(resolve(MIG_DIR, f), 'utf8'));

  // Bootstrap: no ledger yet → assume prod is in sync, apply nothing.
  if (!existsSync(LEDGER)) {
    await writeFile(LEDGER, JSON.stringify(hashes, null, 2) + '\n');
    return;
  }

  let ledger = {};
  try { ledger = JSON.parse(await readFile(LEDGER, 'utf8')); } catch { ledger = {}; }

  const pending = files.filter((f) => ledger[f] !== hashes[f]);
  if (pending.length === 0) return; // silent no-op

  const env = await loadEnv();
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref   = env.SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    // Can't apply here — leave the ledger untouched so a creds-having run still will.
    console.error(`[migrations] ${pending.length} pending but no Supabase creds — skipping: ${pending.join(', ')}`);
    return;
  }

  const applied = [];
  for (const f of pending) {
    const sql = await readFile(resolve(MIG_DIR, f), 'utf8');
    if (isDestructive(sql)) {
      console.error(`[migrations] REFUSED (destructive) ${f} — run it by hand if intended.`);
      continue;
    }
    const r = await applyOne(sql, token, ref);
    if (!r.ok) {
      console.error(`[migrations] FAILED ${f}: ${r.msg}`); // don't record → retried next run
      continue;
    }
    ledger[f] = hashes[f];
    await writeFile(LEDGER, JSON.stringify(ledger, null, 2) + '\n'); // record incrementally
    applied.push(f);
  }
  if (applied.length) console.log(`[migrations] applied to prod: ${applied.join(', ')}`);
}

// Never throw out of the hook.
main().catch((e) => { console.error('[migrations] error:', e.message); }).finally(() => process.exit(0));
