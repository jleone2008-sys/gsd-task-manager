/* ══════════════════════════════════════════════════════════════
   ROUTER — bookmarkable URLs for /app/*
   Classic script (no type=module). Loads first so helpers are
   in the global scope before any other script references them.

   Supported routes:
     /app                       → redirect to last-visited tool (default /app/tasks)
     /app/tasks                 → tasks tool
     /app/tasks?filter=<name>   → tasks tool with filter active (all|overdue|personal|biz)
     /app/habits                → habits tool, today view
     /app/habits/<view>         → habits tool (today|all|stats)
     /app/notes                 → notes tool
     /app/scratch               → scratch tool

   Netlify fallthrough (_redirects + netlify.toml) sends every /app/*
   path to /app.html, so paste-and-refresh works.
═══════════════════════════════════════════════════════════════ */
const GSD_LAST_TOOL_KEY = 'gsd_last_tool';
const GSD_HABIT_VIEWS = ['today', 'all', 'stats'];
const GSD_TOOLS = ['tasks', 'habits', 'notes', 'scratch'];

function parseAppRoute() {
  const path = location.pathname;
  const q = new URLSearchParams(location.search);
  const m = path.match(/^\/app(?:\/([^/?#]+))?(?:\/([^/?#]+))?\/?$/);
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
  return { tool: seg1 };
}

function buildAppRoute(r) {
  if (!r || !r.tool) return '/app';
  if (r.tool === 'tasks') {
    return r.filter ? `/app/tasks?filter=${encodeURIComponent(r.filter)}` : '/app/tasks';
  }
  if (r.tool === 'habits') {
    return r.view && r.view !== 'today' ? `/app/habits/${r.view}` : '/app/habits';
  }
  return `/app/${r.tool}`;
}

function routerSyncUrl(route, opts) {
  opts = opts || {};
  const path = buildAppRoute(route);
  const state = { ...route };
  const method = opts.replace ? 'replaceState' : 'pushState';
  // Avoid pushing a duplicate state if nothing changed.
  if (path === location.pathname + location.search && method === 'pushState') return;
  try { history[method](state, '', path); } catch (_) { /* security errors on file:// */ }
  if (route.tool) {
    try { localStorage.setItem(GSD_LAST_TOOL_KEY, route.tool); } catch (_) {}
  }
}

// Apply a parsed route to the UI. Safe to call when handlers are globals.
function routerApplyRoute(r) {
  if (!r || !r.tool) return;
  if (typeof activeTool === 'string' && activeTool !== r.tool && typeof switchTool === 'function') {
    _navFromPop = true;
    try { switchTool(r.tool); } finally { _navFromPop = false; }
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

// Called once from 11-init.js after session restore runs.
function routerInitFromUrl() {
  const r = parseAppRoute();
  if (!r) return;
  if (r._bare) {
    history.replaceState({ tool: r.tool }, '', buildAppRoute({ tool: r.tool }));
  }
  routerApplyRoute(r);
}
