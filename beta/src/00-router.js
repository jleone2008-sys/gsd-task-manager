/* ══════════════════════════════════════════════════════════════
   ROUTER — bookmarkable URLs for /beta/app/*
   Identical to prod 00-router.js except:
     - All routes use /beta/app/* prefix
     - localStorage key is gsd_beta_last_tool (isolated from prod)
═══════════════════════════════════════════════════════════════ */
const GSD_LAST_TOOL_KEY = 'gsd_beta_last_tool';
const GSD_HABIT_VIEWS = ['today', 'all', 'stats'];
const GSD_TOOLS = ['tasks', 'habits', 'notes', 'scratch', 'journal', 'settings'];

function parseAppRoute() {
  const path = location.pathname;
  const q = new URLSearchParams(location.search);
  const m = path.match(/^\/beta\/app(?:\/([^/?#]+))?(?:\/([^/?#]+))?\/?$/);
  if (!m) return null;
  const [, seg1, seg2] = m;
  if (!seg1) {
    const stored = localStorage.getItem(GSD_LAST_TOOL_KEY);
    const tool = GSD_TOOLS.includes(stored) ? stored : 'tasks';
    return { tool, _bare: true };
  }
  if (!GSD_TOOLS.includes(seg1)) return null;
  if (seg1 === 'tasks') {
    return { tool: 'tasks', filter: q.get('filter') || null };
  }
  if (seg1 === 'habits') {
    const view = seg2 && GSD_HABIT_VIEWS.includes(seg2) ? seg2 : 'today';
    return { tool: 'habits', view };
  }
  if (seg1 === 'journal') {
    const date = seg2 && /^\d{4}-\d{2}-\d{2}$/.test(seg2) ? seg2 : null;
    return { tool: 'journal', date };
  }
  return { tool: seg1 };
}

function buildAppRoute(r) {
  if (!r || !r.tool) return '/beta/app';
  if (r.tool === 'tasks') {
    return r.filter ? `/beta/app/tasks?filter=${encodeURIComponent(r.filter)}` : '/beta/app/tasks';
  }
  if (r.tool === 'habits') {
    return r.view && r.view !== 'today' ? `/beta/app/habits/${r.view}` : '/beta/app/habits';
  }
  if (r.tool === 'journal') {
    return r.date ? `/beta/app/journal/${r.date}` : '/beta/app/journal';
  }
  return `/beta/app/${r.tool}`;
}

function routerSyncUrl(route, opts) {
  opts = opts || {};
  const path = buildAppRoute(route);
  const state = { ...route };
  const method = opts.replace ? 'replaceState' : 'pushState';
  if (path === location.pathname + location.search && method === 'pushState') return;
  try { history[method](state, '', path); } catch (_) { /* security errors on file:// */ }
  if (route.tool) {
    try { localStorage.setItem(GSD_LAST_TOOL_KEY, route.tool); } catch (_) {}
  }
}

function routerApplyRoute(r) {
  if (!r || !r.tool) return;
  const journalDateChanged = r.tool === 'journal' && r.date && typeof journalState !== 'undefined' && journalState.selectedDate !== r.date;
  if (journalDateChanged) {
    journalState.selectedDate = r.date;
    const d = new Date(r.date + 'T00:00:00');
    journalState.viewMonth = { year: d.getFullYear(), month: d.getMonth() };
  }
  const wasOnJournal = activeTool === 'journal';
  if (typeof activeTool === 'string' && activeTool !== r.tool && typeof switchTool === 'function') {
    _navFromPop = true;
    try { switchTool(r.tool); } finally { _navFromPop = false; }
  } else if (journalDateChanged && wasOnJournal && typeof renderJournal === 'function') {
    renderJournal();
  }
  if (r.tool === 'tasks' && r.filter) {
    const pill = document.querySelector(`[data-tool-view="tasks"].pill-bar .pill[data-filter="${r.filter}"]`);
    if (typeof setCatFilter === 'function') setCatFilter(r.filter, pill);
  }
  if (r.tool === 'habits' && r.view) {
    activeHabitView = r.view;
    document.querySelectorAll('.habit-sub-pills .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.habitView === r.view);
    });
    document.querySelectorAll('.habit-sub-content').forEach(c => c.classList.remove('active'));
    const target = document.getElementById('habit-' + r.view);
    if (target) target.classList.add('active');
    if (typeof renderHabits === 'function') renderHabits();
  }
}

function routerInitFromUrl() {
  const r = parseAppRoute();
  if (!r) return;
  if (r._bare) {
    history.replaceState({ tool: r.tool }, '', buildAppRoute({ tool: r.tool }));
  }
  routerApplyRoute(r);
}
