# Legacy Code Audit & Cleanup — execution plan

> **STATUS: COMPLETE (2026-04-21).** Every phase below has been executed
> and shipped to `dev`. The runbook is kept for historical reference
> in case a similar cleanup is needed on a future port. For the
> current post-cleanup state see the "Legacy audit — completed"
> section of [PROGRESS.md](PROGRESS.md).

This is a runbook for cleaning up the dead code and aliased tokens
that built up during the lifestyle redesign port. **Read `PROGRESS.md`
first** — it has the working rules and broader context.

You are a fresh Claude session. The user wants the cleanup done **the
right way every time**. Faster per turn does not mean faster overall.
If you cut a corner you'll be back here in two days fixing it.

---

## Goal

Get `app.html` to a state where:

- No CSS rule references a token that's just an alias for another
  token. Every component CSS rule speaks the canonical lifestyle
  vocabulary directly (`--guava-700`, `--ink`, `--edge`, `--r-md`,
  `--shadow-card`, etc.).
- No CSS rule targets an element that no longer exists or is
  permanently `display: none`.
- Every `!important` declaration has a one-line comment naming the
  rule it's beating, OR is removed.
- Every override CSS block (rules that win over earlier rules in the
  cascade) is either justified by an inline comment, or merged with
  the earlier block, or one of the two is deleted.
- No JavaScript writes a value to an element that no longer renders.

The user does not care about ship speed for this work. They care
that it's done correctly and that the next round of feature work
isn't fighting cascade ghosts.

---

## Hard rules (non-negotiable)

These are summarised in `PROGRESS.md`; restating because they matter
acutely for cleanup work:

1. **Grep before you cut.** For every selector or token you propose
   to delete, run a grep across `app.html` AND `index.html` (the
   marketing site) and any other repo file. If anything outside
   `app.html` references it, the cleanup blocks until you've checked
   with the user.
2. **One concept per commit.** "Removed the legacy --navy alias and
   migrated 47 call sites" is a commit. Don't bundle unrelated
   cleanups together — the user has to read these diffs.
3. **Commit messages explain *why*, not just *what*.** "Remove
   .star-btn rules — the .star-btn HTML element has display:none
   since 2026-04-19 (Phase 3 task card rebuild)" is good.
4. **`!important` is a code smell.** If you find one without a
   commenting rule, EITHER remove it (and verify the cascade still
   works) OR add a comment naming the rule it beats.
5. **Never claim done without a verification path.** Cleanup is
   higher-risk than features because dead code "works" until it
   doesn't. After each phase: grep the file for what you removed,
   confirm zero matches.
6. **Surface tradeoffs.** If you find a rule that *might* be live
   but you can't be sure (e.g., reachable only via a code path you
   can't trigger), say so. Don't assume.

---

## Phase 0 — Inventory (read-only, no edits)

Before cutting anything, build a known-dead list. Do not commit
anything in this phase. Output goes to a temp file or your reply
to the user; the user approves the list before Phase 1 starts.

Steps:

1. **Tokens.** Grep every `--*:` declaration in the `:root` block.
   For each one, grep for `var(--name)` across the file. Bucket:
   - Used in canonical rules (keep)
   - Used only in legacy rules (alias chain — to migrate)
   - Defined but never used (dead — delete)
2. **Selectors.** For each of these classes/IDs, grep:
   - `.star-btn`, `.del-btn`, `.tool-switcher`, `.tool-tab`,
     `.tool-badge`, `.mobile-slim-stats`, `.mss-group`,
     `.empty-state-icon`, `.empty-state-desc`,
     `.pill.biz`, `.pill.personal`, `.pill.top3-pill`,
     `.pill.habit-pill`, `.pill.stat-pill`,
     `.scratch-header`, `.heatmap-l1`/`l2`/`l3`/`l4`,
     `.stats-legacy`, `#statsBar`, `#mobileSlimStats`,
     `#tasksBadge` (legacy header badge — now hidden)
   For each: confirm the element is permanently hidden (CSS), or
   the element has been removed from HTML, or the JS that creates
   it never runs. If any of those is uncertain, do NOT mark dead.
3. **`!important` declarations.** Grep `!important` and produce a
   table:
   | Line | Selector | Property | Beating which rule? |
   For each: either the comment explaining it beats X, or the
   beat-rule line number, or "needs investigation".
4. **Cross-file references.** Grep the dead-list selectors and
   tokens against `index.html`, `privacy.html`, `terms.html`, and
   any `*.md` in repo root. Anything used externally moves out of
   "dead" into "scoped — keep until external migrated".

Acceptance: a single comment to the user with three lists:
**Confirmed dead** (safe to delete), **Migrate then delete** (used
in legacy rules only — migrate call sites first), and
**Investigate** (uncertain).

---

## Phase 1 — Verifiably dead CSS rules

Only items from the **Confirmed dead** list. Examples (verify each
yourself in the audit; don't trust this list blindly — it might be
out of date by the time you read this):

- `.star-btn` rules (button has `display: none`, JS no longer toggles
  visibility on it)
- `.mobile-slim-stats` rules (element hidden via `display: none !important`)
- `.stats-legacy` rules (left over from header rebuild)
- `.empty-state-icon` / `.empty-state-desc` (both `display: none`,
  the new empty state renders only `.empty-state-title` + ghost button)
- Old desktop `.stats` bar internal rules (only the `display: none`
  shim on `.stats` itself stays, deletes the rest)
- `--max-notes` token (no longer referenced anywhere — `.ne-page`
  card shell was removed in the scratch double-card fix)
- `.heatmap-l1` through `.heatmap-l4` if no template references them
  anymore (the habit heatmap was simplified)
- Sample arrays (`seedActive`, `seedDone`) ONLY if onboarding has
  also been removed — DO NOT delete these without confirming
  `buildSeed()` and its caller are gone
- `--app-max` aliases or duplicates if any (the canonical is in
  `:root`)

**For each rule deleted in this phase**: verify zero matches for
the selector after the edit, in the same commit. Push, ask the user
to spot-check the deploy. Move to Phase 2 only after user confirms.

---

## Phase 2 — Token alias migration

Migration mapping is in `PROGRESS.md` under "Token migration plan".
Order matters — start with tokens that have the FEWEST call sites,
because those changes are easiest to verify.

Suggested order (lowest → highest call site count):

1. `--accent` → `--guava-800`
2. `--navy-muted` / `--navy-border` (rgba) → drop entirely (only
   used by the old navy header, which is gone)
3. `--top3` / `--top3-bg` → `--guava-700` / `--guava-100`
4. `--check` → `--guava-700`
5. `--danger` / `--danger-bg` / `--danger-border` →
   `--guava-700` / `--guava-100` / `--guava-200`
6. `--biz-bg` / `--biz-text` / `--biz` → `--slate-bg` / `--slate-fg`
7. `--personal-bg` / `--personal-text` / `--personal` →
   `--ochre-bg` / `--ochre-fg`
8. `--pastel-mint-*` → `--moss-*`
9. `--pastel-sky-*` → `--sky-*`
10. `--pastel-lavender-*` → `--plum-*`
11. `--pastel-yellow-*` → `--ochre-*`
12. `--pastel-coral-*` → `--guava-*`
13. `--heatmap-l*` → `--surface-2` / `--guava-*` ramp
14. `--drag-over` → `--guava-100`
15. `--link` → `--guava-700`
16. `--shadow-xs` / `--shadow-sm` → `--shadow-card`
17. `--shadow-md` → `--shadow-card-hover`
18. `--shadow-lg` / `--shadow-xl` → `--shadow-raised`
19. `--shadow-focus` → `--shadow-focus` (this one is canonical, but
    confirm rgba uses guava not navy)
20. `--radius-xs` → `--r-sm`
21. `--radius-sm` / `--radius-md` / `--radius-lg` → `--r-md`
22. `--radius-xl` → `--r-lg`
23. `--radius-pill` → `9999px` (or keep as `--r-pill: 9999px` if
    used in many places)
24. `--text` → `--ink`
25. `--text2` → `--ink-2`
26. `--muted` → `--ink-3`
27. `--border` → `--edge`
28. `--border2` → `--edge-strong`
29. `--surface2` → `--surface-2`
30. `--navy` → `--guava-700` (DO LAST — most call sites, biggest
    blast radius if you misjudge a rule)

**Per-token process**:

1. Grep `var(--legacy-name)` to count call sites.
2. Read each call site. If the call site is in a rule for an
   element that's permanently hidden, the call site can be
   deleted instead of migrated (mark this in your commit message).
3. Migrate live call sites to the canonical token.
4. Delete the alias from `:root`.
5. Verify: zero matches for `--legacy-name` (both as definition
   and as `var()` reference) in the file.
6. Commit with the migration count.
7. **Push and let the user spot-check before moving to the next
   token.** Yes, every single one. The whole point is to not blow
   anything up.

---

## Phase 3 — Override consolidation

Find rule pairs that target the same selector, where one overrides
the other. Common patterns:

- A base rule sets a color, a media query overrides it for mobile —
  consolidate by making the base mobile-first and the media query
  the desktop-only override.
- A legacy rule is followed later by an override rule from the
  redesign port. Merge into the redesign rule, delete the legacy.

Examples to look for (verify each):

- `.pill` base rule + `.pill.biz` / `.pill.personal` /
  `.pill.top3-pill` neutralizing overrides — collapse to a single
  `.pill` rule with no per-tag variants.
- `.mobile-note-header` defined twice (mobile media + unscoped
  desktop) — already cleaned in Phase 6 work but verify nothing
  similar exists for `.mobile-note-back`, `.mobile-note-actions`.
- Multiple `@media (max-width: 899.98px)` blocks scattered across
  the file — consolidate where it's safe (hard rule: only
  consolidate blocks that target related selectors; don't merge
  unrelated rules just because they share a media query).

Per-merge: name it in the commit, verify no behaviour changes
visually (or surface to user).

---

## Phase 4 — `!important` audit

Walk every `!important` from the inventory.

For each:

- If you can rewrite the rule to win via specificity instead, do
  that and remove the `!important`.
- If `!important` is genuinely needed (e.g., overriding an inline
  style or beating a third-party rule), keep it AND add a
  one-line comment naming the rule it's beating.
- If neither applies, delete it and verify the cascade still
  produces the right result.

Commit per group of 3-5 related `!important` removals so each diff
is reviewable.

---

## Phase 5 — Dead JavaScript

Grep for functions that are never called.

- For each function defined in `app.html`, grep for invocations.
- If zero invocations: candidate for deletion. **Verify no
  inline `onclick=`, `onkeydown=`, etc. attribute references.**
  These are easy to miss because grep for `funcName(` matches
  inline handlers but `funcName ` does not.
- For each function that's only called by another removed function,
  it's transitively dead — delete in the same commit.

Examples (verify before deleting):

- Helpers that supported old features (e.g., the old emoji-prefixed
  section labels — `slabel()` was simplified, but its helpers may
  not have been)
- `restoreJSON` / `exportJSON` if the backup feature was removed
  (it wasn't — it's still in the user dropdown — but grep before
  assuming)
- Stats bar update functions that write to hidden `.stats` /
  `#mobileSlimStats` elements: these can be no-ops with a comment,
  or removed if no other call site depends on the side effect

---

## Phase 6 — Cleanup PROGRESS.md and this file

After Phases 1-5 are merged:

- Update `PROGRESS.md` "Known dead code" and "Token migration plan"
  sections — items completed should be marked done with the commit
  hash, items deferred should have a reason written.
- Update this file (`LEGACY_AUDIT.md`) to mark phases complete and
  add anything you encountered that wasn't on the original list.
- If new dead-code patterns emerged, add them to PROGRESS.md so the
  next session inherits the knowledge.

---

## Verification checklist (run at the end of every phase)

```
# Confirm no broken references (run via Bash tool, not Grep, since
# we want to fail loud if any remain — Grep treats no-match as OK).
grep -n "var(--<just-deleted-token>)" app.html         # expect: 0
grep -n "\\.<just-deleted-class>" app.html             # expect: 0
grep -n "\\.<just-deleted-class>" index.html           # expect: 0
grep -n "\\b<just-deleted-id>\\b" app.html             # expect: 0

# Sanity: app.html still parses (no truncated CSS blocks).
# Eyeball the head: should be valid HTML, :root should still close cleanly.
```

If any expected-zero is non-zero, the deletion is incomplete.
Restore and investigate before moving on.

---

## What NOT to touch in this audit

These are documented decisions — leave them alone unless the user
explicitly asks:

- The DB schema (no Supabase migrations as part of cleanup).
- The Inter / JetBrains Mono font loading.
- The `app-shell { max-width: 1250px }` cap.
- The `--content-max: 810px` content column width.
- The 25px sidebar-to-content gutter.
- The 14/16px header-to-first-element vertical gap.
- The `scrollbar-gutter: stable` rule.
- The notes-layout / scratch / task / habit shared card styling
  (`--r-md` + `--shadow-card` + `--edge`). These are deliberately
  identical and any "cleanup" that diverges them is a regression.
- The `.mobile-note-header` class name (deferred rename to
  `.note-editor-header` is OK to do as part of cleanup, but it's a
  distinct change — separate commit, mention in PROGRESS.md).

---

## Estimated scope

Phase 0 (inventory): 1 session
Phases 1-5 (cleanup): 3-5 sessions, depending on user verification cadence

Don't try to do it all in one session. The user actively prefers
slow + correct over fast + wrong. Each phase ends with a "user
spot-checks the deploy" gate. Honor it.
