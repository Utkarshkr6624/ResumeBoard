/* Resumeboard — right panel shell
 *
 * Owns #rb-panel: a header, a vertical icon rail of registered panels, and a
 * content area. Panels are owned entirely by RB.panels; this file never touches
 * the resume model. The one rule it enforces for every panel is the mount
 * contract: a fresh, empty container on every show, and RB.lifecycle 'unmount'
 * before the previous one goes away.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var U = global.RB && global.RB.utils;
  var bus = global.RB && global.RB.bus;
  if (!U || !bus) return;

  var PREF_KEY = 'ui:panel';
  var SHEET_QUERY = '(max-width: 899.98px)';
  var STYLE_ID = 'rb-panel-style';

  var root = null;
  var els = {};
  var activeId = null;
  var scrollMemory = {};
  var collapsed = false;
  var mode = 'sidebar';
  var mql = null;
  var mountedCleanup = null;
  var emitting = false;
  var disposers = [];

  /* ---------------- Styles ----------------
   * The shell CSS lives here because this module owns the panel's structure
   * and no other file is guaranteed to have rules for it. Tokens only — every
   * colour, radius, and duration resolves through tokens.css. */

  var CSS = [
    '#rb-panel[data-rb-panel] {',
    '  --rb-pane-rail-w: 44px;',
    '  display: flex;',
    '  min-width: 0;',
    '  min-height: 0;',
    '  background: var(--rb-bg-elevated);',
    '  border-left: 1px solid var(--rb-border);',
    '}',
    /* min-width:0 on both: as flex items they default to min-width:auto, so
     * the header row's min-content width pushes the whole pane — and the page
     * with it — wider than the panel. */
    '#rb-panel .rb-pane { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }',
    '#rb-panel .rb-pane__head {',
    '  display: flex; align-items: center; gap: var(--rb-space-2);',
    '  min-width: 0;',
    '  min-height: 44px; padding: var(--rb-space-2) var(--rb-space-2) var(--rb-space-2) var(--rb-space-4);',
    '  border-bottom: 1px solid var(--rb-border-subtle);',
    '}',
    '#rb-panel .rb-pane__title { font-size: var(--rb-text-md); font-weight: 650; letter-spacing: -0.01em; min-width: 0; }',
    '#rb-panel .rb-pane__main { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }',
    '#rb-panel .rb-pane__rail {',
    '  display: flex; flex-direction: column; align-items: center; gap: var(--rb-space-1);',
    '  flex: none; width: var(--rb-pane-rail-w);',
    '  padding: var(--rb-space-2) 0;',
    '  border-right: 1px solid var(--rb-border-subtle);',
    '}',
    '#rb-panel .rb-pane__tab {',
    '  display: grid; place-items: center;',
    '  width: 32px; height: 32px; flex: none;',
    '  border: 0; border-radius: var(--rb-radius-sm);',
    '  background: transparent; color: var(--rb-text-muted);',
    '  cursor: pointer;',
    '  transition: background var(--rb-dur-fast) var(--rb-ease-out), color var(--rb-dur-fast) var(--rb-ease-out);',
    '}',
    '#rb-panel .rb-pane__tab:hover { background: var(--rb-bg-hover); color: var(--rb-text); }',
    '#rb-panel .rb-pane__tab[aria-selected="true"] { background: var(--rb-accent-50); color: var(--rb-accent-700); }',
    'html[data-theme="dark"] #rb-panel .rb-pane__tab[aria-selected="true"] { background: var(--rb-accent-900); color: var(--rb-accent-200); }',
    '@media (prefers-color-scheme: dark) {',
    '  html:not([data-theme="light"]) #rb-panel .rb-pane__tab[aria-selected="true"] { background: var(--rb-accent-900); color: var(--rb-accent-200); }',
    '}',
    '#rb-panel .rb-pane__view { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }',
    '#rb-panel .rb-pane__grab { display: none; }',
    '#rb-panel[data-mode="sidebar"] .rb-pane__view { border-left: 0; }',
    '#rb-panel[data-mode="sidebar"][data-collapsed="true"] .rb-pane__view { display: none; }',
    '#rb-panel[data-mode="sidebar"][data-collapsed="true"] .rb-pane__head {',
    '  flex-direction: column; justify-content: center; gap: 0; padding: var(--rb-space-2) 0;',
    '}',
    '#rb-panel[data-mode="sidebar"][data-collapsed="true"] .rb-pane__title { display: none; }',
    '#rb-panel[data-mode="sidebar"][data-collapsed="true"] .rb-pane__head .rb-spacer { display: none; }',
    '@media (max-width: 899.98px) {',
    '  #rb-panel[data-rb-panel] {',
    '    position: fixed; left: 0; right: 0; bottom: 0;',
    '    z-index: var(--rb-z-panel);',
    '    width: auto;',
    '    max-height: 72vh;',
    '    border-left: 0;',
    '    border-top: 1px solid var(--rb-border);',
    '    border-radius: var(--rb-radius-xl) var(--rb-radius-xl) 0 0;',
    '    box-shadow: var(--rb-shadow-xl);',
    '    transform: translateY(0);',
    '    transition: transform var(--rb-dur-base) var(--rb-ease-out);',
    '  }',
    '  #rb-panel .rb-pane__head { min-height: 40px; }',
    '  #rb-panel .rb-pane__grab { display: grid; place-items: center; width: 100%; height: 18px; margin: 0; border-radius: 0; }',
    '  #rb-panel .rb-pane__main { flex-direction: column; }',
    '  #rb-panel .rb-pane__rail {',
    '    flex-direction: row; justify-content: flex-start;',
    '    width: auto; overflow-x: auto; overflow-y: hidden;',
    '    padding: var(--rb-space-1) var(--rb-space-2);',
    '    border-right: 0; border-bottom: 1px solid var(--rb-border-subtle);',
    '  }',
    '  #rb-panel[data-collapsed="true"] { transform: translateY(calc(100% - 58px)); }',
    '  #rb-panel[data-collapsed="true"] .rb-pane__view { display: none; }',
    '  #rb-panel[data-collapsed="true"] .rb-pane__rail { display: none; }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  #rb-panel[data-rb-panel] { transition: none; }',
    '  #rb-panel .rb-pane__tab { transition: none; }',
    '}'
  ].join('\n');

  function injectStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* ---------------- Helpers ---------------- */

  function iconEl(name, size) {
    var icons = global.RB.icons;
    if (!icons) return null;
    try {
      if (typeof icons.el === 'function') return icons.el(name, { size: size || 'lg' });
      if (typeof icons.svg === 'function') {
        return U.el('span', { class: 'rb-i', html: icons.svg(name, { size: size || 'lg' }) }).firstChild;
      }
    } catch (err) {
      if (global.console) console.error('[panel] icon failed', err);
    }
    return null;
  }

  function iconButton(iconName, label, tip, onClick) {
    var btn = U.el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-tip',
      'aria-label': label,
      'data-tip': tip
    });
    var svg = iconEl(iconName);
    if (svg) btn.appendChild(svg);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function domId(prefix, id) { return prefix + String(id).replace(/[^\w-]+/g, '-'); }
  function tabId(id) { return domId('rb-panel-tab-', id); }
  function viewId(id) { return domId('rb-panel-view-', id); }

  /* Accepts a definition object, and tolerates a bare id string. */
  function normalize(def) {
    if (!def || typeof def !== 'object' || !def.id) return null;
    return Object.assign({}, def, {
      id: String(def.id),
      title: def.title || def.label || String(def.id),
      icon: typeof def.icon === 'string' ? def.icon : 'layout',
      order: typeof def.order === 'number' ? def.order : 0,
      mount: typeof def.mount === 'function' ? def.mount : null
    });
  }

  function registryPanels() {
    var list = global.RB.panels && typeof global.RB.panels.all === 'function' ? global.RB.panels.all() : [];
    return (list || [])
      .map(normalize)
      .filter(Boolean)
      .sort(function (a, b) { return a.order - b.order; });
  }

  function announce(message) { U.announce(message); }

  function toast(message, tone) {
    if (global.RB.ui && typeof global.RB.ui.toast === 'function') global.RB.ui.toast(message, { tone: tone || 'error' });
  }

  /* ---------------- Build ---------------- */

  function build() {
    root.textContent = '';
    root.setAttribute('data-rb-panel', '');
    root.setAttribute('data-collapsed', String(collapsed));

    var title = U.el('h2', { class: 'rb-pane__title rb-truncate', id: 'rb-panel-heading', text: '' });

    var collapse = iconButton('chevron-right', 'Collapse panel', 'Hide this panel and give the document the full width', function () {
      setCollapsed(!collapsed);
    });
    collapse.setAttribute('aria-expanded', 'true');
    collapse.setAttribute('aria-controls', 'rb-panel-content');

    var head = U.el('div', { class: 'rb-pane__head rb-panel-head' }, [
      title,
      U.el('span', { class: 'rb-spacer' }),
      collapse
    ]);

    var grab = iconButton('chevron-down', 'Collapse panel', 'Hide this panel', function () {
      setCollapsed(!collapsed);
    });
    grab.classList.add('rb-pane__grab');
    grab.setAttribute('aria-expanded', 'true');
    grab.setAttribute('aria-controls', 'rb-panel-content');

    var rail = U.el('div', {
      class: 'rb-pane__rail',
      id: 'rb-panel-rail',
      role: 'tablist',
      'aria-orientation': 'vertical',
      'aria-label': 'Editing panels'
    });

    var main = U.el('div', { class: 'rb-pane__main', id: 'rb-panel-content' }, [rail]);
    main.addEventListener('keydown', onRailKeydown);

    els = {
      pane: U.el('div', { class: 'rb-pane' }, [grab, head, main]),
      head: head,
      title: title,
      collapse: collapse,
      grab: grab,
      rail: rail,
      main: main
    };

    root.appendChild(els.pane);
  }

  function renderTabs(panels) {
    /* Rebuilding the rail drops focus, so put it back on the active tab. */
    var hadFocus = els.rail.contains(doc.activeElement);
    els.rail.textContent = '';
    if (!panels.length) return;

    panels.forEach(function (panel) {
      var selected = panel.id === activeId;
      var tab = U.el('button', {
        type: 'button',
        class: 'rb-pane__tab rb-tip',
        id: tabId(panel.id),
        role: 'tab',
        'aria-label': panel.title,
        'aria-selected': selected ? 'true' : 'false',
        /* Only the selected panel is in the DOM — the others are torn down on
         * the tab swap — so only that tab can point at one. A reference to an
         * element that does not exist is worse than no reference: a screen
         * reader follows it and finds nothing. */
        'aria-controls': selected ? viewId(panel.id) : null,
        'data-tip': panel.title,
        tabindex: selected ? '0' : '-1',
        dataset: { panelId: panel.id }
      });
      var svg = iconEl(panel.icon);
      if (svg) tab.appendChild(svg);
      tab.addEventListener('click', function () { setActive(panel.id, { expand: true }); });
      els.rail.appendChild(tab);
    });

    if (hadFocus && activeId) {
      var current = doc.getElementById(tabId(activeId));
      if (current) current.focus();
    }
  }

  function renderEmpty() {
    clearView();
    activeId = null;
    els.title.textContent = 'Panel';
    var box = U.el('div', { class: 'rb-empty' });
    var icon = iconEl('panel', 'xl');
    if (icon) box.appendChild(U.el('div', { class: 'rb-empty__icon' }, [icon]));
    box.appendChild(U.el('div', { class: 'rb-empty__title', text: 'No panels yet' }));
    box.appendChild(U.el('p', {
      class: 'rb-empty__text',
      text: 'Editor panels appear here as soon as their modules load. Nothing has registered one yet.'
    }));
    var retry = U.el('button', { type: 'button', class: 'rb-btn rb-btn--secondary', text: 'Check again' });
    retry.addEventListener('click', function () { refresh(); });
    box.appendChild(retry);
    els.main.appendChild(box);
  }

  function renderMountError(panel) {
    clearView();
    var box = U.el('div', { class: 'rb-empty' });
    var icon = iconEl('alert-circle', 'xl');
    if (icon) box.appendChild(U.el('div', { class: 'rb-empty__icon' }, [icon]));
    box.appendChild(U.el('div', { class: 'rb-empty__title', text: 'This panel did not load' }));
    box.appendChild(U.el('p', {
      class: 'rb-empty__text',
      text: 'The ' + panel.title + ' panel stopped while it was rendering. The rest of the editor is unaffected.'
    }));
    var retry = U.el('button', { type: 'button', class: 'rb-btn rb-btn--secondary', text: 'Try again' });
    retry.addEventListener('click', function () { setActive(panel.id, { force: true }); });
    box.appendChild(retry);
    els.main.appendChild(box);
  }

  function clearView() {
    if (typeof mountedCleanup === 'function') {
      try { mountedCleanup(); } catch (err) { if (global.console) console.error('[panel] cleanup failed', err); }
    }
    mountedCleanup = null;
    U.qsa(':scope > .rb-pane__view, :scope > .rb-empty', els.main).forEach(function (node) { node.remove(); });
  }

  function unmount(panelId) {
    if (panelId) rememberScroll(panelId);
    if (global.RB.lifecycle && typeof global.RB.lifecycle.emit === 'function') {
      /* `scope: 'panel'` is what tells app-wide modules (the binder, the rail,
         the paginator) that this is a tab swap and not the shell going away.
         panelId alone is not enough: the first mount has no active panel. */
      global.RB.lifecycle.emit('unmount', { scope: 'panel', panelId: panelId, container: els.main });
    }
    clearView();
  }

  /* A panel is torn down and rebuilt on every tab swap, so the scroll offset
   * has to outlive the DOM. Without this, stepping away from a long form and
   * back drops the user at the top and they lose their place. */
  function rememberScroll(panelId) {
    if (!els.main) return;
    var view = doc.getElementById(viewId(panelId));
    if (view) scrollMemory[panelId] = view.scrollTop;
  }

  function restoreScroll(panelId) {
    var top = scrollMemory[panelId];
    if (!top) return;
    U.requestIdle(function () {
      var view = doc.getElementById(viewId(panelId));
      if (view && activeId === panelId) view.scrollTop = top;
    }, 40);
  }

  function mountPanel(panel) {
    var view = U.el('div', {
      class: 'rb-pane__view rb-scroll',
      id: viewId(panel.id),
      role: 'tabpanel',
      'aria-labelledby': tabId(panel.id)
    });
    els.main.appendChild(view);
    if (!panel.mount) return;
    try {
      var cleanup = panel.mount(view);
      if (typeof cleanup === 'function') mountedCleanup = cleanup;
    } catch (err) {
      if (global.console) console.error('[panel] mount failed for "' + panel.id + '"', err);
      toast('The ' + panel.title + ' panel failed to open.');
      renderMountError(panel);
    }
  }

  /* ---------------- State ---------------- */

  function setActive(id, opts) {
    if (!root) return false;
    opts = opts || {};
    var panels = registryPanels();
    if (!panels.length) { renderEmpty(); return false; }

    var next = null;
    for (var i = 0; i < panels.length; i++) if (panels[i].id === id) { next = panels[i]; break; }
    if (!next) next = panels[0];

    if (next.id === activeId && !opts.force) {
      if (opts.expand && collapsed) setCollapsed(false);
      return true;
    }

    unmount(activeId);
    activeId = next.id;
    els.title.textContent = next.title;
    renderTabs(panels);
    mountPanel(next);

    emitting = true;
    try {
      if (global.RB.panels && typeof global.RB.panels.setActive === 'function') global.RB.panels.setActive(next.id);
      else bus.emit('panel:active', { id: next.id });
      bus.emit('panel:open', { panelId: next.id });
    } finally {
      emitting = false;
    }

    announce(next.title + ' panel');
    if (opts.expand && collapsed) setCollapsed(false);
    if (opts.scrollTop !== false) restoreScroll(next.id);
    savePrefs();
    return true;
  }

  function setCollapsed(next, opts) {
    if (!root) return;
    opts = opts || {};
    var value = !!next;
    if (value === collapsed && !opts.force) return;
    collapsed = value;
    root.setAttribute('data-collapsed', String(collapsed));

    /* Width is set inline so the collapse works regardless of what the shell
     * stylesheet does; sheet mode clears it so the media query owns layout. */
    root.style.width = mode === 'sheet' ? '' : (collapsed ? 'var(--rb-pane-rail-w)' : 'var(--rb-panel-w)');

    var open = !collapsed;
    [els.collapse, els.grab].forEach(function (btn) {
      if (!btn) return;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
      btn.setAttribute('data-tip', open ? 'Hide this panel' : 'Show this panel');
      btn.textContent = '';
      var svg = iconEl(open ? (mode === 'sheet' ? 'chevron-down' : 'chevron-right') : (mode === 'sheet' ? 'chevron-up' : 'chevron-left'), 'lg');
      if (svg) btn.appendChild(svg);
    });

    if (collapsed) announce('Panel hidden');
    else announce('Panel shown');
    if (opts.silent) return;

    emitting = true;
    try {
      if (collapsed) bus.emit('panel:close', {});
      else bus.emit('panel:open', { panelId: activeId });
    } finally {
      emitting = false;
    }
    savePrefs();
  }

  function applyMode() {
    if (!root) return;
    mode = mql && mql.matches ? 'sheet' : 'sidebar';
    root.setAttribute('data-mode', mode);
    if (els.rail) els.rail.setAttribute('aria-orientation', mode === 'sheet' ? 'horizontal' : 'vertical');
    root.style.width = mode === 'sheet' ? '' : (collapsed ? 'var(--rb-pane-rail-w)' : 'var(--rb-panel-w)');
    setCollapsed(collapsed, { force: true, silent: true });
  }

  function onRailKeydown(ev) {
    if (!els.rail.contains(ev.target)) return;
    var keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (keys.indexOf(ev.key) === -1) return;
    var tabs = U.qsa('.rb-pane__tab', els.rail);
    if (!tabs.length) return;
    ev.preventDefault();
    var index = tabs.indexOf(doc.activeElement);
    if (index === -1) index = 0;
    if (ev.key === 'Home') index = 0;
    else if (ev.key === 'End') index = tabs.length - 1;
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
    else index = (index + 1) % tabs.length;
    tabs[index].focus();
    setActive(tabs[index].dataset.panelId, { expand: true });
  }

  /* ---------------- Registry sync ---------------- */

  var lastSignature = '';

  function refresh() {
    if (!root) return;
    var panels = registryPanels();
    var signature = panels.map(function (p) { return p.id; }).join('|');
    if (signature !== lastSignature) {
      lastSignature = signature;
      renderTabs(panels);
    }
    if (!panels.length) { renderEmpty(); return; }
    var stillThere = panels.some(function (p) { return p.id === activeId; });
    if (!stillThere || !activeId) { setActive(activeId, { force: true }); return; }
    var def = findRaw(activeId);
    els.title.textContent = def ? def.title : activeId;
  }

  function findRaw(id) {
    var list = global.RB.panels && typeof global.RB.panels.all === 'function' ? global.RB.panels.all() : [];
    for (var i = 0; i < (list || []).length; i++) {
      var def = normalize(list[i]);
      if (def && def.id === id) return def;
    }
    return null;
  }

  /* AGENTS.md documents register('id', def) but the registry only accepts a
   * definition object, so the documented call style would be dropped. Normalise
   * it here rather than failing silently, and re-sync the rail on every
   * registration (modules may load after this file). */
  function patchRegistry() {
    var panels = global.RB.panels;
    if (!panels || typeof panels.register !== 'function' || panels.register.__rbPanelPatched) return;
    var original = panels.register;
    function patched(idOrDef, def) {
      var payload = typeof idOrDef === 'string' ? Object.assign({ id: idOrDef }, def) : idOrDef;
      var out = original.call(panels, payload);
      refresh();
      return out;
    }
    patched.__rbPanelPatched = true;
    panels.register = patched;
  }

  /* ---------------- Persistence ---------------- */

  var savePrefs = U.debounce(function () {
    if (!global.RB.idb) return;
    global.RB.idb.set(PREF_KEY, { tab: activeId, collapsed: collapsed }).catch(function () {});
  }, 200);

  function hydrate() {
    if (!global.RB.idb) return;
    global.RB.idb.get(PREF_KEY).then(function (stored) {
      if (!root) return;
      if (stored && typeof stored === 'object') {
        if (typeof stored.collapsed === 'boolean') collapsed = stored.collapsed;
        applyMode();
        if (stored.tab) setActive(stored.tab);
      }
    }).catch(function () {});
  }

  /* ---------------- Wiring ---------------- */

  function listen() {
    disposers.push(bus.on('panel:open', function (payload) {
      if (emitting || !root) return;
      var id = payload && payload.panelId;
      if (id) setActive(id, { expand: true });
      else setCollapsed(false);
    }));

    disposers.push(bus.on('panel:close', function () {
      if (emitting || !root) return;
      setCollapsed(true);
    }));

    disposers.push(bus.on('panel:active', function (payload) {
      if (emitting || !root || !payload) return;
      if (payload.id) setActive(payload.id, { expand: true });
    }));

    doc.addEventListener('keydown', onDocKeydown);

    if (global.matchMedia) {
      mql = global.matchMedia(SHEET_QUERY);
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', applyMode);
      else if (typeof mql.addListener === 'function') mql.addListener(applyMode);
    }
  }

  function isTyping(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    var tag = (node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function onDocKeydown(ev) {
    if (!root) return;
    if (ev.key === 'Escape' && mode === 'sheet' && !collapsed && activeId) {
      ev.stopPropagation();
      setCollapsed(true);
      return;
    }
    /* chrome.js guards its global keys on the element being typed in; this one
     * did not, so Ctrl+` — a plain character to type on a US layout — collapsed
     * the panel out from under a resume field that had focus. */
    if (isTyping(ev.target) || isTyping(doc.activeElement)) return;
    if (U.hotkey(ev, '`', { ctrl: true }) || U.hotkey(ev, '`', { meta: true })) {
      ev.preventDefault();
      setCollapsed(!collapsed);
    }
  }

  /* ---------------- Public API ---------------- */

  function init() {
    if (root) return true;
    root = U.qs('#rb-panel') || U.qs('.rb-panel');
    if (!root) return false;
    injectStyles();
    build();
    listen();
    /* A sheet that opens expanded covers ~77% of the stage on the first visit
     * (measured 461/595 at 360x640, 737/971 at 768x1024) and swallows the
     * wheel, so the resume cannot be scrolled or read until it is dismissed.
     * Start sheet mode collapsed; hydrate() below still restores whatever the
     * user last chose, so this only affects a first visit. */
    if (global.matchMedia && global.matchMedia(SHEET_QUERY).matches) collapsed = true;
    applyMode();
    refresh();
    hydrate();
    return true;
  }

  function destroy() {
    if (!root) return;
    unmount(activeId);
    activeId = null;
    disposers.forEach(function (off) { off(); });
    disposers = [];
    doc.removeEventListener('keydown', onDocKeydown);
    if (mql) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', applyMode);
      else if (typeof mql.removeListener === 'function') mql.removeListener(applyMode);
    }
    mql = null;
    savePrefs.cancel();
    root.textContent = '';
    root.style.width = '';
    root.removeAttribute('data-rb-panel');
    root.removeAttribute('data-mode');
    root.removeAttribute('data-collapsed');
    var style = doc.getElementById(STYLE_ID);
    if (style) style.remove();
    els = {};
    root = null;
  }

  global.RB.panel = {
    init: init,
    destroy: destroy,
    refresh: refresh,
    show: function (id) { return setActive(id, { expand: true }); },
    setActive: setActive,
    activeId: function () { return activeId; },
    collapse: function () { setCollapsed(true); },
    expand: function () { setCollapsed(false); },
    toggle: function () { setCollapsed(!collapsed); },
    setCollapsed: setCollapsed,
    isCollapsed: function () { return collapsed; },
    mode: function () { return mode; },
    isOpen: function () { return !collapsed; }
  };

  /* Patched at load, not at init: panel modules call register() while their own
   * script evaluates, which can be before the panel DOM exists. */
  patchRegistry();

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
