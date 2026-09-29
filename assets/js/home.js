/* Resumeboard — landing page behaviour
 * Small on purpose: the only jobs are opening the auto-build dialog, running
 * the theme toggle, and marking the nav when it sticks.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var doc = global.document;

  var THEME_KEY = 'resumeboard:theme';

  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      doc.documentElement.setAttribute('data-theme', theme);
    } else {
      doc.documentElement.removeAttribute('data-theme');
    }
  }

  function nextTheme() {
    var explicit = currentTheme();
    var systemDark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = explicit ? explicit === 'dark' : systemDark;
    return isDark ? 'light' : 'dark';
  }

  function initTheme() {
    applyTheme(currentTheme());
    var btn = U.qs('#rb-theme-toggle');
    if (!btn) return;

    function paint() {
      var explicit = currentTheme();
      var systemDark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
      var isDark = explicit ? explicit === 'dark' : systemDark;
      btn.textContent = '';
      btn.appendChild(global.RB.icons.el(isDark ? 'sun' : 'moon'));
      btn.setAttribute('aria-label', isDark ? 'Switch to the light theme' : 'Switch to the dark theme');
      btn.setAttribute('data-tip', isDark ? 'Light theme' : 'Dark theme');
    }

    btn.addEventListener('click', function () {
      var t = nextTheme();
      try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode */ }
      applyTheme(t);
      paint();
      U.announce(t === 'dark' ? 'Dark theme on.' : 'Light theme on.');
    });

    if (global.matchMedia) {
      global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (!currentTheme()) paint();
      });
    }
    paint();
  }

  function initAutoBuild() {
    var open = function (ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      if (global.RB.onboarding && global.RB.onboarding.show) {
        global.RB.onboarding.show({ onGotoEditor: function () { global.location.href = 'editor.html#start'; } });
        return;
      }
      if (global.RB.autofill) { global.RB.autofill.open(); return; }
      global.location.href = 'editor.html#start';
    };
    U.qsa('[data-build]').forEach(function (el) { el.addEventListener('click', open); });

    if (/(?:^|[#&])build(?:=|$)/i.test(global.location.hash || '')) open();
  }

  /* The home page opens with the same start dialog the editor uses. It is
   * dismissible, and every option in it is something the reader came here for,
   * so there is nothing to gate it behind a first-run flag — a session is
   * reset on reload anyway, which is exactly when this box is worth showing. */
  function initWelcome() {
    if (!global.RB.onboarding || !global.RB.onboarding.show) return;
    /* Back/forward is a resumed visit, not an arrival. */
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type === 'back_forward') return;
    } catch (e) { /* keep going: the box is useful either way */ }
    global.setTimeout(function () {
      if (document.querySelector('.rb-modal')) return;
      global.RB.onboarding.show({
        onGotoEditor: function () { global.location.href = 'editor.html#start'; }
      });
    }, 380);
  }

  function initNav() {
    var nav = U.qs('#rb-nav');
    if (!nav) return;
    /* Scroll fires far faster than the page can paint. Coalesce to one write
     * per frame, and skip the DOM entirely unless the stuck state actually
     * flips — classList.toggle is cheap but it is not free, and the nav is
     * the only thing this page listens to during a scroll. */
    var stuck = null;
    var pending = false;
    function paint() {
      pending = false;
      var next = global.scrollY > 8;
      if (next === stuck) return;
      stuck = next;
      nav.classList.toggle('is-stuck', next);
    }
    function onScroll() {
      if (pending) return;
      pending = true;
      if (global.requestAnimationFrame) global.requestAnimationFrame(paint);
      else setTimeout(paint, 16);
    }
    paint();
    global.addEventListener('scroll', onScroll, { passive: true });
  }

  function init() {
    initTheme();
    initAutoBuild();
    initNav();
    initWelcome();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
