# GSD — Claude Code project instructions

## Read-first protocol — every session

Before planning, exploring, or building ANY feature in this repo:

1. **Read [`docs/app-knowledge-bank.html`](docs/app-knowledge-bank.html) first.** It lists what's currently shipped, what's in progress, and the open backlog. Browser-renderable, but plain-text read works fine too.

1b. **For any UI / visual / design work, also read [`docs/brand-framework.html`](docs/brand-framework.html).** It's the single source of truth for color, typography, components, motion, and iconography. Every new UI change uses the documented classes (`.btn`, `.btn--primary`, `.text-h1`, `.card`, `.chip--*`, `.overlay`, etc.) — don't invent one-off styles. If your need isn't covered, propose adding it to the framework first, then implement.

2. **Do not re-plan shipped features.** If something you're about to plan already appears under "Tabs & user features" or "Backend systems" with a `SHIPPED` badge, do NOT plan a rebuild. Verify the existing implementation behaves as intended; only plan changes when it doesn't. This rule exists because of repeated phantom-replanning failures (e.g. the workout-tuner UI proposal card was marked done, then re-planned, then discovered live by reading code).

3. **Patch the bank when you ship anything notable.** After completing any of the following, update the relevant section of the bank inline (don't wait for session close):
   - User-visible feature change → `Tabs & user features` + `Recent changes`
   - Schema migration applied → `Data model` + `Recent changes`
   - New backend system (cron, background fn, RPC) → `Backend systems` + `Recent changes`
   - Material behavior change to an existing feature → whichever section owns it + `Recent changes`
   - Learning / convention / invariant discovered → `Learnings & non-visualized context`
   - Open question / known weirdness → `Open questions & known weirdness`

4. **Batch-update at session close.** When Joe signals end of session ("wrap up", "we're done", "see you tomorrow", "let's call it"), do a sweep:
   - Move completed multi-session items off `Active to-do`
   - Sweep relevant TaskCreate items into `Recent changes` (as `YYYY-MM-DD · shipped X` lines)
   - Surface any newly-discovered cross-session work into `Active to-do`
   - Trim `Recent changes` to ~15 entries (archive overflow into the collapsed `<details>` block).

5. **Source-of-truth hierarchy:**
   - **`docs/app-knowledge-bank.html`** — source of truth for *what currently exists*.
   - **`docs/brand-framework.html`** — source of truth for *how it should look* (color, type, components, motion).
   - **`~/.claude/plans/i-want-this-app-hidden-wall.md`** — source of truth for the 10-phase *design intent*.
   - **`~/.claude/projects/<this project>/memory/MEMORY.md`** — point-in-time facts (when each thing landed).
   - **`docs/health-integrations.md`** and other docs/* files — feature-scoped technical references.

   The bank summarizes from the others and is the fast-path daily reference.

## Other rules

- Working branch: `main` is default — work directly on it. Pushing to `main` deploys to production (gsdtasks.com). Feature branches only when explicitly requested. (The old `dev` integration branch is stale/abandoned as of 2026-05-28.)
- Surgical edits: one change at a time during execution, read before write.
- Do not Co-Author Claude on commits.
- App features go in `app.html` (not `index.html` — that's the marketing page).
- Do not write scratch files under `.git/`; use repo-root dot-prefixed files for `gh --body-file`.
- All UI changes must use the documented brand framework classes (see `docs/brand-framework.html`). Don't introduce new button/card/chip/overlay variants — extend the framework first if needed.
- Backend Netlify Functions: use the shared lib in `netlify/functions/lib/` (http, encryption, auth, supabase) — don't redefine `cors`/`json`/`encryptToken`/`decryptToken`/JWT validation inline.
