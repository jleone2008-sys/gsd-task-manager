/* ══════════════════════════════════════════════════════════════
   GSDMotion — shared motion utilities (Phase 0 bedrock)

   Tiny WAAPI wrapper that every per-surface animation calls into.
   Centralizes:
     • prefers-reduced-motion guard (live boolean)
     • token reads from CSS custom properties (one source of truth)
     • per-session reveal keying via sessionStorage
     • a FLIP helper for list-reorder animations
     • SVG arc drawing for the home rings

   No dependencies. Loaded right after 00-router.js so every tab
   module can call into it without ordering ceremony. If this file
   fails to load, every helper degrades to a no-op (state changes
   still happen — just no animation). That's the contract.

   Paired with the @media (prefers-reduced-motion: reduce) block at
   the bottom of app.css which collapses CSS transitions/animations
   to ~0ms. JS-driven motion short-circuits via GSDMotion.reduced.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const M = {
    reduced: !!(mql && mql.matches),
  };
  if (mql && typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', (e) => { M.reduced = !!e.matches; });
  }

  // Token resolver — reads computed CSS custom property off :root,
  // falls back to a sensible default. Called per-animation; cheap
  // enough not to memoize and keeps live-edit of tokens working.
  function tokenMs(name, fallbackMs) {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!raw) return fallbackMs;
      if (raw.endsWith('ms')) return parseFloat(raw);
      if (raw.endsWith('s'))  return parseFloat(raw) * 1000;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallbackMs;
    } catch (_e) {
      return fallbackMs;
    }
  }

  function token(name, fallback) {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return raw || fallback;
    } catch (_e) {
      return fallback;
    }
  }

  /* ── countUp ─────────────────────────────────────────────────
     Animate the numeric text content of an element from `from` to
     `to` over `dur` ms. WAAPI is used only for timing; the text
     itself is mutated each frame. Pairs with `tabular-nums` on the
     element so glyph widths don't jitter the layout. */
  M.countUp = function countUp(el, opts) {
    if (!el) return;
    const o = opts || {};
    const to = (o.to != null) ? Number(o.to) : parseFloat(el.textContent) || 0;
    if (M.reduced) { el.textContent = String(Math.round(to)); return; }
    const from = (o.from != null) ? Number(o.from) : 0;
    const dur = o.dur || tokenMs('--dur-count', 600);
    const fmt = o.format || ((v) => String(Math.round(v)));
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      // ease-out cubic — matches --ease feel without parsing the bezier
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(to);
    };
    requestAnimationFrame(tick);
  };

  /* ── flip ────────────────────────────────────────────────────
     First-Last-Invert-Play for list reorders. Measures all element
     children of `parent` before `run()` mutates the DOM, then
     animates each child from its old position to its new one.
     Children that didn't exist before, or no longer exist after,
     are left alone (CSS keyframes or the caller can handle enter/
     exit). Stable identity via [data-flip-id] or element identity. */
  M.flip = function flip(parent, run, opts) {
    if (!parent || typeof run !== 'function') { if (typeof run === 'function') run(); return; }
    if (M.reduced) { run(); return; }
    const o = opts || {};
    const selector = o.selector || null;       // optional CSS selector for deep matching
    const idAttr   = o.idAttr   || null;       // optional data-attr name used as identity
    const collect = () => selector ? parent.querySelectorAll(selector) : parent.children;
    const before = new Map();
    // Identity: data-flip-id wins, fall back to caller-specified data attr,
    // then element id, then element identity (which only survives if `run`
    // mutates children rather than replacing them via innerHTML).
    const idOf = (n) =>
      (n.dataset && n.dataset.flipId) ||
      (idAttr && n.getAttribute && n.getAttribute(idAttr)) ||
      n.id ||
      n;
    for (const child of collect()) {
      before.set(idOf(child), child.getBoundingClientRect());
    }
    run();
    const dur = tokenMs('--dur-mid', 220);
    const easing = token('--ease', 'cubic-bezier(0.2,0.8,0.2,1)');
    for (const child of collect()) {
      const prev = before.get(idOf(child));
      if (!prev) continue;
      const next = child.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) continue;
      child.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: dur, easing }
      );
    }
  };

  /* ── reveal ──────────────────────────────────────────────────
     One-shot wrapper. If a session-key is given, the runner only
     fires once per session (sessionStorage). Used to avoid replaying
     the brief count-up every time the user flips back to Home. */
  M.reveal = function reveal(el, opts) {
    const o = opts || {};
    const run = typeof o.run === 'function' ? o.run : () => {};
    if (!el) { run(); return; }
    if (o.key) {
      try {
        const sk = 'gsd_motion_seen:' + o.key;
        if (sessionStorage.getItem(sk)) return;
        sessionStorage.setItem(sk, '1');
      } catch (_e) { /* private mode — fall through and animate */ }
    }
    if (M.reduced) { run(); return; }
    if (typeof IntersectionObserver === 'undefined') { run(); return; }
    const io = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { obs.disconnect(); run(); return; }
      }
    }, { threshold: 0.1 });
    io.observe(el);
  };

  /* ── drawArc ─────────────────────────────────────────────────
     Animate an SVG <circle> from empty (full dashoffset) to its
     intended fill amount. `to` is a fraction 0..1; if omitted, the
     element's current `stroke-dashoffset` is treated as the target
     and the animation just sweeps from 0% to that. */
  M.drawArc = function drawArc(circle, opts) {
    if (!circle) return;
    const o = opts || {};
    const r = parseFloat(circle.getAttribute('r')) || 0;
    if (!r) return;
    const C = 2 * Math.PI * r;
    const to = (o.to != null)
      ? Math.max(0, Math.min(1, Number(o.to)))
      : 1 - (parseFloat(circle.style.strokeDashoffset || circle.getAttribute('stroke-dashoffset') || 0) / C);
    const target = C * (1 - to);
    circle.style.strokeDasharray = String(C);
    if (M.reduced) { circle.style.strokeDashoffset = String(target); return; }
    const dur = o.dur || tokenMs('--dur-arc', 400);
    const easing = token('--ease', 'cubic-bezier(0.2,0.8,0.2,1)');
    const delay = o.delay || 0;
    circle.style.strokeDashoffset = String(C);
    circle.animate(
      [{ strokeDashoffset: C }, { strokeDashoffset: target }],
      { duration: dur, delay, easing, fill: 'forwards' }
    ).addEventListener('finish', () => { circle.style.strokeDashoffset = String(target); });
  };

  window.GSDMotion = M;
})();
