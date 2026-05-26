/* ══════════════════════════════════════════════════════════════
   INSIGHTS — subtab switcher + Patterns + Weekly views
   Phase 7, Commits 6-7.

   The Insights tab now has three subtab pills:
     - Timeline   (default — the unified notes + docs feed from 06-brain.js)
     - Patterns   (this commit — discovered patterns from weekly synthesis)
     - Weekly     (this commit — the current weekly_briefs row)

   Pill click hides/shows the right surface inside the existing
   notes-list container (#nlScroll, #insightsPatterns, #insightsWeekly).
   The Timeline view is the legacy notes/docs flow — untouched.

   Data layer for patterns + weekly is loaded on subtab activation
   so the Timeline view doesn't pay the cost when not needed.
══════════════════════════════════════════════════════════════ */

(function () {
  // ── State ─────────────────────────────────────────────────────
  let _patterns = [];
  let _patternsLoaded = false;
  let _patternsLoading = false;
  let _weeklyBrief = null;
  let _weeklyLoading = false;
  let _weeklyInflight = false;   // for the "Generate now" flow

  let _activeView = 'timeline';

  // ── Bootstrap ─────────────────────────────────────────────────
  function _onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      setTimeout(fn, 0);
    }
  }

  _onReady(() => {
    wireSubtabPills();
    // Prefetch patterns count so the pill badge is accurate on first paint
    waitForUser().then(() => refreshPatternsCount());
  });

  async function waitForUser() {
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      if (typeof currentUser !== 'undefined' && currentUser?.id) return;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ── Subtab pill wiring ────────────────────────────────────────
  function wireSubtabPills() {
    const bar = document.getElementById('insightsSubtabs');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-insights-view]');
      if (!pill) return;
      setActiveView(pill.dataset.insightsView);
    });
  }

  function setActiveView(view) {
    if (!['timeline', 'patterns', 'weekly'].includes(view)) return;
    _activeView = view;
    // Toggle pill active state
    document.querySelectorAll('[data-insights-view]').forEach(b => {
      b.classList.toggle('is-active', b.dataset.insightsView === view);
    });
    // Toggle surfaces
    const scroll   = document.getElementById('nlScroll');
    const docsTop  = document.getElementById('brainDocsSection');
    const patterns = document.getElementById('insightsPatterns');
    const weekly   = document.getElementById('insightsWeekly');
    const upload   = document.getElementById('brainUploadBtn');
    const uploadInput = document.getElementById('brainUploadInput');
    const uploadStatus = document.getElementById('brainUploadStatus');
    // Header pieces that are timeline-only
    const headerTitle = document.getElementById('nlTitle');

    const showTimeline = view === 'timeline';
    if (scroll)   scroll.style.display   = showTimeline ? '' : 'none';
    if (docsTop)  docsTop.style.display  = showTimeline ? '' : 'none';
    if (patterns) patterns.style.display = view === 'patterns' ? '' : 'none';
    if (weekly)   weekly.style.display   = view === 'weekly'   ? '' : 'none';
    if (upload)   upload.style.display   = showTimeline ? '' : 'none';
    if (uploadStatus) uploadStatus.style.display = showTimeline ? (uploadStatus.style.display) : 'none';

    if (view === 'patterns') loadPatterns();
    if (view === 'weekly')   loadWeekly();
  }

  // ── Patterns ──────────────────────────────────────────────────
  async function loadPatterns() {
    if (_patternsLoading) return;
    _patternsLoading = true;
    try {
      const { data, error } = await db.from('patterns_discovered')
        .select('id, label, description, evidence_window, n, strength_score, first_seen_at, last_seen_at, dismissed_by_user, metadata')
        .order('last_seen_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      _patterns = data || [];
      _patternsLoaded = true;
      renderPatterns();
      refreshPatternsCount();
    } catch (e) {
      console.warn('[insights] patterns load failed', e);
      renderPatternsError(e.message || 'load_failed');
    } finally {
      _patternsLoading = false;
    }
  }

  async function refreshPatternsCount() {
    try {
      const { count, error } = await db.from('patterns_discovered')
        .select('id', { count: 'exact', head: true })
        .eq('dismissed_by_user', false);
      if (error) return;
      const el = document.getElementById('insightsPatternsCount');
      if (el) el.textContent = String(count || 0);
    } catch (_) { /* ignore */ }
  }

  function renderPatterns() {
    const el = document.getElementById('insightsPatterns');
    if (!el) return;
    if (!_patterns.length) {
      el.innerHTML = `<div class="brain-empty">
        <div class="brain-empty-icon">📈</div>
        <div class="brain-empty-title">No patterns discovered yet</div>
        <div class="brain-empty-hint">Patterns get identified during the weekly synthesis (Sundays). Once you have ~2 weeks of data + at least one weekly brief, this view fills in.</div>
      </div>`;
      return;
    }
    const active = _patterns.filter(p => !p.dismissed_by_user);
    const dismissed = _patterns.filter(p => p.dismissed_by_user);
    el.innerHTML = `
      ${active.map(renderPatternCard).join('')}
      ${dismissed.length ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-4);margin:14px 0 8px">Dismissed</div>${dismissed.map(renderPatternCard).join('')}` : ''}
    `;
    // Wire delegated card actions
    el.onclick = onPatternClick;
  }

  function renderPatternsError(msg) {
    const el = document.getElementById('insightsPatterns');
    if (el) el.innerHTML = `<div class="brain-empty"><div class="brain-empty-title">Couldn't load patterns</div><div class="brain-empty-hint">${escapeHtml(msg)}</div></div>`;
  }

  function renderPatternCard(p) {
    const strength = (typeof p.strength_score === 'number') ? p.strength_score : 0;
    const strengthLabel = strength >= 0.7 ? 'STRONG' : strength >= 0.4 ? 'MODERATE' : 'WEAK';
    const strengthCls = strength < 0.4 ? ' is-weak' : '';
    const ew = p.evidence_window || {};
    const nText = p.n ? `${p.n} obs` : '';
    const winText = (ew.start_date && ew.end_date) ? `${ew.start_date} → ${ew.end_date}` : '';
    const dismissed = p.dismissed_by_user;

    return `<div class="pattern-card" data-pattern-id="${escapeHtml(p.id)}"${dismissed ? ' style="opacity:0.5"' : ''}>
      <div class="pattern-card-head">
        <div class="pattern-card-label">${escapeHtml(p.label || '')}</div>
        <span class="pattern-card-strength${strengthCls}">${strengthLabel}</span>
      </div>
      <div class="pattern-card-description">${escapeHtml(p.description || '')}</div>
      <div class="pattern-card-meta">
        ${nText ? `<span>${escapeHtml(nText)}</span>` : ''}
        ${winText ? `<span>${escapeHtml(winText)}</span>` : ''}
        ${p.last_seen_at ? `<span>Last seen ${escapeHtml(formatRelTime(p.last_seen_at))}</span>` : ''}
      </div>
      <div class="pattern-card-actions">
        ${dismissed
          ? `<button data-pattern-action="restore">Restore</button>`
          : `<button data-pattern-action="dismiss" class="is-destructive">Dismiss</button>`}
      </div>
    </div>`;
  }

  function onPatternClick(e) {
    const actionBtn = e.target.closest('[data-pattern-action]');
    const card = e.target.closest('[data-pattern-id]');
    if (!actionBtn || !card) return;
    const id = card.dataset.patternId;
    const action = actionBtn.dataset.patternAction;
    if (action === 'dismiss') dismissPattern(id);
    if (action === 'restore') restorePattern(id);
  }

  async function dismissPattern(id) {
    try {
      const { error } = await db.from('patterns_discovered')
        .update({ dismissed_by_user: true, dismissed_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      const p = _patterns.find(x => x.id === id);
      if (p) { p.dismissed_by_user = true; p.dismissed_at = new Date().toISOString(); }
      renderPatterns();
      refreshPatternsCount();
    } catch (e) { console.error('[insights] dismiss failed', e); }
  }

  async function restorePattern(id) {
    try {
      const { error } = await db.from('patterns_discovered')
        .update({ dismissed_by_user: false, dismissed_at: null })
        .eq('id', id);
      if (error) throw error;
      const p = _patterns.find(x => x.id === id);
      if (p) { p.dismissed_by_user = false; p.dismissed_at = null; }
      renderPatterns();
      refreshPatternsCount();
    } catch (e) { console.error('[insights] restore failed', e); }
  }

  // ── Weekly synthesis view ────────────────────────────────────
  async function loadWeekly() {
    if (_weeklyLoading) return;
    _weeklyLoading = true;
    try {
      const { data, error } = await db.from('weekly_briefs')
        .select('id, week_start_date, generated_at, model, structured, narrative, patterns_discovered_ids, confidence, status, failure_reason, total_iterations')
        .order('week_start_date', { ascending: false })
        .limit(1);
      if (error) throw error;
      _weeklyBrief = (data && data[0]) || null;
      renderWeekly();
    } catch (e) {
      console.warn('[insights] weekly load failed', e);
      renderWeeklyError(e.message || 'load_failed');
    } finally {
      _weeklyLoading = false;
    }
  }

  function renderWeekly() {
    const el = document.getElementById('insightsWeekly');
    if (!el) return;
    if (!_weeklyBrief) {
      el.innerHTML = `<div class="weekly-empty">
        <div class="brain-empty-icon">📅</div>
        <div class="brain-empty-title">No weekly brief yet</div>
        <div class="brain-empty-hint">The weekly synthesis runs Sundays at 18:00 local. You can also kick it manually below — takes about a minute.</div>
        <button class="weekly-empty-cta" data-weekly-action="generate">Generate this week's brief</button>
      </div>`;
      el.onclick = onWeeklyClick;
      return;
    }
    if (_weeklyBrief.status === 'processing') {
      el.innerHTML = `<div class="weekly-empty">
        <div class="brain-empty-icon">⏳</div>
        <div class="brain-empty-title">Generating…</div>
        <div class="brain-empty-hint">Opus is investigating your week. Usually 30–90 seconds. Refresh in a minute.</div>
      </div>`;
      // Poll
      pollWeeklyStatus();
      return;
    }
    if (_weeklyBrief.status === 'failed') {
      el.innerHTML = `<div class="weekly-empty">
        <div class="brain-empty-icon">⚠️</div>
        <div class="brain-empty-title">Last run failed</div>
        <div class="brain-empty-hint">${escapeHtml(_weeklyBrief.failure_reason || 'See server logs.')}</div>
        <button class="weekly-empty-cta" data-weekly-action="generate">Re-generate</button>
      </div>`;
      el.onclick = onWeeklyClick;
      return;
    }
    const s = _weeklyBrief.structured || {};
    const sections = Array.isArray(s.sections) ? s.sections : [];
    el.innerHTML = `<div class="weekly-card">
      <div class="weekly-card-eyebrow">Week of ${escapeHtml(_weeklyBrief.week_start_date)}</div>
      <div class="weekly-card-headline">${escapeHtml(s.headline || '')}</div>
      ${s.subhead ? `<div class="weekly-card-subhead">${escapeHtml(s.subhead)}</div>` : ''}
      ${sections.map(sec => `<div class="weekly-section">
        <div class="weekly-section-label">${escapeHtml(sec.label || '')}</div>
        <div class="weekly-section-body">${escapeHtml(sec.body || '')}</div>
      </div>`).join('')}
      ${_weeklyBrief.narrative ? `<div class="weekly-narrative">${escapeHtml(_weeklyBrief.narrative)}</div>` : ''}
      <div class="weekly-meta">
        ${_weeklyBrief.confidence ? `<span>Confidence: ${escapeHtml(_weeklyBrief.confidence)}</span>` : ''}
        ${_weeklyBrief.total_iterations ? `<span>${_weeklyBrief.total_iterations} tool calls</span>` : ''}
        ${(_weeklyBrief.patterns_discovered_ids || []).length ? `<span>${_weeklyBrief.patterns_discovered_ids.length} pattern${_weeklyBrief.patterns_discovered_ids.length === 1 ? '' : 's'} this run</span>` : ''}
        ${_weeklyBrief.model ? `<span>${escapeHtml(_weeklyBrief.model)}</span>` : ''}
      </div>
      <div class="pattern-card-actions">
        <button data-weekly-action="regenerate">Re-generate</button>
      </div>
    </div>`;
    el.onclick = onWeeklyClick;
  }

  function renderWeeklyError(msg) {
    const el = document.getElementById('insightsWeekly');
    if (el) el.innerHTML = `<div class="weekly-empty"><div class="brain-empty-title">Couldn't load weekly brief</div><div class="brain-empty-hint">${escapeHtml(msg)}</div></div>`;
  }

  function onWeeklyClick(e) {
    const btn = e.target.closest('[data-weekly-action]');
    if (!btn) return;
    const action = btn.dataset.weeklyAction;
    if (action === 'generate' || action === 'regenerate') {
      triggerWeeklyGeneration(btn);
    }
  }

  async function triggerWeeklyGeneration(btn) {
    if (_weeklyInflight) return;
    _weeklyInflight = true;
    if (btn) btn.disabled = true;
    try {
      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('not_signed_in');

      const res = await fetch('/.netlify/functions/beta-weekly-synthesis-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      // 202 Accepted (background) or 200 (sync error path)
      if (res.status !== 202 && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.detail || body?.error || `http_${res.status}`);
      }
      // Refresh the view so the poll picks up the processing row
      await loadWeekly();
    } catch (e) {
      console.error('[insights] weekly generate failed', e);
      alert('Generation failed: ' + (e.message || e));
    } finally {
      _weeklyInflight = false;
      if (btn) btn.disabled = false;
    }
  }

  async function pollWeeklyStatus() {
    // 3-minute budget at 4s intervals
    const start = Date.now();
    while (Date.now() - start < 180_000) {
      await new Promise(r => setTimeout(r, 4000));
      if (_activeView !== 'weekly') return;   // user navigated away
      const { data, error } = await db.from('weekly_briefs')
        .select('id, week_start_date, generated_at, model, structured, narrative, patterns_discovered_ids, confidence, status, failure_reason, total_iterations')
        .order('week_start_date', { ascending: false })
        .limit(1);
      if (error) continue;
      const fresh = data?.[0] || null;
      if (fresh && fresh.status !== 'processing') {
        _weeklyBrief = fresh;
        renderWeekly();
        return;
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatRelTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    const diff = (Date.now() - then) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
})();
