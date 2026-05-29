/* ════════════════════════════════════════════════════════════════════
   DEV MOCK-MODE  —  run the real app UI on fake data, with no login.

   WHAT IT DOES (only when activated):
     1. Bypasses auth — overrides supabase.createClient() so the global `db`
        in 01-core.js becomes an in-memory stub. restoreSession() then finds a
        fake session and boots straight into the app (no #authScreen).
     2. Replaces the data client — a chainable query builder backed by
        window.GSD_FIXTURES. Mutations persist in memory for the session, so
        adding/editing/deleting feels real. Unknown tables resolve to [].
     3. Intercepts function calls — /.netlify/functions/* and googleapis.com
        return canned JSON; everything else passes through to the real fetch.

   SECURITY (triple-gated — see docs/dev-mock-mode-plan.md):
     1. No real anything. Zero credentials; contacts no backend.
     2. Refuses to run on production. Dev/preview hosts only; explicitly
        blocked on gsdtasks.com; requires ?mock in the URL (or a same-session
        flag set after the first ?mock activation).
     3. Not shipped to prod at all. scripts/inject-dev-mode.mjs strips this
        script (and fixtures.js) from app.html when CONTEXT === 'production'.
════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Gate ─────────────────────────────────────────────────── */
  const host = location.hostname;
  const params = new URLSearchParams(location.search);
  const SS_KEY = 'gsd_mock_mode';
  const DEV_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', ''];
  const isPreview = host.endsWith('.netlify.app');
  const isDevHost = DEV_HOSTS.includes(host) || isPreview;
  // Same-session flag keeps mock alive across internal navigations that drop
  // the ?mock query string (the router rewrites the URL). Still requires a
  // dev host, so this can never self-activate on prod.
  const flagged = sessionStorage.getItem(SS_KEY) === '1';
  const requested = params.has('mock') || flagged;
  const enabled = isDevHost && host !== 'gsdtasks.com' && requested;

  if (!enabled) return;
  sessionStorage.setItem(SS_KEY, '1');

  const FIX = window.GSD_FIXTURES;
  if (!FIX) {
    console.error('[mock] GSD_FIXTURES not loaded — fixtures.js must load before mock-mode.js');
    return;
  }
  console.info('%c[mock] DEV MOCK-MODE active — fake data, no login.', 'color:#b25c3d;font-weight:700');

  const tables = FIX.tables;
  let _pkSeq = 100000;
  const nextPk = () => ++_pkSeq;

  /* ── Filter matching for the query builder ────────────────── */
  function rowMatches(row, ops) {
    return ops.every(([m, args]) => {
      const [col, val] = args;
      const cell = row == null ? undefined : row[col];
      switch (m) {
        case 'eq':  return cell == val;
        case 'neq': return cell != val;
        case 'gt':  return cell > val;
        case 'gte': return cell >= val;
        case 'lt':  return cell < val;
        case 'lte': return cell <= val;
        case 'in':  return Array.isArray(val) && val.includes(cell);
        case 'is':  return val === null ? (cell == null) : cell === val;
        case 'like':
        case 'ilike': {
          const re = new RegExp('^' + String(val).replace(/%/g, '.*').replace(/_/g, '.') + '$', m === 'ilike' ? 'i' : '');
          return re.test(String(cell ?? ''));
        }
        case 'contains':
          // array column contains all values, or jsonb contains keys
          if (Array.isArray(cell) && Array.isArray(val)) return val.every((v) => cell.includes(v));
          return true;
        // not / or / match / filter / overlaps / textSearch — best-effort pass-through
        default: return true;
      }
    });
  }

  function conflictKeys(opts) {
    if (opts && opts.onConflict) return String(opts.onConflict).split(',').map((s) => s.trim());
    return ['id'];
  }

  /* ── Chainable query builder (thenable) ───────────────────── */
  function makeBuilder(table) {
    const ops = [];
    let _order = null, _limit = null, _rangeFrom = null, _rangeTo = null;
    let _single = false, _maybe = false;
    let _mutation = null, _returning = false;

    const store = () => (tables[table] || (tables[table] = []));

    const exec = () => {
      let data = null, error = null;
      try {
        if (_mutation) {
          data = applyMutation();
        } else {
          let rows = store().filter((r) => rowMatches(r, ops));
          if (_order) {
            const { col, asc } = _order;
            rows = rows.slice().sort((a, b) => {
              const x = a[col], y = b[col];
              if (x == null && y == null) return 0;
              if (x == null) return asc ? -1 : 1;
              if (y == null) return asc ? 1 : -1;
              return asc ? (x > y ? 1 : x < y ? -1 : 0) : (x < y ? 1 : x > y ? -1 : 0);
            });
          }
          if (_rangeFrom != null) rows = rows.slice(_rangeFrom, (_rangeTo != null ? _rangeTo + 1 : undefined));
          if (_limit != null) rows = rows.slice(0, _limit);
          data = rows;
        }
        // single() and maybeSingle() behave identically in the mock (real
        // single() throwing on 0/≠1 rows isn't worth simulating for fixtures).
        if (_single || _maybe) data = (Array.isArray(data) ? data[0] : data) ?? null;
      } catch (e) {
        error = { message: e.message, code: 'MOCK_ERR' };
        data = _single || _maybe ? null : [];
      }
      return Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : (data ? 1 : 0), status: 200, statusText: 'OK' });
    };

    function applyMutation() {
      const s = store();
      const { type, payload, opts } = _mutation;
      const rowsIn = Array.isArray(payload) ? payload : (payload ? [payload] : []);
      let affected = [];
      if (type === 'insert') {
        affected = rowsIn.map((r) => { const row = Object.assign({}, r); if (row.id == null) row.id = nextPk(); s.push(row); return row; });
      } else if (type === 'upsert') {
        const keys = conflictKeys(opts);
        rowsIn.forEach((r) => {
          const idx = s.findIndex((existing) => keys.every((k) => existing[k] == r[k]));
          if (idx >= 0) { s[idx] = Object.assign({}, s[idx], r); affected.push(s[idx]); }
          else { const row = Object.assign({}, r); if (row.id == null) row.id = nextPk(); s.push(row); affected.push(row); }
        });
      } else if (type === 'update') {
        s.forEach((row, i) => { if (rowMatches(row, ops)) { s[i] = Object.assign({}, row, payload); affected.push(s[i]); } });
      } else if (type === 'delete') {
        const keep = []; s.forEach((row) => { if (rowMatches(row, ops)) affected.push(row); else keep.push(row); });
        tables[table] = keep;
      }
      return _returning ? affected : (affected.length ? affected : []);
    }

    const b = {
      // filters
      eq: f('eq'), neq: f('neq'), gt: f('gt'), gte: f('gte'), lt: f('lt'), lte: f('lte'),
      in: f('in'), is: f('is'), like: f('like'), ilike: f('ilike'), contains: f('contains'),
      not: f('not'), or: f('or'), match: f('match'), filter: f('filter'), overlaps: f('overlaps'), textSearch: f('textSearch'),
      order(col, o) { _order = { col, asc: !(o && o.ascending === false) }; return b; },
      limit(n) { _limit = n; return b; },
      range(from, to) { _rangeFrom = from; _rangeTo = to; return b; },
      select(_cols) { if (_mutation) _returning = true; return b; },
      single() { _single = true; return b; },
      maybeSingle() { _maybe = true; return b; },
      csv() { return b; },
      insert(p) { _mutation = { type: 'insert', payload: p }; return b; },
      update(p) { _mutation = { type: 'update', payload: p }; return b; },
      upsert(p, o) { _mutation = { type: 'upsert', payload: p, opts: o }; return b; },
      delete() { _mutation = { type: 'delete' }; return b; },
      then(resolve, reject) { return exec().then(resolve, reject); },
      catch(rej) { return exec().catch(rej); },
      finally(fn) { return exec().finally(fn); },
    };
    function f(name) { return (...args) => { ops.push([name, args]); return b; }; }
    return b;
  }

  /* ── Realtime channel stub ────────────────────────────────── */
  function makeChannel() {
    const ch = { on() { return ch; }, subscribe(cb) { try { cb && cb('SUBSCRIBED'); } catch (_) {} return ch; }, unsubscribe() { return Promise.resolve('ok'); }, send() { return Promise.resolve('ok'); } };
    return ch;
  }

  /* ── Storage stub ─────────────────────────────────────────── */
  function makeStorageBucket() {
    return {
      upload: async () => ({ data: { path: 'mock/path' }, error: null }),
      download: async () => ({ data: new Blob([]), error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: 'about:blank#' + encodeURIComponent(p || '') } }),
      createSignedUrl: async (p) => ({ data: { signedUrl: 'about:blank#' + encodeURIComponent(p || '') }, error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
      remove: async () => ({ data: [], error: null }),
      list: async () => ({ data: [], error: null }),
    };
  }

  /* ── RPC stub ─────────────────────────────────────────────── */
  function rpc(name) {
    // Anything that returns rows for the app: default to []. Single-value
    // RPCs the app only fires-and-forgets resolve to null.
    const arrayReturning = ['search_knowledge_chunks', 'match_documents'];
    const data = arrayReturning.includes(name) ? [] : null;
    return Promise.resolve({ data, error: null });
  }

  /* ── The mock Supabase client ─────────────────────────────── */
  const mockClient = {
    from: (table) => makeBuilder(table),
    rpc,
    channel: makeChannel,
    removeAllChannels() { return Promise.resolve('ok'); },
    removeChannel() { return Promise.resolve('ok'); },
    getChannels() { return []; },
    storage: { from: makeStorageBucket },
    auth: {
      getSession: async () => ({ data: { session: FIX.session }, error: null }),
      getUser: async () => ({ data: { user: FIX.user }, error: null }),
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithIdToken: async () => ({ data: { session: FIX.session, user: FIX.user }, error: null }),
      setSession: async () => ({ data: { session: FIX.session, user: FIX.user }, error: null }),
      signInWithPassword: async () => ({ data: { session: FIX.session, user: FIX.user }, error: null }),
      signOut: async () => { sessionStorage.removeItem(SS_KEY); return { error: null }; },
      refreshSession: async () => ({ data: { session: FIX.session, user: FIX.user }, error: null }),
    },
  };

  /* ── Override createClient before 01-core.js evaluates ────── */
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    window.supabase.createClient = () => mockClient;
  } else {
    console.error('[mock] supabase global not present — load order wrong; mock cannot install db stub');
  }

  /* ── Canned Netlify-function responses ────────────────────── */
  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function mockFunction(url) {
    const u = url.toLowerCase();
    if (u.includes('action=status')) return jsonResponse({ connected: true, last_sync: new Date().toISOString(), status: 'connected' });
    if (u.includes('beta-daily-brief')) {
      const fix = (tables.daily_briefs || [])[0] || {};
      return jsonResponse(fix);
    }
    if (u.includes('beta-train-feedback')) return jsonResponse({ ai_feedback: { summary: 'Solid work — progressive overload is on track.', focus: ['Keep rest under 2 min on accessories'] } });
    if (u.includes('beta-progress-pic-analysis')) return jsonResponse({ ai_analysis: { body_type: 'mesomorph', stage: 'lean', needs_work: ['upper chest'], focus_areas: ['incline pressing'] } });
    if (u.includes('beta-sync-now')) return jsonResponse({ ok: true, rows_upserted: 0 });
    if (u.includes('beta-weather')) return jsonResponse({
      ok: true, has_location: true, location_label: 'Austin, TX', updated_at: new Date().toISOString(),
      current: { temp_f: 74, feels_f: 76, humidity: 45, wind_mph: 8, gust_mph: 15, condition: 'partly cloudy', emoji: '⛅', code: 2 },
      today: { high_f: 78, low_f: 57, feels_high_f: 80, precip_pct: 10, uv_max: 7, condition: 'partly cloudy', emoji: '⛅', code: 2, sunrise_label: '6:42a', sunset_label: '8:14p', daylight_min: 812 },
      tomorrow: { high_f: 72, low_f: 55, precip_pct: 60, condition: 'light rain', emoji: '🌦️', code: 61 },
      hourly: [
        { label: 'Now', temp_f: 74, precip_pct: 0,  emoji: '⛅' },
        { label: '2p',  temp_f: 77, precip_pct: 0,  emoji: '☀️' },
        { label: '3p',  temp_f: 78, precip_pct: 0,  emoji: '☀️' },
        { label: '4p',  temp_f: 77, precip_pct: 10, emoji: '⛅' },
        { label: '5p',  temp_f: 73, precip_pct: 30, emoji: '🌦️' },
        { label: '6p',  temp_f: 70, precip_pct: 35, emoji: '🌦️' },
        { label: '7p',  temp_f: 67, precip_pct: 15, emoji: '⛅' },
        { label: '8p',  temp_f: 64, precip_pct: 0,  emoji: '☁️' },
      ],
    });
    if (u.includes('beta-set-location')) return jsonResponse({ ok: true, weather_lat: 30.27, weather_lng: -97.74, city: 'Austin, TX', weather_label: 'Austin, TX' });
    if (u.includes('beta-knowledge-search')) return jsonResponse({ matches: [] });
    if (u.includes('refresh-google-token')) return jsonResponse({ access_token: 'mock-google-token', expires_in: 3600 });
    return jsonResponse({ ok: true });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    try {
      if (url.includes('/.netlify/functions/')) return Promise.resolve(mockFunction(url));
      if (url.includes('googleapis.com')) return Promise.resolve(jsonResponse({ items: [] }));
    } catch (e) {
      console.warn('[mock] fetch intercept failed, passing through', e);
    }
    return realFetch(input, init);
  };

  /* ── On-screen banner (dev affordance) ────────────────────── */
  function injectBanner() {
    if (document.getElementById('mockModeBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'mockModeBanner';
    bar.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#b25c3d', 'color:#fff', 'font:600 12px/1.4 -apple-system,Segoe UI,system-ui,sans-serif',
      'padding:5px 12px', 'display:flex', 'align-items:center', 'justify-content:center', 'gap:10px',
      'box-shadow:0 -2px 8px rgba(0,0,0,.18)', 'letter-spacing:.02em',
    ].join(';');
    bar.innerHTML = 'MOCK DATA — fake data, no login. Not connected to anything.' +
      '<button id="mockModeHide" style="background:rgba(255,255,255,.2);border:0;color:#fff;padding:2px 8px;border-radius:5px;cursor:pointer;font:inherit">hide</button>';
    document.body.appendChild(bar);
    document.getElementById('mockModeHide').addEventListener('click', () => bar.remove());
  }
  if (document.body) injectBanner();
  else document.addEventListener('DOMContentLoaded', injectBanner);
})();
