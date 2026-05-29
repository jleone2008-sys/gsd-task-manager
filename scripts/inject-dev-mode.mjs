#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   Production guard for the dev mock-mode tool (Phase 4 / Gate 3).

   The dev mock-mode <script> tags live committed in app.html between
   <!-- DEV-MOCK-MODE:start --> and <!-- DEV-MOCK-MODE:end --> markers so
   the local + preview workflow works with zero build steps. This script
   runs as the Netlify build command and STRIPS that block when the deploy
   context is production, so gsdtasks.com never ships the dev tool at all.

   It edits only the ephemeral build checkout — never committed. It is a
   precise, idempotent marker-delimited removal: safe to run repeatedly,
   and a no-op on non-production builds (the self-gating in mock-mode.js
   already refuses to activate there).

   Netlify exposes CONTEXT = 'production' | 'deploy-preview' | 'branch-deploy'.
   Falls back to BRANCH/NODE_ENV when run outside Netlify.
════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appHtml = join(__dirname, '..', 'app.html');

const context = process.env.CONTEXT || (process.env.NODE_ENV === 'production' ? 'production' : '');
const isProduction = context === 'production';

const MARKER = /[ \t]*<!-- DEV-MOCK-MODE:start[\s\S]*?DEV-MOCK-MODE:end -->\n?/g;

if (!existsSync(appHtml)) {
  console.error('[inject-dev-mode] app.html not found at', appHtml);
  process.exit(0); // don't fail the build over this
}

if (!isProduction) {
  console.log(`[inject-dev-mode] context="${context || 'unknown'}" — dev mock-mode left in place.`);
  process.exit(0);
}

const html = readFileSync(appHtml, 'utf8');
if (!MARKER.test(html)) {
  console.log('[inject-dev-mode] production build — no dev mock-mode block found (already clean).');
  process.exit(0);
}
const stripped = html.replace(MARKER, '');
writeFileSync(appHtml, stripped, 'utf8');
console.log('[inject-dev-mode] production build — stripped dev mock-mode block from app.html.');
