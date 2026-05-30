/* ══════════════════════════════════════════════════════════════
   SETTINGS PAGE
   Sections: Integrations, Location, Connected calendars, Danger zone.
   Reads/writes user_settings table. Admin tab_permissions still
   controls which tabs each user can see (managed in /admin), but the
   per-user "choose your tabs" toggle has been removed — every tab the
   user is permissioned for is always visible.
═══════════════════════════════════════════════════════════════ */

let userSettings = null;

const BETA_DROPBOX_CLIENT_ID = '7rf801fqot1xx8n';
// Oura uses a single shared GSD-owned dev app — public client_id is hardcoded.
const BETA_OURA_CLIENT_ID    = '718bad26-5171-4dc7-addc-ca20cd1a4f73';
// Whoop uses a per-user "bring your own app" model: each user creates their
// own dev app at developer.whoop.com and saves credentials via the Settings
// form (stored in user_profiles via beta-whoop-creds). There is intentionally
// no Whoop client_id constant here — it's read from userSettings at runtime.

const SETTINGS_DEFAULTS = {
  integrations: {},
  appearance: {},
};

// ── Appearance / theme ──────────────────────────────────────────────
// Four independent axes applied as data-* attributes on <html>; app.css
// (the "THEMING" block) maps them to design-token overrides, re-theming
// the whole app with no per-component changes. Defaults reproduce today's
// look exactly. Persisted in user_settings.appearance (jsonb). An inline
// script in app.html applies the localStorage cache before first paint;
// loadUserSettings() reconciles from the DB. See docs/brand-framework.html.
const THEME_DEFAULTS = { palette: 'paper', corners: 'xs', type: 'geometric', cards: 'solid', cardAlpha: 0.9 };
const THEME_OPTIONS = {
  palette: [
    { v: 'paper',      label: 'Paper',          sw: ['#fbf6ee', '#b82d3b'] },
    { v: 'sage',       label: 'Sage',           sw: ['#eef3ec', '#4f8a6b'] },
    { v: 'sky',        label: 'Sky',            sw: ['#eef2fb', '#3f6fd1'] },
    { v: 'paper-grad', label: 'Paper gradient', sw: ['linear-gradient(135deg,#fbccb2,#e0dbf8)', '#b82d3b'] },
    { v: 'sage-grad',  label: 'Sage gradient',  sw: ['linear-gradient(135deg,#c6e6c4,#cfece4)', '#4f8a6b'] },
    { v: 'sky-grad',   label: 'Sky gradient',   sw: ['linear-gradient(135deg,#cbddfb,#d2f0e9)', '#3f6fd1'] },
  ],
  corners: [
    { v: 'sharp', label: 'Sharp' },
    { v: 'xs',    label: 'Subtle' },
    { v: 'soft',  label: 'Soft' },
    { v: 'round', label: 'Round' },
  ],
  type: [
    { v: 'geometric', label: 'Geometric' },
    { v: 'friendly',  label: 'Friendly' },
    { v: 'modern',    label: 'Modern' },
  ],
  cards: [
    { v: 'solid', label: 'Solid' },
    { v: 'soft',  label: 'Translucent' },
  ],
};

// Current theme = defaults overlaid with the user's saved appearance.
function getTheme() {
  return { ...THEME_DEFAULTS, ...((userSettings && userSettings.appearance) || {}) };
}

// Apply a theme to <html> + cache it in localStorage (read pre-paint by the
// inline app.html script on the next load). Also mirrors into userSettings.
function applyTheme(theme) {
  const t = { ...THEME_DEFAULTS, ...(theme || {}) };
  const d = document.documentElement;
  d.setAttribute('data-palette', t.palette);
  d.setAttribute('data-corners', t.corners);
  d.setAttribute('data-type', t.type);
  d.setAttribute('data-cards', t.cards);
  d.style.setProperty('--card-alpha', t.cardAlpha != null ? t.cardAlpha : 0.9);
  if (userSettings) userSettings.appearance = t;
  try { localStorage.setItem('gsd_theme', JSON.stringify(t)); } catch (e) {}
}

const INTEGRATIONS_META = [
  { id: 'dropbox', label: 'Dropbox',   desc: 'Grant Dropbox access for AI insights functionality.' },
  { id: 'oura',    label: 'Oura Ring', desc: 'Sleep, readiness, and activity from your Oura Ring.' },
  { id: 'whoop',   label: 'Whoop',     desc: 'Recovery, strain, and sleep from your Whoop.' }
];

// Which wearable's scores show on the Home tab. Stored inside the integrations
// jsonb column (no schema change). Defaults to Oura.
function getHealthSource() {
  return (userSettings?.integrations?.health_source === 'whoop') ? 'whoop' : 'oura';
}

async function loadUserSettings() {
  console.time('[perf] settings.userSettings');
  try {
    const { data, error } = await db.from('user_settings').select('*').maybeSingle();
    console.timeEnd('[perf] settings.userSettings');
    if (error) throw error;
    userSettings = data ? {
      integrations: data.integrations || {},
      appearance: data.appearance || {},
    } : { ...SETTINGS_DEFAULTS };
  } catch (e) {
    console.warn('[settings] load failed', e);
    userSettings = { ...SETTINGS_DEFAULTS };
  }
  // Reconcile the saved theme (DB is source of truth) onto <html> + the
  // localStorage cache. The inline app.html script already applied the
  // cached value pre-paint; this corrects it if the DB differs.
  applyTheme(getTheme());
  // Layer in live integration status from the server. Fire-and-forget so the
  // synchronous boot path (which awaits loadUserSettings) isn't blocked on
  // cold-startable Netlify functions (Dropbox/Whoop/Oura). The Settings page
  // renders with default "disconnected" states; values fill in when each
  // loader returns via settingsRefreshIntegrationsIfOpen.
  for (const id of Object.keys(INTEGRATIONS)) {
    loadIntegrationStatus(id).then(settingsRefreshIntegrationsIfOpen);
  }
  loadLocationStatus().then(settingsRefreshIntegrationsIfOpen);
  loadConnectedCalendars().then(settingsRefreshIntegrationsIfOpen);
}

// No-op when the Settings page isn't currently mounted. When it is,
// re-render the integrations panel so newly-arrived status values
// replace the default "disconnected" stub. Cheap — the panel is
// small relative to the full Settings page.
function settingsRefreshIntegrationsIfOpen() {
  if (typeof activeTool === 'undefined' || activeTool !== 'settings') return;
  if (typeof renderSettingsPage === 'function') renderSettingsPage();
}

// Phase 5 — multi-calendar selection, plus linked-Google-account
// support. Loads the user's stored toggles (google_calendars_synced)
// AND the live Google calendarList — for the primary signed-in account
// PLUS every row in linked_google_accounts. Each calendar item is
// tagged with `account_email` ('' for primary, real email for linked)
// so toggles can be scoped per-account.
async function loadConnectedCalendars() {
  if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
  userSettings.calendars = { items: [], accounts: [], loading: true, error: null };
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;

    // Linked accounts (RLS = select own).
    const { data: linkedRows } = await db.from('linked_google_accounts')
      .select('google_email,display_name')
      .eq('user_id', session.user.id);
    const linked = linkedRows || [];

    // Sources to fetch: primary first (empty account_email), then each linked.
    const sources = [{ email: '', display: null }]
      .concat(linked.map(l => ({ email: l.google_email, display: l.display_name })));

    const fetchOne = async (src) => {
      try {
        const token = typeof getGoogleAccessToken === 'function'
          ? await getGoogleAccessToken(false, src.email || undefined)
          : null;
        if (!token) return { src, items: [], error: 'no_token' };
        const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return { src, items: [], error: `api_${res.status}` };
        const json = await res.json();
        const items = (json.items || []).map(c => ({
          id:            c.id,
          summary:       c.summaryOverride || c.summary || c.id,
          color_hex:     c.backgroundColor || null,
          primary:       !!c.primary,
          account_email: src.email,    // '' for primary, real email for linked
        }));
        return { src, items, error: null };
      } catch (err) {
        console.warn('[settings] calendar list fetch failed for', src.email || 'primary', err);
        return { src, items: [], error: 'fetch_failed' };
      }
    };

    const results = await Promise.all(sources.map(fetchOne));
    const live = results.flatMap(r => r.items);

    // If the ONLY source (primary, no linked accounts) failed with
    // no_token, surface that to the UI so we can prompt to sign in.
    if (!linked.length && live.length === 0 && results[0]?.error === 'no_token') {
      userSettings.calendars = {
        items: [], accounts: sources, loading: false, error: 'no_token',
      };
      return;
    }

    // Existing toggles — now scoped by (calendar_id, account_email).
    const { data: synced } = await db.from('google_calendars_synced')
      .select('google_calendar_id,google_account_email,enabled')
      .eq('user_id', session.user.id);
    const enabledMap = {};
    for (const row of (synced || [])) {
      const k = `${row.google_account_email || ''}${row.google_calendar_id}`;
      enabledMap[k] = !!row.enabled;
    }
    const hasAnyRow = (synced || []).length > 0;

    const items = live.map(c => {
      const k = `${c.account_email}${c.id}`;
      const enabled = enabledMap[k] != null
        ? enabledMap[k]
        // First-time defaults: primary's primary calendar = true; everything
        // else for a fresh user = true too (we want linked accounts to feed
        // in by default once linked — user can opt out of specific ones).
        // If the user has already touched ANY toggle, new calendars are
        // opt-in (false) to preserve the configure-once feel.
        : (!hasAnyRow ? !!c.primary || c.account_email !== '' : false);
      return { ...c, enabled };
    });

    userSettings.calendars = { items, accounts: sources, loading: false, error: null };
  } catch (e) {
    console.warn('[settings] calendars load failed', e);
    userSettings.calendars = { items: [], accounts: [], loading: false, error: 'fetch_failed' };
  }
}

// Per-integration config consumed by loadIntegrationStatus +
// disconnectIntegration. Each loader hits its `status` endpoint, runs
// the response through `mapStatus`, and stores the result on
// userSettings.integrations[id]. Disconnect POSTs { action:'disconnect' }
// to `endpoint` and applies `onDisconnect` to clean up local state.
//
// Whoop's mapStatus uniquely preserves `configured` + `client_id` from
// the credentials endpoint (BYO model — disconnect revokes the OAuth
// token but keeps saved credentials). The other two are plain.
const INTEGRATIONS = {
  dropbox: {
    label:        'Dropbox',
    endpoint:     '/.netlify/functions/beta-dropbox',
    statusUrl:    '/.netlify/functions/beta-dropbox?action=status',
    mapStatus:    d => ({ connected: !!d.connected, email: d.dropbox_account_email || null }),
    confirmText:  'Disconnect Dropbox? GSD will no longer be able to access your Dropbox files. Any folders previously shared with GSD will remain shared until you remove them from your Dropbox account.',
    onDisconnect: () => ({ connected: false, email: null }),
  },
  whoop: {
    label:        'Whoop',
    endpoint:     '/.netlify/functions/beta-whoop',
    statusUrl:    '/.netlify/functions/beta-whoop-creds?action=status',
    mapStatus:    d => ({
      configured: !!d.configured,
      client_id:  d.client_id || null,
      connected:  !!d.connected,
      email:      d.whoop_account_email || null,
      last_sync:  d.last_sync || null,    // {ran_at, success, error, rows_upserted}
    }),
    confirmText:  'Disconnect Whoop? GSD will no longer sync your Whoop data. Historical data already synced will remain in your account.',
    onDisconnect: prev => ({ ...prev, connected: false, email: null }),  // preserve client_id + configured
  },
  oura: {
    label:        'Oura',
    endpoint:     '/.netlify/functions/beta-oura',
    statusUrl:    '/.netlify/functions/beta-oura?action=status',
    mapStatus:    d => ({ connected: !!d.connected, email: d.oura_account_email || null }),
    confirmText:  'Disconnect Oura? GSD will no longer sync your Oura Ring data. Historical data already synced will remain in your account.',
    onDisconnect: () => ({ connected: false, email: null }),
  },
};

async function loadIntegrationStatus(id) {
  const cfg = INTEGRATIONS[id];
  if (!cfg) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch(cfg.statusUrl, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    if (!userSettings.integrations) userSettings.integrations = {};
    userSettings.integrations[id] = cfg.mapStatus(data);
  } catch (e) {
    console.warn(`[settings] ${id} status load failed`, e);
  }
}

// User-set city for the daily brief's weather line. Lives on
// user_preferences (full RLS — user owns their row). Was on user_profiles
// before the table split; moved so the client can write directly without
// the SECURITY DEFINER RPC dance.
async function loadLocationStatus() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const { data, error } = await db.from('user_preferences')
      .select('city,weather_label')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    userSettings.location = {
      city:          data?.city || null,
      weather_label: data?.weather_label || null,
    };
  } catch (e) {
    console.warn('[settings] location status load failed', e);
  }
}

async function saveUserSettings(patch) {
  if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
  Object.assign(userSettings, patch);
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('No session');
    const { error } = await db.from('user_settings').upsert({
      user_id: session.user.id,
      integrations: userSettings.integrations,
      appearance: userSettings.appearance || {},
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
  } catch (e) {
    console.error('[settings] save failed', e);
    if (typeof showToast === 'function') showToast('Could not save settings', 'offline');
  }
}

function ensureSettingsStyles() {
  if (document.getElementById('settingsStyles')) return;
  const style = document.createElement('style');
  style.id = 'settingsStyles';
  style.textContent = `
    .settings-page { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    .settings-section { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-lg); padding: 22px 24px; margin-bottom: 18px; box-shadow: var(--shadow-card); }
    .settings-section.settings-danger { border-color: var(--danger-200); background: var(--danger-50); }
    .settings-h { font-size: var(--fs-card); font-weight: 600; color: var(--ink); margin-bottom: 4px; letter-spacing: -0.01em; }
    .settings-sub { font-size: var(--fs-pill); color: var(--ink-3); line-height: 1.6; margin-bottom: 14px; }
    .settings-tab-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--edge); cursor: pointer; }
    .settings-tab-row:first-of-type { border-top: none; }
    .settings-tab-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--guava-700); cursor: pointer; flex-shrink: 0; }
    .settings-tab-row--locked { cursor: default; opacity: 0.7; }
    .settings-tab-row--locked input { cursor: not-allowed; }
    .settings-tab-label { font-size: var(--fs-search); font-weight: 600; color: var(--ink); min-width: 80px; }
    .settings-tab-desc { font-size: var(--fs-pill); color: var(--ink-3); line-height: 1.5; flex: 1; }
    .settings-reorder { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
    .settings-reorder button { width: 22px; height: 16px; border: 1px solid var(--edge); background: var(--surface); border-radius: var(--r-sm); cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); font-size: var(--fs-nano); line-height: 1; }
    .settings-reorder button:hover:not([disabled]) { background: var(--surface-2); color: var(--ink); }
    .settings-reorder button[disabled] { opacity: 0.3; cursor: not-allowed; }
    .settings-health-source { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 4px 0 16px; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--edge); border-radius: var(--r-md); }
    .settings-health-source-label { font-size: var(--fs-pill); font-weight: 600; color: var(--ink-2); }
    .settings-health-source-opts { display: flex; gap: 18px; flex-wrap: wrap; }
    .settings-health-source-opts label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-search); color: var(--ink); cursor: pointer; }
    .settings-soon { font-size: var(--fs-label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-4); }
    .settings-int-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .settings-int-card { background: var(--surface-2); border: 1px solid var(--edge); border-radius: var(--r-md); padding: 14px 16px; }
    .settings-int-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .settings-int-name { font-size: var(--fs-search); font-weight: 600; color: var(--ink); }
    .settings-int-status { font-size: var(--fs-label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-4); }
    .settings-int-status.connected { color: var(--moss-fg); }
    .settings-int-desc { font-size: 11.5px; color: var(--ink-3); line-height: 1.55; margin-bottom: 10px; }
    .settings-btn-secondary { background: var(--surface); border: 1px solid var(--edge-strong); color: var(--ink-2); padding: 7px 14px; border-radius: var(--r-md); font-family: inherit; font-size: var(--fs-pill); font-weight: 500; cursor: pointer; }
    .settings-btn-secondary:hover:not([disabled]) { background: var(--surface-2); color: var(--ink); }
    .settings-btn-secondary[disabled] { opacity: 0.55; cursor: not-allowed; }
    .settings-btn-danger { background: var(--danger-700); border: 1px solid var(--danger-700); color: #fff; padding: 7px 14px; border-radius: var(--r-md); font-family: inherit; font-size: var(--fs-pill); font-weight: 600; cursor: pointer; }
    .settings-btn-danger:hover { background: var(--danger-800); }
    .settings-saved { display: inline-block; margin-left: 10px; font-size: var(--fs-meta); color: var(--moss-fg); opacity: 0; transition: opacity var(--dur-calm); }
    .settings-saved.visible { opacity: 1; }
    .settings-int-card--whoop { grid-column: 1 / -1; }
    .settings-whoop-sync-error { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--guava-700); background: rgba(199, 75, 75, 0.08); border: 1px solid rgba(199, 75, 75, 0.25); border-radius: var(--r-sm); padding: 6px 10px; margin: 6px 0 10px; font-weight: 500; }
    .settings-whoop-sync-error-dot { color: var(--guava-700); font-size: var(--fs-label); line-height: 1; }
    .settings-whoop-sync-ok { font-size: var(--fs-meta); color: var(--ink-3); margin: 6px 0 10px; }
    .settings-whoop-creds-summary { font-size: 11.5px; color: var(--ink-3); margin: 6px 0 10px; }
    .settings-whoop-creds-summary code { background: var(--surface); padding: 1px 6px; border-radius: 4px; font-size: var(--fs-meta); }
    .settings-whoop-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .settings-btn-linklike { background: none; border: none; color: var(--ink-3); font-size: 11.5px; cursor: pointer; padding: 0; text-decoration: underline; font-family: inherit; }
    .settings-btn-linklike:hover { color: var(--guava-700); }
    .settings-whoop-help { font-size: 11.5px; color: var(--ink-3); margin: 6px 0 12px; background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-sm); padding: 8px 12px; }
    .settings-whoop-help summary { cursor: pointer; font-weight: 500; color: var(--ink-2); }
    .settings-whoop-help[open] summary { margin-bottom: 8px; }
    .settings-whoop-help ol { margin: 0; padding-left: 18px; line-height: 1.7; }
    .settings-whoop-help code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: var(--fs-meta); word-break: break-all; }
    .settings-whoop-help a { color: var(--guava-700); }
    .settings-whoop-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; }
    .settings-whoop-field { display: flex; flex-direction: column; gap: 4px; }
    .settings-whoop-field span { font-size: var(--fs-meta); font-weight: 600; color: var(--ink-2); }
    .settings-whoop-field input { font-family: inherit; font-size: var(--fs-pill); padding: 7px 10px; border: 1px solid var(--edge-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--ink); }
    .settings-whoop-field input:focus { outline: none; border-color: var(--guava-700); }
    /* Appearance (theme picker) */
    .settings-appearance { display: flex; flex-direction: column; gap: 18px; margin-top: 6px; }
    .settings-appearance-label { font-size: var(--fs-pill); font-weight: 600; color: var(--ink-2); margin-bottom: 8px; }
    .settings-appearance-opts { display: flex; flex-wrap: wrap; gap: 8px; }
    .settings-appearance-opt { display: inline-flex; align-items: center; gap: 7px; background: var(--surface); border: 1px solid var(--edge-strong); border-radius: var(--r-md); padding: 7px 12px; font-family: inherit; font-size: var(--fs-pill); font-weight: 500; color: var(--ink-2); cursor: pointer; transition: border-color var(--dur-quick), color var(--dur-quick), background var(--dur-quick); }
    .settings-appearance-opt:hover { border-color: var(--ink-3); color: var(--ink); }
    .settings-appearance-opt.is-active { border-color: var(--guava-700); color: var(--guava-700); background: var(--guava-50); font-weight: 600; }
    .settings-appearance-sw { display: inline-flex; border-radius: 3px; overflow: hidden; box-shadow: 0 0 0 1px rgba(20,15,10,0.10); }
    .settings-appearance-sw i { width: 14px; height: 14px; display: block; }
    .settings-appearance-slider { display: flex; align-items: center; gap: 12px; margin-top: 10px; max-width: 360px; }
    .settings-appearance-slider input[type=range] { flex: 1; accent-color: var(--guava-700); cursor: pointer; min-width: 0; }
    .settings-appearance-alpha-val { font-size: var(--fs-meta); font-weight: 600; color: var(--ink-3); min-width: 82px; text-align: right; font-variant-numeric: tabular-nums; }
    .settings-appearance-reset { margin-top: 2px; }
    @media (max-width: 600px) { .settings-page { padding: 20px 14px 80px; } .settings-section { padding: 18px 16px; } .settings-whoop-form { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);
}

// One control group (segmented option buttons) for an appearance axis.
function appearanceGroupHtml(label, axis, current) {
  const opts = THEME_OPTIONS[axis].map(o => {
    const sw = o.sw ? `<span class="settings-appearance-sw">${o.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>` : '';
    return `<button class="settings-appearance-opt${o.v === current ? ' is-active' : ''}" data-appearance-axis="${axis}" data-appearance-value="${o.v}">${sw}${o.label}</button>`;
  }).join('');
  return `<div class="settings-appearance-group"><div class="settings-appearance-label">${label}</div><div class="settings-appearance-opts">${opts}</div></div>`;
}

// Card panels group: Solid / Translucent buttons + an opacity slider. Dragging
// the slider implies Translucent (handled live in the input listener).
function cardPanelsGroupHtml(t) {
  const pct = Math.round((t.cardAlpha != null ? t.cardAlpha : 0.9) * 100);
  const opts = THEME_OPTIONS.cards.map(o =>
    `<button class="settings-appearance-opt${o.v === t.cards ? ' is-active' : ''}" data-appearance-axis="cards" data-appearance-value="${o.v}">${o.label}</button>`).join('');
  return `<div class="settings-appearance-group">
            <div class="settings-appearance-label">Card panels</div>
            <div class="settings-appearance-opts">${opts}</div>
            <div class="settings-appearance-slider">
              <input type="range" min="50" max="100" step="5" value="${pct}" data-appearance-alpha aria-label="Card opacity" />
              <span class="settings-appearance-alpha-val">${pct}% opaque</span>
            </div>
          </div>`;
}

// The whole Appearance settings section (theme picker). Reads the current
// theme via getTheme(); changes are handled by the global click/input listeners.
function appearanceSectionHtml() {
  const t = getTheme();
  return `
      <div class="settings-section">
        <div class="settings-h">Appearance <span class="settings-saved" id="settingsAppearanceSaved">Saved</span></div>
        <div class="settings-sub">Personalize the look of the app. Changes apply instantly and save automatically.</div>
        <div class="settings-appearance">
          ${appearanceGroupHtml('Palette', 'palette', t.palette)}
          ${appearanceGroupHtml('Corners', 'corners', t.corners)}
          ${appearanceGroupHtml('Typography', 'type', t.type)}
          ${cardPanelsGroupHtml(t)}
          <div class="settings-appearance-reset"><button class="settings-btn-linklike" data-appearance-reset>Reset to default</button></div>
        </div>
      </div>`;
}

function renderSettingsPage() {
  ensureSettingsStyles();
  const root = document.getElementById('settingsContainer');
  if (!root) return;
  const integrations = userSettings?.integrations || {};
  const healthSource = getHealthSource();

  const sharedClientIdByProvider = { dropbox: BETA_DROPBOX_CLIENT_ID, oura: BETA_OURA_CLIENT_ID };
  const integrationsHtml = INTEGRATIONS_META.map(i => {
    if (i.id === 'whoop') return renderWhoopCard(integrations.whoop || {});
    const intData = integrations[i.id] || {};
    const conn = !!intData.connected;
    const statusLabel = conn
      ? (intData.email ? `Connected · ${escapeHtml(intData.email)}` : 'Connected')
      : 'Not connected';
    const configured = !!sharedClientIdByProvider[i.id];
    let buttonHtml;
    if (conn) {
      buttonHtml = `<button class="settings-btn-secondary" data-settings-int-action="disconnect" data-settings-int-id="${i.id}">Disconnect</button>`;
    } else if (configured) {
      buttonHtml = `<button class="settings-btn-secondary" data-settings-int-action="connect" data-settings-int-id="${i.id}">Connect ${escapeHtml(i.label)}</button>`;
    } else {
      buttonHtml = `<button class="settings-btn-secondary" disabled title="OAuth client_id not yet configured in beta/src/02-settings.js">Connect (coming soon)</button>`;
    }
    return `
      <div class="settings-int-card">
        <div class="settings-int-head">
          <div class="settings-int-name">${i.label}</div>
          <span class="settings-int-status${conn ? ' connected' : ''}">${statusLabel}</span>
        </div>
        <div class="settings-int-desc">${i.desc}</div>
        ${buttonHtml}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="settings-page">
      <div class="settings-section">
        <div class="settings-h">Integrations</div>
        <div class="settings-sub">Connect external services to enrich your journal entries with health data.</div>
        <div class="settings-health-source">
          <span class="settings-health-source-label">Health rings on Home</span>
          <div class="settings-health-source-opts">
            <label><input type="radio" name="healthSource" data-settings-health-source="oura" ${healthSource === 'oura' ? 'checked' : ''} /> Oura</label>
            <label><input type="radio" name="healthSource" data-settings-health-source="whoop" ${healthSource === 'whoop' ? 'checked' : ''} /> Whoop</label>
          </div>
          <button class="settings-btn-secondary" data-settings-sync-now>Sync now</button>
          <span class="settings-saved" id="settingsSyncStatus"></span>
        </div>
        <div class="settings-int-grid">${integrationsHtml}</div>
      </div>

${appearanceSectionHtml()}

      <div class="settings-section">
        <div class="settings-h">Location <span class="settings-saved" id="settingsLocationSaved">Saved</span></div>
        <div class="settings-sub">Sets the weather line on your morning brief. We use Open-Meteo (no account needed).</div>
        ${(userSettings?.location?.weather_label) ? `<div class="settings-sub" style="margin-top:6px"><strong>Current:</strong> ${escapeHtml(userSettings.location.weather_label)}</div>` : ''}
        <div class="settings-whoop-field" style="margin-top:10px; display:flex; gap:8px; align-items:center;">
          <input type="text" id="settingsLocationInput" placeholder="e.g. Birmingham, MI" autocomplete="off" spellcheck="false" value="${escapeHtml(userSettings?.location?.city || '')}" style="flex:1; min-width:0;" />
          <button class="settings-btn-secondary" data-settings-action="save-location">Save</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-h">Connected calendars <span class="settings-saved" id="settingsCalendarsSaved">Saved</span></div>
        <div class="settings-sub">Pick which Google calendars feed events into Journal + Brief. Toggling saves immediately.</div>
        <div id="settingsCalendarsList" style="margin-top:10px;">${renderConnectedCalendarsList()}</div>
      </div>

      <div class="settings-section settings-danger">
        <div class="settings-h">Danger zone</div>
        <div class="settings-sub">This action is permanent and cannot be undone.</div>
        <button class="settings-btn-danger" data-settings-action="delete-account">Delete account &amp; data</button>
      </div>
    </div>`;
}

// Whoop card has its own renderer because the integration uses a per-user
// "bring your own dev credentials" model — each user creates their own Whoop
// dev app at developer.whoop.com and pastes client_id + client_secret here
// before OAuth can run.
function renderWhoopCard(intData) {
  const configured = !!intData.configured;
  const connected  = !!intData.connected;
  const clientId   = intData.client_id || '';
  const lastSync   = intData.last_sync || null;

  // Sync-error badge: shows when the most recent nightly sync (or backfill)
  // for this user failed. Whoop's V1→V2 deprecation made silent failure a
  // real problem — surface it explicitly so the user can act (re-authorize,
  // recheck creds) instead of wondering why no fresh data appears on Home.
  let syncBadge = '';
  if (connected && lastSync && !lastSync.success && lastSync.error) {
    const when = formatRelativeTime(lastSync.ran_at);
    const errSummary = String(lastSync.error).slice(0, 160);
    syncBadge = `
      <div class="settings-whoop-sync-error" title="${escapeHtml(errSummary)}">
        <span class="settings-whoop-sync-error-dot">●</span>
        Last sync failed${when ? ` · ${escapeHtml(when)}` : ''}
      </div>`;
  } else if (connected && lastSync && lastSync.success) {
    const when = formatRelativeTime(lastSync.ran_at);
    if (when) syncBadge = `<div class="settings-whoop-sync-ok">Last synced ${escapeHtml(when)} · ${lastSync.rows_upserted ?? 0} days</div>`;
  }

  let statusLabel, body;
  if (connected) {
    statusLabel = intData.email ? `Connected · ${escapeHtml(intData.email)}` : 'Connected';
    body = `
      <div class="settings-whoop-creds-summary">
        Using your own Whoop dev app (client_id <code>${escapeHtml(clientId)}</code>).
      </div>
      <div class="settings-whoop-actions">
        <button class="settings-btn-secondary" data-settings-int-action="disconnect" data-settings-int-id="whoop">Disconnect</button>
        <button class="settings-btn-linklike" data-settings-whoop-action="clear">Clear credentials</button>
      </div>`;
  } else if (configured) {
    statusLabel = 'Credentials saved · not authorized';
    body = `
      <div class="settings-whoop-creds-summary">
        client_id <code>${escapeHtml(clientId)}</code> saved. Click below to authorize Whoop access.
      </div>
      <div class="settings-whoop-actions">
        <button class="settings-btn-secondary" data-settings-int-action="connect" data-settings-int-id="whoop">Authorize Whoop</button>
        <button class="settings-btn-linklike" data-settings-whoop-action="clear">Clear credentials</button>
      </div>`;
  } else {
    statusLabel = 'Not configured';
    const redirectDev  = window.location.origin + '/.netlify/functions/beta-whoop-auth';
    body = `
      <details class="settings-whoop-help">
        <summary>How to get a Whoop client_id and client_secret</summary>
        <ol>
          <li>Sign in at <a href="https://developer.whoop.com" target="_blank" rel="noopener">developer.whoop.com</a> with your Whoop account.</li>
          <li>Create a new app. Use any name (e.g. "GSD personal sync").</li>
          <li>Under <strong>Redirect URIs</strong>, add this exact URL:<br><code>${escapeHtml(redirectDev)}</code></li>
          <li>Under <strong>Scopes</strong>, check: <code>offline</code>, <code>read:recovery</code>, <code>read:cycles</code>, <code>read:sleep</code>, <code>read:workout</code>, <code>read:profile</code>, <code>read:body_measurement</code>.</li>
          <li>Save the app. Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> into the fields below.</li>
        </ol>
      </details>
      <form class="settings-whoop-form" data-settings-whoop-form>
        <label class="settings-whoop-field">
          <span>Client ID</span>
          <input type="text" name="client_id" autocomplete="off" spellcheck="false" required />
        </label>
        <label class="settings-whoop-field">
          <span>Client Secret</span>
          <input type="password" name="client_secret" autocomplete="off" spellcheck="false" required />
        </label>
        <button type="submit" class="settings-btn-secondary">Save &amp; Authorize</button>
      </form>`;
  }

  return `
    <div class="settings-int-card settings-int-card--whoop">
      <div class="settings-int-head">
        <div class="settings-int-name">Whoop</div>
        <span class="settings-int-status${connected ? ' connected' : ''}">${statusLabel}</span>
      </div>
      <div class="settings-int-desc">Recovery, strain, and sleep from your Whoop. Uses your own Whoop developer app for OAuth.</div>
      ${syncBadge}
      ${body}
    </div>`;
}

// Compact "5 min ago" / "2 hr ago" / "3 days ago" for sync-log timestamps.
// Returns null for missing input so callers can guard cheaply.
function formatRelativeTime(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60)      return `${secs}s ago`;
  if (secs < 3600)    return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400)   return `${Math.floor(secs / 3600)} hr ago`;
  const days = Math.floor(secs / 86400);
  if (days < 30)      return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function flashSettingsSaved(elementId) {
  // No-op when no elementId given OR when the named element isn't mounted
  // (some surfaces — e.g. the health-source radio — don't have a dedicated
  // saved-flash slot and just rely on the silent persist).
  if (!elementId) return;
  const el = document.getElementById(elementId);
  if (!el) return;
  el.classList.add('visible');
  if (!flashSettingsSaved._timers) flashSettingsSaved._timers = {};
  const key = el.id;
  clearTimeout(flashSettingsSaved._timers[key]);
  flashSettingsSaved._timers[key] = setTimeout(() => el.classList.remove('visible'), 1400);
}

function flashSyncStatus(msg) {
  const el = document.getElementById('settingsSyncStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(flashSyncStatus._t);
  flashSyncStatus._t = setTimeout(() => el.classList.remove('visible'), 6000);
}

// Self-serve "Sync now": pulls the selected wearable's recent history on demand
// via beta-sync-now (which triggers the cron backfill server-side for this user).
async function runSyncNow(btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  const src = getHealthSource();
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const res = await fetch(`/.netlify/functions/beta-sync-now?provider=${src}&days=30`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      // A long sync can exceed the function timeout (502/504) while still
      // finishing in the background — report that rather than a hard failure.
      throw new Error(res.status >= 500 ? 'still-running' : `HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    let total = 0;
    Object.values(data.results || {}).forEach(r => { if (typeof r.rowsUpserted === 'number') total += r.rowsUpserted; });
    const msg = total > 0 ? `Synced — ${total} day${total === 1 ? '' : 's'} of data` : 'Sync ran — no new data found';
    flashSyncStatus(msg);
    if (typeof showToast === 'function') showToast(msg);
    loadIntegrationStatus('oura');
  } catch (err) {
    if (err.message === 'still-running') {
      const msg = 'Sync is running — reload Home in a minute';
      flashSyncStatus(msg);
      if (typeof showToast === 'function') showToast(msg);
    } else {
      console.error('[settings] sync now failed', err);
      flashSyncStatus('Sync failed');
      if (typeof showToast === 'function') showToast('Sync failed: ' + err.message, 'offline');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

document.addEventListener('change', e => {
  const calCb = e.target.closest('[data-settings-action="toggle-calendar"]');
  if (calCb) {
    toggleConnectedCalendar(calCb.dataset.calId, calCb.dataset.accountEmail || '', calCb.checked);
    return;
  }
  const healthRadio = e.target.closest('input[data-settings-health-source]');
  if (healthRadio) {
    const src = healthRadio.dataset.settingsHealthSource;
    const merged = { ...(userSettings?.integrations || {}), health_source: src };
    saveUserSettings({ integrations: merged }).then(() => flashSettingsSaved());
    return;
  }
  // Card opacity slider released → persist (live apply happens on 'input').
  const alphaCommit = e.target.closest('[data-appearance-alpha]');
  if (alphaCommit) {
    saveUserSettings({ appearance: getTheme() }).then(() => flashSettingsSaved('settingsAppearanceSaved'));
    return;
  }
});

// Card opacity slider dragged → apply live (Translucent implied), no DB write
// until release ('change', above).
document.addEventListener('input', e => {
  const alpha = e.target.closest('[data-appearance-alpha]');
  if (!alpha) return;
  const a = Math.max(0.5, Math.min(1, (+alpha.value || 90) / 100));
  applyTheme({ ...getTheme(), cards: 'soft', cardAlpha: a });
  const grp = alpha.closest('.settings-appearance-group');
  if (grp) {
    grp.querySelectorAll('.settings-appearance-opt').forEach(b => b.classList.toggle('is-active', b.dataset.appearanceValue === 'soft'));
    const lbl = grp.querySelector('.settings-appearance-alpha-val');
    if (lbl) lbl.textContent = Math.round(a * 100) + '% opaque';
  }
});

document.addEventListener('click', e => {
  // Appearance: pick a theme option → apply live + auto-save.
  const appOpt = e.target.closest('[data-appearance-axis]');
  if (appOpt) {
    const axis = appOpt.dataset.appearanceAxis;
    const value = appOpt.dataset.appearanceValue;
    const next = { ...getTheme(), [axis]: value };
    applyTheme(next);
    saveUserSettings({ appearance: next }).then(() => flashSettingsSaved('settingsAppearanceSaved'));
    // Update active state in-place (avoids a full re-render / scroll jump).
    const group = appOpt.closest('.settings-appearance-group');
    if (group) group.querySelectorAll('.settings-appearance-opt').forEach(b => b.classList.toggle('is-active', b === appOpt));
    return;
  }
  const appReset = e.target.closest('[data-appearance-reset]');
  if (appReset) {
    applyTheme({ ...THEME_DEFAULTS });
    saveUserSettings({ appearance: { ...THEME_DEFAULTS } }).then(() => {
      flashSettingsSaved('settingsAppearanceSaved');
      if (activeTool === 'settings') renderSettingsPage();
    });
    return;
  }
  const syncBtn = e.target.closest('[data-settings-sync-now]');
  if (syncBtn) { runSyncNow(syncBtn); return; }
  const intBtn = e.target.closest('[data-settings-int-action]');
  if (intBtn) {
    const op = intBtn.dataset.settingsIntAction;
    const id = intBtn.dataset.settingsIntId;
    if (op === 'connect') {
      if (id === 'dropbox') startDropboxConnect();
      else if (id === 'whoop') startWhoopConnect();
      else if (id === 'oura') startOuraConnect();
    } else if (op === 'disconnect') {
      disconnectIntegration(id);
    }
    return;
  }
  const whoopBtn = e.target.closest('[data-settings-whoop-action]');
  if (whoopBtn) {
    const op = whoopBtn.dataset.settingsWhoopAction;
    if (op === 'clear') clearWhoopCreds();
    return;
  }
  const action = e.target.closest('[data-settings-action]')?.dataset.settingsAction;
  if (!action) return;
  if (action === 'delete-account' && typeof openDeleteAccountModal === 'function') openDeleteAccountModal();
  else if (action === 'save-location') saveLocationFromInput(e.target.closest('[data-settings-action]'));
  else if (action === 'link-google') {
    if (typeof linkGoogleAccount === 'function') linkGoogleAccount();
  } else if (action === 'unlink-google') {
    const email = e.target.closest('[data-settings-action="unlink-google"]')?.dataset.accountEmail;
    if (email) unlinkGoogleAccount(email);
  }
});

// Phase 1.6: save the user's city for the morning brief's weather line.
async function saveLocationFromInput(btn) {
  const input = document.getElementById('settingsLocationInput');
  if (!input) return;
  const city = input.value.trim();
  if (!city) {
    if (typeof showToast === 'function') showToast('Enter a city first', 'offline');
    return;
  }
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Sign in required');
    const res = await fetch('/.netlify/functions/beta-set-location', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ city }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.detail ? `${data.error}: ${data.detail}` : (data?.error || `HTTP ${res.status}`);
      throw new Error(msg);
    }
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    userSettings.location = { city: data.city, weather_label: data.weather_label };
    flashSettingsSaved('settingsLocationSaved');
    if (typeof showToast === 'function') showToast(`Location set to ${data.weather_label}`, 'ok');
    if (activeTool === 'settings') renderSettingsPage();
    // Auto-regenerate today's brief so the weather line picks up the new location
    // immediately instead of waiting for the next cron tick or manual cache bust.
    if (typeof homeBriefRefresh === 'function') {
      homeBriefRefresh(true).catch(e => console.warn('[settings] brief regen after location save failed', e));
    }
  } catch (err) {
    console.error('[settings] save location failed', err);
    if (typeof showToast === 'function') showToast(`Could not save location: ${err.message}`, 'offline');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-settings-whoop-form]');
  if (!form) return;
  e.preventDefault();
  const clientId     = form.client_id?.value?.trim();
  const clientSecret = form.client_secret?.value?.trim();
  if (!clientId || !clientSecret) return;
  const ok = await saveWhoopCreds(clientId, clientSecret);
  if (ok) startWhoopConnect();
});

async function startDropboxConnect() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    if (typeof showToast === 'function') showToast('Sign in required', 'offline');
    return;
  }
  const params = new URLSearchParams({
    client_id:          BETA_DROPBOX_CLIENT_ID,
    redirect_uri:       window.location.origin + '/.netlify/functions/beta-dropbox-auth',
    response_type:      'code',
    token_access_type:  'offline',     // required for a refresh_token
    state:              session.access_token,
  });
  window.location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
}

async function startWhoopConnect() {
  // Per-user model: the client_id was saved by the user via beta-whoop-creds
  // and loaded into userSettings.integrations.whoop.client_id at status time.
  const clientId = userSettings?.integrations?.whoop?.client_id;
  if (!clientId) {
    if (typeof showToast === 'function') showToast('Save your Whoop credentials first', 'offline');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    if (typeof showToast === 'function') showToast('Sign in required', 'offline');
    return;
  }
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  window.location.origin + '/.netlify/functions/beta-whoop-auth',
    response_type: 'code',
    scope:         'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement',
    state:         session.access_token,
  });
  window.location.href = 'https://api.prod.whoop.com/oauth/oauth2/auth?' + params;
}

async function saveWhoopCreds(clientId, clientSecret) {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      if (typeof showToast === 'function') showToast('Sign in required', 'offline');
      return false;
    }
    const res = await fetch('/.netlify/functions/beta-whoop-creds', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'set', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'save_failed' }));
      throw new Error(err.error || 'save_failed');
    }
    await loadIntegrationStatus('whoop');
    return true;
  } catch (e) {
    console.error('[settings] save whoop creds failed', e);
    if (typeof showToast === 'function') showToast(`Could not save credentials: ${e.message}`, 'offline');
    return false;
  }
}

async function clearWhoopCreds() {
  if (!confirm('Clear your Whoop developer credentials? This also disconnects Whoop if currently connected.')) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-whoop-creds', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'clear' }),
    });
    if (!res.ok) throw new Error('clear failed');
    if (userSettings?.integrations?.whoop) {
      userSettings.integrations.whoop = { configured: false, client_id: null, connected: false, email: null };
    }
    if (activeTool === 'settings') renderSettingsPage();
    if (typeof showToast === 'function') showToast('Whoop credentials cleared', 'ok');
  } catch (e) {
    console.error('[settings] clear whoop creds failed', e);
    if (typeof showToast === 'function') showToast('Could not clear credentials', 'offline');
  }
}

async function disconnectIntegration(id) {
  const cfg = INTEGRATIONS[id];
  if (!cfg) return;
  if (!confirm(cfg.confirmText)) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    if (!res.ok) throw new Error('disconnect failed');
    if (userSettings?.integrations?.[id]) {
      userSettings.integrations[id] = cfg.onDisconnect(userSettings.integrations[id]);
    }
    if (activeTool === 'settings') renderSettingsPage();
    if (typeof showToast === 'function') showToast(`${cfg.label} disconnected`, 'ok');
  } catch (e) {
    console.error(`[settings] ${id} disconnect failed`, e);
    if (typeof showToast === 'function') showToast(`Could not disconnect ${cfg.label}`, 'offline');
  }
}

async function startOuraConnect() {
  if (!BETA_OURA_CLIENT_ID) {
    if (typeof showToast === 'function') showToast('Oura client_id not yet configured', 'offline');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    if (typeof showToast === 'function') showToast('Sign in required', 'offline');
    return;
  }
  const params = new URLSearchParams({
    client_id:     BETA_OURA_CLIENT_ID,
    redirect_uri:  window.location.origin + '/.netlify/functions/beta-oura-auth',
    response_type: 'code',
    scope:         'email personal daily heartrate workout tag session spo2Daily ring_configuration',
    state:         session.access_token,
  });
  window.location.href = 'https://cloud.ouraring.com/oauth/authorize?' + params;
}


/* ── Phase 5 — Connected calendars panel ─────────────────────────── */

function renderConnectedCalendarsList() {
  const state = userSettings?.calendars;
  if (!state) return `<div class="settings-sub">Loading…</div>`;
  if (state.loading)        return `<div class="settings-sub">Loading your calendars…</div>`;
  if (state.error === 'no_token') return `<div class="settings-sub">Sign in with Google to manage connected calendars.</div>`;
  if (state.error)          return `<div class="settings-sub">Couldn't load calendars (${escapeHtml(state.error)}). Refresh to retry.</div>`;
  if (!state.items.length)  return `<div class="settings-sub">No calendars found.</div>`;

  // Group items by account_email. Primary ('') goes first.
  const groups = new Map();
  for (const c of state.items) {
    const key = c.account_email || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const orderedKeys = ['', ...[...groups.keys()].filter(k => k !== '').sort()];

  const groupHtml = orderedKeys.map(key => {
    const items = groups.get(key) || [];
    if (!items.length) return '';
    const isPrimary = key === '';
    const headerLabel = isPrimary ? 'Primary account' : escapeHtml(key);
    const disconnectBtn = isPrimary ? '' : `
      <button class="settings-btn-secondary" data-settings-action="unlink-google" data-account-email="${escapeHtml(key)}" style="font-size:var(--fs-meta);padding:4px 8px;">Disconnect</button>
    `;
    const rows = items.map(c => `
      <label class="settings-tab-row" style="display:flex;align-items:center;gap:10px;padding:6px 0;">
        <input type="checkbox" data-settings-action="toggle-calendar" data-cal-id="${escapeHtml(c.id)}" data-account-email="${escapeHtml(c.account_email || '')}" ${c.enabled ? 'checked' : ''}>
        ${c.color_hex ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escapeHtml(c.color_hex)};flex-shrink:0;"></span>` : ''}
        <span class="settings-tab-label" style="flex:1;min-width:0;">${escapeHtml(c.summary)}${c.primary ? ' <span class="settings-sub" style="display:inline">(primary)</span>' : ''}</span>
      </label>
    `).join('');
    return `
      <div class="settings-cal-group" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--edge);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
          <div class="settings-sub" style="margin:0;font-weight:600;color:var(--ink-2);">${headerLabel}</div>
          ${disconnectBtn}
        </div>
        ${rows}
      </div>
    `;
  }).join('');

  const addBtn = `
    <div style="margin-top:14px;">
      <button class="settings-btn-secondary" data-settings-action="link-google">Add Google account</button>
    </div>
  `;

  return groupHtml + addBtn;
}

// Persist a single calendar toggle, scoped to its source account email.
async function toggleConnectedCalendar(calId, accountEmail, enabled) {
  const acct = accountEmail || '';
  const item = userSettings?.calendars?.items?.find(c => c.id === calId && (c.account_email || '') === acct);
  if (!item) return;
  // Optimistic local update + saved-flash.
  item.enabled = enabled;
  const savedEl = document.getElementById('settingsCalendarsSaved');
  if (savedEl) { savedEl.style.opacity = '1'; savedEl.textContent = 'Saving…'; }
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('No session');
    const { error } = await db.from('google_calendars_synced').upsert({
      user_id:              session.user.id,
      google_calendar_id:   calId,
      google_account_email: acct,
      label:                item.summary,
      color_hex:            item.color_hex,
      enabled,
    }, { onConflict: 'user_id,google_account_email,google_calendar_id' });
    if (error) throw error;
    if (savedEl) {
      savedEl.textContent = 'Saved';
      setTimeout(() => { if (savedEl) savedEl.style.opacity = '0'; }, 1500);
    }
    // Trigger a journal refresh on next visit — clear in-memory event
    // caches so the new set of enabled calendars is reflected.
    if (typeof journalState !== 'undefined' && journalState?.calendarEvents) {
      journalState.calendarEvents.clear();
      journalState.enabledCalendarIds = null;
    }
  } catch (e) {
    console.warn('[settings] toggle calendar failed', e);
    item.enabled = !enabled;
    const cb = document.querySelector(`[data-settings-action="toggle-calendar"][data-cal-id="${calId.replace(/"/g, '\\"')}"][data-account-email="${acct.replace(/"/g, '\\"')}"]`);
    if (cb) cb.checked = !enabled;
    if (savedEl) { savedEl.textContent = 'Failed'; savedEl.style.color = 'var(--guava-700)'; }
    if (typeof showToast === 'function') showToast('Could not save calendar toggle', 'offline');
  }
}

// Disconnect a linked Google account: server revokes Google's refresh
// token and deletes the linked_google_accounts row + scoped toggles.
async function unlinkGoogleAccount(accountEmail) {
  if (!accountEmail) return;
  if (!confirm(`Disconnect ${accountEmail}? Calendars from this account will stop syncing.`)) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('No session');
    const res = await fetch('/.netlify/functions/beta-unlink-google-account', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_email: accountEmail }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail?.error || `status_${res.status}`);
    }
    if (typeof showToast === 'function') showToast(`Disconnected ${accountEmail}`, 'ok');
    // Reset caches and re-render.
    if (typeof journalState !== 'undefined' && journalState?.calendarEvents) {
      journalState.calendarEvents.clear();
      journalState.enabledCalendarIds = null;
    }
    await loadConnectedCalendars();
    if (typeof activeTool !== 'undefined' && activeTool === 'settings') renderSettingsPage();
  } catch (e) {
    console.warn('[settings] unlink google failed', e);
    if (typeof showToast === 'function') showToast('Could not disconnect account', 'offline');
  }
}
