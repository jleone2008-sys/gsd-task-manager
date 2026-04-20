# GSD Task Manager — Current State

Inventory of what exists today, as a baseline for the reskin. Pulled from [app.html](app.html), [gsd-brand-framework-v3.md](gsd-brand-framework-v3.md), and the component/HTML map. Line numbers refer to `app.html` unless noted.

---

## 1. File Architecture

Single-file SPA. All CSS, HTML, and JS inline in one document.

| Section | Lines | Size |
|---|---|---|
| `<style>` block | 10 – 1864 | ~1,855 lines |
| HTML body | 1867 – 2553 | ~686 lines |
| `<script>` block | 2554 – 7489 | ~4,935 lines |

Third-party: Supabase JS client (CDN), Inter (Google Fonts), nothing else. No build step.

Related files (not part of the app proper, but included in the repo):
- [index.html](index.html) — marketing landing page (separate design system, not in scope)
- [privacy.html](privacy.html), [terms.html](terms.html) — legal
- `gsd-platform-full.html`, `desktop-stats-all-tools.html`, `habits-stats-mockup.html`, `mobile-stats-all-tools.html` — earlier mockups/prototypes
- `gsd-brand-framework-v3.md` — the authoritative design-system spec

---

## 2. Design Tokens (current)

All in `:root` at lines 12–35. These are the source of truth — the brand framework (§2) enumerates them verbatim.

### Colors

```
--bg           #f4f5f7    page background (warm gray)
--surface      #ffffff    card / item background
--surface2     #f0f1f3    secondary surface, hover
--border       #e2e4e8    default 1px border
--border2      #d0d3da    input / focused border
--navy         #2d5fa6    brand primary, header, CTAs, FAB
--navy-dark    #224a8a    navy hover
--navy-light   #3d70c0    focus ring, drag highlight
--navy-muted   rgba(255,255,255,0.6)
--navy-border  rgba(255,255,255,0.2)
--accent       #3d3d8f    secondary / habit scores
--text         #1d1c1d
--text2        #454245
--muted        #9a9a9a
--biz          #1264a3    Work tag text
--personal     #7c2d96    Personal tag text
--top3         #b85c00    Starred indicator
--top3-bg      #fffcf5    Starred task bg
--check        #007a5a    Checkmark, positive state
--danger       #e01e5a    Destructive
--link         #1264a3
--drag-over    #eef0fb
```

### Non-tokenized colors still in use

Scattered hex literals exist for states that aren't in `:root`. The reskin will need to either tokenize or replace these:

- Pill filter colors (lines 169–177): `#f59e0b #92400e #fffbeb #d97706 #3b82f6 #1e40af #eff6ff #1a5fa8 #a855f7 #6b21a8 #faf5ff #7c3aad` — both idle and active states
- Tag surfaces (lines 390–393): `#e4eef8 #ece6f4 #ffefc0`
- Due-date badge states (lines 380–388): `#fff8e6 #b45309 #fcd34d #fef2f2 #dc2626 #fca5a5 #eff6ff #2563eb #bfdbfe`
- Mobile stats chip colors (lines 580–583): `#93c5fd #d4a8f0 #86efac #fcd34d`
- Error toast: `#1e2231 #f87171 #fbbf24`
- Auth screen: `#0f1117 #2563eb #6b7280 #fdf0ee #f0c8c0`

### Typography

- Font: `Inter` only (loaded via Google Fonts, line 9)
- Scale is locked (brand framework §3) — 10px → 24px in ~10 discrete steps; weights 300–800

### Radius

- Standard: **8px** everywhere except `50%` for circles and `4px 4px 0 0` for chart bars
- **Known deviation:** `.pill-bar-inner` uses `12px` at line 122, and modals use `10px` at line 631 (brand framework §4 says 8px — these are pre-existing drifts)
- `.auth-card` uses `16px` (line 830), `.auth-logo-badge` uses `16px` (line 841)

### Shadow vocabulary (informal — no tokens)

- Pill bar: `0 6px 24px rgba(0,0,0,0.11), 0 2px 8px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04)` (line 123)
- Modal: `0 8px 32px rgba(0,0,0,0.14)` (line 631)
- FAB: `0 4px 16px rgba(45,95,166,0.35)` (line 532)
- Auth card: `0 8px 40px rgba(0,0,0,0.08)` (line 831)
- User dropdown: `0 6px 28px rgba(0,0,0,0.12)` (line 990)

No shadow tokens — every use is a raw value.

### Spacing / layout

- Max content width: **720px** (tasks, habits); pill bar: **560px**; modals: **460px**; auth card: **380px**; notes editor: **740px**
- Mobile breakpoint: **600px** (single breakpoint used throughout; notes has secondary 800px and 1080px breakpoints at lines 1847–1863)
- Header height: 50px (48px mobile); stats bar: 40px desktop / 28px mobile slim; mobile nav: 56px
- Content padding: `8px 16px 100px` desktop / `6px 12px 130px` mobile

---

## 3. Component Inventory

Line ranges map the CSS + HTML regions that make up each component.

### Chrome

| Component | CSS | HTML | Notes |
|---|---|---|---|
| Header (fixed) | 46–104 | 2052–2116 | Sticky, navy bg, logo + tool switcher + search + avatar |
| Tool switcher (desktop) | 83–104 | 2060–2077 | Segmented control, 4 tabs: Tasks / Habits / Notes / Scratch |
| User avatar + dropdown | 972–1055 | 2078–2113 | Circle, opens dropdown with backup/legal/faq/signout |
| Pill bar (filter row) | 106–177 | 2118–2126 | Floating white card with 5 filter pills |
| FAB (+) | 527–538 | 2232–2234 | Fixed bottom-right, navy square 8px radius |
| Stats bar (desktop) | 460–492 | 2178 | Fixed bottom, navy, centered metrics |
| Mobile slim stats | 569–587 | 2212–2220 | 28px navy bar above mobile nav |
| Mobile bottom nav | 540–567 | 2189–2209 | 56px, surface bg, 3 tabs (Tasks/Habits/Notes) |
| Floating search | 773–816 | 2223–2229 | Collapsible pill, 46px → 260px on expand |
| Error toast | 494–525 | 2181–2187 | Bottom-left, dark bg, dismissible |

### Tasks tool

| Component | CSS | HTML | Notes |
|---|---|---|---|
| Add-task row (legacy/hidden) | 179–277 | — | Replaced by FAB + create panel in UI, CSS retained |
| Task list | 318–441 | 2129–2131 | `.task-list` renders items dynamically from JS |
| Task item | 322–369 | (dynamic) | Checkbox + text + note + meta row + actions |
| Tag pills (biz/personal/top3) | 390–393 | (dynamic) | Inline pills in `.task-meta` |
| Due-date badge | 374–389 | (dynamic) | 4 states: default / today / overdue / soon |
| Drag handle + drag states | 415–438 | (dynamic) | Desktop drag-drop + mobile touch drag |
| Section labels | 282–316 | (dynamic) | "STARRED", "TASKS", "LATER", "COMPLETED" + sort dropdown |
| Done toggle divider | 442–458 | (dynamic) | Collapsible completed section |
| Create panel (modal overlay) | 589–625 | 2237–2263 | FAB opens this, 480px card |
| Edit task modal | (shared modal styles 627–662) | 2512–2552 | Full editor: title/note/tags/due/delete |

### Habits tool

Dense sub-app. CSS lives roughly between lines ~1040–1500.

| Component | Approx CSS | HTML |
|---|---|---|
| Habit sub-pills (Today/Week/Month/Year/Insights) | (shares `.pill-bar` styles) | 2140–2147 |
| Habit card (today view) | ~1050–1200 | (dynamic) |
| Day dots (26/32px circles, streaks) | ~1100–1180 | (dynamic) |
| Score rings (SVG, 4 color tiers) | ~1200–1260 | (dynamic) |
| Stat cards grid | ~1270–1330 | (dynamic) |
| Heatmap (year view) | ~1340–1440 | (dynamic) |
| Habit create panel | — | 2266–2329 |
| Habit edit modal | — | 2332–2404 |
| Habit drill-in view | ~1591–1643 | 2407–2509 |

### Notes tool

Dense sub-app with three-pane desktop layout (sidebar + list + editor). CSS roughly 1500–1864.

| Component | Approx CSS | HTML |
|---|---|---|
| Notes sidebar (notebooks tree) | ~1500–1580 | 2156–2177 |
| Note list (middle column) | ~1580–1640 | 2156–2177 |
| Notes editor (right column) | ~1640–1800 | 2156–2177 |
| Note item (list entry) | ~1620–1640 | (dynamic) |
| Mobile notes layout | 1643, 1847, 1853, 1860 | — |

### Scratch tool

| Component | CSS | HTML |
|---|---|---|
| Scratch textarea | (simple — uses base textarea style) | 2148–2154 |

### Auth

| Component | CSS | HTML |
|---|---|---|
| Auth screen overlay | 818–929 | 1871–1911 |
| Auth card | 827–856 | 1871–1911 |
| Google button | 858–871 | 1871–1911 |
| Email form | 881–911 | 1871–1911 |

### Legal / FAQ / confirm / onboarding

Modal-based overlays. Share `.modal-overlay / .modal` styles (lines 627–662). Legal tabs 950–967. Onboarding tooltip + spotlight at z-index 800–802 (classes `.onboard-tooltip`, `.onboard-spotlight`, `.onboard-overlay`).

---

## 4. Layout Patterns Per View

### Tasks view

```
┌─────────────────────────────────┐
│ [Header: logo | switcher | search | avatar]  (navy, fixed, 50px)
├─────────────────────────────────┤
│        [Filter pill bar]         (white card, floating in gray bg)
├─────────────────────────────────┤
│   Section label: STARRED (1)     (uppercase muted, sort dropdown right)
│   [Task item] [Task item]        (white card, 1px border, 8px radius)
│   Section label: TASKS (12)
│   [Task item] [Task item] ...
│   Section label: LATER (3)       (collapsed or expanded)
│   Section label: COMPLETED (7)   (toggle to show)
├─────────────────────────────────┤
│ [Stats bar: 12 active · 7 done]  (navy, fixed bottom, 40px)
└─────────────────────────────────┘
                                    ↑ FAB + (navy square bottom-right)
                                    ↑ Floating search (pill left of FAB)
```

Max content width 720px centered. Scroll is on body.

### Habits view

Same chrome. Content region shows:
- Secondary pill row (Today / Week / Month / Year / Insights) — reuses `.pill-bar` styles
- Today view: habit cards with day-dot row
- Week/Month view: larger cards + score rings
- Year view: heatmap grid per habit
- Insights view: aggregated stats
- Tapping a habit opens `#habitDrillIn` (not a modal — a full-view replacement)

### Notes view

Three-pane desktop layout:

```
┌──────┬─────────┬─────────────────┐
│ side │  list   │  editor         │
│ bar  │  of     │  (ProseMirror-  │
│      │  notes  │   like editor)  │
│ [all]│         │                 │
│ [in] │ [note1] │  # Title        │
│ [f1] │ [note2] │  body body …    │
│ [f2] │  …      │                 │
└──────┴─────────┴─────────────────┘
```

- Sidebar: notebook tree (root + nested folders). 260px.
- List: note titles + snippets + timestamps. ~280px.
- Editor: max 740px. Scrolls independently.
- Mobile: list-only; tap opens full-bleed editor with `.mobile-open` class (z-index 150).

### Scratch view

Single full-width textarea with debounced Supabase sync. No chrome beyond the standard header/nav.

### Auth screen

Centered 380px card over the app (z-index 500). Logo badge + tagline + Google button + divider + email form + legal footer.

---

## 5. Responsive Behavior

**One primary breakpoint: 600px.** Above = desktop; below = mobile.

Key transitions at 600px:
- Header tool switcher → hides; mobile bottom nav appears
- Stats bar → slim-mobile variant at 28px
- FAB bottom offset: 56px → 96/100px (clears slim stats + nav)
- Floating search: 260px-expanded → full-width-minus-82px expanded
- Content padding bottom: 100px → 130px
- Drag handles: hover-only → always visible
- Task actions: hover-only → always visible
- Pill bar: 560px max → 100% width

Notes has extra breakpoints:
- 1080px — sidebar narrows
- 800px — sidebar + list stack or shrink
- 600px — list-only; editor becomes full-bleed overlay

---

## 6. Animations

Defined lines 666–717. All declarative CSS keyframes — no JS-driven animation libraries.

| Name | Duration | Use |
|---|---|---|
| `slideDown` | 0.18s | Task/habit card entry (staggered to 5) |
| `fadeIn` | 0.25s | Section labels, modal overlay |
| `fadeUp` | 0.22s | Modal card entry |
| `checkPop` | 0.25s | Checkbox tick |
| `dotPop` | 0.25s | Habit day-dot toggle |
| `streakPulse` | — | Streak badge |
| `logoSlide` | 0.4s | Logo entry on mount |
| `toastIn` | 0.3s | Error toast slide-in |
| `blink` | 1.5s infinite | Sync error dot pulse |

---

## 7. Z-Index Stack (from brand framework §10, verified)

```
900  #confirmDialog
802  #onboardTooltip
801  #onboardSpotlight
800  #onboardOverlay
600  #legalModal, #faqModal
500  #authScreen
400  .user-dropdown
300  .mobile-bottom-nav
295  .mobile-slim-stats
250  .fab (mobile)
200  .modal-overlay, header (fixed)
150  .notes-editor.mobile-open
100  .error-toast
 90  .stats-bar (desktop)
 50  .fab (desktop)
  0  .pill-bar (normal flow)
```

Reskin must preserve this stack — any new overlay/floating UI must slot in without crossing existing layers.

---

## 8. What Is and Isn't In Scope

**In scope for "reskin":**
- Any CSS in `:root` or inline style blocks (visual tokens, shadows, radii, surfaces)
- Non-structural HTML tweaks if a new component needs extra nodes (e.g. wrapping a card)

**Out of scope for reskin (would break behavior or backend contracts):**
- Supabase schema, auth flow, sync logic
- JS event handling, state management, render functions
- Class names referenced from JS (see [RESKIN_PLAN.md](RESKIN_PLAN.md) risk list)
- Feature set, keyboard shortcuts, data model
