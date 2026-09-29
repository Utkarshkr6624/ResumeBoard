/* Resumeboard — responsive shell
 * ============================================================================
 * The one job this file has is the phone layout. Above MOBILE_MAX everything
 * below is inert: the rail is a docked column, the panel is a sidebar, and the
 * topbar shows its desktop bar. Below it the rail becomes a drawer that the
 * topbar has no control for, so this module supplies that control and the
 * scrim app.css already styles.
 *
 * It owns no styles of its own. app.css declares the drawer, the scrim and
 * the touch-target sizes; this only moves the body class and the focus.
 *
 * The drawer must not outlive a viewport change: rotate the phone and a rail
 * left open would sit over a layout that has a docked column of its own.
 */
(function (global) {
  'use strict';

  var U = global.RB && global.RB.utils;
  var bus = global.RB && global.RB.bus;
  var doc = global.document;
  if (!U || !doc) return;

  /* Must match MOBILE_MAX in ui/chrome.js: that is the width at which the
   * topbar swaps to the row this module's button lives in. */
  var MOBILE_MAX = 760;

  var button = null;
  var scrim = null;
  var rail = null;
  var lastFocus = null;
  var wide = null;

  function isDrawerMode() {
    return global.matchMedia && global.matchMedia('(max-width: ' + MOBILE_MAX + 'px)').matches;
  }

  function isOpen() {
    return doc.body.classList.contains('rb-rail-open');
  }

  function setState(open) {
    if (!button) return;
    doc.body.classList.toggle('rb-rail-open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      lastFocus = doc.activeElement;
      var first = rail && U.focusableIn(rail)[0];
      if (first) first.focus();
    } else if (lastFocus && lastFocus.isConnected) {
      lastFocus.focus();
      lastFocus = null;
    }
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    doc.body.classList.remove('rb-rail-open');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (returnFocus) {
      if (lastFocus && lastFocus.isConnected) lastFocus.focus();
      else if (button) button.focus();
      lastFocus = null;
    }
  }

  function onKeydown(ev) {
    if (!isOpen()) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(true); return; }
    if (ev.key === 'Tab' && rail) U.trapFocus(rail, ev);
  }

  /* Clicking a section is the whole point of opening the drawer, so the
   * drawer gets out of the way once the section has focus. Section menus and
   * the add-section picker mount in #rb-overlay-root, above the scrim, and
   * are deliberately not caught here. */
  function onRailClick(ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest('.rb-rail__row') : null;
    if (!row || !rail || !rail.contains(row)) return;
    var grip = ev.target.closest ? ev.target.closest('.rb-rail__grip, [data-tip]') : null;
    if (grip) return;
    close(false);
  }

  function build() {
    var bar = U.qs('.rb-topbar__mobile');
    if (!bar) return;

    var svg = global.RB.icons && global.RB.icons.svg
      ? global.RB.icons.svg('list', { size: 'sm' })
      : '';
    button = U.el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--icon rb-btn--ghost rb-tip rb-shell__drawer-btn',
      'aria-label': 'Sections',
      'aria-haspopup': 'true',
      'aria-controls': 'rb-rail',
      'aria-expanded': 'false',
      'data-tip': 'Sections',
      'data-action': 'rail',
      html: svg
    });
    button.addEventListener('click', function () { setState(!isOpen()); });

    /* The rail is the drawer's content, so its id has to exist before the
     * button can point at it. */
    rail = U.qs('#rb-rail');
    if (rail && !rail.id) rail.id = 'rb-rail';
    bar.insertBefore(button, bar.firstChild);

    scrim = U.el('div', { class: 'rb-scrim', 'aria-hidden': 'true' });
    scrim.addEventListener('click', function () { close(true); });
    var shell = U.qs('#rb-shell');
    if (shell) shell.appendChild(scrim);

    doc.addEventListener('keydown', onKeydown);
    if (rail) rail.addEventListener('click', onRailClick);
    if (bus && typeof bus.on === 'function') {
      bus.on('section:focus', function () { close(false); });
    }

    if (global.matchMedia) {
      wide = global.matchMedia('(min-width: ' + (MOBILE_MAX + 1) + 'px)');
      var onChange = function (ev) { if (ev.matches) close(false); };
      if (typeof wide.addEventListener === 'function') wide.addEventListener('change', onChange);
      else if (typeof wide.addListener === 'function') wide.addListener(onChange);
    }
  }

  function start() {
    if (button) return;
    if (!U.qs('#rb-shell')) return;
    build();
  }

  global.RB = global.RB || {};
  global.RB.shell = {
    isDrawerMode: isDrawerMode,
    isRailOpen: isOpen,
    closeRail: close
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window);
