/* Resumeboard — left rail: the section navigator
 *
 * Lists the resume's sections in document order and owns every structural
 * operation on them: add, reorder, rename, hide, pin, delete. The rail is a
 * view, so nothing here writes to the model directly — every mutation is a
 * RB.store.update().
 *
 * Rows are patched in place rather than rebuilt on a keystroke, so typing on
 * the document can never steal focus out of the rail mid-word.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var doc = global.document;
  var U = RB.utils, bus = RB.bus, store = RB.store, M = RB.model;
  if (!U || !bus || !store || !M) return;

  var el = U.el;

  var COLLAPSE_KEY = 'resumeboard.rail.collapsed';
  var STYLE_ID = 'rb-rail-styles';
  var DRAG_MIME = 'application/x-rb-section';

  var root = null;          // #rb-rail
  var listEl = null;        // the <ul>
  var addBtn = null;        // footer "Add section"
  var mounted = false;
  var unsubs = [];
  var activeId = null;
  var renamingId = null;
  var draggingId = null;
  var dropHint = null;      // { node, before }
  var rowSignature = '';    // ids + order + rename state, drives rebuild vs patch

  /* ---------------- styles ----------------
   * Injected once and scoped under #rb-rail so it can never collide with the
   * shell stylesheet. Width is only asserted for the collapsed rail, and only
   * above 900px, because below that the shell owns the rail as a drawer.
   * Every color is a token. */

  var CSS = [
    '#rb-rail{display:flex;flex-direction:column;min-height:0}',
    '#rb-rail .rb-rail__head{display:flex;align-items:center;gap:var(--rb-space-2);padding:var(--rb-space-3) var(--rb-space-2) var(--rb-space-2) var(--rb-space-4)}',
    '#rb-rail .rb-rail__title{font-size:var(--rb-text-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--rb-text-faint);margin:0}',
    '#rb-rail .rb-rail__list{flex:1 1 auto;min-height:0;margin:0;padding:0 var(--rb-space-2) var(--rb-space-2);list-style:none;display:flex;flex-direction:column;gap:1px}',
    '#rb-rail .rb-rail__row{position:relative;border-radius:var(--rb-radius-sm)}',
    '#rb-rail .rb-rail__row::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2px;border-radius:1px;background:transparent;transition:background var(--rb-dur-fast) var(--rb-ease-out)}',
    '#rb-rail .rb-rail__row.is-active{background:var(--rb-bg-hover)}',
    '#rb-rail .rb-rail__row.is-active::before{background:var(--rb-accent-600)}',
    '#rb-rail .rb-rail__row.is-dragging{opacity:.5}',
    '#rb-rail .rb-rail__row.is-drop-before{box-shadow:inset 0 2px 0 var(--rb-accent-600)}',
    '#rb-rail .rb-rail__row.is-drop-after{box-shadow:inset 0 -2px 0 var(--rb-accent-600)}',
    '#rb-rail .rb-rail__line{display:flex;align-items:center;gap:2px;min-width:0}',
    '#rb-rail .rb-rail__grip{width:20px;flex:none;cursor:grab;color:var(--rb-text-faint);touch-action:none}',
    '#rb-rail .rb-rail__grip:active{cursor:grabbing}',
    '#rb-rail .rb-rail__main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:var(--rb-space-2);height:32px;padding:0 var(--rb-space-2);border:0;border-radius:var(--rb-radius-sm);background:transparent;color:var(--rb-text);font:inherit;font-size:var(--rb-text-base);font-weight:550;text-align:left;cursor:pointer;transition:background var(--rb-dur-fast) var(--rb-ease-out)}',
    '#rb-rail .rb-rail__main:hover{background:var(--rb-bg-hover)}',
    '#rb-rail .rb-rail__icon{color:var(--rb-text-muted);display:flex;flex:none}',
    '#rb-rail .rb-rail__label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#rb-rail .rb-rail__pin{color:var(--rb-accent-600);display:flex;flex:none}',
    '#rb-rail .rb-rail__dot{width:6px;height:6px;flex:none;border-radius:var(--rb-radius-full);background:var(--rb-border-strong)}',
    '#rb-rail .rb-rail__dot[data-state="partial"]{background:var(--rb-amber-600)}',
    '#rb-rail .rb-rail__dot[data-state="full"]{background:var(--rb-green-600)}',
    'html[data-theme="dark"] #rb-rail .rb-rail__dot[data-state="partial"]{background:var(--rb-amber-200)}',
    'html[data-theme="dark"] #rb-rail .rb-rail__dot[data-state="full"]{background:var(--rb-green-200)}',
    'html[data-theme="dark"] #rb-rail .rb-rail__pin{color:var(--rb-accent-300)}',
    '@media (prefers-color-scheme: dark){html:not([data-theme="light"]) #rb-rail .rb-rail__dot[data-state="partial"]{background:var(--rb-amber-200)}html:not([data-theme="light"]) #rb-rail .rb-rail__dot[data-state="full"]{background:var(--rb-green-200)}html:not([data-theme="light"]) #rb-rail .rb-rail__pin{color:var(--rb-accent-300)}}',
    '#rb-rail .rb-rail__eye{width:26px;flex:none;color:var(--rb-text-muted)}',
    '#rb-rail .rb-rail__eye[aria-pressed="false"]{color:var(--rb-text-faint)}',
    '#rb-rail .rb-rail__row.is-hidden .rb-rail__label,#rb-rail .rb-rail__row.is-hidden .rb-rail__icon{color:var(--rb-text-faint)}',
    '#rb-rail .rb-rail__row.is-hidden .rb-rail__dot{opacity:.45}',
    '#rb-rail .rb-rail__rename{width:100%;height:32px;min-width:0;text-transform:none;letter-spacing:0}',
    '#rb-rail .rb-rail__foot{padding:var(--rb-space-2) var(--rb-space-2) var(--rb-space-3)}',
    '#rb-rail .rb-rail__add{width:100%;justify-content:flex-start;border:1px dashed var(--rb-border-strong);color:var(--rb-text-secondary)}',
    '#rb-rail .rb-rail__add:hover:not(:disabled){background:var(--rb-bg-hover);color:var(--rb-text);border-color:var(--rb-text-faint)}',
    /* The type picker renders into #rb-overlay-root, so these three are not
     * scoped to the rail. The rb-rail- prefix keeps them collision-free. */
    '.rb-rail__search{padding:var(--rb-space-2);border-bottom:1px solid var(--rb-border-subtle)}',
    '.rb-rail__results{max-height:min(50vh,320px);overflow-y:auto;overscroll-behavior:contain;padding:var(--rb-space-1)}',
    '.rb-rail__noresult{padding:var(--rb-space-4) var(--rb-space-2);font-size:var(--rb-text-sm);color:var(--rb-text-muted);text-align:center}',
    '.rb-rail__hint{padding:var(--rb-space-1) var(--rb-space-2) var(--rb-space-2);font-size:var(--rb-text-2xs);color:var(--rb-text-faint);line-height:1.4}',
    '.rb-rail__picon{display:flex;flex:none;color:var(--rb-text-muted)}',
    /* Right-align tooltips: a centred one leaves the rail and gets clipped. */
    '#rb-rail .rb-tip::after{left:auto;right:0;transform:translateY(2px)}',
    '#rb-rail .rb-tip:hover::after,#rb-rail .rb-tip:focus-visible::after{transform:translateY(0)}',
    '@media (max-width:899px){#rb-rail .rb-rail__collapse{display:none}}',
    '@media (min-width:900px){#rb-rail[data-collapsed="true"]{width:64px}}',
    '@media (min-width:900px){#rb-rail[data-collapsed="true"] .rb-rail__title,#rb-rail[data-collapsed="true"] .rb-rail__label,#rb-rail[data-collapsed="true"] .rb-rail__dot,#rb-rail[data-collapsed="true"] .rb-rail__pin,#rb-rail[data-collapsed="true"] .rb-rail__grip{display:none}}',
    '@media (min-width:900px){#rb-rail[data-collapsed="true"] .rb-rail__main{justify-content:center;padding:0}}'
  ].join('\n');

  function installStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    var style = el('style', { id: STYLE_ID });
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* ---------------- small helpers ---------------- */

  function iconEl(name, opts) {
    if (!RB.icons || typeof RB.icons.el !== 'function') return null;
    return RB.icons.el(name, opts) || null;
  }

  function iconWrap(name, className, opts) {
    var svg = iconEl(name, opts);
    if (!svg) return null;
    var wrap = el('span', { class: className, 'aria-hidden': 'true' });
    wrap.appendChild(svg);
    return wrap;
  }

  /* Popover items live in #rb-overlay-root, outside the rail's style scope. */
  function popIcon(name) {
    return iconWrap(name, 'rb-rail__picon', { size: 'sm' });
  }

  function iconBtn(opts) {
    var attrs = {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm rb-tip ' + (opts.className || ''),
      'aria-label': opts.label,
      'data-tip': opts.tip || opts.label
    };
    if (opts.pressed !== undefined) attrs['aria-pressed'] = String(!!opts.pressed);
    if (opts.expanded !== undefined) attrs['aria-expanded'] = String(!!opts.expanded);
    if (opts.haspopup) attrs['aria-haspopup'] = opts.haspopup;
    var btn = el('button', attrs);
    var svg = iconEl(opts.icon, { size: 'sm' });
    if (svg) btn.appendChild(svg);
    if (opts.onClick) btn.addEventListener('click', opts.onClick);
    return btn;
  }

  function attrSel(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function findSection(resume, id) {
    var list = (resume && resume.sections) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function sectionIndex(resume, id) {
    var list = (resume && resume.sections) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  /* One section per type is an invariant the model maintains, so the type is
   * a safe fallback before the renderer stamps data-section-id. */
  function docNode(section) {
    var docRoot = U.qs('#rb-doc');
    if (!docRoot || !section) return null;
    return U.qs('[data-section-id="' + attrSel(section.id) + '"]', docRoot) ||
      U.qs('#section-' + attrSel(section.id), docRoot) ||
      U.qs('[data-section="' + attrSel(section.id) + '"]', docRoot) ||
      U.qs('[data-section-type="' + attrSel(section.type) + '"]', docRoot) ||
      null;
  }

  /* ---------------- completion ---------------- */

  function completion(resume, section) {
    var type = section.type;
    if (M.typeMeta(type).hasMany !== true) {
      /* Single sections keep their text on basics, not in an entry list. */
      var text = (resume.basics || {})[type] || '';
      var done = String(text).trim().length > 0;
      return { filled: done ? 1 : 0, total: 1, state: done ? 'full' : 'empty' };
    }
    var entries = M.sectionEntries(resume, type);
    var total = entries.length;
    var filled = 0;
    for (var i = 0; i < total; i++) if (!M.isBlankEntry(entries[i])) filled++;
    if (!total) return { filled: 0, total: 0, state: 'empty' };
    return {
      filled: filled,
      total: total,
      state: filled === 0 ? 'empty' : (filled < total ? 'partial' : 'full')
    };
  }

  function completionText(stat) {
    if (!stat.total) return 'No entries yet';
    if (stat.state === 'full') return stat.total === 1 ? 'Filled in' : 'Complete';
    if (stat.state === 'empty') return 'Empty';
    return stat.filled + ' of ' + stat.total + ' filled';
  }

  function sectionLabel(section) {
    return section.label || M.typeMeta(section.type).defaultLabel;
  }

  /* The accessible name of a row, and the text of its tooltip. */
  function rowName(section, resume) {
    var parts = [sectionLabel(section), completionText(completion(resume, section))];
    if (section.pinned) parts.push('Pinned to top');
    if (section.visible === false) parts.push('Hidden');
    return parts.join(', ');
  }

  /* ---------------- persistence ---------------- */

  function readCollapsed() {
    try { return global.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
  }

  function writeCollapsed(value) {
    try { global.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  /* ---------------- build ---------------- */

  function buildRow(section, resume) {
    var stat = completion(resume, section);
    var name = rowName(section, resume);
    var row = el('li', { class: 'rb-rail__row' });
    row.dataset.sectionId = section.id;
    row.dataset.pinned = String(!!section.pinned);
    if (section.visible === false) row.classList.add('is-hidden');

    var line = el('div', { class: 'rb-rail__line' });

    var grip = iconBtn({
      className: 'rb-rail__grip',
      icon: 'drag-handle',
      label: 'Section options: ' + sectionLabel(section),
      tip: 'Drag to reorder, or open options',
      haspopup: 'menu',
      onClick: function (ev) { ev.preventDefault(); openSectionMenu(grip, section.id); }
    });
    /* draggable is armed on pointerdown so the handle never steals a text
     * selection or a click that was meant for the label. */
    grip.addEventListener('pointerdown', function () { row.draggable = true; });
    grip.addEventListener('blur', function () { row.draggable = false; });
    line.appendChild(grip);

    line.appendChild(renamingId === section.id ? renameField(section) : mainButton(section, stat, name));

    line.appendChild(iconBtn({
      className: 'rb-rail__eye',
      icon: section.visible === false ? 'eye-off' : 'eye',
      label: sectionLabel(section) + ' visibility',
      tip: section.visible === false ? 'Show on the resume' : 'Hide from the resume',
      pressed: section.visible !== false,
      /* The row outlives any single render (patch mode keeps the same nodes),
       * so the toggle has to read live state or the button freezes on whatever
       * `visible` was when the row was first built. */
      onClick: function () {
        var current = findSection(store.get(), section.id);
        setVisible(section.id, !current || current.visible === false);
      }
    }));

    row.appendChild(line);
    return row;
  }

  function mainButton(section, stat, name) {
    var main = el('button', {
      type: 'button',
      class: 'rb-rail__main rb-tip',
      'aria-label': name,
      'data-tip': name
    });
    if (section.id === activeId) main.setAttribute('aria-current', 'true');

    var icon = iconWrap(M.typeMeta(section.type).icon, 'rb-rail__icon', { size: 'sm' });
    if (icon) main.appendChild(icon);
    if (section.pinned) {
      var pin = iconWrap('star', 'rb-rail__pin', { size: 'sm' });
      if (pin) main.appendChild(pin);
    }
    main.appendChild(el('span', { class: 'rb-rail__label', 'aria-hidden': 'true', text: sectionLabel(section) }));
    main.appendChild(el('span', { class: 'rb-rail__dot', 'aria-hidden': 'true', dataset: { state: stat.state } }));

    main.addEventListener('click', function () { focusSection(section.id); });
    main.addEventListener('keydown', function (ev) {
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        nudge(section.id, ev.key === 'ArrowUp' ? -1 : 1);
      } else if (ev.key === 'F2') {
        ev.preventDefault();
        startRename(section.id);
      } else if (ev.key === 'Delete') {
        ev.preventDefault();
        confirmDelete(section.id);
      }
    });
    return main;
  }

  function renameField(section) {
    var input = el('input', {
      type: 'text',
      class: 'rb-input rb-input--sm rb-rail__rename',
      'aria-label': 'Section heading',
      maxlength: '80',
      value: sectionLabel(section)
    });
    input.dataset.sectionId = section.id;
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitRename(section.id, input.value, false); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commitRename(section.id, input.value, true); }
    });
    input.addEventListener('blur', function () { commitRename(section.id, input.value, false); });
    /* The input is not in the document until the row is appended, so focus
     * has to wait for the current task to finish. */
    U.requestIdle(function () { input.focus(); input.select(); }, 30);
    return input;
  }

  function buildShell() {
    root.textContent = '';
    root.setAttribute('data-collapsed', String(readCollapsed()));

    var head = el('div', { class: 'rb-rail__head' });
    head.appendChild(el('h2', { class: 'rb-rail__title', id: 'rb-rail-title', text: 'Sections' }));
    head.appendChild(el('span', { class: 'rb-spacer' }));
    head.appendChild(iconBtn({
      icon: 'plus',
      label: 'Add section',
      tip: 'Add a section',
      haspopup: 'dialog',
      onClick: function (ev) { openAddPopover(ev.currentTarget); }
    }));
    head.appendChild(iconBtn({
      className: 'rb-rail__collapse',
      icon: 'chevron-left',
      label: 'Collapse section list',
      tip: 'Collapse',
      expanded: !readCollapsed(),
      onClick: function () { toggleCollapsed(); }
    }));
    root.appendChild(head);

    listEl = el('ul', { class: 'rb-rail__list rb-scroll', 'aria-labelledby': 'rb-rail-title' });
    root.appendChild(listEl);
    bindList();

    var foot = el('div', { class: 'rb-rail__foot' });
    addBtn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--sm rb-tip rb-rail__add',
      'aria-haspopup': 'dialog',
      'data-tip': 'Add a section'
    });
    var plus = iconEl('plus', { size: 'sm' });
    if (plus) addBtn.appendChild(plus);
    addBtn.appendChild(el('span', { text: 'Add section' }));
    addBtn.addEventListener('click', function () { openAddPopover(addBtn); });
    foot.appendChild(addBtn);
    root.appendChild(foot);

    rowSignature = '';
  }

  /* ---------------- render ---------------- */

  function signature(ordered) {
    return (renamingId || '-') + '::' +
      ordered.map(function (s) { return s.id + ':' + (s.order || 0) + ':' + (s.pinned ? 1 : 0); }).join('|');
  }

  function render() {
    if (!mounted || !listEl) return;
    var resume = store.get();
    if (!resume) return;
    var ordered = M.orderedSections(resume);
    var sig = signature(ordered);

    if (sig !== rowSignature) {
      rowSignature = sig;
      var hadFocus = root.contains(doc.activeElement);
      /* Which row, not merely whether the rail had focus. Landing on the first
       * row put the next key — Delete, Alt+Arrow — on a section the person was
       * not looking at, so reordering a section and then pressing Delete
       * offered to delete a different one entirely. */
      var focusedRow = hadFocus && doc.activeElement.closest
        ? doc.activeElement.closest('.rb-rail__row')
        : null;
      var focusRowId = focusedRow ? focusedRow.dataset.sectionId : null;
      var frag = doc.createDocumentFragment();
      ordered.forEach(function (section) { frag.appendChild(buildRow(section, resume)); });
      listEl.textContent = '';
      listEl.appendChild(frag);
      if (hadFocus) {
        /* A rename field, when one is open, belongs to the row being renamed,
           so it wins over the generic row lookup. */
        var target = U.qs('.rb-rail__rename', listEl) ||
          (focusRowId ? U.qs('.rb-rail__row[data-section-id="' + attrSel(focusRowId) + '"] .rb-rail__main', listEl) : null) ||
          U.qs('.rb-rail__main', listEl) || addBtn;
        if (target) target.focus();
      }
    } else {
      patch(ordered);
    }

    setActiveUI();
    updateAddAvailability();
  }

  /* In-place refresh: a rebuild here would drop focus mid-keystroke. */
  function patch(ordered) {
    var resume = store.get();
    var rebuild = false;

    ordered.forEach(function (section) {
      var row = listEl.querySelector('[data-section-id="' + attrSel(section.id) + '"]');
      if (!row) { rebuild = true; return; }
      if (renamingId === section.id) return;

      var stat = completion(resume, section);
      var name = rowName(section, resume);
      var label = sectionLabel(section);
      row.classList.toggle('is-hidden', section.visible === false);
      row.dataset.pinned = String(!!section.pinned);

      var main = U.qs('.rb-rail__main', row);
      if (main) {
        main.setAttribute('aria-label', name);
        main.setAttribute('data-tip', name);
        var text = U.qs('.rb-rail__label', main);
        if (text) text.textContent = label;
        var dot = U.qs('.rb-rail__dot', main);
        if (dot) dot.dataset.state = stat.state;
      }
      var grip = U.qs('.rb-rail__grip', row);
      if (grip) grip.setAttribute('aria-label', 'Section options: ' + label);
      var eye = U.qs('.rb-rail__eye', row);
      if (eye) {
        /* The accessible name too, not just the tooltip. Left stale, the
           button announced the heading the section had before it was renamed,
           so a screen reader user was told they were toggling the wrong thing. */
        eye.setAttribute('aria-label', label + ' visibility');
        eye.setAttribute('aria-pressed', String(section.visible !== false));
        eye.setAttribute('data-tip', section.visible === false ? 'Show on the resume' : 'Hide from the resume');
      }
    });

    if (rebuild) { rowSignature = ''; render(); }
  }

  var syncSoon = U.debounce(function () { render(); }, 80);

  /* ---------------- active section ---------------- */

  function setActive(sectionId) {
    activeId = sectionId;
    setActiveUI();
  }

  function setActiveUI() {
    if (!listEl) return;
    U.qsa('.rb-rail__row', listEl).forEach(function (row) {
      var on = row.dataset.sectionId === activeId;
      row.classList.toggle('is-active', on);
      var main = U.qs('.rb-rail__main', row);
      if (!main) return;
      if (on) main.setAttribute('aria-current', 'true');
      else main.removeAttribute('aria-current');
    });
  }

  /* ---------------- navigating to a section ---------------- */

  function revealIfHidden(section) {
    if (section.visible !== false) return;
    store.update(function (draft) {
      var sec = findSection(draft, section.id);
      if (!sec) return false;
      sec.visible = true;
    }, { source: 'update' });
    U.announce(sectionLabel(section) + ' is back on the resume.');
  }

  function scrollTo(node) {
    if (!node || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({
      behavior: U.prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    });
  }

  function focusFirstField(node) {
    var field = U.qs('[data-bind]', node);
    if (!field) {
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      field = node;
    }
    try { field.focus({ preventScroll: true }); }
    catch (e) { field.focus(); }
  }

  function focusSection(sectionId) {
    var section = findSection(store.get(), sectionId);
    if (!section) return false;

    revealIfHidden(section);
    setActive(sectionId);
    bus.emit('section:focus', { sectionId: sectionId, type: section.type });

    var node = docNode(section);
    if (node) {
      scrollTo(node);
      focusFirstField(node);
      return true;
    }
    /* A section revealed from the rail may only reach the document after the
     * renderer catches up with the store, so give it one more idle pass. */
    U.requestIdle(function () {
      var late = docNode(findSection(store.get(), sectionId));
      if (late) { scrollTo(late); focusFirstField(late); }
    }, 150);
    return true;
  }

  /* ---------------- mutations ---------------- */

  function setVisible(sectionId, visible) {
    store.update(function (draft) {
      var sec = findSection(draft, sectionId);
      if (!sec) return false;
      sec.visible = visible;
    }, { source: 'update' });
    render();
    var section = findSection(store.get(), sectionId);
    if (section) {
      U.announce(sectionLabel(section) + (visible ? ' shown on the resume.' : ' hidden from the resume.'));
    }
  }

  function setPinned(sectionId, pinned) {
    store.update(function (draft) {
      var sec = findSection(draft, sectionId);
      if (!sec) return false;
      sec.pinned = pinned;
      M.normalizeOrders(draft);
    }, { source: 'update' });
    render();
    U.announce(pinned ? 'Pinned to the top.' : 'Unpinned.');
  }

  /* Reordering never crosses the pinned/unpinned boundary: pinned rows float
   * to the top on every sort, so such a move would silently be a no-op. */
  function canMove(ordered, section, delta) {
    var i = ordered.indexOf(section);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return false;
    return !!ordered[j].pinned === !!section.pinned;
  }

  function nudge(sectionId, delta) {
    var section = findSection(store.get(), sectionId);
    if (!section) return false;
    if (!canMove(M.orderedSections(store.get()), section, delta)) {
      U.announce(delta < 0 ? 'Already at the top of this group.' : 'Already at the bottom of this group.');
      return false;
    }
    var label = sectionLabel(section);
    store.update(function (draft) { return M.moveSection(draft, sectionId, delta); }, { source: 'update' });
    render();
    var ordered = M.orderedSections(store.get());
    var index = ordered.map(function (s) { return s.id; }).indexOf(sectionId);
    U.announce(label + ' moved to position ' + (index + 1) + ' of ' + ordered.length + '.');
    return true;
  }

  function moveTo(sectionId, targetIndex) {
    var section = findSection(store.get(), sectionId);
    if (!section) return false;
    var ordered = M.orderedSections(store.get());
    if (targetIndex < 0 || targetIndex > ordered.length) return false;
    if (!!ordered[Math.min(targetIndex, ordered.length - 1)].pinned !== !!section.pinned) return false;

    store.update(function (draft) {
      var list = M.orderedSections(draft);
      var from = list.map(function (s) { return s.id; }).indexOf(sectionId);
      if (from === -1) return false;
      var item = list.splice(from, 1)[0];
      list.splice(targetIndex, 0, item);
      list.forEach(function (s, i) { s.order = i; });
    }, { source: 'update' });
    render();
    return true;
  }

  function startRename(sectionId) {
    renamingId = sectionId;
    render();
  }

  function commitRename(sectionId, value, cancelled) {
    if (renamingId !== sectionId) return;
    renamingId = null;

    var typed = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 80);
    var index = sectionIndex(store.get(), sectionId);
    if (typed && !cancelled && index >= 0) {
      store.setField('sections.' + index + '.label', typed);
    }
    render();
  }

  function confirmDelete(sectionId) {
    var section = findSection(store.get(), sectionId);
    if (!section) return;
    var label = sectionLabel(section);
    var count = M.sectionEntries(store.get(), section.type).length;
    var undoKey = U.isMac() ? '⌘Z' : 'Ctrl+Z';
    /* Where the list will be after the removal, so focus can land on the row
       that took this one's place instead of jumping to the top. */
    var wasAt = M.orderedSections(store.get()).map(function (s) { return s.id; }).indexOf(sectionId);

    RB.ui.confirm({
      title: 'Delete ' + label + '?',
      message: count
        ? 'Its ' + U.pluralize(count, 'entry', 'entries') + ' go with it. You can undo this with ' + undoKey + '.'
        : 'You can undo this with ' + undoKey + '.',
      confirmLabel: 'Delete section',
      tone: 'danger'
    }).then(function (yes) {
      if (!yes) return;
      store.update(function (draft) { return M.removeSection(draft, sectionId); }, { source: 'update' });
      if (activeId === sectionId) activeId = null;
      render();
      U.announce(label + ' deleted.');
      var mains = listEl ? U.qsa('.rb-rail__main', listEl) : [];
      var next = wasAt >= 0 ? mains[Math.min(wasAt, mains.length - 1)] : mains[0];
      if (next) next.focus();
    });
  }

  function unusedTypes() {
    var used = {};
    (store.get().sections || []).forEach(function (s) { used[s.type] = true; });
    return M.SECTION_TYPES.filter(function (t) { return !used[t.type]; });
  }

  function addSection(type) {
    var added = null;
    store.update(function (draft) {
      added = M.addSection(draft, type);
      if (!added) return false;
    }, { source: 'update' });

    if (!added) {
      RB.ui.toast('That section could not be added. Close the list and try again.', { tone: 'error' });
      return;
    }
    render();
    U.announce(sectionLabel(added) + ' added.');
    /* The new section's form lives in the Edit panel, and the `section:focus`
     * event it is driven by is only heard while that panel is mounted. Adding
     * a section from the Design or Import tab therefore did nothing a person
     * could see: a row in this rail, an empty panel, and a page that cannot
     * show the section until it has an entry. Bring the panel over first. */
    if (RB.panel && typeof RB.panel.show === 'function') RB.panel.show('edit');
    focusSection(added.id);

    /* An empty section has no page to scroll to: the renderer only lays down a
     * section that has content in it, so the new row appears in the rail and
     * the panel jumps to its form while the page itself looks untouched. Say
     * so, or "Add section" reads as a control that did nothing. */
    U.requestIdle(function () {
      if (docNode(findSection(store.get(), added.id))) return;
      RB.ui.toast(sectionLabel(added) + ' added. It appears on the page once you fill in its first entry.',
        { tone: 'info' });
    }, 220);
  }

  function updateAddAvailability() {
    if (!addBtn) return;
    var none = unusedTypes().length === 0;
    addBtn.disabled = none;
    addBtn.setAttribute('data-tip', none ? 'Every section type is already on this resume' : 'Add a section');
  }

  /* ---------------- popovers ---------------- */

  /* Items get no role unless the caller supplies one: the section menu is a
   * real menu, the type picker is a dialog of plain buttons. */
  function popItem(opts) {
    var node = el('button', { type: 'button', class: 'rb-pop__item' });
    if (opts.role) node.setAttribute('role', opts.role);
    var icon = popIcon(opts.icon);
    if (icon) node.appendChild(icon);
    node.appendChild(el('span', { text: opts.label }));
    if (opts.kbd) {
      node.appendChild(el('span', { class: 'rb-spacer' }));
      node.appendChild(el('span', { class: 'rb-kbd', text: opts.kbd }));
    }
    if (opts.disabled) {
      node.setAttribute('aria-disabled', 'true');
      node.addEventListener('click', function (ev) { ev.preventDefault(); });
    } else if (opts.onClick) {
      node.addEventListener('click', function (ev) {
        if (opts.pop) opts.pop.close();
        opts.onClick(ev);
      });
    }
    return node;
  }

  function popSep() { return el('div', { class: 'rb-pop__sep', role: 'separator' }); }

  function openSectionMenu(anchor, sectionId) {
    var state = store.get();
    var section = findSection(state, sectionId);
    if (!section) return;
    var ordered = M.orderedSections(state);
    var body = el('div', { class: 'rb-col', style: 'gap:1px;min-width:212px' });
    var pop = { close: function () {} };

    body.appendChild(popItem({
      role: 'menuitem', label: 'Move up', icon: 'chevron-up', kbd: 'Alt+↑', pop: pop,
      disabled: !canMove(ordered, section, -1),
      onClick: function () { nudge(sectionId, -1); }
    }));
    body.appendChild(popItem({
      role: 'menuitem', label: 'Move down', icon: 'chevron-down', kbd: 'Alt+↓', pop: pop,
      disabled: !canMove(ordered, section, 1),
      onClick: function () { nudge(sectionId, 1); }
    }));
    body.appendChild(popSep());
    body.appendChild(popItem({
      role: 'menuitem', label: 'Rename heading', icon: 'type', kbd: 'F2', pop: pop,
      onClick: function () { startRename(sectionId); }
    }));
    body.appendChild(popItem({
      role: 'menuitem', pop: pop, icon: 'star',
      label: section.pinned ? 'Unpin from top' : 'Pin to top',
      onClick: function () { setPinned(sectionId, !section.pinned); }
    }));
    body.appendChild(popItem({
      role: 'menuitem', pop: pop,
      icon: section.visible === false ? 'eye' : 'eye-off',
      label: section.visible === false ? 'Show on the resume' : 'Hide from the resume',
      onClick: function () { setVisible(sectionId, section.visible === false); }
    }));
    body.appendChild(popSep());
    body.appendChild(popItem({
      role: 'menuitem', label: 'Delete section', icon: 'trash', pop: pop,
      onClick: function () { confirmDelete(sectionId); }
    }));

    pop.close = RB.ui.popover(anchor, body, { role: 'menu', align: 'start', side: 'bottom' }).close;
  }

  function openAddPopover(anchor) {
    var available = unusedTypes();
    if (!available.length) {
      RB.ui.toast('Every section type is already on this resume.', { tone: 'info' });
      return;
    }

    var body = el('div', { class: 'rb-col', style: 'min-width:236px' });
    var searchId = 'rb-rail-add-search';
    var search = el('input', {
      type: 'search',
      class: 'rb-input rb-input--sm',
      id: searchId,
      placeholder: 'Search sections',
      'data-autofocus': '',
      autocomplete: 'off'
    });
    var searchWrap = el('div', { class: 'rb-rail__search' });
    searchWrap.appendChild(el('label', { class: 'sr-only', for: searchId, text: 'Search section types' }));
    searchWrap.appendChild(search);
    body.appendChild(searchWrap);

    var results = el('div', { class: 'rb-rail__results rb-scroll' });
    body.appendChild(results);
    body.appendChild(el('div', { class: 'rb-rail__hint', text: 'A type can only be added once. Re-adding one brings it back.' }));

    function paint(query) {
      results.textContent = '';
      var q = String(query || '').trim().toLowerCase();
      var hits = available.filter(function (t) {
        if (!q) return true;
        return t.type.indexOf(q) !== -1 ||
          t.label.toLowerCase().indexOf(q) !== -1 ||
          t.defaultLabel.toLowerCase().indexOf(q) !== -1;
      });
      if (!hits.length) {
        results.appendChild(el('div', { class: 'rb-rail__noresult', text: 'No section matches “' + String(query).trim() + '”.' }));
        return;
      }
      hits.forEach(function (t) {
        results.appendChild(popItem({
          icon: t.icon, label: t.label, pop: pop,
          onClick: function () { addSection(t.type); }
        }));
      });
    }

    var pop = RB.ui.popover(anchor, body, { role: 'dialog', align: 'start', side: 'bottom' });
    if (pop.element) pop.element.setAttribute('aria-label', 'Add a section');
    paint('');
    search.addEventListener('input', function () { paint(search.value); });
    search.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var first = U.qs('.rb-pop__item', results);
      if (!first) return;
      ev.preventDefault();
      first.click();
    });
  }

  /* ---------------- drag and drop ---------------- */

  function clearDropHint() {
    if (dropHint) dropHint.node.classList.remove('is-drop-before', 'is-drop-after');
    dropHint = null;
  }

  function bindList() {
    U.on(listEl, 'dragstart', '.rb-rail__row', function (ev, row) {
      draggingId = row.dataset.sectionId;
      row.classList.add('is-dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', draggingId);
        ev.dataTransfer.setData(DRAG_MIME, draggingId);
      } catch (e) { /* older Safari refuses custom drag types */ }
    });

    /* The list itself is part of the drop target so a row can be dropped
     * into the gap above the first or below the last one. */
    U.on(listEl, 'dragover', '.rb-rail__row, .rb-rail__list', function (ev, hit) {
      if (!draggingId) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (!hit.classList.contains('rb-rail__row')) { clearDropHint(); return; }
      var rect = hit.getBoundingClientRect();
      var before = ev.clientY < rect.top + rect.height / 2;
      if (dropHint && dropHint.node === hit && dropHint.before === before) return;
      clearDropHint();
      hit.classList.add(before ? 'is-drop-before' : 'is-drop-after');
      dropHint = { node: hit, before: before };
    });

    U.on(listEl, 'dragleave', '.rb-rail__row', function (ev) {
      if (!listEl.contains(ev.relatedTarget)) clearDropHint();
    });

    U.on(listEl, 'drop', '.rb-rail__row, .rb-rail__list', function (ev, hit) {
      if (!draggingId) return;
      ev.preventDefault();
      var id = draggingId;
      var hint = dropHint;
      clearDropHint();
      draggingId = null;
      var rows = U.qsa('.rb-rail__row', listEl);
      if (!rows.length) return;
      if (!hint) {
        if (hit.classList.contains('rb-rail__row')) return;
        moveTo(id, rows.length);
        return;
      }
      var target = rows.indexOf(hint.node);
      if (target === -1) return;
      moveTo(id, hint.before ? target : target + 1);
    });

    U.on(listEl, 'dragend', null, function () {
      draggingId = null;
      clearDropHint();
      U.qsa('.rb-rail__row', listEl).forEach(function (row) {
        row.draggable = false;
        row.classList.remove('is-dragging');
      });
    });
  }

  /* ---------------- collapse ---------------- */

  function isCollapsed() {
    return root ? root.getAttribute('data-collapsed') === 'true' : readCollapsed();
  }

  function setCollapsed(value) {
    var next = !!value;
    if (root) {
      root.setAttribute('data-collapsed', String(next));
      var btn = U.qs('.rb-rail__collapse', root);
      if (btn) {
        btn.setAttribute('aria-expanded', String(!next));
        btn.setAttribute('aria-label', next ? 'Expand section list' : 'Collapse section list');
        btn.setAttribute('data-tip', next ? 'Expand' : 'Collapse');
        var svg = btn.querySelector('svg');
        var fresh = iconEl(next ? 'chevron-right' : 'chevron-left', { size: 'sm' });
        if (svg && fresh) btn.replaceChild(fresh, svg);
      }
    }
    writeCollapsed(next);
  }

  function toggleCollapsed() { setCollapsed(!isCollapsed()); }

  /* ---------------- lifecycle ---------------- */

  function subscribe() {
    unsubscribe();
    unsubs.push(bus.on('change', function () { syncSoon(); }));
    unsubs.push(bus.on('section:focus', function (payload) {
      if (payload && payload.sectionId) setActive(payload.sectionId);
    }));
    unsubs.push(bus.on('selection', function (payload) {
      if (!payload || !listEl) return;
      var type = payload.entryType || (payload.path && payload.path.indexOf('basics.') === 0 ? 'summary' : null);
      if (!type) return;
      var match = null;
      U.qsa('.rb-rail__row', listEl).forEach(function (row) {
        if (match) return;
        var section = findSection(store.get(), row.dataset.sectionId);
        if (section && section.type === type) match = row;
      });
      if (match) setActive(match.dataset.sectionId);
    }));
  }

  function unsubscribe() {
    unsubs.forEach(function (off) { if (typeof off === 'function') off(); });
    unsubs = [];
  }

  function destroy() {
    unsubscribe();
    if (syncSoon.cancel) syncSoon.cancel();
    mounted = false;
    root = null;
    listEl = null;
    addBtn = null;
    rowSignature = '';
  }

  function mount(target) {
    var container = target || U.qs('#rb-rail');
    if (!container) return null;
    if (mounted && root !== container) destroy();
    root = container;
    installStyles();
    buildShell();
    mounted = true;
    subscribe();
    render();
    return root;
  }

  /* ---------------- public API ----------------
   * registry.js hard-assigns RB.rail, so install() re-merges this object onto
   * whatever RB.rail currently is. RB.railApi is an alias nothing else
   * overwrites, for modules that want a guaranteed entry point. */

  var api = {
    mount: mount,
    render: render,
    refresh: render,
    destroy: destroy,
    focusSection: focusSection,
    setActive: setActive,
    isCollapsed: isCollapsed,
    setCollapsed: setCollapsed,
    toggleCollapsed: toggleCollapsed,
    addSection: addSection,
    openAddPopover: openAddPopover
  };

  var fallbackRegistry = [];

  function install() {
    if (!RB.rail || typeof RB.rail.register !== 'function') {
      RB.rail = {
        register: function (def) { if (def) fallbackRegistry.push(def); },
        modules: function () { return fallbackRegistry.slice(); }
      };
    }
    Object.keys(api).forEach(function (key) { RB.rail[key] = api[key]; });
    RB.railApi = api;

    RB.rail.register({ id: 'sections', mount: mount });
    if (RB.lifecycle && typeof RB.lifecycle.on === 'function') {
      /* A panel tab swap emits 'unmount' too; only an unscoped event means the
         whole shell is going away. */
      RB.lifecycle.on('unmount', function (payload) {
        if (payload && (payload.scope === 'panel' || payload.panelId != null)) return;
        destroy();
      });
    }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  function boot() {
    if (mounted) return;
    if (store.isReady()) start();
    else store.whenReady().then(start, start);
  }

  function start() {
    if (!mounted) mount();
  }

  install();
})(window);
