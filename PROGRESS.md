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

## Known dead code (delete when touched)

These are LEGACY rules still in `app.html` that were aliased rather
than removed. Rule: if you edit anything nearby, delete the dead rule
in the same commit.

- Old pill color variants (`.pill.biz`, `.pill.personal`, `.pill.top3-pill`)
  — currently neutralized by later overrides. Delete originals.
- `.star-btn` styles (button is `display: none`). Delete all rules.
- `.mobile-slim-stats` styles (element is `display: none !important`).
  Delete the 30+ lines of rules.
- Desktop `.stats` bar styles (element is `display: none !important`).
- Empty-state `.empty-state-icon` and `-desc` (both `display: none`).
- `--max-notes` token (no longer used after ne-page card shell removal).
- Legacy token aliases: `--navy`, `--navy-dark`, `--navy-light`,
  `--navy-muted`, `--navy-border`, `--accent`, `--top3`, `--top3-bg`,
  `--check`, `--danger`, `--danger-bg`, `--danger-border`, `--link`,
  `--drag-over`, `--biz`, `--biz-bg`, `--biz-text`, `--personal`,
  `--personal-bg`, `--personal-text`, `--pastel-*`, `--heatmap-l*`,
  `--radius-xs/sm/md/lg/xl/pill`, `--shadow-xs/sm/md/lg/xl/focus`.
  Each one: grep, find every call site, migrate to the canonical
  token, delete the alias. See "Token migration plan" below.

## Token migration plan

When touching a file in the same area as a legacy call site:

| Legacy | Canonical | Notes |
|---|---|---|
| `--navy` | `--guava-700` | primary accent |
| `--navy-dark` | `--guava-800` | |
| `--navy-light` | `--guava-500` | |
| `--text` | `--ink` | |
| `--text2` | `--ink-2` | |
| `--muted` | `--ink-3` | |
| `--border` | `--edge` | |
| `--border2` | `--edge-strong` | |
| `--surface2` | `--surface-2` | |
| `--top3` | `--guava-700` | priority |
| `--top3-bg` | `--guava-100` | |
| `--check` | `--guava-700` | check fill |
| `--danger` / `--danger-bg` | `--guava-700` / `--guava-100` | |
| `--biz-bg` / `--biz-text` | `--slate-bg` / `--slate-fg` | |
| `--personal-bg` / `--personal-text` | `--ochre-bg` / `--ochre-fg` | |
| `--pastel-mint-*` | `--moss-*` | |
| `--pastel-sky-*` | `--sky-*` | |
| `--pastel-lavender-*` / `--pastel-coral-*` | `--plum-*` / `--guava-*` | |
| `--pastel-yellow-*` | `--ochre-*` | |
| `--radius-xs/sm/md/lg` | `--r-sm` / `--r-md` | cards = 4px, chips = 3px |
| `--radius-xl` | `--r-lg` | FAB only |
| `--radius-pill` | `9999px` | only avatar / day dots |
| `--shadow-sm` / `--shadow-xs` | `--shadow-card` | |
| `--shadow-md` | `--shadow-card-hover` | |
| `--shadow-lg` / `--shadow-xl` | `--shadow-raised` | |

Phase-out strategy: every PR deletes at least one alias and migrates
its call sites. Track remaining count here.

## Phase completion

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

### Not done
- Loading skeletons (Phase 9 also had this — deferred)
- Full touch-target pass beyond .pill and .check
- Legacy code cleanup (see "Known dead code")
- Token alias migration (see "Token migration plan")
- `.mobile-note-header` / `.mobile-note-back` naming — still uses
  "mobile" prefix but the element is now desktop + mobile. Rename to
  `.note-editor-header` / `.note-editor-back` when convenient.

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
