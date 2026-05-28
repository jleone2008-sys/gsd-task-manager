# Dev mock-mode — design spec (plan only, not yet built)

Status: **proposed**. Written 2026-05-28. No code shipped yet.

## Problem

The app sits behind Google OAuth (Supabase `signInWithIdToken`). There is no
way to open the real UI without a Google login, so UI changes can't be visually
verified by an agent (or by anyone without the test account) — every UI task
ends in "please test it yourself." We want a way to run the **real** app UI
against **fake** data, with **no login**, that (a) stays automatically in sync
with shipped code and (b) is not a security risk.

## How the app boots today (the two seams we swap)

All data + auth funnel through a small number of points in `beta/src/01-core.js`:

1. **Auth gate** — `restoreSession()` (≈ line 968): calls `db.auth.getSession()`;
   if a session exists it calls `signInUser(user)` (which reads `user_profiles`
   for `access_status` gating and then boots the app); otherwise it reveals
   `#authScreen`. `signInWithGoogle()` is the only entry to a real session.
2. **Data client** — `db` (the Supabase client, created ≈ line 185) is used
   everywhere via `db.from(table).select()…`, `db.rpc(...)`, `db.auth.*`,
   `db.storage.*`.
3. **Backend calls** — feature code `fetch()`es `/.netlify/functions/*`
   (daily brief, train feedback, progress-pic analysis, weekly synthesis, etc.).

Mock mode only has to intercept these three seams. Everything else — rendering,
interactions, business logic — is the real shipped code.

## Architecture

A self-contained dev module (e.g. `beta/src/dev/mock-mode.js` + a
`beta/src/dev/fixtures.js`) that, **only when activated** (see gating):

- **Bypasses auth.** Sets a fake `currentUser` and makes `restoreSession()`
  skip straight into the app (no `#authScreen`, no Supabase session).
- **Replaces `db`.** Installs a stub implementing the Supabase surface the app
  actually uses — a chainable query builder (`from().select().eq().order()…`
  resolving to fixture rows), `rpc()` (canned returns), `auth.getSession()`
  (fake), and `storage` (no-op / object URLs). Unknown tables resolve to `[]`
  so the app degrades gracefully instead of throwing.
- **Intercepts function calls.** Wraps `window.fetch` so requests to
  `/.netlify/functions/*` return canned JSON (a sample brief, a sample train
  insight, …); everything else passes through.
- **Seeds fixtures.** `fixtures.js` holds deterministic fake data: a handful of
  tasks/habits/journal entries/calendar events, a sample daily brief, workout
  sessions, and health rings — enough to exercise every tab.

### Why it stays in sync automatically

It swaps only the **data boundary**. The UI, rendering, and logic are the real
modules loaded in the real order. Any feature we ship is automatically exercised
by mock mode with no extra work. The only upkeep is adding a fixture when a
brand-new data shape appears — and because unknown queries return `[]`, a
missing fixture degrades gracefully (empty state) rather than breaking.

## Security model (triple-gated)

1. **No real anything.** The mock holds zero credentials and never contacts
   Supabase, Anthropic, Google, or any backend. It only serves in-memory fake
   data. Worst case if it ran somewhere unexpected: a stranger sees fabricated
   data and can touch nothing real.
2. **Refuses to run on production.** Activation is gated to local/preview hosts
   and **explicitly blocked on the production hostname**:
   ```
   const DEV_HOSTS = ['localhost', '127.0.0.1'];
   const isPreview = location.hostname.endsWith('.netlify.app'); // deploy previews
   const enabled = (DEV_HOSTS.includes(location.hostname) || isPreview)
                   && location.hostname !== 'gsdtasks.com'
                   && new URLSearchParams(location.search).has('mock');
   ```
   Even if the file were present in prod, it cannot self-activate there.
3. **Not shipped to production at all.** The dev script tag is injected only in
   non-production deploy contexts. Netlify exposes `CONTEXT` at build time
   (`production` vs `deploy-preview`/`branch-deploy`); a tiny build step
   (`scripts/inject-dev-mode.mjs`, run from the Netlify build command) adds the
   `<script src="/beta/src/dev/mock-mode.js">` tag + `?mock` bootstrap only when
   `CONTEXT !== 'production'`. The production `app.html` served from gsdtasks.com
   never contains it.

Gate 2 alone makes it safe; gates 1 and 3 are defense-in-depth.

### Optional hardening
- Password-protect non-prod Netlify contexts (Netlify site setting) so preview
  URLs aren't world-readable.
- Keep `beta/src/dev/**` out of any search-indexed path; add to robots if a
  preview is ever public.

## How the agent (or you) uses it

- Local: run the static server, open `http://localhost:8080/app.html?mock=1` —
  the real UI boots on fake data, no login. (This is the immediate workflow win:
  the agent can finally screenshot/verify UI changes.)
- Preview: open the branch-deploy URL with `?mock=1`.

## Phased build

- **Phase 1 (unblocks most UI work):** mock `db` + auth bypass + fixtures for the
  Tasks and Habits core. Activation gating + the local `?mock=1` path.
- **Phase 2:** extend fixtures to Home, Journal, Train, Brief (rings, calendar,
  sessions, a sample brief).
- **Phase 3:** stub the `/.netlify/functions/*` endpoints (brief generation,
  train feedback, progress-pic) so AI-driven surfaces render canned output.
- **Phase 4 (optional):** the Netlify build-context injection + preview password,
  if we want mock mode reachable on preview URLs and provably absent from prod.

## Open questions
- Fixtures: hand-authored vs generated from the live schema? Start hand-authored;
  revisit if they drift from real shapes.
- Do we want a tiny on-screen "MOCK DATA" banner (like the admin impersonation
  banner) so it's unmistakable? Recommended.
