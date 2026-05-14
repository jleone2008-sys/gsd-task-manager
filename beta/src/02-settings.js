/* ══════════════════════════════════════════════════════════════
   SETTINGS PAGE — beta-only
   Sections: Tabs, Integrations, Backup & Restore, Danger zone.
   Reads/writes user_settings table; intersects admin tab_permissions
   with user-chosen enabled_tools so both layers control visibility.
═══════════════════════════════════════════════════════════════ */

let userSettings = null;

const BETA_DROPBOX_CLIENT_ID = '7rf801fqot1xx8n';
// Public OAuth client IDs. Set these once after creating apps in each vendor's
// developer console (developer.whoop.com / cloud.ouraring.com/oauth/applications).
// Until populated, the connect button stays disabled with a "not yet configured" tooltip.
const BETA_WHOOP_CLIENT_ID = '';
const BETA_OURA_CLIENT_ID  = '718bad26-5171-4dc7-addc-ca20cd1a4f73';

const SETTINGS_DEFAULTS = {
  enabled_tools: ['tasks', 'habits', 'notes', 'scratch', 'journal'],
  integrations: {},
  beta_enabled: false
};

const TAB_META = {
  habits:  { label: 'Habits',  desc: 'Track recurring habits and streaks.' },
  notes:   { label: 'Notes',   desc: 'Long-form notes organized by notebook.' },
  scratch: { label: 'Scratch', desc: 'A quick scratchpad for ad-hoc text.' },
  journal: { label: 'Journal', desc: 'Daily reflections, photos, and mood.' }
};

const INTEGRATIONS_META = [
  { id: 'dropbox', label: 'Dropbox',   desc: 'Grant Dropbox access for AI insights functionality.' },
  { id: 'oura',    label: 'Oura Ring', desc: 'Sleep, readiness, and activity from your Oura Ring.' },
  { id: 'whoop',   label: 'Whoop',     desc: 'Recovery, strain, and sleep from your Whoop.' }
];

async function loadUserSettings() {
  try {
    const { data, error } = await db.from('user_settings').select('*').maybeSingle();
    if (error) throw error;
    userSettings = data ? {
      enabled_tools: data.enabled_tools || SETTINGS_DEFAULTS.enabled_tools,
      integrations: data.integrations || {},
      beta_enabled: data.beta_enabled === true
    } : { ...SETTINGS_DEFAULTS };
  } catch (e) {
    console.warn('[settings] load failed', e);
    userSettings = { ...SETTINGS_DEFAULTS };
  }
  // Layer in live integration status from the server (per-integration status
  // lives in user_profiles, not user_settings).
  await Promise.all([
    loadDropboxStatus(),
    loadWhoopStatus(),
    loadOuraStatus(),
  ]);
}

async function loadDropboxStatus() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-dropbox?action=status', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    if (!userSettings.integrations) userSettings.integrations = {};
    userSettings.integrations.dropbox = {
      connected: !!data.connected,
      email:     data.dropbox_account_email || null,
    };
  } catch (e) {
    console.warn('[settings] dropbox status load failed', e);
  }
}

async function loadWhoopStatus() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-whoop?action=status', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    if (!userSettings.integrations) userSettings.integrations = {};
    userSettings.integrations.whoop = {
      connected: !!data.connected,
      email:     data.whoop_account_email || null,
    };
  } catch (e) {
    console.warn('[settings] whoop status load failed', e);
  }
}

async function loadOuraStatus() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-oura?action=status', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!userSettings) userSettings = { ...SETTINGS_DEFAULTS };
    if (!userSettings.integrations) userSettings.integrations = {};
    userSettings.integrations.oura = {
      connected: !!data.connected,
      email:     data.oura_account_email || null,
    };
  } catch (e) {
    console.warn('[settings] oura status load failed', e);
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
      enabled_tools: userSettings.enabled_tools,
      integrations: userSettings.integrations,
      beta_enabled: userSettings.beta_enabled === true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
  } catch (e) {
    console.error('[settings] save failed', e);
    if (typeof showToast === 'function') showToast('Could not save settings', 'offline');
  }
}

function getEffectiveTabs() {
  const adminPerms = (typeof currentUserProfile !== 'undefined' && currentUserProfile?.tab_permissions) || VALID_TABS;
  const userEnabled = userSettings?.enabled_tools || VALID_TABS;
  return VALID_TABS.filter(t =>
    adminPerms.includes(t) && (t === 'tasks' || userEnabled.includes(t))
  );
}

function getOrderedEffectiveTabs() {
  const effective = getEffectiveTabs();
  const userOrder = userSettings?.enabled_tools || VALID_TABS;
  // Tasks first; then user's order; then any remaining effective tabs not in user's order
  const result = ['tasks'].filter(t => effective.includes(t));
  for (const t of userOrder) if (effective.includes(t) && !result.includes(t)) result.push(t);
  for (const t of effective) if (!result.includes(t)) result.push(t);
  return result;
}

function applyEffectiveTabs() {
  const ordered = getOrderedEffectiveTabs();
  VALID_TABS.forEach(tool => {
    const allowed = ordered.includes(tool);
    const idx = ordered.indexOf(tool);
    document.querySelectorAll(`.mobile-nav-btn[data-tool="${tool}"]`).forEach(el => {
      el.style.display = allowed ? '' : 'none';
      el.style.order = idx >= 0 ? String(idx) : '';
    });
    document.querySelectorAll(`.sidebar-btn[data-tool="${tool}"]`).forEach(el => {
      el.style.display = allowed ? '' : 'none';
      el.style.order = idx >= 0 ? String(idx) : '';
    });
  });
  if (typeof activeTool !== 'undefined' && activeTool !== 'settings' && !ordered.includes(activeTool)) {
    if (typeof switchTool === 'function') switchTool('tasks');
  }
}

function ensureSettingsStyles() {
  if (document.getElementById('settingsStyles')) return;
  const style = document.createElement('style');
  style.id = 'settingsStyles';
  style.textContent = `
    .settings-page { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    .settings-section { background: var(--surface); border: 1px solid var(--edge); border-radius: var(--r-lg); padding: 22px 24px; margin-bottom: 18px; box-shadow: var(--shadow-card); }
    .settings-section.settings-danger { border-color: var(--guava-200); background: var(--guava-50); }
    .settings-h { font-size: 16px; font-weight: 600; color: var(--ink); margin-bottom: 4px; letter-spacing: -0.01em; }
    .settings-sub { font-size: 12px; color: var(--ink-3); line-height: 1.6; margin-bottom: 14px; }
    .settings-tab-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--edge); cursor: pointer; }
    .settings-tab-row:first-of-type { border-top: none; }
    .settings-tab-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--guava-700); cursor: pointer; flex-shrink: 0; }
    .settings-tab-row--locked { cursor: default; opacity: 0.7; }
    .settings-tab-row--locked input { cursor: not-allowed; }
    .settings-tab-label { font-size: 13px; font-weight: 600; color: var(--ink); min-width: 80px; }
    .settings-tab-desc { font-size: 12px; color: var(--ink-3); line-height: 1.5; flex: 1; }
    .settings-reorder { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
    .settings-reorder button { width: 22px; height: 16px; border: 1px solid var(--edge); background: var(--surface); border-radius: var(--r-sm); cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); font-size: 9px; line-height: 1; }
    .settings-reorder button:hover:not([disabled]) { background: var(--surface-2); color: var(--ink); }
    .settings-reorder button[disabled] { opacity: 0.3; cursor: not-allowed; }
    .settings-int-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .settings-int-card { background: var(--surface-2); border: 1px solid var(--edge); border-radius: var(--r-md); padding: 14px 16px; }
    .settings-int-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .settings-int-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .settings-int-status { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-4); }
    .settings-int-status.connected { color: var(--moss-fg); }
    .settings-int-desc { font-size: 11.5px; color: var(--ink-3); line-height: 1.55; margin-bottom: 10px; }
    .settings-btn-secondary { background: var(--surface); border: 1px solid var(--edge-strong); color: var(--ink-2); padding: 7px 14px; border-radius: var(--r-md); font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
    .settings-btn-secondary:hover:not([disabled]) { background: var(--surface-2); color: var(--ink); }
    .settings-btn-secondary[disabled] { opacity: 0.55; cursor: not-allowed; }
    .settings-btn-danger { background: var(--guava-700); border: 1px solid var(--guava-700); color: #fff; padding: 7px 14px; border-radius: var(--r-md); font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .settings-btn-danger:hover { background: var(--guava-800); }
    .settings-saved { display: inline-block; margin-left: 10px; font-size: 11px; color: var(--moss-fg); opacity: 0; transition: opacity 0.2s; }
    .settings-saved.visible { opacity: 1; }
    @media (max-width: 600px) { .settings-page { padding: 20px 14px 80px; } .settings-section { padding: 18px 16px; } }
  `;
  document.head.appendChild(style);
}

function renderSettingsPage() {
  ensureSettingsStyles();
  const root = document.getElementById('settingsContainer');
  if (!root) return;
  const enabled = userSettings?.enabled_tools || SETTINGS_DEFAULTS.enabled_tools;
  const integrations = userSettings?.integrations || {};

  // Build the order: enabled tabs in user order, then disabled tabs at the end
  const tabIds = Object.keys(TAB_META);
  const enabledOrdered = (enabled || []).filter(t => tabIds.includes(t));
  const disabledTabs = tabIds.filter(t => !enabledOrdered.includes(t));
  const orderedForRender = [...enabledOrdered, ...disabledTabs];

  const tabsHtml = orderedForRender.map((id, displayIdx) => {
    const meta = TAB_META[id];
    if (!meta) return '';
    const isEnabled = enabledOrdered.includes(id);
    const orderPos = enabledOrdered.indexOf(id);
    const canMoveUp = isEnabled && orderPos > 0;
    const canMoveDown = isEnabled && orderPos >= 0 && orderPos < enabledOrdered.length - 1;
    return `
    <div class="settings-tab-row">
      <div class="settings-reorder">
        <button data-settings-reorder="up" data-tab="${id}" ${canMoveUp ? '' : 'disabled'} title="Move up">▲</button>
        <button data-settings-reorder="down" data-tab="${id}" ${canMoveDown ? '' : 'disabled'} title="Move down">▼</button>
      </div>
      <input type="checkbox" data-settings-tab="${id}" ${isEnabled ? 'checked' : ''} />
      <span class="settings-tab-label">${meta.label}</span>
      <span class="settings-tab-desc">${meta.desc}</span>
    </div>`;
  }).join('');

  const clientIdByProvider = { dropbox: BETA_DROPBOX_CLIENT_ID, whoop: BETA_WHOOP_CLIENT_ID, oura: BETA_OURA_CLIENT_ID };
  const integrationsHtml = INTEGRATIONS_META.map(i => {
    const intData = integrations[i.id] || {};
    const conn = !!intData.connected;
    const statusLabel = conn
      ? (intData.email ? `Connected · ${escapeHtml(intData.email)}` : 'Connected')
      : 'Not connected';
    const configured = !!clientIdByProvider[i.id];
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
        <div class="settings-h">Tabs <span class="settings-saved" id="settingsTabsSaved">Saved</span></div>
        <div class="settings-sub">Choose which tabs appear in your sidebar. Tasks is always enabled.</div>
        <label class="settings-tab-row settings-tab-row--locked">
          <input type="checkbox" checked disabled />
          <span class="settings-tab-label">Tasks</span>
          <span class="settings-tab-desc">Always enabled.</span>
        </label>
        ${tabsHtml}
      </div>

      <div class="settings-section">
        <div class="settings-h">Integrations</div>
        <div class="settings-sub">Connect external services to enrich your journal entries with health data.</div>
        <div class="settings-int-grid">${integrationsHtml}</div>
      </div>

      <div class="settings-section">
        <div class="settings-h">Backup &amp; Restore</div>
        <div class="settings-sub">Export a full backup of all your data, or restore from a previous backup file.</div>
        <button class="settings-btn-secondary" data-settings-action="backup">Open Backup &amp; Restore</button>
      </div>

      ${(typeof currentUserProfile !== 'undefined' && currentUserProfile?.role === 'admin') ? `
      <div class="settings-section">
        <div class="settings-h">Beta access</div>
        <div class="settings-sub">When enabled, signing in to gsdtasks.com/app auto-redirects you to the beta app. Visit <code>/app?prod=1</code> to bypass for one session.</div>
        <label class="settings-tab-row">
          <input type="checkbox" id="settingsBetaEnabled" ${userSettings?.beta_enabled ? 'checked' : ''} />
          <span class="settings-tab-label">Use beta app</span>
          <span class="settings-tab-desc">Auto-redirect on prod sign-in.</span>
        </label>
      </div>` : ''}

      <div class="settings-section settings-danger">
        <div class="settings-h">Danger zone</div>
        <div class="settings-sub">This action is permanent and cannot be undone.</div>
        <button class="settings-btn-danger" data-settings-action="delete-account">Delete account &amp; data</button>
      </div>
    </div>`;
}

function flashSettingsSaved() {
  const el = document.getElementById('settingsTabsSaved');
  if (!el) return;
  el.classList.add('visible');
  clearTimeout(flashSettingsSaved._t);
  flashSettingsSaved._t = setTimeout(() => el.classList.remove('visible'), 1400);
}

document.addEventListener('change', e => {
  const betaCb = e.target.closest('#settingsBetaEnabled');
  if (betaCb) {
    saveUserSettings({ beta_enabled: betaCb.checked }).then(() => flashSettingsSaved());
    return;
  }
  const cb = e.target.closest('input[data-settings-tab]');
  if (!cb) return;
  const tab = cb.dataset.settingsTab;
  const current = (userSettings?.enabled_tools || SETTINGS_DEFAULTS.enabled_tools).slice();
  if (cb.checked) {
    if (!current.includes(tab)) current.push(tab);
  } else {
    const idx = current.indexOf(tab);
    if (idx >= 0) current.splice(idx, 1);
  }
  if (!current.includes('tasks')) current.unshift('tasks');
  saveUserSettings({ enabled_tools: current }).then(() => {
    applyEffectiveTabs();
    flashSettingsSaved();
    if (activeTool === 'settings') renderSettingsPage();
  });
});

document.addEventListener('click', e => {
  const reorderBtn = e.target.closest('[data-settings-reorder]');
  if (reorderBtn) {
    const tab = reorderBtn.dataset.tab;
    const direction = reorderBtn.dataset.settingsReorder;
    const current = (userSettings?.enabled_tools || SETTINGS_DEFAULTS.enabled_tools).slice();
    const idx = current.indexOf(tab);
    if (idx < 0) return;
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= current.length) return;
    [current[idx], current[swap]] = [current[swap], current[idx]];
    saveUserSettings({ enabled_tools: current }).then(() => {
      applyEffectiveTabs();
      flashSettingsSaved();
      if (activeTool === 'settings') renderSettingsPage();
    });
    return;
  }
  const intBtn = e.target.closest('[data-settings-int-action]');
  if (intBtn) {
    const op = intBtn.dataset.settingsIntAction;
    const id = intBtn.dataset.settingsIntId;
    if (op === 'connect') {
      if (id === 'dropbox') startDropboxConnect();
      else if (id === 'whoop') startWhoopConnect();
      else if (id === 'oura') startOuraConnect();
    } else if (op === 'disconnect') {
      if (id === 'dropbox') disconnectDropbox();
      else if (id === 'whoop') disconnectWhoop();
      else if (id === 'oura') disconnectOura();
    }
    return;
  }
  const action = e.target.closest('[data-settings-action]')?.dataset.settingsAction;
  if (!action) return;
  if (action === 'backup' && typeof openBackupModal === 'function') openBackupModal();
  else if (action === 'delete-account' && typeof openDeleteAccountModal === 'function') openDeleteAccountModal();
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
  if (!BETA_WHOOP_CLIENT_ID) {
    if (typeof showToast === 'function') showToast('Whoop client_id not yet configured', 'offline');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    if (typeof showToast === 'function') showToast('Sign in required', 'offline');
    return;
  }
  const params = new URLSearchParams({
    client_id:     BETA_WHOOP_CLIENT_ID,
    redirect_uri:  window.location.origin + '/.netlify/functions/beta-whoop-auth',
    response_type: 'code',
    scope:         'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement',
    state:         session.access_token,
  });
  window.location.href = 'https://api.prod.whoop.com/oauth/oauth2/auth?' + params;
}

async function disconnectWhoop() {
  if (!confirm('Disconnect Whoop? GSD will no longer sync your Whoop data. Historical data already synced will remain in your account.')) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-whoop', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    if (!res.ok) throw new Error('disconnect failed');
    if (userSettings?.integrations?.whoop) {
      userSettings.integrations.whoop = { connected: false, email: null };
    }
    if (activeTool === 'settings') renderSettingsPage();
    if (typeof showToast === 'function') showToast('Whoop disconnected', 'ok');
  } catch (e) {
    console.error('[settings] whoop disconnect failed', e);
    if (typeof showToast === 'function') showToast('Could not disconnect Whoop', 'offline');
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

async function disconnectOura() {
  if (!confirm('Disconnect Oura? GSD will no longer sync your Oura Ring data. Historical data already synced will remain in your account.')) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-oura', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    if (!res.ok) throw new Error('disconnect failed');
    if (userSettings?.integrations?.oura) {
      userSettings.integrations.oura = { connected: false, email: null };
    }
    if (activeTool === 'settings') renderSettingsPage();
    if (typeof showToast === 'function') showToast('Oura disconnected', 'ok');
  } catch (e) {
    console.error('[settings] oura disconnect failed', e);
    if (typeof showToast === 'function') showToast('Could not disconnect Oura', 'offline');
  }
}

async function disconnectDropbox() {
  if (!confirm('Disconnect Dropbox? GSD will no longer be able to access your Dropbox files. Any folders previously shared with GSD will remain shared until you remove them from your Dropbox account.')) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const res = await fetch('/.netlify/functions/beta-dropbox', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    if (!res.ok) throw new Error('disconnect failed');
    if (userSettings?.integrations?.dropbox) {
      userSettings.integrations.dropbox = { connected: false, email: null };
    }
    if (activeTool === 'settings') renderSettingsPage();
    if (typeof showToast === 'function') showToast('Dropbox disconnected', 'ok');
  } catch (e) {
    console.error('[settings] dropbox disconnect failed', e);
    if (typeof showToast === 'function') showToast('Could not disconnect Dropbox', 'offline');
  }
}
