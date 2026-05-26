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
  const PILL_BARS = [
    {
      selector: '.pill-bar[data-tool-view="tasks"]',
      dataKey:  'data-filter',
      pills: [
        { key: 'all',   label: 'Tasks',      default: true, count: 'pc-all' },
        { key: 'stats', label: 'Statistics' },
      ],
    },
    {
      selector: '.pill-bar.habit-sub-pills',
      dataKey:  'data-habit-view',
      pills: [
        { key: 'today', label: 'Habits',     default: true, count: 'pc-habit-today', extraClass: 'habit-pill' },
        { key: 'stats', label: 'Statistics', extraClass: 'stat-pill' },
      ],
    },
    {
      selector: '.pill-bar.insights-sub-pills',
      dataKey:  'data-insights-view',
      pills: [
        { key: 'timeline', label: 'Knowledgebase', default: true, extraClass: 'insights-pill' },
        { key: 'patterns', label: 'Patterns',                    count: 'insightsPatternsCount', countClass: 'insights-pill-count', extraClass: 'insights-pill' },
        { key: 'weekly',   label: 'Weekly Insights',              extraClass: 'insights-pill' },
      ],
    },
    {
      selector: '.pill-bar.train-sub-pills',
      dataKey:  'data-train-view',
      pills: [
        { key: 'workout',  label: 'Workout',     default: true, extraClass: 'train-pill',
          icon: '<rect x="2" y="8" width="3" height="8" rx="1"/><rect x="19" y="8" width="3" height="8" rx="1"/><rect x="5" y="10" width="2" height="4"/><rect x="17" y="10" width="2" height="4"/><line x1="7" y1="12" x2="17" y2="12"/>' },
        { key: 'history',  label: 'History',     extraClass: 'train-pill',
          icon: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><polyline points="12 7 12 12 15 14"/>' },
        { key: 'progress', label: 'My Progress', extraClass: 'train-pill',
          icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
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
