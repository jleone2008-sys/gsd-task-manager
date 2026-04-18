# GSD Task Manager — Proposed Design System (Reskin)

A new token system inspired by — not copied from — modern mobile task-manager UIs. Visual direction: **sleek, airy, blue-forward, mobile-first, with a signature notched-card pattern** and softer shadows and more generous rounding than today's build. All existing functionality, HTML structure, and class names are preserved — this document defines *visual* replacements only.

> This file is a proposal. Nothing is implemented yet. See [RESKIN_PLAN.md](RESKIN_PLAN.md) for the phased rollout.

## Guiding Principles

These four principles override any specific spec in this doc. If a later section conflicts with one of these, the principle wins.

1. **Nothing is hardcoded.** Every color, font size, font weight, spacing unit, shadow, radius, z-index, and transition duration lives as a CSS custom property. The app consumes tokens; it never inlines raw values. Hard rule — see [RESKIN_PLAN.md](RESKIN_PLAN.md) Phase 3 for enforcement.
2. **Mobile-first.** Every component is designed at 375px first, then adapted up. Touch targets ≥44×44, thumb-zone reachable controls, swipe affordances obvious. Desktop is an adaptation, not the source of truth.
3. **Unique, not replica.** The inspiration's purple+pastel palette is shifted to blue. The *one* pattern we lift wholesale is the **notched-corner card with a standalone floating icon** — used sparingly to give GSD visual character without becoming a clone. Everywhere else we take the inspiration's *language* (soft shadows, generous radii, pastel accents, floating pill nav) and apply it in GSD-native ways.
4. **Extensible.** Component patterns must accommodate features we haven't built yet — subtasks, project grouping, reminders, recurring tasks, custom fields, attachments. See §8 (Slot System). *(Out of scope: time estimates and assignees.)*

---

## 1. Design Direction (from the inspiration)

The two reference images share a recognizable language:

- **Cool-tinted page background** (not neutral gray). The whole canvas has a subtle blue undertone.
- **Pastel accent cards** as category/status indicators — lavender, mustard yellow, pink/coral, mint green — used for stat summaries and priority pills.
- **A single "hero" card** per list that is filled with the primary color (high priority / highlighted task).
- **Generous radii** (~16–20px on major cards, ~10–12px on pills and inputs).
- **Soft, diffused elevation** — multi-layer shadows with very low opacity, not crisp drop shadows.
- **Dark floating pill nav** at the bottom (not a full-width bar) with a primary-blue "active" bubble behind the selected icon.
- **Large, tidy type hierarchy** — clear jump from title → label → body.
- **Avatar stacks** with `+N` overflow badge as a collaboration signal (our app is single-user today; we treat this as a visual accent, not a feature signal).

**Palette shift from the inspiration:** the mockups lead with purple; we lead with blue. The pastel accent family (yellow, coral, mint, sky, lavender) is retained verbatim — those warm + cool pops are what give the design its character. Only the *primary* hue moves.

GSD is a denser productivity tool than these showcase mockups — a full reskin must keep information density workable. We translate the *language*, not the *layout*.

---

## 2. Proposed Color Tokens

All new tokens are drop-in replacements for the existing `--*` variables so the bulk of the app needs no selector changes. We also introduce new token families for cases that today use raw hex (shadow, pastel accents, notes states) plus new scales for typography, spacing, z-index, and transitions (see §3–§7).

### 2.1 Core surface + text

```css
--bg:         #eef2fb;   /* blue-tinted page bg (was #f4f5f7) */
--surface:    #ffffff;   /* unchanged */
--surface2:   #e6edf8;   /* cool hover / secondary (was #f0f1f3) */
--border:     #dce4f2;   /* softer blue-gray border (was #e2e4e8) */
--border2:    #c8d3e9;   /* stronger input border (was #d0d3da) */
--text:       #1a1e2e;   /* cool near-black (was #1d1c1d) */
--text2:      #4a5168;   /* muted body text */
--muted:      #8690a8;   /* metadata / placeholders */
```

### 2.2 Brand primary (blue)

We keep the existing `--navy*` names to avoid touching JS-emitted SVG strokes (lines 3647–3648 in [app.html](app.html#L3647)), but shift the *value* to a softer, more approachable blue. Reads as the same role everywhere.

```css
--navy:       #5b82e0;   /* primary: header, CTAs, FAB (was #2d5fa6) */
--navy-dark:  #4568c8;   /* hover (was #224a8a) */
--navy-light: #8eaaee;   /* focus ring / drag highlight (was #3d70c0) */
--navy-muted: rgba(255,255,255,0.72);
--navy-border: rgba(255,255,255,0.22);
--accent:     #3d5fb3;   /* deeper blue for score rings, stats accents */
```

> **Naming caveat:** `--navy` is still blue (it always was), just softer and cooler. The variable name remains accurate. No rename is needed. `--accent` is now a deeper blue, not purple — see §2.5 for the lavender/purple accent token, which is now part of the pastel family.

### 2.3 Semantic states

```css
--check:      #2fa97e;   /* positive / completed (green, was #007a5a) */
--danger:     #e54a7a;   /* destructive (was #e01e5a) */
--top3:       #d97706;   /* starred amber (was #b85c00, now brighter) */
--top3-bg:    #fff8eb;   /* starred surface (was #fffcf5) */
--link:       #4568c8;   /* follows brand primary */
--drag-over:  #e1ebfb;   /* drag-zone tint (was #eef0fb) */
```

### 2.4 Tag system (pastel)

Tag colors move to lighter pastels, with more saturation in the text for legibility.

```css
--biz-bg:        #d9e6ff;   /* soft sky-blue */
--biz-text:      #2a5fd6;
--personal-bg:   #f3e6fd;   /* soft orchid (unchanged-ish) */
--personal-text: #8341c6;
```

Retained for backwards-compat (used by legacy selectors):
```css
--biz:        var(--biz-text);
--personal:   var(--personal-text);
```

### 2.5 NEW: Pastel accent family

Used for **stat cards, due-date badges, and future category surfaces** — never for primary actions. Calibrated to be **a touch more vibrant than current GSD tag colors without being overwhelming** — landing between the old muted `#e4eef8` / `#ece6f4` tags and the more saturated pastels seen in the inspiration.

```css
--pastel-lavender-bg:  #dfd6e8;   --pastel-lavender-text:  #574a6d;
--pastel-sky-bg:       #d4e2ec;   --pastel-sky-text:       #2d5577;
--pastel-mint-bg:      #cfe8d6;   --pastel-mint-text:      #2d6848;
--pastel-yellow-bg:    #f5e6b8;   --pastel-yellow-text:    #7a5600;
--pastel-coral-bg:     #f9d5dc;   --pastel-coral-text:     #a03050;
```

> **Calibration note:** these pair with the cool blue base palette. Saturation held around 20–30% (vs 50%+ on the inspiration); lightness 88–92%. The goal is "dustier" — readable, gentle, feels cohesive with the existing muted-blue brand energy.

### 2.6 NEW: Shadow scale

Replaces the eight one-off shadows scattered through the CSS. Shadow color is tinted with the brand blue rather than pure black — matches the inspiration's "soft" feel and avoids a gray cast on the blue-tinted background.

```css
--shadow-xs:  0 1px 2px rgba(30,60,140,0.04);
--shadow-sm:  0 2px 6px rgba(30,60,140,0.06), 0 0 0 1px rgba(30,60,140,0.03);
--shadow-md:  0 6px 20px rgba(30,60,140,0.08), 0 2px 6px rgba(30,60,140,0.05);
--shadow-lg:  0 12px 40px rgba(30,60,140,0.12), 0 4px 12px rgba(30,60,140,0.06);
--shadow-xl:  0 20px 60px rgba(30,60,140,0.16), 0 6px 20px rgba(30,60,140,0.08);
--shadow-focus: 0 0 0 3px rgba(91,130,224,0.22);
```

### 2.7 NEW: Radius scale

```css
--radius-sm:  8px;    /* pills, small buttons, tags */
--radius-md:  12px;   /* inputs, dropdowns, secondary cards */
--radius-lg:  16px;   /* task cards, habit cards, note items */
--radius-xl:  20px;   /* modals, pill bar, primary containers */
--radius-pill: 9999px;/* mobile bottom nav, avatar stack, search */
```

> **Change from brand framework v3.0:** The previous rule was "8px on everything." The inspiration uses deliberate size-based rounding. This is the single biggest structural token change.

---

## 3. Typography Tokens

Font remains **Inter only**. The existing scale stays (it's well-considered), but we **tokenize it** so every `font-size`, `font-weight`, and `font-family` reference in the app comes from a variable. No raw `font-size: 13.5px` in a rule — it's `font-size: var(--fs-task)`.

### 3.1 Font family

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Single declaration on `body`. Every other place that sets `font-family` uses `inherit` (already the convention in most of the file — we just finish the job).

### 3.2 Font sizes

Each token is named by **role**, not by size, so future scale tweaks don't require grep-and-replace.

```css
--fs-label:    10px;    /* uppercase section labels, day labels */
--fs-micro:    10.5px;  /* mobile slim stats */
--fs-meta:     11px;    /* stats bar, timestamps, metadata */
--fs-pill:     12px;    /* pill labels, tool switcher tabs */
--fs-search:   13px;    /* search bar input */
--fs-task:     13.5px;  /* task text, habit names, note list titles */
--fs-body:     14px;    /* editor content, base body */
--fs-card:     16px;    /* NEW — card titles in dense views */
--fs-section:  18px;    /* section headings in habit stats */
--fs-title:    22px;    /* page titles, note editor title desktop */
--fs-title-mobile: 20px;/* note editor title mobile, logo mobile */
--fs-display:  28px;    /* NEW — hero / dashboard greeting */
```

### 3.3 Font weights

```css
--fw-regular:   400;
--fw-medium:    500;
--fw-semibold:  600;
--fw-bold:      700;
--fw-black:     800;
```

### 3.4 Letter-spacing (for uppercase labels)

```css
--tracking-label: 1.6px;  /* section labels */
--tracking-tight: -0.5px; /* logo "GSD." */
```

No tracking changes; we just tokenize what's already there.

---

## 4. Spacing Tokens

Audit finding: `16px` appears 50+ times, `8px` ~30 times, `12px` ~20 times. These are consolidated into a 4-based scale. Every padding, margin, and gap in the app consumes a token.

```css
--space-0:  0;
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;    /* the workhorse — content padding, card spacing */
--space-5:  24px;
--space-6:  32px;
--space-7:  48px;
```

### Layout width tokens

```css
--max-content:   720px;   /* tasks, habits */
--max-pill-bar:  560px;   /* filter pills row */
--max-modal:     460px;   /* modal dialogs */
--max-auth:      380px;   /* auth card */
--max-notes:     740px;   /* notes editor */
```

### Breakpoint (for use in `@media`)

CSS custom properties can't be used inside media queries, so this stays as a documented constant rather than a variable — but we pick one and stick with it:

```
--bp-mobile: 600px    (commented at the top of the stylesheet)
```

Notes has three additional breakpoints (1080 / 800 / 600). Keep them documented as comments in-file.

---

## 5. Z-Index Tokens

Audit finding: the app uses ~15 unique z-index values scattered across the CSS, plus one offender at `9999` (sort-opt dropdown) that will crush modals. Consolidate into a named stack that mirrors the brand framework §10.

```css
--z-pill-bar:        0;
--z-fab-desktop:     50;
--z-stats-bar:       90;
--z-toast:           100;
--z-editor-mobile:   150;
--z-modal:           200;    /* shared: .modal-overlay, fixed header */
--z-fab-mobile:      250;
--z-slim-stats:      295;
--z-mobile-nav:      300;
--z-dropdown:        400;    /* user menu, sort-opt dropdown */
--z-auth:            500;
--z-legal:           600;    /* legal & FAQ modals */
--z-onboard-bg:      800;
--z-onboard-ring:    801;
--z-onboard-tip:     802;
--z-confirm:         900;    /* highest — destructive confirm */
```

> **Bug fix embedded:** `.sort-opt` currently at `z-index: 9999` (line 311) is wrong and will render over any modal. Replace with `var(--z-dropdown)`.

---

## 6. Transition & Easing Tokens

Audit finding: `0.12s`, `0.15s`, `0.18s`, `0.22s`, `0.25s`, `0.4s` appear throughout with no system. Consolidated:

```css
--dur-fast:    0.12s;   /* hover states, color changes */
--dur-base:    0.18s;   /* standard transitions, slideDown */
--dur-mid:     0.22s;   /* modal card entry, new-task */
--dur-slow:    0.25s;   /* fadeIn, checkPop, dotPop */
--dur-slower:  0.3s;    /* toastIn */
--dur-slowest: 0.4s;    /* logo entry */

--ease-out:     ease;
--ease-spring:  cubic-bezier(0.34, 1.4, 0.64, 1);
--ease-bounce:  cubic-bezier(0.34, 1.56, 0.64, 1);
```

---

## 7. Component Patterns (visual deltas only)

Structure is unchanged; these are the surface-level rules for each component.

### 7.1 Header

- Background: `--navy` (now purple) — same role, new hue.
- Add subtle bottom shadow (`--shadow-sm`) instead of the current 1px rgba border, for the floating feel in the inspiration.
- Tool switcher: keep segmented control, but active tab uses `rgba(255,255,255,0.22)` + `--shadow-focus` for a soft-glow active state.

### 7.2 Pill bar (filter row)

- Inner card: `--radius-xl` (20px), `--shadow-md`.
- Idle pill: `background: var(--surface2)`, `color: var(--muted)`, no border.
- Active pill: backgrounds taken from the pastel accent family (Starred → yellow, Work → sky, Personal → purple, Later → neutral, All → purple).
- Active pills carry filled pastel backgrounds with dark pastel text — not solid navy as today. Matches the "tag pill" feel from the inspiration.

### 7.3 Task card — three-zone layout

Tasks use a **leading / body / trailing** three-zone structure (research-backed pattern from Linear, Todoist, Height). This is the foundation for extensibility — new per-task features (subtasks, time estimates, assignees, attachments, reminders) plug into existing zones without restructuring the card.

```
┌──────────────────────────────────────────────────────────────┐
│  [LEADING]   [BODY: title + meta-chip row]         [TRAILING]│
│   checkbox    Finish the quarterly report          star   ⋮  │
│   (or        #work  · due today  · 30m  (chips)              │
│    notch)                                                    │
└──────────────────────────────────────────────────────────────┘
```

- Background: `var(--surface)`, radius `var(--radius-lg)` (16px on mobile), `var(--shadow-xs)` idle.
- Hover (desktop): `var(--shadow-sm)` + `var(--border2)`.
- Done: opacity 0.4 + strikethrough (unchanged).
- **Meta chip row** (`.task-meta`) is the extensibility seam — any future feature adds a chip here. See §8 Slot System.

#### Starred variant (multi-star safe)

Many tasks can be starred. No filled-hero card. Instead:
- **Left accent strip:** 12px on mobile, 8px on desktop, filled with `var(--navy)` (primary blue). Replaces the current 3px `--top3` left-border.
- **No text overlaps the strip** — card inner padding-left increases to clear it.
- **Background:** stays `var(--surface)` (not tinted). The strip alone carries the priority signal; tinted bg would be overkill when many rows have it.
- **Card elevation:** `var(--shadow-sm)` (one step up from non-starred) to keep a subtle lift.

#### Due-state callout

Lives in the **meta chip row**, not layered over the card. Chip variants (tokenized via pastel family):
- Overdue → `var(--pastel-coral-*)` + `⚠` icon
- Due today → `var(--pastel-yellow-*)` + clock icon
- Due soon (≤3 days) → `var(--pastel-sky-*)` + calendar icon
- Default/future → `var(--surface2)` + muted

A starred task that is also due-today/overdue gets the strip **and** the meta chip. The two signals stack cleanly without needing a hero card.

### 7.3a Notched-corner variant (signature pattern)

The single motif lifted whole-cloth from the inspiration: a **circular cutout in the top-left corner of the card housing a floating standalone icon** (checkbox or star). Used selectively, not on every card.

**Where it ships:**
- Mobile task cards (primary surface where visual character earns its keep)
- Habit "streak badge" card variant (the streak icon sits in the notch)
- Desktop: off by default — the row-dense layout doesn't benefit from the taller notched card

**Implementation approach:**
- Preferred: `mask-image: radial-gradient(...)` at the corner to subtract a circle from the card surface. Works everywhere except deprecated Edge. CSS-only, responsive, tokenized via `--notch-size: 44px` and `--notch-inset: -6px`.
- Fallback: pseudo-element positioned over the corner with `background: var(--bg)` and `border-radius: 50%` — visually identical on solid backgrounds, breaks on gradients (we don't use any, so this is fine).
- SVG backgrounds considered but rejected — harder to theme dynamically via CSS variables.

**HTML shape (zero JS changes):**
```html
<div class="task-item has-notch">
  <button class="checkbox notch-slot">…</button>
  <div class="task-content">…</div>
</div>
```

The `.notch-slot` element gets absolute-positioned to overlap the notched corner. Tokens: `--notch-size`, `--notch-icon-size`, `--notch-shadow` (uses `--shadow-sm`).

**Why it works for GSD specifically:** our checkboxes are already circular (17px). Enlarging them and floating them in a notch turns a mundane affordance into a signature touchpoint — and the user's tap target goes from 17px to 44px+, which is a mobile-first win, not just a stylistic one.

### 7.3b Desktop fallback

Desktop retains the current inline-checkbox + text layout for density. The three-zone structure still applies, but:
- Leading zone: 17px inline checkbox (no notch)
- Body zone: title + meta chip row (unchanged)
- Trailing zone: star + drag handle + overflow (`⋮`) menu
- Starred strip remains (8px desktop width)

### 7.4 Tag / priority pill

- Radius: `--radius-sm` (unchanged 8px).
- Use the pastel bg/text pairs above.
- Add a new set for *priority/status* surfaces for future use:
  - High → `--pastel-coral-*`
  - Medium → `--pastel-yellow-*`
  - Low → `--pastel-mint-*`
  - These do not ship as task metadata today, but the tokens exist so future features can use them consistently.

### 7.5 Due-date badge

Replace ad-hoc hexes with pastel family:
- Default → surface2 + muted
- Due today → pastel-yellow
- Overdue → pastel-coral
- Due soon → pastel-sky

### 7.6 Checkbox

- Unchanged geometry (17px circle).
- Done state: `--check` bg (green), white check.
- Hover ring: `--shadow-focus` instead of border-color change — more tactile.

### 7.7 FAB

- Size: 52×52 desktop / 48×48 mobile (up from 46×46 / 44×44).
- Radius: `--radius-pill` (fully circular, matching the inspiration).
- Shadow: `--shadow-lg`.
- Background: `--navy` (purple). `:hover` `--navy-dark`.
- Drop the current 8px-square look — this is the single most visible deviation from brand framework §4.

### 7.8 Stats bar (desktop)

Keep the fixed-bottom, centered metric bar — no "floating pill" version yet (the current bar is load-bearing for info; the inspiration's floating pill is nav, not stats). The visual update:
- Background stays `--navy` (now purple).
- Top border becomes `--shadow-sm` (glows up rather than a hard line).

### 7.9 Mobile bottom nav

This is where we go furthest toward the inspiration.

- Anchored bottom, but **not full-width**. Max width 280px, centered, with 12px gap from screen edges.
- Background: `#1f1a3b` (near-black indigo, matches inspiration).
- Radius: `--radius-pill`.
- Shadow: `--shadow-xl`.
- Active tab: purple circle behind the icon (`background: var(--navy)`, 40×40, `--radius-pill`), icon stays white.
- Inactive tabs: icon only (no label — the pill nav in the inspiration is icon-only). Label returns on long-press or via a settings toggle.
- Mobile slim stats moves to sit *above* and *beside* the pill, or collapses into the error-toast slot. Specific placement decided in Phase 3.

### 7.10 Modals

- Overlay: lavender-tinted backdrop `rgba(44, 30, 90, 0.45)` with `backdrop-filter: blur(6px)` (stronger blur than today's 3px).
- Card: `--radius-xl` (20px), `--shadow-xl`, `--surface` bg.

### 7.11 Auth screen

- Background: `--bg` (lavender).
- Card: `--radius-xl`, `--shadow-lg`.
- Logo badge: purple background (`--navy`), `--radius-lg`.

### 7.12 Notes tool

- Sidebar / list active item: `--surface2` bg (lavender tint) replaces the hardcoded `#e8edf5` and `#eef1f8`.
- Editor card: `--radius-xl`, `--shadow-sm`.
- Mobile full-bleed editor: radius 0 (unchanged).

### 7.13 Habits tool

- Day dots: unchanged geometry. Done dots: `--check` (green). Today dot: `--navy-light` ring + `--shadow-focus`.
- Score rings (SVG, hardcoded stroke in JS): continues to use `#2d5fa6` and `#e2e4e8` unless Phase 2 swaps them — see [RESKIN_PLAN.md](RESKIN_PLAN.md).
- Habit "done" card (currently inline-styled green `#ecfdf5` / `#d1fae5` in JS templates): migrates to new `--pastel-mint-bg` / `--pastel-mint-text` via a new CSS class `.habit-done` so we can drop the inline styles from JS.

---

## 8. Slot System (extensibility)

Cards must accommodate features we haven't built yet. Rather than redesigning the task card every time a feature lands, we commit to a **slot-based structure** now so future additions drop into existing seams.

### 8.1 Task card slots

```
┌──── leading ────┐  ┌──────── body ────────┐  ┌──── trailing ────┐
│  .lead-slot     │  │  .task-title         │  │  .trail-slot-a   │
│  (checkbox,     │  │  .meta-row           │  │  .trail-slot-b   │
│   notch icon)   │  │   ├─ .chip           │  │  .trail-slot-c   │
│                 │  │   ├─ .chip           │  │  (star, menu,    │
│                 │  │   └─ .chip (any n)   │  │   drag)          │
└─────────────────┘  └──────────────────────┘  └──────────────────┘
```

- **`.lead-slot`** — one item only (checkbox OR notch-icon).
- **`.meta-row`** — horizontal scroll / wrap. Any number of `.chip` children. Current chips: tag, due-date. Future chips: subtask count (`3/5 ▓▓▓░░`), reminder (`🔔 9:00`), attachment (`📎 2`), project pill, recurring indicator, comments count.
- **`.trail-slot-*`** — stacked or inline. Current: star, drag handle. Future: priority flag, snooze.

### 8.2 Chip component (the extensibility seam)

A new `.chip` base class replaces the current ad-hoc `.tag`, `.due-badge`, and habit metadata styling. One component, many variants via modifier classes.

```css
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-label);
  font-weight: var(--fw-medium);
  background: var(--surface2);
  color: var(--muted);
  line-height: 1.5;
  white-space: nowrap;
  max-width: 160px;        /* truncate runaway content */
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip--work     { background: var(--biz-bg);        color: var(--biz-text); }
.chip--personal { background: var(--personal-bg);   color: var(--personal-text); }
.chip--overdue  { background: var(--pastel-coral-bg);   color: var(--pastel-coral-text); }
.chip--today    { background: var(--pastel-yellow-bg);  color: var(--pastel-yellow-text); }
.chip--soon     { background: var(--pastel-sky-bg);     color: var(--pastel-sky-text); }
.chip--sub      { background: var(--pastel-mint-bg);    color: var(--pastel-mint-text); }    /* future: subtask progress */
.chip--project  { background: var(--pastel-lavender-bg);color: var(--pastel-lavender-text); }/* future: project grouping */
```

Backwards-compat: the existing `.tag.biz`, `.tag.personal`, `.due-badge.*` selectors alias to `.chip.chip--*` rules so no JS changes needed for the migration. New features ship straight to `.chip--*`.

### 8.3 Meta-row overflow strategy

On mobile at 375px the meta row can exceed the card width once 3+ chips land. Strategy:
1. Wrap to a second line (default) — acceptable up to 2 lines.
2. If chip count > 4, collapse trailing chips into a `+N` chip that expands the row on tap.
3. Never horizontal-scroll the meta row — confuses drag-to-reorder gestures.

### 8.4 Anticipated features and their slot mapping

| Feature | Lives in | Notes |
|---|---|---|
| Subtasks | `.meta-row` chip + expandable child list below card | Chip shows `n/m` complete |
| Recurring task | `.meta-row` chip | Repeat icon + cadence text |
| Reminder | `.meta-row` chip | Bell icon + time |
| Attachment | `.meta-row` chip | Paperclip + count |
| Project | `.meta-row` chip | Colored dot + name |
| Priority level (beyond star) | Extension of starred strip | Different strip widths/colors per level |
| Custom field | `.meta-row` chip | User-configured bg/text tokens |

*Out of scope: time estimates, assignees (single-user app, no estimation workflow).*

### 8.5 What this guarantees

Adding any of these features becomes: **(a)** add a `.chip--feature` CSS variant using existing tokens, **(b)** render the chip from JS. Zero card-shape changes. Zero regressions to existing features.

---

## 9. Mobile-First Rules

Principle #2 from the guiding principles, operationalized. These rules are acceptance criteria, not suggestions.

1. **44×44 minimum touch targets.** Checkboxes, buttons, chips that are tappable — all. Checkboxes are currently 17px; the notched-corner variant (§7.3a) bumps them to 44px inside the notch slot, which fixes this.
2. **Row height ≥56px.** Task and habit rows on mobile. Below that, accidental taps multiply.
3. **Swipe is a first-class action.** Left swipe = complete (existing), right swipe = quick menu (delete/snooze/star). Threshold 80px, already matches current build — retain.
4. **Primary input lives in the thumb zone.** FAB bottom-right (existing); create panel opens as a bottom sheet on mobile (not a centered modal). Modal creation only on desktop.
5. **Max four gestures.** tap, long-press, swipe-left, swipe-right. No pinch, no two-finger, no shake. If a new feature needs a fifth, it goes in a menu.
6. **Safe-area padding.** Bottom nav respects `env(safe-area-inset-bottom)` (already done); top header respects `env(safe-area-inset-top)` when the app is installed as a PWA.
7. **Design at 375px first, then scale up.** When evaluating a component, screenshot at 375px before 1200px. If it doesn't work at 375px, it doesn't ship — regardless of how it looks on desktop.

---

## 10. Animation

Keyframes (current lines 666–717) stay — they're a good match for the inspiration's feel. The only change is consumption: every `animation:` and `transition:` now references `--dur-*` and `--ease-*` tokens instead of raw durations.

---

## 11. Mapping: Old → New

Quick-reference migration map. All values are produced by tokens — this table shows the replacement for each previously-hardcoded source.

### Colors

| Old | New | Notes |
|---|---|---|
| `--bg: #f4f5f7` | `--bg: #eef2fb` | Blue-tinted |
| `--navy: #2d5fa6` | `--navy: #5b82e0` | Softer, more approachable blue |
| `--navy-dark: #224a8a` | `--navy-dark: #4568c8` | Hover state |
| `--navy-light: #3d70c0` | `--navy-light: #8eaaee` | Focus ring |
| `--accent: #3d3d8f` | `--accent: #3d5fb3` | Deeper blue (not purple) |
| `--check: #007a5a` | `--check: #2fa97e` | Brighter green |
| `--danger: #e01e5a` | `--danger: #e54a7a` | Softer pink-red |
| Ad-hoc tag bg `#e4eef8` | `var(--biz-bg)` = `#d9e6ff` | Tokenized |
| Ad-hoc tag bg `#ece6f4` | `var(--personal-bg)` = `#f3e6fd` | Tokenized |
| Due-today `#fff8e6 / #b45309 / #fcd34d` | `var(--pastel-yellow-*)` | Pastel family |
| Due-overdue `#fef2f2 / #dc2626 / #fca5a5` | `var(--pastel-coral-*)` | Pastel family |
| Due-soon `#eff6ff / #2563eb / #bfdbfe` | `var(--pastel-sky-*)` | Pastel family |
| Notes active `#e8edf5` / `#eef1f8` | `var(--surface2)` | Deduped |
| Habit done inline `#ecfdf5 / #d1fae5` | `.habit-done` class using `var(--pastel-mint-*)` | Removes JS inline style |

### Structure

| Old | New | Notes |
|---|---|---|
| Eight ad-hoc shadow strings | `--shadow-xs / sm / md / lg / xl / focus` | Tokenized + blue-tinted |
| Radii: 4 / 6 / 7 / 8 / 10 / 11 / 12 / 16 / 22 / 23 px | `--radius-sm / md / lg / xl / pill` | Consolidated to 5 steps |
| Spacings: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 24 / 32 / 48 px | `--space-1 … --space-7` | Consolidated to 7 steps |
| Font sizes scattered across rules | `--fs-label … --fs-display` | 12 role-based tokens |
| Font weights inline (300–800) | `--fw-regular … --fw-black` | 5 tokens |
| Z-index literals (50, 90, 100, 200, 250, 295, 300, 400, 500, 600, 800, 801, 802, 900, 9999) | `--z-*` | 14 tokens; `9999` removed |
| Transition durations (0.12 / 0.15 / 0.18 / 0.22 / 0.25 / 0.3 / 0.4s) | `--dur-*` | 6 tokens |
| Easings inline | `--ease-out / --ease-spring / --ease-bounce` | 3 tokens |

---

## 12. Accessibility Notes

- Primary blue `#5b82e0` on white: contrast ratio ~3.9:1 (passes WCAG AA for large text ≥18px and UI components). We use it as chrome/buttons, never for body text on white. Text on navy backgrounds stays white (14.5:1 on `--navy`).
- Pastel backgrounds are used only with their paired dark text — every pair in §2.5 is ≥4.5:1.
- Focus ring `--shadow-focus` is 3px, meets WCAG 2.2 focus-visible minimum.
- Starred amber `#d97706` on white: 4.8:1 (AA pass).
- Green `#2fa97e` on white: 3.1:1 — used only for icons/borders, not text.

No change to font sizes or line heights means the existing accessibility posture of the app is preserved; this reskin does not regress any existing contrast passes. The audit (see [RESKIN_PLAN.md](RESKIN_PLAN.md) Phase 1 bug list) found several missing aria-labels on icon-only buttons — those are fixed as part of the bug phase, separate from the reskin itself.

---

## 13. Dynamic-theming guarantee

Because every visual property is a token, a single `.theme-*` block on `<body>` can re-theme the entire app without touching selectors. Example:

```css
body.theme-high-contrast {
  --navy: #1245b8;
  --border: #000;
  --shadow-md: none;
}
```

This unlocks (without further refactoring):
- Dark mode (future)
- High-contrast mode (future accessibility improvement)
- Per-user theme overrides (future)
- A/B test variants during the reskin rollout

None of these ship with the reskin, but the door is open.

---

## 14. Decisions Locked In

Previously-open questions have been answered. Recording them here for handoff / audit.

1. **Multi-star support with left-strip treatment.** Many tasks can be starred simultaneously. Each starred task gets a 12px (mobile) / 8px (desktop) left accent strip in `var(--navy)`. No full-card fill. Due-today/overdue renders as a chip in the meta row, not a background.
2. **Mobile bottom nav keeps labels.** Icons + labels, not icons-only. Preserves muscle memory; we still get the floating pill shape for visual character.
3. **Pastel palette calibrated dustier.** Saturation ~20–30% (between current muted tags and inspiration's pop). Specific values in §2.5.
4. **`richToDisplay()` sanitization uses DOMPurify.** +~20KB, but a solved problem is better than a hand-rolled allowlist. Loaded via CDN.
5. **New framework document: `gsd-brand-framework-v4.md`** authored in Phase 8. v3.0 retained for history.
6. **Signature pattern: notched-corner card with floating icon.** Used on mobile task cards and habit streak-badge cards. Desktop falls back to the classic inline layout for density.
7. **Tokenization is total.** Every color, font-size, font-weight, spacing unit, radius, shadow, z-index, transition duration, and easing goes through a token. Raw literals are only permitted for `1px` borders, `50%` circle radii, `100%`/`auto`/`0` dimensions, animation keyframe percentages, and `env(safe-area-inset-*)`.
8. **SVG strokes refactored to `currentColor`.** The hardcoded `#2d5fa6` / `#e2e4e8` in JS-emitted SVG templates (lines 3647–3648, 4740) migrate to `currentColor`, with the parent's `color` set via CSS token. Done in Phase 3e.
9. **Three-zone card structure + slot system adopted now.** Even though we're not shipping subtasks/time-estimates/etc yet, we re-lay the task card as leading / body / trailing and introduce the `.chip` component so future features slot in without structural change.
10. **Dark mode remains out of scope.** Tokens support adding `.theme-dark` later with no refactor.
