# GSD — Claude Code project instructions

## Knowledge bank — READ FIRST, every session

Before planning, exploring, or building ANY feature in this repo:

1. **Read [`docs/app-knowledge-bank.html`](docs/app-knowledge-bank.html) first.** It lists what's currently shipped, what's in progress, and the open backlog. Browser-renderable, but plain-text read works fine too.

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
   - **`~/.claude/plans/i-want-this-app-hidden-wall.md`** — source of truth for the 10-phase *design intent*.
   - **`~/.claude/projects/<this project>/memory/MEMORY.md`** — point-in-time facts (when each thing landed).
   - **`docs/health-integrations.md`** and other docs/* files — feature-scoped technical references.

   The bank summarizes from the other three and is the fast-path daily reference.

## Other rules

- Working branch: `dev` is default. Feature branches only for multi-commit plans. `main` is release-only.
- Surgical edits: one change at a time during execution, read before write.
- Do not Co-Author Claude on commits.
- App features go in `app.html` (not `index.html` — that's the marketing page).
- Do not write scratch files under `.git/`; use repo-root dot-prefixed files for `gh --body-file`.
- `gsd-handoff/` is reference-only; tokens are inlined in `app.html` and must be edited there to deploy.
