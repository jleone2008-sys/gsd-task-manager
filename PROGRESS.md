# GSD — Lifestyle Redesign, Session Log

Single source of truth for the lifestyle redesign, now on `dev`. If
you're starting a fresh Claude session, **read this first** before
editing anything.

## Working rules (hard requirements)

1. **No shortcuts.** Faster per turn ≠ faster overall. Every bug we
   chased twice came from an additive hack. Grep the cascade, delete
   conflicts in the same commit, make it right the first time.
2. **Never use `!important` without naming the rule it's beating.**
   If there isn't one, remove the `!important`. It's a code smell.
3. **Never alias a token without a reason.** If a legacy token
   (`--navy`, `--radius-md`, `--shadow-sm`) can be deleted, delete it
   and migrate its call sites. Keep aliases only if the migration is
   explicitly deferred and tracked here.
4. **Commit messages explain *why*, not just *what*.** "Fix notes
   card" is useless. "Root cause: rowToNote defaulted missing
   timestamps to now(), so all notes rendered the same relative time."
   is useful.
5. **Never claim a visual change is "done" without explicit user
   verification.** I can grep the cascade but I can't see the browser.
   Say "needs your check" when you can't prove it rendered correctly.
6. **Surface tradeoffs before making them.** If "do it right" costs
   5 more minutes than "patch it", name both options and let the user
   pick. Don't silently pick the shortcut.

## User preferences (learned, enforce in all sessions)

- No "Co-Authored-By Claude" lines in commit messages. (See
  `.claude/memory/feedback_no_coauthor.md`.)
- No emojis in code, commits, or UI unless explicitly requested.
- Surgical edits, one change at a time. Read before write.
- Marketing lives in `index.html`, app features in `app.html`.
- Deploy URLs: `gsdtasks.com` (prod, deploys from `main`),
  `https://dev--gsd-task-manager.netlify.app/app` (dev, deploys from
  `dev`). The redesign lives on `dev` and only reaches production
  when `dev` is merged to `main`.

## Design source of truth

- `gsd-handoff/DESIGN_HANDOFF.md` — spec v2.2
- `gsd-handoff/tokens-lifestyle.css` — canonical tokens
- `gsd-handoff/screens-lifestyle.jsx` — reference component markup

If the handoff doc and the tokens file disagree (e.g., `--r-md` is
listed as 8px in the doc and 4px in the tokens), **the tokens file
wins** — that's what's literally imported.

## Tokens in play

Canonical (from `tokens-lifestyle.css`):

- Surfaces: `--bg` `--surface` `--surface-2` `--edge` `--edge-strong`
- Ink: `--ink` `--ink-2` `--ink-3` `--ink-4` `--ink-5`
- Guava ramp: `--guava-50` through `--guava-900` (core: `--guava-700`)
- Earth chips: `--sage` `--sky` `--clay` `--moss` `--slate` `--ochre` `--plum`
  (each with `-fg` + `-bg` variants)
- Radii: `--r-sm` 3px, `--r-md` 4px, `--r-lg` 10px
- Shadows: `--shadow-card` `--shadow-card-hover` `--shadow-raised` `--shadow-fab`
- Type: `--t-xs` through `--t-3xl` (7 steps)
- Motion: `--ease` `--dur-fast` (120ms) `--dur` (180ms)
- Fonts: `--font-sans` (Inter), `--font-mono` (JetBrains Mono)

## Legacy audit — completed 2026-04-21

Every item below was closed out in a single session. `app.html` now
has:

- **Zero** legacy token aliases in `:root`. Every component rule
  speaks canonical lifestyle vocabulary directly (`--guava-*`,
  `--ink*`, `--edge*`, `--surface*`, `--r-*`, `--shadow-card/-hover/
  -raised/-fab/-focus`).
- **Zero** `!important` declarations outside documentation comments.
- **Zero** rules targeting permanently-hidden elements.
- **Zero** JS writing to never-rendered DOM elements.

The work, in order:

1. Phase 0 inventory (no edits; produced the dead-list + migration map).
2. Phase 1 dead CSS rules — `.stats-legacy`, `.empty-state-icon/-desc`,
   `.scratch-header`, `.del-btn`, plus `.pill.biz/.personal/.top3-pill`
   fragment prune, plus eight zero-use tokens.
3. Phase 5 dead JS/DOM — `.star-btn` markup and swipe refs;
   `.tool-switcher`/`.tool-tab` nav with its three desktop tool-badge
   paintBadge calls; the `#statsBar`/`#mobileSlimStats` pipeline
   including `updateNotesStatsBar()`, the inline tasks stats block,
   and the post-return body of `updateHabitStatsBar()`.
4. Phase 2 token alias migration in ten family-scoped commits: toast,
   pastel, shadow, radius, priority/danger/check/link/accent,
   biz/personal, heatmap, ink, edge/surface, navy. Every alias's
   call sites moved to the canonical token, then the alias deleted.
5. Phase 3 override consolidation — `.pill` fragment prune happened
   in Phase 1; the one remaining structural issue was an unreachable
   `@media (max-width: 800px) and (min-width: 900px)` block whose
   conditions could never both hold, deleted.
6. Phase 4 `!important` audit — specificity bump on the one rule
   that actually needed cascade help (`.user-menu .user-dropdown` on
   mobile); the other eight were either beating nothing or winning
   by source order anyway.

Deferred (intentionally out of scope, user-acknowledged):

- Internal `top3` rename — requires a Supabase column migration
  (`tasks.top3` → `tasks.priority`) plus 20+ JS call-site updates.
  User-facing text already says "Priority" everywhere.
- `.mobile-note-header` / `.mobile-note-back` naming — still uses
  "mobile" prefix but the elements now render at every width. Rename
  to `.note-editor-header` / `.note-editor-back` when next touched.
- Full touch-target pass beyond `.pill` and `.check`.
- Loading skeletons (originally scoped to Phase 9 of the redesign).

## Phase completion (redesign)

### Shipped (verified by user)
- Phase 1: Tokens
- Phase 2: Chrome (header, sidebar, tabbar, FAB)
- Phase 3: Task card (card/strip/check + inline expansion)
- Phase 4: Subtasks (Supabase + realtime)
- Phase 5: Habit row + cadence-aware stats
- Phase 6: Notes list rebuild (card shell + tone chips)
- Phase 7: Scratch document polish
- Phase 8: "Starred" → "Priority" text pass
- Phase 9: Empty state rewrite (spec §9.3)
- Phase 10: Tap target inflation (pill + check)

## Layout rules (enforce when editing layout)

- App-shell max-width: **1250px**, centered on viewport
- Sidebar: 220px (desktop ≥900px only)
- Content max-width: **810px** (`--content-max`)
- Sidebar-to-content gutter: **25px**
- All tabs share the same horizontal bounds (title, pill-bar, cards)
- Notes is the only full-width exception (its own 3-pane layout)
- Vertical gap from header title to next element: **14px** (desktop) /
  **16px** (mobile) — provided by header's own padding-bottom; every
  first child (pill-bar, content) has padding-top: 0 so there's no
  extra compounding gap

## Recurring bugs to watch for

- **Stale mobile overrides.** The file has layers of `@media (max-width: ...)`
  rules from pre-redesign. New rules added at the top get beaten by
  older overrides at the bottom. Always grep the whole file for the
  selector before assuming your rule wins.
- **`position: fixed` inside `overflow: hidden` ancestors.** Works
  fine by CSS spec but can surprise when `overflow-x: hidden` on a
  parent silently forces `overflow-y: auto`, creating a scroll
  container that breaks sticky children. Use `overflow: clip` instead.
- **`position: sticky` under a scrollable parent.** Sticks to the
  parent's scroll, not the viewport. If sticky breaks, check if a
  parent became a scroll container.
- **`scrollbar-gutter: stable` on html.** Needed so pages with
  scrollbars (Tasks, Notes) don't shift the centered shell by 15px
  vs pages without (Habits, Scratch).
- **Bubbling clicks closing dropdowns.** If a dropdown trigger is
  OUTSIDE the dropdown's parent, a document-level "close on outside
  click" handler closes it on the same click that opened it. Add
  the trigger element to the handler's "inside" check.
- **Notes/scratch sharing `.notes-editor`.** Scratch reuses the
  same DOM class as the notes editor. Mobile media query hides
  `.notes-editor` because of the notes overlay pattern. Scratch needs
  to force it visible (`display: flex`, `position: static`) in a
  `.scratch-view .notes-editor` rule.
- **`rowToX` defaulting timestamps to now().** If a DB column is null
  and you default to `new Date().toISOString()` in the row→object
  transform, every freshly-loaded record gets the same "now" value
  and relative-time formatters ("47m ago") show identical labels for
  the whole list. Fall back to a sibling timestamp or null instead.
