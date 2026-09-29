/* Resumeboard — inline editing binder
 *
 * Makes the rendered resume the editing surface. Any node carrying
 * `data-bind="<dot.path>"` inside #rb-doc becomes a contenteditable field that
 * writes straight back through RB.store.setField.
 *
 * Node contract read from the DOM (all optional except data-bind):
 *   data-bind         dot path into the resume            (required)
 *   data-multiline    "true" -> Enter inserts a newline, otherwise commits.
 *                     aria-multiline="true" is accepted as the same signal.
 *   data-rich         "true" -> inline HTML allowed, value is sanitized HTML
 *   data-label        human name used for aria-label and the selection payload
 *   data-placeholder  hint shown while the field is empty
 *
 * The renderer already puts contenteditable, role, aria-label and
 * aria-multiline on every field; anything it set is left exactly as it was and
 * never removed on blur. This module only adds what is missing.
 *
 * Node contract written by this module:
 *   .is-editing           class while a node is being edited
 *   data-editing="path"   set on the root while any field holds focus, so the
 *                         renderer can skip the node the user is typing into
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var U = global.RB && global.RB.utils;
  var bus = global.RB && global.RB.bus;
  var store = global.RB && global.RB.store;
  var model = global.RB && global.RB.model;
  var icons = global.RB && global.RB.icons;
  if (!U || !bus || !store) return;

  var BIND = '[data-bind]';
  var STYLE_ID = 'rb-binder-styles';
  var EDITING_ATTR = 'data-editing';
  var TOPBAR_GAP = 56;

  /* plaintext-only is Chromium-only. On engines that do not understand the
   * value the IDL falls back to "inherit", which would make the field
   * uneditable, so probe once and never write an unsupported value. */
  var PLAIN_EDITABLE = (function () {
    try {
      var probe = doc.createElement('div');
      probe.setAttribute('contenteditable', 'plaintext-only');
      return probe.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
    } catch (e) { return 'true'; }
  })();

  var root = null;
  var unsubs = [];
  var active = null;
  var toolbar = null;
  var watcher = null;
  var fieldWatcher = null;
  var warnedFormatting = false;

  /* ---------------- small helpers ---------------- */

  function readPath(obj, path) {
    if (model && model.getPath) return model.getPath(obj, path);
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function pathOf(node) {
    return node ? (node.getAttribute('data-bind') || '') : '';
  }

  function flag(node, name) {
    return node.getAttribute(name) === 'true';
  }

  function isMultiline(node) {
    return flag(node, 'data-multiline') || flag(node, 'aria-multiline');
  }

  function isRich(node) {
    return flag(node, 'data-rich');
  }

  /* Innermost bound node only. A renderer that binds a wrapper around bound
   * children would otherwise swallow every keystroke aimed at a child. */
  function innermost(node) {
    return !!node && node.closest && node.closest(BIND) === node;
  }

  function boundNodes() {
    if (!root) return [];
    return U.qsa(BIND, root).filter(innermost);
  }

  function overlayRoot() {
    return U.qs('#rb-overlay-root') || doc.body;
  }

  function iconMarkup(name) {
    return icons && icons.svg ? icons.svg(name, { size: 'sm' }) : '';
  }

  function humanize(path) {
    var segs = String(path).split('.').filter(function (s) { return s && !/^\d+$/.test(s); });
    var seg = (segs[segs.length - 1] || 'Field').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    /* Three letters or fewer reads as an acronym (url, doi, gpa). Anything
     * longer is a word and must not be shouted at a screen reader. */
    return seg.length <= 3 ? seg.toUpperCase() : U.titleCase(seg);
  }

  /* ---------------- styles ---------------- */

  function ensureStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.rb-bind-host [data-bind] { cursor: text; border-radius: var(--rb-radius-xs); }',
      '@media (hover: hover) {',
      '  .rb-bind-host [data-bind]:hover {',
      '    background: color-mix(in srgb, var(--rb-accent-500) 7%, transparent);',
      '    box-shadow: 0 0 0 1px color-mix(in srgb, var(--rb-accent-500) 22%, transparent);',
      '  }',
      '}',
      '.rb-bind-host [data-bind]:focus,',
      '.rb-bind-host [data-bind].is-editing {',
      '  outline: none;',
      '  background: color-mix(in srgb, var(--rb-accent-500) 5%, transparent);',
      '  box-shadow: 0 0 0 1px var(--rb-accent-400),',
      '              0 0 0 3px color-mix(in srgb, var(--rb-accent-400) 20%, transparent);',
      '}',
      '.rb-bind-host [data-bind][data-placeholder]:empty::before {',
      '  content: attr(data-placeholder);',
      '  color: var(--rb-text-faint);',
      '  font-style: italic;',
      '  pointer-events: none;',
      '}',
      '.rb-fmt {',
      '  position: fixed;',
      '  z-index: var(--rb-z-popover);',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 2px;',
      '  padding: var(--rb-space-1);',
      '  background: var(--rb-bg-elevated);',
      '  border: 1px solid var(--rb-border);',
      '  border-radius: var(--rb-radius-md);',
      '  box-shadow: var(--rb-shadow-lg);',
      '}',
      '.rb-fmt[hidden] { display: none; }',
      '@media (hover: none) { .rb-fmt .rb-btn { width: 36px; height: 36px; } }',
      '@media print {',
      '  .rb-bind-host [data-bind],',
      '  .rb-bind-host [data-bind]:hover,',
      '  .rb-bind-host [data-bind].is-editing {',
      '    background: none !important; box-shadow: none !important; outline: none !important;',
      '  }',
      '  .rb-fmt { display: none !important; }',
      '}'
    ].join('\n');
    doc.head.appendChild(style);
  }

  /* ---------------- value read/write ---------------- */

  function plainText(node) {
    var out = [];
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var child = n.childNodes[i];
        if (child.nodeType === 3) out.push(child.nodeValue);
        else if (child.nodeName === 'BR') out.push('\n');
        else {
          if (child.nodeName === 'DIV' || child.nodeName === 'P' || child.nodeName === 'LI') out.push('\n');
          walk(child);
        }
      }
    })(node);
    return out.join('').replace(/\u00a0/g, ' ');
  }

  /* Never trims: trailing spaces and blank lines are things the user typed and
   * must survive the round trip or the caret fights back. */
  function readValue(node) {
    if (!isRich(node)) return plainText(node);
    var html = U.sanitizeHtml(node.innerHTML);
    if (!html.replace(/<br\s*\/?>|\s|&nbsp;/gi, '')) return '';
    return html.replace(/^(?:<br\s*\/?>\s*)+/i, '');
  }

  function setValue(node, value, rich) {
    if (rich) node.innerHTML = U.sanitizeHtml(String(value == null ? '' : value));
    else node.textContent = String(value == null ? '' : value);
  }

  /* Commit runs on blur or Enter, not per keystroke, so the caret is never
   * fought. Mechanical cleanup is silent; a value that cannot possibly be
   * right is refused out loud and the field is put back the way it was. */
  function commit() {
    if (!active || !active.node.isConnected) return;
    var raw = readValue(active.node);
    if (raw === active.written) return;

    /* An anchor-based field — the contact line is a list of links — can read
     * back empty while the caret is in it. Writing that empty value over a
     * real one is silent data loss, so it is refused rather than saved. */
    if (raw === '' && /contact|^basics\.(email|phone|url)$/.test(active.path)) {
      var existing = model.getPath(store.get(), active.path);
      if (existing) { setValue(active.node, existing, active.rich); return; }
    }

    /* Revert from the model, not from `active.written`: that can hold a
     * rich-text round trip which no longer matches what is on screen, and
     * putting it back concatenates instead of replacing. */
    function revert() {
      var truth = model.getPath(store.get(), active.path);
      setValue(active.node, truth == null ? '' : truth, active.rich);
    }

    var value = raw;
    var V = global.RB && global.RB.validate;
    if (V) {
      var clean = V.sanitize(raw, active.path);
      if (typeof clean === 'string' && clean !== raw) {
        /* Painted back, so what the reader sees is what was stored. */
        setValue(active.node, clean);
      }
      var verdict = V.accept(clean, active.path);
      if (!verdict.ok) {
        revert();
        warn(verdict.reason);
        return;
      }
      value = verdict.value;
      var why = V.gibberish(value, active.path);
      if (why) {
        revert();
        warn(why);
        return;
      }
    }

    active.written = value;
    store.setField(active.path, value, { coalesceKey: active.path });
  }

  var lastWarn = 0;
  function warn(message, tone) {
    if (!message) return;
    var now = Date.now();
    if (now - lastWarn < 1200) return;
    lastWarn = now;
    if (global.RB && global.RB.ui && global.RB.ui.toast) {
      global.RB.ui.toast(message, { tone: tone || 'warn', duration: 4200 });
    }
    if (global.RB && global.RB.bus) global.RB.bus.emit('validate:warn', { path: active && active.path, message: message });
  }

  /* ---------------- selection context ---------------- */

  function entryContext(path) {
    var parts = String(path).split('.');
    var ctx = { entryType: null, entryId: null, roleId: null, childId: null, sectionId: null, entryIndex: null };
    var resume = store.get();
    if (!resume || parts.length < 2 || !/^\d+$/.test(parts[1])) return ctx;
    ctx.entryType = parts[0];
    ctx.entryIndex = Number(parts[1]);
    ctx.entryId = readPath(resume, parts[0] + '.' + parts[1] + '.id') || null;
    if (parts[2] === 'roles' && /^\d+$/.test(parts[3] || '')) {
      ctx.roleId = readPath(resume, parts[0] + '.' + parts[1] + '.roles.' + parts[3] + '.id') || null;
    } else if (parts[2] === 'entries' && /^\d+$/.test(parts[3] || '')) {
      ctx.childId = readPath(resume, parts[0] + '.' + parts[1] + '.entries.' + parts[3] + '.id') || null;
    }
    var sections = resume.sections || [];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].type === ctx.entryType) { ctx.sectionId = sections[i].id; break; }
    }
    return ctx;
  }

  function entryTitle(ctx) {
    var resume = store.get();
    var entry = resume ? readPath(resume, ctx.entryType + '.' + ctx.entryIndex) : null;
    if (!entry) return '';
    var keys = ['company', 'institution', 'name', 'title', 'label', 'organization', 'network', 'awarder', 'issuer'];
    for (var i = 0; i < keys.length; i++) {
      var v = entry[keys[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  function labelFor(node, path, ctx) {
    var label = node.getAttribute('data-label') || node.getAttribute('aria-label') || '';
    if (!label) {
      label = humanize(path);
      if (ctx.entryType) {
        var title = entryTitle(ctx);
        var typeLabel = model && model.typeMeta ? model.typeMeta(ctx.entryType).label : ctx.entryType;
        label += ', ' + (title || (typeLabel + ' ' + (ctx.entryIndex + 1)));
      }
    }
    return label;
  }

  function emitSelection(node, ctx) {
    if (!node) { bus.emit('selection', { path: null }); return; }
    var path = pathOf(node);
    var context = ctx || entryContext(path);
    bus.emit('selection', {
      path: path,
      entryType: context.entryType,
      entryId: context.entryId,
      roleId: context.roleId,
      childId: context.childId,
      sectionId: context.sectionId,
      entryIndex: context.entryIndex,
      label: labelFor(node, path, context)
    });
  }

  /* ---------------- activation ---------------- */

  function listen(node, type, fn) {
    node.addEventListener(type, fn);
    (active ? active.offs : []).push(function () { node.removeEventListener(type, fn); });
  }

  /* Set an attribute only when nobody else owns it, and remember that this
   * module owns it so blur can hand the node back untouched. */
  function claim(name, value) {
    var node = active.node;
    if (node.hasAttribute(name)) return;
    node.setAttribute(name, value);
    active.claimed.push(name);
  }

  function activate(node, takeFocus) {
    if (!innermost(node) || !pathOf(node)) return false;
    if (active && active.node === node) {
      if (takeFocus && doc.activeElement !== node) node.focus();
      return true;
    }
    deactivate();

    var rich = isRich(node);
    var multiline = isMultiline(node);
    var ctx = entryContext(pathOf(node));
    active = {
      node: node,
      path: pathOf(node),
      rich: rich,
      multiline: multiline,
      hadCE: node.hasAttribute('contenteditable'),
      previousCE: node.getAttribute('contenteditable'),
      claimed: [],
      offs: [],
      written: readValue(node)
    };

    var editable = rich ? 'true' : PLAIN_EDITABLE;
    if (!active.hadCE || active.previousCE !== editable) {
      active.claimed.push('contenteditable');
      node.setAttribute('contenteditable', editable);
    }
    /* An <a> may not carry role=textbox, and the contact details, profile
     * links and project names are all anchors. contenteditable already makes
     * the node an editable host, so the role is redundant there; the label
     * below is what a screen reader needs either way. */
    if (node.tagName !== 'A') {
      claim('role', 'textbox');
      claim('aria-multiline', multiline ? 'true' : 'false');
    }
    claim('aria-label', labelFor(node, active.path, ctx));
    claim('tabindex', '0');
    if (!node.getAttribute('data-placeholder') && !plainText(node).trim()) {
      claim('data-placeholder', humanize(active.path));
    }
    node.classList.add('is-editing');
    if (root) root.setAttribute(EDITING_ATTR, active.path);

    listen(node, 'input', onInput);
    listen(node, 'keydown', onKeyDown);
    listen(node, 'paste', onPaste);
    listen(node, 'focus', function () { liftHref(activeNodeFor(node)); });
    listen(node, 'blur', function (ev) { restoreHref(node); onBlur(ev); releaseRenderer(); });
    listen(node, 'mouseup', scheduleToolbar);
    listen(node, 'dblclick', scheduleToolbar);

    if (takeFocus !== false) {
      try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
      placeCaretAtEnd(node);
    }
    emitSelection(node, ctx);
    return true;
  }

  function deactivate() {
    if (!active) return;
    var node = active.node;
    active.offs.forEach(function (off) { off(); });

    node.classList.remove('is-editing');
    active.claimed.forEach(function (name) { node.removeAttribute(name); });
    if (active.hadCE) node.setAttribute('contenteditable', active.previousCE);

    /* Validation may have clipped the value. Show what was actually stored, but
     * only after the user has left the field. */
    var stored = readPath(store.get(), active.path);
    if (stored != null && String(stored) !== active.written) {
      setValue(node, stored, active.rich);
    }

    active = null;
    hideToolbar();
    if (root && root.hasAttribute(EDITING_ATTR)) root.removeAttribute(EDITING_ATTR);
    emitSelection(null);
  }

  function onInput() { commit(); }

  /* The renderer holds back re-renders while a bound field has the caret, so
   * this is where it is told to catch up. */
  /* A field inside a hyperlink cannot be selected: Control+A is swallowed by
   * the link and Backspace removes one character, so typing interleaves with
   * the old value. Lifting the href while the field is focused makes it an
   * ordinary span for exactly as long as someone is typing in it, and puts the
   * link back on blur so the printed and exported page is still navigable. */
  function liftHref(node) {
    var link = node && node.closest && node.closest('a[href]');
    if (!link || link.hasAttribute('data-href-stashed')) return;
    link.setAttribute('data-href-stashed', link.getAttribute('href') || '');
    link.removeAttribute('href');
    link.setAttribute('data-editing', '');
  }

  function restoreHref(node) {
    var link = node && node.closest && node.closest('a[data-href-stashed]');
    if (!link) return;
    var href = link.getAttribute('data-href-stashed');
    link.removeAttribute('data-href-stashed');
    link.removeAttribute('data-editing');
    if (href) link.setAttribute('href', href);
  }

  function activeNodeFor(node) { return node; }

  function releaseRenderer() {
    if (global.RB && global.RB.renderer && typeof global.RB.renderer.releaseField === 'function') {
      global.RB.renderer.releaseField();
    }
  }

  function onBlur() { deactivate(); }

  function onKeyDown(ev) {
    if (!active) return;
    var key = ev.key;

    if (key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      commit();
      var node = active.node;
      deactivate();
      node.blur();
      return;
    }

    if (key === 'Enter' && !ev.shiftKey && !active.multiline) {
      ev.preventDefault();
      commit();
      focusNeighbour(active.node, 1);
      return;
    }
  }

  function onPaste(ev) {
    if (!active || active.rich) return;
    var data = ev.clipboardData;
    if (!data) return;
    var text = data.getData('text/plain');
    if (!text) return;
    ev.preventDefault();
    insertTextAtCaret(text);
    commit();
  }

  function focusNeighbour(node, dir) {
    var all = boundNodes();
    var i = all.indexOf(node);
    /* A renderer rebuild detaches the node between keystrokes. -1 would put
     * dir=1 on all[0] and throw the user back to the top of the document. */
    if (i === -1) return false;
    var next = all[i + dir];
    if (!next) return false;
    var before = active;
    if (before) commit();
    deactivate();
    return activate(next, true);
  }

  function insertTextAtCaret(text) {
    if (typeof doc.execCommand === 'function') {
      try { if (doc.execCommand('insertText', false, text) !== false) return true; } catch (e) { /* fall through */ }
    }
    var sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return false;
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /* ---------------- caret ---------------- */

  function placeCaretAt(node, offset) {
    var sel = doc.getSelection();
    if (!sel) return;
    var range = doc.createRange();
    if (typeof offset === 'number') {
      var walker = doc.createTreeWalker(node, global.NodeFilter.SHOW_TEXT, null);
      var text;
      var left = offset;
      while ((text = walker.nextNode())) {
        if (left <= text.nodeValue.length) {
          range.setStart(text, left);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
        left -= text.nodeValue.length;
      }
    }
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function placeCaretAtEnd(node) { placeCaretAt(node, null); }

  /* ---------------- store reconciliation ---------------- */

  /* The renderer owns the DOM. All this module may do to a node the user is
   * typing into is restore the caret after somebody else replaced it. */
  var resync = null;

  function scheduleResync() {
    if (resync) return;
    resync = U.requestIdle(function () {
      resync = null;
      restoreActive();
    }, 120);
  }

  /* Another module replaced the node the user was typing into. Re-open the
   * same path and put the caret back where it was, rather than dropping the
   * edit on the floor. */
  function restoreActive() {
    if (!active || !root || !root.isConnected) return;
    var node = active.node;
    if (node.isConnected && root.contains(node)) return;

    var path = active.path;
    var rich = active.rich;
    var caret = caretOffsetOfNode(node);
    var replacement = U.qsa(BIND, root).filter(function (n) {
      return n.getAttribute('data-bind') === path && innermost(n);
    })[0];
    if (!replacement) { deactivate(); return; }

    var value = readPath(store.get(), path);
    if (value != null) setValue(replacement, value, rich);
    deactivate();
    activate(replacement, false);
    replacement.focus({ preventScroll: true });
    placeCaretAt(replacement, caret);
  }

  function caretOffsetOfNode(node) {
    var sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var container = sel.getRangeAt(0).startContainer;
    if (container !== node && !node.contains(container)) return null;
    var pre = doc.createRange();
    pre.selectNodeContents(node);
    try { pre.setEnd(container, sel.getRangeAt(0).startOffset); } catch (e) { return null; }
    return pre.toString().length;
  }

  function onChange(payload) {
    if (!root) return;
    if (!root.isConnected) { teardown(); watchForRoot(); return; }
    if (!active) return;
    if (!active.node.isConnected || !root.contains(active.node)) { scheduleResync(); return; }
    if (payload && payload.state && active.path) {
      var incoming = readPath(payload.state, active.path);
      if (incoming != null && String(incoming) !== active.written) {
        /* An undo, a panel edit or an import landed on the focused field. */
        active.written = String(incoming);
        setValue(active.node, incoming, active.rich);
        placeCaretAtEnd(active.node);
      }
    }
  }

  /* ---------------- formatting toolbar ---------------- */

  var FORMAT_BUTTONS = [
    { cmd: 'bold', icon: 'bold', label: 'Bold' },
    { cmd: 'italic', icon: 'italic', label: 'Italic' },
    { cmd: 'underline', icon: 'underline', label: 'Underline' },
    { cmd: 'link', icon: 'link', label: 'Add link' }
  ];

  function buildToolbar() {
    if (toolbar) return toolbar;
    var bar = U.el('div', { class: 'rb-fmt', role: 'toolbar', 'aria-label': 'Text formatting', hidden: true });
    FORMAT_BUTTONS.forEach(function (spec) {
      var btn = U.el('button', {
        type: 'button',
        class: 'rb-tip rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm',
        'aria-label': spec.label,
        'data-tip': spec.label,
        'data-cmd': spec.cmd,
        'aria-pressed': 'false',
        html: iconMarkup(spec.icon)
      });
      /* Keeping the default mousedown off is what preserves the text selection
       * the command is supposed to act on. */
      btn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      btn.addEventListener('click', function (ev) { ev.preventDefault(); onFormat(spec.cmd); });
      btn.addEventListener('keydown', function (ev) {
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        ev.preventDefault();
        var items = U.qsa('button', bar);
        var i = items.indexOf(btn);
        items[(i + (ev.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus();
      });
      bar.appendChild(btn);
    });
    overlayRoot().appendChild(bar);
    toolbar = bar;
    return bar;
  }

  function selectionInside() {
    if (!active || !active.rich) return null;
    var sel = doc.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var node = sel.anchorNode;
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el || !active.node.contains(el)) return null;
    return sel;
  }

  function placeToolbar() {
    if (!active || !active.rich) { hideToolbar(); return; }
    var sel = selectionInside();
    if (!sel) { hideToolbar(); return; }
    var bar = buildToolbar();
    var range = sel.getRangeAt(0);
    var rect = typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : active.node.getBoundingClientRect();
    if (!rect) { bar.hidden = true; return; }
    bar.hidden = false;
    var top = rect.top - bar.offsetHeight - 8;
    if (top < TOPBAR_GAP) top = rect.bottom + 8;
    var left = rect.left + rect.width / 2 - bar.offsetWidth / 2;
    bar.style.left = Math.round(U.clamp(left, 8, global.innerWidth - bar.offsetWidth - 8)) + 'px';
    bar.style.top = Math.round(U.clamp(top, 8, global.innerHeight - bar.offsetHeight - 8)) + 'px';
    syncToolbarState();
  }

  function hideToolbar() { if (toolbar) toolbar.hidden = true; }

  function syncToolbarState() {
    if (!toolbar || toolbar.hidden) return;
    FORMAT_BUTTONS.forEach(function (spec) {
      var btn = U.qs('[data-cmd="' + spec.cmd + '"]', toolbar);
      if (!btn) return;
      var on = false;
      if (spec.cmd !== 'link' && typeof doc.queryCommandState === 'function') {
        try { on = !!doc.queryCommandState(spec.cmd); } catch (e) { on = false; }
      }
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  var scheduleToolbar = U.throttle(placeToolbar, 120);

  function execCommand(cmd, value) {
    if (typeof doc.execCommand !== 'function') return false;
    try { return doc.execCommand(cmd, false, value == null ? null : value) !== false; }
    catch (e) { return false; }
  }

  /* Browser refused the command. Keep the text, lose the formatting. */
  function stripFormatting() {
    if (!active) return;
    if (!warnedFormatting) {
      warnedFormatting = true;
      var ui = global.RB && global.RB.ui;
      if (ui && ui.toast) ui.toast('This browser cannot format inline text. The formatting was removed.', { tone: 'warn' });
    }
    setValue(active.node, U.htmlToText(readValue(active.node)), false);
  }

  function onFormat(cmd) {
    if (!active || !active.rich) return;
    if (cmd === 'link') { applyLink(); return; }
    if (!execCommand(cmd)) stripFormatting();
    commit();
    placeToolbar();
  }

  function applyLink() {
    if (!active || !active.rich) return;
    var sel = selectionInside();
    if (!sel) return;
    var node = active.node;
    var path = active.path;
    var saved = sel.getRangeAt(0).cloneRange();

    function finish(url) {
      if (!url || !node.isConnected) return;
      var still = U.qsa(BIND, root || doc).filter(function (n) {
        return n.getAttribute('data-bind') === path && innermost(n);
      })[0];
      if (!still) return;
      if (active && active.node !== still) { deactivate(); activate(still, false); }
      else if (!active) activate(still, false);
      if (!node.contains(saved.commonAncestorContainer)) return;
      var sel2 = doc.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(saved);
      if (!execCommand('createLink', url)) wrapInLink(still, saved, url);
      still.focus({ preventScroll: true });
      commit();
      placeToolbar();
    }

    var ui = global.RB && global.RB.ui;
    if (!ui || !ui.prompt) {
      if (ui && ui.toast) ui.toast('Links cannot be added in this browser.', { tone: 'warn' });
      return;
    }
    ui.prompt({
      title: 'Add a link',
      label: 'Address',
      placeholder: 'https://',
      confirmLabel: 'Add link'
    }).then(function (value) {
      var url = String(value || '').trim();
      if (!url) return;
      if (!/^(https?:|mailto:)/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
      finish(url);
    }).catch(function () { /* dismissed */ });
  }

  function wrapInLink(node, range, url) {
    if (!node.contains(range.commonAncestorContainer)) return false;
    var anchor = doc.createElement('a');
    anchor.setAttribute('href', url);
    try { anchor.appendChild(range.extractContents()); range.insertNode(anchor); }
    catch (e) { return false; }
    var after = doc.createRange();
    after.selectNodeContents(anchor);
    after.collapse(false);
    var sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(after);
    return true;
  }

  /* ---------------- document-level listeners ---------------- */

  function onKeyDownGlobal(ev) {
    if (!active || !active.rich) return;
    if (U.hotkey(ev, 'b', { ctrl: !U.isMac(), meta: U.isMac() })) { ev.preventDefault(); onFormat('bold'); }
    else if (U.hotkey(ev, 'i', { ctrl: !U.isMac(), meta: U.isMac() })) { ev.preventDefault(); onFormat('italic'); }
    else if (U.hotkey(ev, 'u', { ctrl: !U.isMac(), meta: U.isMac() })) { ev.preventDefault(); onFormat('underline'); }
    else if (U.hotkey(ev, 'k', { ctrl: !U.isMac(), meta: U.isMac() })) { ev.preventDefault(); onFormat('link'); }
  }

  function onSelectionChange() { if (active) scheduleToolbar(); }

  function mount(docEl) {
    teardown();
    var host = docEl || doc.getElementById('rb-doc');
    if (!host) return null;
    ensureStyles();
    host.classList.add('rb-bind-host');
    root = host;

    tagFields(host);

    /* The renderer replaces #rb-doc's children wholesale on every store write,
     * so stamping tabindex once at mount leaves every field created after that
     * out of the tab order. Watch for them instead. */
    if (global.MutationObserver) {
      fieldWatcher = new global.MutationObserver(function () { tagFields(root); });
      fieldWatcher.observe(host, { childList: true, subtree: true });
    }

    unsubs.push(U.on(root, 'focusin', BIND, function (ev, node) {
      if (innermost(node)) activate(node, false);
    }));
    unsubs.push(U.on(root, 'mousedown', BIND, function (ev, node) {
      if (ev.button === 0 && innermost(node)) activate(node, false);
    }));
    /* A bound link is still a real link. Editing it must not navigate. */
    unsubs.push(U.on(root, 'click', BIND, function (ev, node) {
      if (active && node.tagName === 'A' && node.getAttribute('href')) ev.preventDefault();
    }));
    /* Keyboard route: a focused but not yet editable field opens on Enter. */
    unsubs.push(U.on(root, 'keydown', BIND, function (ev, node) {
      if (!active && (ev.key === 'Enter' || ev.key === ' ') && innermost(node)) {
        ev.preventDefault();
        activate(node, true);
      }
    }));

    unsubs.push(bus.on('change', onChange));
    unsubs.push(U.on(doc, 'keydown', null, onKeyDownGlobal));
    unsubs.push(U.on(doc, 'selectionchange', null, onSelectionChange));
    /* Capture: element scrolls do not bubble, and the toolbar is position:fixed. */
    doc.addEventListener('scroll', scheduleToolbar, { capture: true, passive: true });
    unsubs.push(function () { doc.removeEventListener('scroll', scheduleToolbar, { capture: true }); });
    unsubs.push(U.on(global, 'resize', null, scheduleToolbar));

    if (global.RB && global.RB.lifecycle) {
      /* A panel tab swap emits 'unmount' too. Only an event that is not scoped
         to a panel means the document itself is going away. */
      unsubs.push(global.RB.lifecycle.on('unmount', function (payload) {
        if (payload && (payload.scope === 'panel' || payload.panelId != null)) return;
        teardown();
      }));
    }
    stopWatcher();
    return teardown;
  }

  /* Every bound field is a tab stop, so the document is editable without a
   * pointer. tabindex is left to the element here rather than to activate(),
   * which only claims it on the one node being edited. */
  function tagFields(host) {
    if (!host) return;
    U.qsa(BIND, host).forEach(function (node) {
      if (!node.getAttribute('tabindex')) node.setAttribute('tabindex', '0');
    });
  }

  function teardown() {
    deactivate();
    if (toolbar) { toolbar.remove(); toolbar = null; }
    unsubs.forEach(function (off) { off(); });
    unsubs = [];
    if (fieldWatcher) { fieldWatcher.disconnect(); fieldWatcher = null; }
    if (root) {
      root.removeAttribute(EDITING_ATTR);
      root.classList.remove('rb-bind-host');
      U.qsa(BIND, root).forEach(function (node) {
        node.classList.remove('is-editing');
        if (node.getAttribute('tabindex') === '0') node.removeAttribute('tabindex');
      });
    }
    root = null;
  }

  /* The document may not exist yet when this script runs. */
  function stopWatcher() {
    if (watcher) { watcher.disconnect(); watcher = null; }
  }

  function watchForRoot() {
    if (watcher || doc.getElementById('rb-doc')) return;
    if (!global.MutationObserver || !doc.body) return;
    watcher = new global.MutationObserver(function () {
      if (doc.getElementById('rb-doc')) {
        stopWatcher();
        mount();
      }
    });
    watcher.observe(doc.body, { childList: true, subtree: true });
  }

  /* ---------------- public API ---------------- */

  var api = {
    mount: mount,
    teardown: teardown,
    isMounted: function () { return !!root; },
    activePath: function () { return active ? active.path : null; },
    activeNode: function () { return active ? active.node : null; },
    isEditing: function (node) { return !!active && active.node === node; },
    readValue: readValue,
    focus: function (path) {
      if (!root) return false;
      var node = boundNodes().filter(function (n) { return n.getAttribute('data-bind') === path; })[0];
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      return activate(node, true);
    }
  };

  global.RB = global.RB || {};
  global.RB.binder = api;

  function start() {
    if (!root && doc.getElementById('rb-doc')) { mount(); return; }
    watchForRoot();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
