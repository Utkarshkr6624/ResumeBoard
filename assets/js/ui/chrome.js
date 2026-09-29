/* Resumeboard — top application chrome
 *
 * The chrome owns everything above the resume: identity, the resume title,
 * history, theme, and the routes out of the app (share, export, import, reset).
 *
 * Layout rules are injected from this module instead of a stylesheet. No other
 * module styles the internals of #rb-topbar, and this module may not add CSS
 * files, so the rules have to travel with the markup they describe.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var bus = RB.bus;
  var doc = global.document;

  var el = U.el;
  var qs = U.qs;

  var THEME_KEY = 'resumeboard:theme';
  var THEMES = ['system', 'light', 'dark'];
  var STYLE_ID = 'rb-chrome-css';
  var MOBILE_MAX = 760;

  var store = null;
  var theme = 'system';
  var host = null;
  var mounted = false;
  var subs = [];
  var titles = [];
  var titleDebounce = null;
  var lastTitleInput = null;

  var undoBtns = [];
  var redoBtns = [];
  var themeBtns = [];

  /* ---------------- tokens-only layout ---------------- */

  var CSS = [
    '.rb-topbar{display:block;background:var(--rb-bg-elevated);border-bottom:1px solid var(--rb-border);position:relative;z-index:var(--rb-z-header)}',
    '.rb-topbar__inner{display:flex;align-items:center;gap:var(--rb-space-2);height:var(--rb-topbar-h);padding:0 var(--rb-space-3)}',
    '.rb-topbar__brand{display:flex;align-items:center;gap:var(--rb-space-2);color:var(--rb-text);user-select:none}',
    '.rb-mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;color:var(--rb-text)}',
    '.rb-mark svg{width:22px;height:22px}',
    '.rb-topbar__wordmark{font-size:var(--rb-text-md);font-weight:650;letter-spacing:-0.01em;white-space:nowrap}',
    '.rb-topbar__titlefield{width:clamp(120px,24vw,300px);flex:0 1 auto}',
    '.rb-topbar__title{width:100%;background:transparent;border-color:transparent}',
    '.rb-topbar__title:hover{border-color:var(--rb-border-subtle)}',
    '.rb-topbar__actions{display:flex;align-items:center;gap:var(--rb-space-1);flex:none}',
    '.rb-topbar__mobile{display:none;align-items:center;gap:var(--rb-space-1);height:var(--rb-subbar-h);padding:0 var(--rb-space-2);border-top:1px solid var(--rb-border-subtle)}',
    '.rb-topbar__mobile .rb-topbar__titlefield{flex:1 1 auto;width:auto}',
    '.rb-kbdlist{display:grid;grid-template-columns:1fr auto;gap:var(--rb-space-2) var(--rb-space-6);align-items:center;margin:0}',
    '.rb-kbdlist dt{color:var(--rb-text-secondary);font-size:var(--rb-text-base)}',
    '.rb-kbdlist dd{margin:0;text-align:right}',
    '.rb-note{margin:0 0 var(--rb-space-3);color:var(--rb-text-secondary);font-size:var(--rb-text-base);line-height:1.55;max-width:56ch}',
    '.rb-note:last-child{margin-bottom:0}',
    '@media (max-width:' + MOBILE_MAX + 'px){',
    '.rb-topbar__inner{display:none}',
    '.rb-topbar__mobile{display:flex}',
    '}',
    '@media print{.rb-topbar{display:none!important}}'
  ].join('');

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  /* ---------------- small helpers ---------------- */

  function ic(name, size) {
    if (!RB.icons || typeof RB.icons.svg !== 'function') return '';
    return RB.icons.svg(name, size ? { size: size } : null);
  }

  function iconButton(opts) {
    return el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--icon rb-tip' + (opts.small ? ' rb-btn--sm' : '') + ' ' + (opts.cls || 'rb-btn--ghost'),
      'aria-label': opts.label,
      'data-tip': opts.tip || opts.label,
      'data-action': opts.action || null,
      disabled: opts.disabled ? true : null,
      html: ic(opts.icon, opts.small ? 'sm' : null)
    });
  }

  function toast(message, tone, action) {
    var opts = { tone: tone || 'info' };
    if (action && action.label) opts.action = action;
    /* Returned so callers that own a transient toast can take it back down
     * when the work it was waiting on finishes. */
    if (RB.ui && RB.ui.toast) return RB.ui.toast(message, opts);
    return null;
  }

  function on(node, type, handler) {
    if (!node) return;
    node.addEventListener(type, handler);
  }

  /* A feature module that does not exist yet is a gap, not a crash. */
  function callFeature(ns, names, missingMessage) {
    if (!ns) { toast(missingMessage, 'warn'); return false; }
    var fn = typeof ns === 'function' ? ns : null;
    for (var i = 0; i < names.length && !fn; i++) {
      if (typeof ns[names[i]] === 'function') fn = ns[names[i]];
    }
    if (!fn) { toast(missingMessage, 'warn'); return false; }
    try {
      fn();
    } catch (err) {
      toast('That did not open. ' + (err && err.message ? err.message : 'Try again.'), 'error');
    }
    return true;
  }

  function openMenu(anchor, items) {
    if (!anchor || !RB.ui) return null;
    if (typeof RB.ui.menu === 'function') return RB.ui.menu(anchor, items, { align: 'end' });

    var list = el('div', { role: 'menu', class: 'rb-col', style: 'gap:1px' });
    items.forEach(function (item) {
      if (item === '-') { list.appendChild(el('div', { class: 'rb-pop__sep' })); return; }
      if (item.label && !item.onClick) { list.appendChild(el('div', { class: 'rb-pop__label', text: item.label })); return; }
      var node = el('button', { type: 'button', class: 'rb-pop__item', role: 'menuitem' });
      if (item.icon) node.appendChild(el('span', { html: ic(item.icon, 'sm') }));
      node.appendChild(el('span', { text: item.label || '' }));
      if (item.kbd) node.appendChild(el('span', { class: 'rb-spacer' }));
      if (item.kbd) node.appendChild(el('span', { class: 'rb-kbd', text: item.kbd }));
      on(node, 'click', function () {
        if (item.onClick) item.onClick();
        if (RB.ui.closePopover) RB.ui.closePopover();
      });
      list.appendChild(node);
    });
    return RB.ui.popover(anchor, list, { align: 'end' });
  }

  /* ---------------- keyboard hints ---------------- */

  function isMac() { return !!(U.isMac && U.isMac()); }

  function modKey() { return isMac() ? '⌘' : 'Ctrl'; }
  function shiftKey() { return isMac() ? '⇧' : 'Shift'; }
  function altKey() { return isMac() ? '⌥' : 'Alt'; }

  function hint(parts) {
    return parts.map(function (p) {
      if (p === 'mod') return modKey();
      if (p === 'shift') return shiftKey();
      if (p === 'alt') return altKey();
      return p.toUpperCase();
    }).join(isMac() ? '' : '+');
  }

  var SHORTCUTS = [
    { keys: ['mod', 'z'], label: 'Undo the last change' },
    { keys: ['mod', 'shift', 'z'], label: 'Redo' },
    { keys: ['mod', 's'], label: 'Save to this browser now' },
    { keys: ['mod', 'p'], label: 'Print or save as PDF' },
    { keys: ['mod', 'f'], label: 'Find text on the page' },
    { keys: ['mod', '/'], label: 'Open this list' },
    { keys: ['esc'], label: 'Close a dialog or menu' }
  ];

  /* ---------------- theme ---------------- */

  function readStoredTheme() {
    try {
      var v = global.localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(v) === -1 ? 'system' : v;
    } catch (e) {
      return 'system';
    }
  }

  function writeStoredTheme(value) {
    try { global.localStorage.setItem(THEME_KEY, value); } catch (e) {}
  }

  function applyTheme() {
    var root = doc.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    renderTheme();
  }

  function renderTheme() {
    var next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    var label = 'Theme: ' + theme + '. Switch to ' + next + '.';
    themeBtns.forEach(function (btn) {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('data-tip', label);
      btn.innerHTML = ic(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor');
    });
  }

  function setTheme(value, announce) {
    if (THEMES.indexOf(value) === -1) return;
    theme = value;
    writeStoredTheme(theme);
    applyTheme();
    if (announce) U.announce('Theme set to ' + theme + '.');
  }

  function cycleTheme() { setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length], true); }

  /* ---------------- store-bound state ---------------- */

  function refreshHistory() {
    var canUndo = !!(store && store.canUndo && store.canUndo());
    var canRedo = !!(store && store.canRedo && store.canRedo());
    undoBtns.forEach(function (btn) { btn.disabled = !canUndo; });
    redoBtns.forEach(function (btn) { btn.disabled = !canRedo; });
  }

  function doUndo() {
    if (!store) return;
    if (!store.undo()) toast('Nothing left to undo.', 'info');
    refreshHistory();
  }

  function doRedo() {
    if (!store) return;
    if (!store.redo()) toast('Nothing to redo.', 'info');
    refreshHistory();
  }

  /* The store has no state until RB.store.load() resolves; reads before that
   * throw, and the chrome mounts before hydration finishes. */
  function titleValue() {
    if (!store) return null;
    try { return store.getField('meta.title'); } catch (err) { return null; }
  }

  function commitTitle(node, trim, retried) {
    if (!store || !node) return;
    var value = node.value;
    if (trim) value = value.replace(/^\s+|\s+$/g, '');
    if (store.isReady && !store.isReady()) {
      if (retried) return;
      store.whenReady().then(function () { commitTitle(node, trim, true); });
      return;
    }
    if (value === titleValue()) return;
    store.setField('meta.title', value);
  }

  function syncTitle() {
    var value = titleValue();
    if (typeof value !== 'string') return;
    titles.forEach(function (node) {
      if (node !== doc.activeElement) node.value = value;
    });
  }

  function saveNow() {
    if (!store || !store.persistNow) return;
    store.persistNow().then(function () {
      toast('Saved to this browser.', 'success');
    }).catch(function () {
      toast('This browser would not let the app save. Your work is still in the tab.', 'error');
    });
  }

  /* ---------------- menus ---------------- */

  var FORMAT_LABELS = {
    pdf: 'PDF',
    docx: 'Word document',
    odt: 'OpenDocument',
    rtf: 'RTF',
    html: 'Web page',
    json: 'JSON backup',
    txt: 'Plain text',
    md: 'Markdown',
    markdown: 'Markdown',
    png: 'PNG image'
  };

  function formatLabel(name) {
    var key = String(name).replace(/download$/i, '').toLowerCase();
    if (FORMAT_LABELS[key]) return FORMAT_LABELS[key];
    return key.replace(/[^a-z0-9]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }).trim() || String(name);
  }

  /* Exporters register after this module loads, so the list is rebuilt on open. */
  function exportFormats() {
    var ns = RB.exporters;
    if (!ns) return [];
    if (typeof ns.list === 'function') {
      try {
        var listed = ns.list();
        if (Array.isArray(listed) && listed.length) return listed;
      } catch (e) {}
    }
    return Object.keys(ns).filter(function (key) {
      return typeof ns[key] === 'function' && /download$/i.test(key);
    });
  }

  function runExporter(name, entry) {
    var ns = RB.exporters;
    var fn = null;
    if (typeof entry === 'function') fn = entry;
    else if (entry && typeof entry.run === 'function') fn = entry.run;
    else if (entry && typeof entry.download === 'function') fn = entry.download;
    else if (ns && typeof ns[name] === 'function') fn = ns[name];
    if (!fn) { toast(formatLabel(name) + ' cannot be exported from here.', 'warn'); return; }

    var result;
    try {
      /* txtDownload and jsonDownload take the resume; without it they return
         null and the click does nothing the user can see. */
      result = fn(RB.store && RB.store.get ? RB.store.get() : undefined);
    } catch (err) {
      toast('Export failed. ' + (err && err.message ? err.message : 'Try again.'), 'error');
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(function (value) {
        if (value === false) toast('Export cancelled.', 'info');
      }, function (err) {
        toast('Export failed. ' + (err && err.message ? err.message : 'Try again.'), 'error');
      });
    }
  }

  function openExportMenu(anchor) {
    var target = anchor || qs('#rb-export-btn');
    if (!target) return;
    var formats = exportFormats();
    if (!formats.length) {
      var empty = el('p', { class: 'rb-hint', style: 'padding:var(--rb-space-3);margin:0' });
      empty.textContent = 'No export formats are registered.';
      if (RB.ui && RB.ui.popover) RB.ui.popover(target, empty, { align: 'end' });
      return;
    }
    openMenu(target, formats.map(function (entry) {
      var name = typeof entry === 'string' ? entry : (entry.id || entry.key || entry.label);
      return {
        label: (entry && entry.label) || formatLabel(name),
        icon: (entry && entry.icon) || 'download',
        onClick: function () { runExporter(name, entry); }
      };
    }));
  }

  function openImport() {
    callFeature(RB.importer || RB.import, ['open', 'pick', 'choose', 'start', 'dialog', 'menu'],
      'Import is not available right now.');
  }

  /* A file:// link can only ever point at the reader's own disk, so offering it
   * would be worse than saying nothing. Send them to the backup instead. */
  function shareNeedsWebUrl() {
    return !global.location || global.location.protocol === 'file:';
  }

  function shareUnavailableBody(reason) {
    var body = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-3)' });
    if (reason) body.appendChild(el('p', { class: 'rb-hint', text: reason }));
    body.appendChild(el('p', {
      class: 'rb-hint',
      text: 'This copy is open straight from a file on your computer, so a link would only point back at your own disk — anyone you sent it to would not be able to open it. A backup file travels anywhere.'
    }));
    return body;
  }

  function shareAsBackup(closeModal) {
    var formats = exportFormats();
    var json = formats.filter(function (f) { return /json/i.test(String(f)); })[0];
    if (!json) { toast('A JSON backup is not available here.', 'warn'); return; }
    runExporter(json);
    toast('Backup saved. Send that file instead of a link.', 'success');
    if (closeModal) closeModal();
  }

  function openShareFallback(reason) {
    if (!RB.ui || !RB.ui.modal) { toast(reason, 'warn'); return; }
    var m = RB.ui.modal({
      title: 'Sharing needs a web address',
      body: shareUnavailableBody(reason),
      actions: [{
        label: 'Save a JSON backup',
        primary: true,
        onClick: function () { shareAsBackup(m.close); }
      }, { label: 'Close', onClick: function () { m.close(); } }]
    });
  }

  function openShare() {
    var share = RB.share;
    /* RB.share is a codec (encode/decode/url), not a dialog. The surface is
     * built here rather than delegated, or the button has nothing to call. */
    if (!share || typeof share.url !== 'function') {
      openShareFallback('Sharing is not available right now.');
      return;
    }
    if (shareNeedsWebUrl()) {
      openShareFallback(null);
      return;
    }

    var pending = toast('Building a share link…', 'info');
    share.url(RB.store && RB.store.get ? RB.store.get() : undefined, { includePhoto: false })
      .then(function (link) {
        if (typeof pending === 'function') pending();
        showShareLink(link);
      })
      .catch(function (err) {
        if (typeof pending === 'function') pending();
        openShareFallback(err && err.message ? err.message : 'This resume could not be turned into a link.');
      });
  }

  function showShareLink(link) {
    var tooLong = RB.share.MAX_URL_CHARS && link.length > RB.share.MAX_URL_CHARS;
    var body = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-3)' });
    var id = 'rb-share-link';
    body.appendChild(el('label', { class: 'rb-label', for: id, text: 'Share link' }));
    var input = el('input', {
      type: 'text', id: id, class: 'rb-input', value: link, readonly: true, spellcheck: 'false'
    });
    body.appendChild(input);

    if (tooLong) {
      body.appendChild(el('p', {
        class: 'rb-hint',
        text: 'This resume is long enough that some email and chat apps will cut the link off. A backup file is the safer way to send it.'
      }));
    } else {
      body.appendChild(el('p', {
        class: 'rb-hint',
        text: 'Anyone with this link opens a copy of the resume. Nothing is uploaded — the whole resume travels inside the link itself.'
      }));
    }

    var actions = [];
    if (tooLong) {
      actions.push({
        label: 'Save a JSON backup', primary: true,
        onClick: function () { shareAsBackup(m.close); }
      });
      actions.push({ label: 'Close', onClick: function () { m.close(); } });
    } else {
      actions.push({
        label: 'Copy link', primary: true,
        onClick: function () {
          var done = function () { toast('Link copied.', 'success'); m.close(); };
          if (typeof U.copyText === 'function') {
            U.copyText(link).then(done, function () { selectAll(); });
          } else selectAll();
        }
      });
      actions.push({ label: 'Close', onClick: function () { m.close(); } });
    }

    function selectAll() {
      try { input.focus(); input.select(); } catch (e) { /* nothing to select */ }
      toast('Press Ctrl+C to copy the selected link.', 'info');
    }

    var m = RB.ui.modal({ title: 'Share this resume', body: body, actions: actions, wide: true });
    U.requestIdle(function () { try { input.focus(); input.select(); } catch (e) { /* no-op */ } }, 60);
  }

  /* Auto-build owns its own focus handoff, so the menu item is a thin delegate
   * rather than a second caller that could disagree about where focus goes. */
  function openAutofill() {
    if (RB.onboarding && typeof RB.onboarding.openAutofill === 'function') {
      RB.onboarding.openAutofill();
      return;
    }
    callFeature(RB.autofill, ['open'], 'Auto-build is not available right now.');
  }

  function openShortcuts() {
    if (!RB.ui || !RB.ui.modal) return;
    var list = el('dl', { class: 'rb-kbdlist' });
    SHORTCUTS.forEach(function (s) {
      list.appendChild(el('dt', { text: s.label }));
      list.appendChild(el('dd', {}, [el('span', { class: 'rb-kbd', text: hint(s.keys) })]));
    });
    var note = el('p', { class: 'rb-hint' });
    note.textContent = 'Shortcuts apply everywhere except inside a text field, where your browser keeps its own editing history.';
    RB.ui.modal({
      title: 'Keyboard shortcuts',
      body: el('div', {}, [note, list]),
      actions: [{ label: 'Close', primary: true }]
    });
  }

  function openPrivacy() {
    if (!RB.ui || !RB.ui.modal) return;
    var body = el('div');
    [
      'Your resume never leaves this device. It is saved in this browser and nowhere else — there is no account, no server, and no analytics.',
      'Nothing on this page loads from a network. The one exception is a PDF reader that is fetched only if you ask to import a PDF.',
      'A share link does carry your resume: the whole thing is encoded into the link itself. Anyone with that link can read it, so treat it like a document you handed over.'
    ].forEach(function (text) { body.appendChild(el('p', { class: 'rb-hint', text: text })); });
    RB.ui.modal({ title: 'Privacy', body: body, actions: [{ label: 'Close', primary: true }] });
  }

  /* A hard wipe, not just a model reset. "Start a new resume" has to leave
   * nothing behind — including the persisted record and the settings keys —
   * otherwise the next reload restores what the user just asked to discard. */
  function hardClear() {
    var jobs = [];
    try {
      /* "ui:" is the panel shell's own prefix. Leaving it behind meant the
       * dialog's promise — "along with your undo history and settings" — was
       * not kept: the panel came back on the same tab, collapsed or not, from
       * the last session. */
      Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('rb:') === 0 || k.indexOf('resumeboard') === 0 || k.indexOf('ui:') === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) { /* private mode: the store clear below still runs */ }
    if (RB.idb && RB.idb.clear) jobs.push(RB.idb.clear());
    return Promise.all(jobs).catch(function () {});
  }

  function openReset() {
    if (!RB.ui || !RB.ui.confirm || !store) return;
    RB.ui.confirm({
      title: 'Start a new resume?',
      message: 'This erases the resume saved in this browser, along with your undo history and settings. There is no way back to it, so export a JSON backup first if you might want it.',
      confirmLabel: 'Erase and start fresh',
      cancelLabel: 'Keep what I have',
      tone: 'danger'
    }).then(function (yes) {
      if (!yes) return;
      hardClear().then(function () {
        store.reset({ noHistory: true });
        syncTitle();
        toast('Everything cleared. Starting fresh.', 'info');
      });
    });
  }

  function overflowItems() {
    return [
      { label: 'Build from my profile', icon: 'wand', onClick: openAutofill },
      { label: 'Import…', icon: 'upload', onClick: openImport },
      { label: 'Share link', icon: 'link', onClick: openShare },
      '-',
      { label: 'Keyboard shortcuts', icon: 'command', kbd: hint(['mod', '/']), onClick: openShortcuts },
      { label: 'Privacy', icon: 'shield', onClick: openPrivacy }
    ];
  }

  function openOverflow(anchor) {
    var target = anchor || qs('#rb-more-btn');
    if (target) openMenu(target, overflowItems());
  }

  /* ---------------- markup ---------------- */

  function titleField(id, compact) {
    var input = el('input', {
      type: 'text',
      id: id,
      class: 'rb-input rb-input--sm rb-topbar__title',
      maxlength: '300',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Untitled resume'
    });
    input.addEventListener('input', function () { lastTitleInput = input; titleDebounce(); });
    input.addEventListener('blur', function () {
      titleDebounce.cancel();
      commitTitle(input, true);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      input.blur();
    });
    titles.push(input);
    if (compact) input.classList.add('rb-truncate');
    return el('div', { class: 'rb-field rb-topbar__titlefield' }, [
      el('label', { class: 'sr-only', for: id, text: 'Resume title' }),
      input
    ]);
  }

  /* The brand mark, drawn rather than fetched from the icon set: the icon set
   * holds glyphs the interface uses, and the logo is not one of them. It is
   * the same geometry the home page and the favicon use, in reverse out of the
   * accent tile. Keeping it here means the editor can never drift onto a
   * different drawing from the rest of the site. */
  var BRAND_MARK =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>' +
    '<path d="M14 2v5h5"/>' +
    '<path d="M8 13h8M8 17h5"/>' +
    '</svg>';

  function brand() {
    return el('a', { class: 'rb-brand rb-topbar__home', href: 'index.html', 'aria-label': 'Resumeboard, back to the home page', 'data-tip': 'Home' }, [
      el('span', { class: 'rb-brand__mark', html: BRAND_MARK }),
      el('span', { class: 'rb-brand__word', text: 'Resumeboard' })
    ]);
  }

  function wireHistoryButtons(root) {
    var undo = iconButton({ icon: 'undo', label: 'Undo', tip: 'Undo (' + hint(['mod', 'z']) + ')', action: 'undo' });
    var redo = iconButton({ icon: 'redo', label: 'Redo', tip: 'Redo (' + hint(['mod', 'shift', 'z']) + ')', action: 'redo' });
    on(undo, 'click', doUndo);
    on(redo, 'click', doRedo);
    undoBtns.push(undo);
    redoBtns.push(redo);
    root.appendChild(el('div', { class: 'rb-btn-group', role: 'group', 'aria-label': 'History' }, [undo, redo]));
  }

  function desktopBar() {
    var bar = el('div', { class: 'rb-topbar__inner' });
    bar.appendChild(brand());
    bar.appendChild(el('span', { class: 'rb-divider--v', 'aria-hidden': 'true' }));
    bar.appendChild(titleField('rb-title-desktop', false));

    /* Site navigation belongs on the same bar as the app controls: this is one
     * page now, so there is nowhere else for the reader to go. It collapses
     * before it can crowd out the document controls. */
    var nav = el('nav', { class: 'rb-topbar__nav', 'aria-label': 'Site' });
    [
      { label: 'Templates', href: 'templates/index.html' },
      { label: 'Examples', href: 'examples/index.html' },
      { label: 'Guides', href: 'guides/index.html' },
      { label: 'ATS', href: 'ats/index.html' },
      { label: 'Contact', href: 'contact.html' }
    ].forEach(function (item) {
      nav.appendChild(el('a', { class: 'rb-topbar__navlink', href: item.href, text: item.label }));
    });
    bar.appendChild(nav);

    bar.appendChild(el('span', { class: 'rb-spacer' }));

    var actions = el('div', { class: 'rb-topbar__actions' });

    /* Erasing the saved resume is the single most destructive thing this app
     * can do and the most asked for. It belongs on the bar, not three layers
     * down in an overflow menu. */
    var newBtn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--new',
      'data-action': 'new',
      'aria-label': 'Start a new resume and erase the saved one',
      'data-tip': 'Start a new resume'
    });
    newBtn.appendChild(el('span', { html: ic('refresh', 'sm') }));
    newBtn.appendChild(el('span', { class: 'rb-btn__label', text: 'New' }));
    on(newBtn, 'click', openReset);
    actions.appendChild(newBtn);

    actions.appendChild(el('span', { class: 'rb-divider--v', 'aria-hidden': 'true' }));
    wireHistoryButtons(actions);
    actions.appendChild(el('span', { class: 'rb-divider--v', 'aria-hidden': 'true' }));

    var themeBtn = iconButton({ icon: 'monitor', label: 'Theme', action: 'theme' });
    themeBtns.push(themeBtn);
    on(themeBtn, 'click', cycleTheme);
    actions.appendChild(themeBtn);

    actions.appendChild(el('span', { class: 'rb-divider--v', 'aria-hidden': 'true' }));

    var shareBtn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--secondary',
      'data-action': 'share'
    });
    shareBtn.appendChild(el('span', { html: ic('share', 'sm') }));
    shareBtn.appendChild(el('span', { text: 'Share' }));
    on(shareBtn, 'click', openShare);
    actions.appendChild(shareBtn);

    var exportBtn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--primary',
      id: 'rb-export-btn',
      'aria-haspopup': 'menu',
      'data-action': 'export'
    });
    exportBtn.appendChild(el('span', { html: ic('download', 'sm') }));
    exportBtn.appendChild(el('span', { text: 'Export' }));
    on(exportBtn, 'click', function () { openExportMenu(exportBtn); });
    actions.appendChild(exportBtn);

    var moreBtn = iconButton({ icon: 'more-horizontal', label: 'More', action: 'more', cls: 'rb-btn--secondary' });
    moreBtn.id = 'rb-more-btn';
    moreBtn.setAttribute('aria-haspopup', 'menu');
    on(moreBtn, 'click', function () { openOverflow(moreBtn); });
    actions.appendChild(moreBtn);

    bar.appendChild(actions);
    return bar;
  }

  function mobileBar() {
    var bar = el('div', { class: 'rb-topbar__mobile' });
    bar.appendChild(brand());
    bar.appendChild(titleField('rb-title-mobile', true));
    bar.appendChild(el('span', { class: 'rb-spacer' }));
    wireHistoryButtons(bar);

    var exportBtn = iconButton({ icon: 'download', label: 'Export', small: true, action: 'export' });
    exportBtn.setAttribute('aria-haspopup', 'menu');
    on(exportBtn, 'click', function () { openExportMenu(exportBtn); });
    bar.appendChild(exportBtn);

    var moreBtn = iconButton({ icon: 'more-horizontal', label: 'More', small: true, action: 'more' });
    moreBtn.setAttribute('aria-haspopup', 'menu');
    on(moreBtn, 'click', function () { openOverflow(moreBtn); });
    bar.appendChild(moreBtn);
    return bar;
  }

  /* ---------------- global keys ---------------- */

  function isEditable(node) {
    if (!node) return false;
    if (node.isContentEditable) return true;
    var tag = (node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function onKeydown(ev) {
    if (ev.defaultPrevented) return;
    if (isEditable(doc.activeElement)) return;
    if (qs('.rb-modal-backdrop')) return;
    var mac = isMac();
    var primary = mac ? ev.metaKey : ev.ctrlKey;
    if (!primary || ev.altKey) return;
    var key = (ev.key || '').toLowerCase();

    if (key === 'z' && !ev.shiftKey) { ev.preventDefault(); doUndo(); return; }
    if (key === 'z' && ev.shiftKey) { ev.preventDefault(); doRedo(); return; }
    if (key === 'y' && !mac) { ev.preventDefault(); doRedo(); return; }
    /* Bare mod+s only. The palette binds mod+shift+s to Share, and this handler
     * runs first, so claiming the shifted chord too meant the documented
     * "Share or copy resume" key quietly saved the file instead. */
    if (key === 's' && !ev.shiftKey) { ev.preventDefault(); saveNow(); return; }
    if (key === '/') { ev.preventDefault(); openShortcuts(); }
  }

  /* ---------------- lifecycle ---------------- */

  function mount() {
    if (mounted) return host;
    host = qs('#rb-topbar');
    if (!host) return null;

    store = RB.store || null;
    ensureStyle();
    theme = readStoredTheme();
    applyTheme();
    titleDebounce = U.debounce(function () { commitTitle(lastTitleInput, false); }, 260);

    host.textContent = '';
    host.appendChild(desktopBar());
    host.appendChild(mobileBar());
    renderTheme(); // after the buttons exist, so their labels name the current mode

    subs.push(bus.on('change', function (payload) {
      /* An undo, a redo, a reset, an import or the sample has just replaced the
       * resume. A title commit still sitting in the debounce window belongs to
       * the state that was thrown away, and letting it land writes the old text
       * straight back over the undo — which reads as "Undo did nothing". The
       * title's own write is source 'field' and is left alone. */
      var source = payload && payload.source;
      if (titleDebounce && source !== 'field' && source !== 'design' &&
          source !== 'update' && source !== 'share' && source !== 'template') {
        titleDebounce.cancel();
      }
      refreshHistory();
      syncTitle();
    }));
    doc.addEventListener('keydown', onKeydown);

    mounted = true;
    refreshHistory();
    syncTitle();
    if (store && store.whenReady) {
      store.whenReady().then(function () {
        refreshHistory();
        syncTitle();
      });
    }
    if (RB.onBoot) RB.onBoot(function () {
      refreshHistory();
      syncTitle();
    });
    return host;
  }

  function unmount() {
    if (!mounted) return;
    subs.forEach(function (off) { off(); });
    subs = [];
    doc.removeEventListener('keydown', onKeydown);
    if (titleDebounce) titleDebounce.cancel();
    if (host) host.textContent = '';
    titles = [];
    undoBtns = [];
    redoBtns = [];
    themeBtns = [];
    lastTitleInput = null;
    mounted = false;
  }

  RB.chrome = {
    mount: mount,
    unmount: unmount,
    getTheme: function () { return theme; },
    setTheme: setTheme,
    cycleTheme: cycleTheme,
    shortcutHint: hint,
    openExportMenu: openExportMenu,
    openOverflow: openOverflow,
    openShortcuts: openShortcuts,
    openPrivacy: openPrivacy,
    openImport: openImport,
    openShare: openShare,
    openAutofill: openAutofill,
    openReset: openReset,
    save: saveNow
  };

  function start() {
    if (mounted || !qs('#rb-topbar')) return;
    mount();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
