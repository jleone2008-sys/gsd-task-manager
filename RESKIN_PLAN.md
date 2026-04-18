# GSD Task Manager — Reskin Execution Plan

Phased rollout of the visual system defined in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), against the baseline mapped in [CURRENT_STATE.md](CURRENT_STATE.md). Every phase lists its **file scope**, **line-range scope inside [app.html](app.html)**, **acceptance criteria**, and **rollback strategy**.

We are on the `ui-redesign` branch. Nothing ships to `main` until Phase 8.

---

## Ground Rules

1. **No behavior changes during visual phases.** Phase 1 (bug fixes) is the only phase that touches JS behavior. Phases 2–8 are visual only.
2. **Nothing is hardcoded.** Every color, font-size, font-weight, font-family, spacing unit, radius, shadow, z-index, transition duration, and easing function must be expressed as a CSS custom property. The only permitted raw literals are: `1px` borders, `50%` circle radii, `100%`/`auto`/`0` dimensions, and animation keyframe percentages. No exceptions without a comment explaining why.
3. **Preserve every class name.** The risk audit (see §Risk Register) found dozens of classes applied/removed by JS (`active`, `open`, `dragging`, `mobile-open`, `clamped`, `new-task`, `just-toggled`, `touch-dragging`, `swiping`, `has-query`, `visible`, `selected`, `expanded`). Untouchable.
4. **Preserve every `id`.** JS queries them directly.
5. **Preserve the HTML structure.** Adding wrapper elements is allowed if unavoidable; structural removal is not.
6. **One phase per commit (minimum).** Each phase revertable via `git revert`.
7. **Verify at 1200px and 375px** after each phase.
8. **No new files added to the app** unless a phase calls for it. Everything stays in `app.html`.

---

## Phase 0 — Planning artifacts ✅

**File scope:** repo root (docs only). No app code.

Deliverables:
- [CURRENT_STATE.md](CURRENT_STATE.md)
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)
- [RESKIN_PLAN.md](RESKIN_PLAN.md) *(this file)*

---

## Phase 1 — Bug fixes & hardening

A code-health audit (see §Audit Findings at the end) surfaced three critical issues and several high-severity ones. **We fix these before the reskin**, on the same branch, so the reskinned build also ships the fixes. Polishing buggy code is wasteful.

**File scope:** `app.html` only. JS edits only — no CSS changes in this phase.

### Critical (ship-blockers)

1. **XSS via task text** ([app.html:4326](app.html#L4326)) — `linkify(t.text)` is injected into an `innerHTML` string. `linkify()` escapes URLs but not surrounding text. Fix: escape `t.text` with a shared `escapeHtml()` helper before passing to linkify, or refactor the render function to use `textContent` for the task body and only use `innerHTML` for the link-wrapped portions.

2. **XSS via user avatar metadata** ([app.html:2661](app.html#L2661)) — avatar `src` and `alt` pulled from `user_metadata` are interpolated directly into `innerHTML`. Fix: construct the `<img>` via `document.createElement`, setting `src`/`alt` via properties (not attributes), and appendChild. Supabase metadata is user-editable so assume it's hostile.

3. **Duplicate `provider` key in Google sign-in config** ([app.html:2591–2593](app.html#L2591)) — silently drops intended OAuth options. Fix: merge into a single object literal.

### High

4. **Duplicate `isHabitDueOnDate()` function** ([app.html:3318](app.html#L3318) and [app.html:3958](app.html#L3958)) — identical logic declared twice, second shadows the first. Keep the later one (canonical); delete the earlier.

5. **`userMenu.style.display` set twice in a row** ([app.html:2665–2668](app.html#L2665)) — `'flex'` then `'block'`. Keep `'flex'` (matches the CSS layout); remove the second assignment.

6. **Supabase subscriptions never unsubscribed** ([app.html:2978–3001](app.html#L2978), [3204–3259](app.html#L3204), [4920–4959](app.html#L4920), [5030–5054](app.html#L5030)) — on tool switch / logout / reload, subscriptions accumulate and leak memory. Add a top-level `activeSubscriptions = []` array; push every `.subscribe(...)` handle into it; add a `cleanupSubscriptions()` call at the start of `load()` and on sign-out.

7. **`reorder()` missing null guards** ([app.html:4367–4378](app.html#L4367)) — if a task is deleted mid-drag, `tasks.find()` returns `undefined` and the subsequent property access throws. Add `if (!fromTask || !toTask) return;` early.

8. **Race in `toggleCompletion()`** ([app.html:3142–3163](app.html#L3142)) — optimistic UI update is not reverted on Supabase error. Ensure the error branch fully restores the pre-toggle state before re-rendering.

9. **`scheduleMidnightRefresh()` timer never cleared** ([app.html:3289–3298](app.html#L3289)) — infinite chained `setTimeout`. On sign-out the timer keeps firing into a logged-out state. Store the timer id; clear it in the sign-out handler.

### Medium

10. **Global document click listener not removed** ([app.html:2676–2682](app.html#L2676)) — may double up if `toggleUserDropdown` is re-entered. Convert to a named function, remove before re-adding.

11. **`richToDisplay()` sanitization gap** ([app.html:6571–6579](app.html#L6571)) — strips `<script>` and `<style>` but leaves `<img onerror>`, `<svg onload>`, and other event-handler vectors. **Decision: adopt DOMPurify** (loaded via CDN, one script tag, ~20KB). Replace the current regex-based sanitize with `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })`.

12. **Missing `try/catch` on `saveTask()` / `deleteTask()`** ([app.html:2938–2960](app.html#L2938)) — promise rejections only hit console. Wrap the Supabase calls, surface failures via the existing error toast.

13. **Dead/unused `_navFromPop`** ([app.html:2698](app.html#L2698)) — declared, set, never read. Delete.

### Low (defer unless opportune)

14. `.faq-a { display: none }` (line 1365) — verify toggleFaq() still calls this; if dead, delete.
15. `.habit-card { z-index: 1 }` (lines 1401–1410) — no stacking context rationale; delete.

**Acceptance:**
- All Critical and High items fixed.
- Manual XSS test: create a task with `<img src=x onerror=alert(1)>` and verify no alert.
- No console errors after full tool-switch cycle (Tasks → Habits → Notes → Scratch → Tasks).
- No regressions in drag, swipe, search, or sync.

**Rollback:** revert the Phase 1 commit. Each sub-fix is small enough to re-cherry-pick individually if partial rollback needed.

---

## Phase 2 — Token foundation

Define the full token system in `:root`. After this phase, `:root` is the source of truth for every visual value in the app. No component styling changes yet — that's Phase 3.

**File scope:** `app.html` only.
**Line scope:** lines **12–35** of the existing `:root`, expanded to roughly lines **12–120** with the full token set.

**Edits:**
1. Replace the existing color values per [DESIGN_SYSTEM.md §2.1–§2.5](DESIGN_SYSTEM.md).
2. Add the shadow scale (§2.6), radius scale (§2.7).
3. Add typography tokens (§3): `--font-sans`, 12× `--fs-*`, 5× `--fw-*`, 2× `--tracking-*`.
4. Add spacing tokens (§4): 8× `--space-*`, 5× `--max-*`.
5. Add z-index tokens (§5): 14× `--z-*`.
6. Add transition & easing tokens (§6): 6× `--dur-*`, 3× `--ease-*`.
7. Add a breakpoint comment at the top of the stylesheet: `/* Mobile breakpoint: 600px. Notes secondary breakpoints: 800px, 1080px. */`

**Acceptance:**
- `:root` contains ~75 tokens, organized by section with comments.
- No component styles touched yet — app still renders in old colors because tokens aren't consumed.
- Load the app: auth screen, tasks, habits, notes, scratch, modals all still render. No visual change (components still use old hardcoded values).

**Risk:** None — additive-only change. Worst case a typo in a token definition causes a later phase to render wrong.

**Rollback:** revert the single commit.

---

## Phase 3 — Full detokenization pass

This is the mechanical heart of the reskin. Every CSS rule and every JS-emitted style migrates from raw values to tokens. Not just colors — fonts, sizes, spacing, radii, shadows, z-index, transitions, everything.

**Approach: work in passes, one token family at a time, so each commit is reviewable.**

**File scope:** `app.html` — CSS block (lines ~120–1864) and the surgical JS edits listed below.

### Pass 3a — Colors

1. **Pill filter colors** (lines 169–177) — all four pill variants → pastel tokens.
2. **Tag surfaces** — `.tag.biz`, `.tag.personal`, `.tag.top3`, `.tag-btn.biz`, `.tag-btn.personal`, `.tag-btn.t3` (lines 270–276, 390–393) → `--biz-bg`, `--biz-text`, `--personal-bg`, `--personal-text`, `--top3-bg`, `--top3`.
3. **Due-date badge states** (lines 380–388) → pastel family.
4. **Mobile slim stats chips** (lines 580–583) → pastel tokens.
5. **Notes active states** (lines 1674, 1695) → `var(--surface2)`.
6. **Habit pill CSS** (line 1376) → `var(--check)` + `var(--pastel-mint-bg)`.
7. **Error toast colors** (lines 497, 509–510) → new tokens `--toast-bg`, `--toast-err-red`, `--toast-err-amber`. Add to `:root` if not already there.
8. **Auth error** (lines 908–910) → tokenize `#fdf0ee` / `#f0c8c0` as `--danger-bg` / `--danger-border`.
9. **Grep-verify:** after this pass, running `rg '#[0-9a-fA-F]{3,6}' app.html` outside `:root` should return only documented exceptions (Google logo SVG colors, data URIs).

### Pass 3b — Typography

10. Every `font-size:` in the CSS block → `var(--fs-*)` token. Estimate: ~50 rules.
11. Every `font-weight:` → `var(--fw-*)` token. Estimate: ~40 rules.
12. Every `font-family:` other than `body` → `inherit` (it's already the pattern, finish the job).
13. Every `letter-spacing:` on uppercase labels → `var(--tracking-label)`.

### Pass 3c — Spacing

14. Every `padding:` and `margin:` with pixel values → `var(--space-*)` tokens. Where a value doesn't cleanly match the scale (e.g. `9px`, `11px`, `14px`), round to nearest token and verify visually. The scale is intentionally coarse — snap unless a visual test fails.
15. Every `gap:` → `var(--space-*)`.
16. Every `max-width:` for content regions → `var(--max-*)`.

### Pass 3d — Structure (radii, shadows, z-index, transitions)

17. Every `border-radius:` → `var(--radius-*)` (except `50%` circles, `4px 4px 0 0` chart bars).
18. Every `box-shadow:` → `var(--shadow-*)`.
19. Every `z-index:` literal → `var(--z-*)`. **Includes fixing the `9999` offender on `.sort-opt`** (line 311).
20. Every `transition:` / `animation:` duration → `var(--dur-*)`. Every easing → `var(--ease-*)`.

### Pass 3e — JS-emitted values

21. **Habit done inline style** (lines 3605, 3620) — delete `style="background:#ecfdf5;border-color:#d1fae5"` from template strings. Add `.habit-card.done` CSS rule using `var(--pastel-mint-bg)` and `var(--pastel-mint-text)`. The `done` class is already toggled by existing JS — we're just removing the inline override.
22. **SVG progress-ring strokes** (lines 3647–3648, 4740) — replace hardcoded `#e2e4e8` / `#2d5fa6` with `currentColor`. Wrap the SVG in an element whose `color:` is set via CSS, e.g. `<svg style="color: var(--border)">` → then use `stroke="currentColor"`. This is the only way these visuals become token-driven.
23. **SVG checkmark `stroke="#fff"`** (lines 3587, 3629, 4223, 4332) — these render on colored backgrounds. Replace with `stroke="currentColor"` where the parent's `color` is set to white via CSS. Keeps the visual identical but moves the white out of the template string.

**Acceptance:**
- Grep: zero hex color literals in CSS outside `:root` (except documented exceptions).
- Grep: zero `font-size:` with a px value outside `:root`.
- Grep: zero `z-index:` with a literal number outside `:root`.
- App renders in the new blue palette with pastel accents.
- All existing behaviors unchanged (drag, swipe, search, modal, sync).
- Visual diff: cards have tokenized shadows, radii match the new scale.

**Risk:**
- Pass 3a–3e together touch hundreds of lines. Commit per pass (5 commits) so each is reviewable.
- Radius/spacing consolidation may shift visual rhythm slightly — diff screenshots from Phase 0 baseline.
- The `currentColor` SVG refactor (pass 3e #22) requires careful wrapper-element placement. If uncertain, skip and leave hardcoded but update the hex values to match new tokens (same trick as before).

**Rollback:** revert per-pass commits.

---

## Phase 4 — Chrome (header, nav, FAB, pill bar, stats)

Tokens are in and consumed. Now reshape the app frame.

**File scope:** `app.html` only.
**Line scope:** 46–177 (header, pill bar), 460–492 (stats), 527–567 (FAB, mobile nav), 569–587 (mobile slim stats), 773–816 (floating search).

**Edits:**
1. **Header** — apply `var(--shadow-sm)` drop shadow; remove 1px rgba bottom border.
2. **Pill bar** — radius `var(--radius-xl)`, shadow `var(--shadow-md)`. Idle pills: `var(--surface2)` + `var(--muted)`. Active pills: pastel family per [DESIGN_SYSTEM §7.2](DESIGN_SYSTEM.md).
3. **FAB** — radius `var(--radius-pill)` (circular). Size 52×52 desktop / 48×48 mobile. Shadow `var(--shadow-lg)`.
4. **Mobile bottom nav** — reshape to floating pill:
   - Width: content-up-to-280px, centered, bottom 12px gap.
   - Background: new token `--nav-bg: #1f2847` (a deep cool near-black; add to `:root`).
   - Radius `var(--radius-pill)`. Shadow `var(--shadow-xl)`.
   - Active tab: primary-blue circle behind icon.
   - Keep labels (deferred decision).
5. **Mobile slim stats** — reposition above the new floating pill nav. `bottom: 76px`.
6. **Desktop stats bar** — swap top border for `var(--shadow-sm)` glow.
7. **Floating search** — expanded radius `var(--radius-pill)`, shadow `var(--shadow-lg)`.

**Acceptance:** mobile + desktop render correctly; touch targets still ≥44px; no stacking collisions.

**Rollback:** revert commit.

---

## Phase 5 — Task card redesign (three-zone + slot system + starred strip + notched corner)

Largest structural phase. Re-lays the task card to the three-zone spec in [DESIGN_SYSTEM.md §7.3](DESIGN_SYSTEM.md) and introduces the notched-corner mobile variant plus the `.chip` component.

**File scope:** `app.html` only.
**Line scope:** CSS 318–441 (task list/item), 370–393 (tag/due badges that become `.chip`), 589–662 (create panel, modal), 818–929 (auth card). JS template scope: task render function (audit pinned this around lines 4300–4420 in the `renderTask` path).

**Edits:**

### 5a — Task card structural pass

1. **Three-zone skeleton.** Refactor task item markup from `checkbox + content + actions` to `.lead-slot + .body + .trail-slot` (preserves existing class names; adds the new slot classes as wrappers/roles).
2. **`.meta-row` chip refactor.** Replace `.tag.biz`, `.tag.personal`, `.tag.top3`, `.due-badge.*` with a base `.chip` class + modifiers (`.chip--work`, `.chip--personal`, `.chip--starred`, `.chip--overdue`, `.chip--today`, `.chip--soon`). Old class names remain as aliases for JS-side compat — one aliasing rule in CSS per legacy class.
3. **Card shell.** Radius `var(--radius-lg)`, `var(--shadow-xs)` idle, `var(--shadow-sm)` hover.

### 5b — Starred left-strip

4. **Remove the current 3px left-border** on `.task-item.top3` and replace with a full-height vertical strip via a pseudo-element (`.task-item.top3::before`) or left-padding + absolute-positioned `<div class="star-strip">`. Width: 12px mobile, 8px desktop. Background: `var(--navy)`. Does not overlap content — padding-left of the card body grows to clear it.
5. **Starred cards do NOT tint the background.** Surface stays white; the strip alone carries the signal. This is what makes multi-star work without monotony.
6. **Remove the old `--top3-bg` tint application** from `.task-item.top3`. Keep the token in case a future variant wants it, but don't consume it on the default starred card.

### 5c — Notched-corner mobile variant

7. Add `.task-item.has-notch` variant applied by default at `@media (max-width: 600px)`.
8. Implement the notch with `mask-image: radial-gradient(circle at var(--notch-inset) var(--notch-inset), transparent var(--notch-size), black calc(var(--notch-size) + 1px))`. Token values: `--notch-size: 22px`, `--notch-inset: 10px`.
9. Enlarge `.lead-slot` checkbox to `var(--notch-icon-size)` = 40px; position absolute inside the notch; tappable area 44×44 via padding.
10. Card padding-left on `.has-notch` becomes `calc(var(--notch-size) + var(--notch-inset) + var(--space-3))` so content clears the notch.
11. **Desktop fallback**: no notch, classic inline checkbox layout.

### 5d — Due-state as chip (not overlay)

12. Starred + overdue task renders: left strip + `.chip--overdue` in the meta row. Two signals, neither overpowers.

### 5e — Modals and auth

13. Create panel & modal — radius `var(--radius-xl)`, shadow `var(--shadow-xl)`, backdrop blur 6px with blue-tinted overlay.
14. Auth card — radius `var(--radius-xl)`, shadow `var(--shadow-lg)`. Logo badge: `var(--radius-lg)`.

**Acceptance:**
- Multiple tasks can be starred and the list still reads cleanly (no monotony).
- Mobile task cards show the notched corner; checkbox tappable area measures ≥44×44 with DevTools inspector.
- Desktop task cards unchanged in structure (density preserved).
- `.chip` class renders all existing tag and due-date variants identically to before Phase 3a (the styling is equivalent; only class names changed).
- No JS functionality regressed (drag, swipe, search, filter).

**Risk:**
- **Markup refactor** is the single biggest regression risk in the reskin. The JS render function touches this HTML — verify every call path.
- **Notch mask** on Safari: `mask-image` works in Safari 15.4+. For older iOS, the fallback pseudo-element kicks in (see [DESIGN_SYSTEM.md §7.3a](DESIGN_SYSTEM.md)).
- **Class-aliasing approach** keeps JS working but leaves dead selectors in CSS. Acceptable for v4; clean up in a follow-up sweep.

**Rollback:** revert commit. If only notch fails, ship 5a/5b/5d/5e and skip 5c.

---

## Phase 6 — Habits tool polish

**File scope:** `app.html` only.
**Line scope:** ~1040–1643 CSS.

**Edits:**
1. Habit card — `var(--radius-lg)`, `var(--shadow-xs)` / `var(--shadow-sm)`.
2. Today dot — `var(--navy-light)` ring + `var(--shadow-focus)`.
3. Score rings — colors now consumed from `currentColor` (Phase 3e #22) — verify visually.
4. Stat cards grid — pastel cycling (lavender / yellow / coral / mint). Optional.
5. Heatmap — fill scale retinted to new `--check` green.
6. Habit drill-in container — `var(--radius-xl)`, `var(--shadow-md)`.

**Rollback:** revert commit.

---

## Phase 7 — Notes tool polish

**File scope:** `app.html` only.
**Line scope:** ~1500–1864.

**Edits:**
1. Sidebar active item — verified tokenized in Phase 3a.
2. Note list item — radius `var(--radius-md)`, selected ring `var(--shadow-focus)`.
3. Editor card — radius `var(--radius-xl)`, shadow `var(--shadow-sm)` desktop.
4. Mobile full-bleed editor — radius 0 (unchanged).

Verify at all three notes breakpoints (1080 / 800 / 600).

**Rollback:** revert commit.

---

## Phase 8 — Polish, audit, and merge

**File scope:** `app.html`, optionally `gsd-brand-framework-v4.md` (new file to capture the new system).

**Edits:**
1. Scratch tab — minor tweaks.
2. Error toast, undo toast, confirm dialog, legal modal, FAQ modal — verify.
3. Onboarding tooltip + spotlight — verify.
4. Accessibility pass: missing aria-labels on icon-only buttons (identified in Phase 1 audit as a low but real issue), tab order, focus rings, contrast.
5. Responsive pass: 375 / 600 / 900 / 1200px across every view.
6. Final grep audit — confirm zero stray literals.
7. Optionally author `gsd-brand-framework-v4.md` to replace v3.0. Keep v3.0 in repo for history.
8. Merge `ui-redesign` → `main` via PR.

**Acceptance:**
- No hex literals outside `:root` (documented exceptions only).
- No layout regressions at any tested breakpoint.
- All JS behaviors intact.
- Critical and High audit items verified fixed.

---

## Risk Register (cross-phase)

| # | Risk | Phase | Mitigation |
|---|---|---|---|
| 1 | JS-emitted inline styles override CSS (habit done) | P3e | Delete inline styles; add `.habit-card.done` rule |
| 2 | SVG stroke hardcodes in JS templates | P3e | Refactor to `currentColor` with CSS-driven parent `color` |
| 3 | Class names are JS-contracted | All | Never rename state classes |
| 4 | HTML `id`s are JS-contracted | All | Never rename ids |
| 5 | Tag colors scattered across 3+ rules | P3a | Token cascade |
| 6 | Mobile bottom nav rebuild risks layout regression | P4 | 375px verification; rollback is cheap |
| 7 | Hero task variant needs JS logic | P5 | Gated; skip if risky |
| 8 | Radius/spacing consolidation shifts visual rhythm | P3c, P3d | Screenshot diff per pass |
| 9 | Notes has three nested breakpoints | P7 | Full responsive pass in Phase 8 |
| 10 | No visual regression test harness | All | Manual screenshots per phase |
| 11 | Dark mode not addressed | All | Explicit non-goal; tokens support adding `.theme-dark` later |
| 12 | XSS via innerHTML in task/avatar/note render | P1 | Fix before anything else |
| 13 | Supabase subscription leaks | P1 | Centralize cleanup |
| 14 | `:root` becomes large (~75 tokens) | P2 | Organize by section with comments; keep monofile |

---

## Audit Findings (summary from Phase 0)

A background code-health audit produced these findings (full detail lives inline in each phase above):

**Critical:** 3 items — two XSS vectors (task text, avatar metadata) and a duplicate `provider` key in OAuth config. All addressed in Phase 1.

**High:** 6 items — duplicate function, subscription leaks, race condition, null-guard gaps. All addressed in Phase 1.

**Medium:** 4 items — HTML sanitization gap, async error handling, midnight-timer leak, global-click listener. Addressed in Phase 1 where reasonable; `richToDisplay` sanitization upgrade may slip to a follow-up if DOMPurify adoption is deferred.

**Low:** 2 items — dead CSS, stray z-index on habit cards. Cleaned up opportunistically.

**Tokenization status pre-reskin:**
- Colors: 34 tokens in `:root`, ~12 hex literals scattered outside. Addressed in Phase 3a.
- Font sizes: 8+ unique px values, **zero tokens**. Addressed in Phase 3b.
- Spacing: 16px×50+, 8px×30+, 12px×20+, zero tokens. Addressed in Phase 3c.
- Z-index: 15+ unique values including a `9999` offender. Addressed in Phase 3d.
- Transitions: 6+ unique durations, zero tokens. Addressed in Phase 3d.
- Radii: 10 unique values, partially tokenized. Addressed in Phase 3d.

---

## Decisions Locked In

Previously-open questions are answered. Captured here for handoff and future audit. The corresponding expanded rationale lives in [DESIGN_SYSTEM.md §14](DESIGN_SYSTEM.md).

1. **Multi-star with left-strip highlight.** Multiple tasks can be starred. Each gets a 12px (mobile) / 8px (desktop) full-height left strip in `var(--navy)`. Card background stays white. Due-today/overdue surfaces as a chip in the meta row.
2. **Mobile bottom nav keeps labels.** Icons + labels inside the floating pill, not icons-only.
3. **Pastel palette calibrated dustier.** Saturation 20–30%, lightness 88–92%. Specific values in [DESIGN_SYSTEM.md §2.5](DESIGN_SYSTEM.md).
4. **DOMPurify for `richToDisplay()`.** CDN load, standard HTML profile.
5. **New brand framework doc: `gsd-brand-framework-v4.md`** authored in Phase 8.
6. **Signature notched-corner card variant** on mobile task and habit cards. Desktop fallback unchanged.
7. **Total tokenization.** See Ground Rule #2.
8. **Three-zone task card + `.chip` slot system** introduced in Phase 5 — foundation for future features (subtasks, time estimates, reminders, assignees, attachments, projects).
9. **Dark mode out of scope.** Tokens enable it; not shipping.

## Mobile-First Acceptance Criteria (every phase)

Every phase must verify these at 375px before signing off:

- No touch target below 44×44px.
- No task/habit row below 56px tall.
- Bottom FAB clears the floating pill nav (no overlap).
- Content does not scroll horizontally.
- Primary action (creating a task/habit/note) remains thumb-reachable.
- No feature requires a gesture outside `tap / long-press / swipe-left / swipe-right`.

---

## Out of Scope (explicit non-goals)

- Dark mode (tokens support it; not shipping)
- New features or functionality
- Backend / Supabase schema changes
- Marketing site ([index.html](index.html)) redesign
- Legal pages ([privacy.html](privacy.html), [terms.html](terms.html)) restyling
- Font change (Inter stays)
- Animation library adoption
- Icon library change
- Build system introduction (no bundler, no Tailwind, no PostCSS)
