/* ══════════════════════════════════════════════════════════════
   PILL BARS — single source of truth for every subtab pill row.

   Every tab (Tasks / Habits / Insights / Train) has the same shape:
   a .pill-bar > .pill-bar-inner row inside the topbar. Historically
   each one was hand-rolled in app.html with slightly different
   markup; this file rebuilds all four from one config so:

     1. The visuals stay consistent (every bar inherits the base
        .pill / .pill.active chrome — the "Train style").
     2. Adding/removing/renaming a pill is one config edit, not a
        DOM hunt across multiple files.
     3. The data-attribute contract per tab is preserved (Tasks
        uses data-filter, Habits data-habit-view, etc.) so the
        existing click handlers in the per-tab JS keep working
        without changes.

   The config is intentionally co-located so the next person editing
   pill labels finds everything in one place.

   Loaded as a classic script before the per-tab JS in app.html,
   wrapped in an IIFE to keep state out of window. The render fires
   on DOMContentLoaded.
══════════════════════════════════════════════════════════════ */

(function () {
  // ── Config — every pill bar listed here ───────────────────────
  // Per-bar shape:
  //   selector   — DOM selector for the .pill-bar (used by the
  //                renderer to find the .pill-bar-inner inside).
  //   dataKey    — name of the data-attribute that carries the
  //                view key on each pill (kept per-bar so existing
  //                handlers don't need to change).
  //   pills      — ordered list of { key, label, default?, count?,
  //                extraClass?, icon? } entries. `count` is the id
  //                of the span element that shows the count badge;
  //                if present, an empty <span> is emitted with that
  //                id and per-tab JS fills it in. `default: true`
  //                marks the initially-active pill.
  //                `icon` is the inner SVG markup (paths/polylines)
  //                rendered inside a wrapper <svg class="train-pill-icon">.
  // Inline-SVG icon library used across every pill bar. Sized to 14×14
  // via the .train-pill-icon CSS rule (in 06-train.js), inherits
  // currentColor so it flips white when the pill goes active.
  const ICONS = {
    // Tasks: checklist
    tasks:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    // Habits: repeat / cycle
    habits:   '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    // Statistics: bar chart
    stats:    '<rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/>',
    // Knowledgebase: book
    book:     '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    // Patterns: trending-up
    patterns: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    // Weekly Brief: calendar
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    // Train pills
    dumbbell: '<rect x="2" y="8" width="3" height="8" rx="1"/><rect x="19" y="8" width="3" height="8" rx="1"/><rect x="5" y="10" width="2" height="4"/><rect x="17" y="10" width="2" height="4"/><line x1="7" y1="12" x2="17" y2="12"/>',
    clock:    '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><polyline points="12 7 12 12 15 14"/>',
    pulse:    '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  };

  const PILL_BARS = [
    {
      selector: '.pill-bar[data-tool-view="tasks"]',
      dataKey:  'data-filter',
      pills: [
        { key: 'all',   label: 'Tasks',      default: true, count: 'pc-all', icon: ICONS.tasks },
        { key: 'stats', label: 'Statistics', icon: ICONS.stats },
      ],
    },
    {
      selector: '.pill-bar.habit-sub-pills',
      dataKey:  'data-habit-view',
      pills: [
        { key: 'today', label: 'Habits',     default: true, count: 'pc-habit-today', extraClass: 'habit-pill', icon: ICONS.habits },
        { key: 'stats', label: 'Statistics', extraClass: 'stat-pill', icon: ICONS.stats },
      ],
    },
    {
      selector: '.pill-bar.insights-sub-pills',
      dataKey:  'data-insights-view',
      pills: [
        { key: 'timeline', label: 'Knowledgebase', default: true, extraClass: 'insights-pill', icon: ICONS.book },
        { key: 'patterns', label: 'Patterns',                    count: 'insightsPatternsCount', countClass: 'insights-pill-count', extraClass: 'insights-pill', icon: ICONS.patterns },
        { key: 'weekly',   label: 'Weekly Brief',                 extraClass: 'insights-pill', icon: ICONS.calendar },
      ],
    },
    {
      // NB: subtab pills don't carry the 'train-pill' class — that
      // class is taken by the coach-traits content badge style in
      // 06-train.js (small caps, pill-shaped, no border) and was
      // bleeding into the subtab bar. .pill + .train-sub-pills is
      // enough to scope the click handler.
      selector: '.pill-bar.train-sub-pills',
      dataKey:  'data-train-view',
      pills: [
        { key: 'progress', label: 'My Progress', default: true, icon: ICONS.pulse },
        { key: 'workout',  label: 'Workout',     icon: ICONS.dumbbell },
        { key: 'history',  label: 'History',     icon: ICONS.clock },
      ],
    },
  ];

  // ── Render helpers ────────────────────────────────────────────
  function renderPill(pill, dataKey) {
    const cls = ['pill'];
    if (pill.extraClass) cls.push(pill.extraClass);
    if (pill.default) cls.push('active');
    const iconHTML = pill.icon
      ? `<svg class="train-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pill.icon}</svg>`
      : '';
    const countCls = pill.countClass || 'pill-count';
    const countHTML = pill.count
      ? `<span class="${countCls}" id="${pill.count}">0</span>`
      : '';
    return `<button class="${cls.join(' ')}" ${dataKey}="${pill.key}">${iconHTML}${pill.label}${countHTML}</button>`;
  }

  function renderBar(cfg) {
    const bar = document.querySelector(cfg.selector);
    if (!bar) return;
    const inner = bar.querySelector('.pill-bar-inner');
    if (!inner) return;
    inner.innerHTML = cfg.pills.map(p => renderPill(p, cfg.dataKey)).join('');
  }

  function renderAllPillBars() {
    PILL_BARS.forEach(renderBar);
  }

  // ── Bootstrap ─────────────────────────────────────────────────
  // Render once the DOM is ready. Per-tab scripts that bind click
  // handlers on .pill-bar-inner (Tasks) or delegate at document
  // level (Habits, Insights, Train) work either way — pills exist
  // before any user interaction.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAllPillBars, { once: true });
  } else {
    renderAllPillBars();
  }

  // Expose for any per-tab code that needs to re-render (e.g. if a
  // pill label depends on dynamic state). Not used today but
  // cheap to keep available.
  window.renderAllPillBars = renderAllPillBars;
})();
