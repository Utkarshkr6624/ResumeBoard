/* Resumeboard — UI kit: toasts, modals, popovers, focus management
 * The only sanctioned way to interrupt the user. No alert/confirm/prompt.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var bus = global.RB.bus;
  var doc = global.document;
  var el = U.el;
  var icons = global.RB.icons;

  var overlayRoot = null;
  var toastRoot = null;
  var openStack = [];
  /* Held only while at least one modal is open, so nested modals do not restore
   * 'hidden' out from under each other. */
  var savedBodyOverflow = null;

  function root(id, fallbackId) {
    return doc.getElementById(id) || doc.getElementById(fallbackId) || doc.body.appendChild(el('div', { id: id }));
  }

  function isTypingTarget(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    var tag = (node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function overlay() { return overlayRoot || (overlayRoot = root('rb-overlay-root')); }
  function toasts() { return toastRoot || (toastRoot = root('rb-toasts')); }

  /* ---------------- Toasts ---------------- */

  function toast(message, opts) {
    opts = opts || {};
    var node = el('div', { class: 'rb-toast' + (opts.tone ? ' rb-toast--' + opts.tone : '') });
    node.setAttribute('role', opts.tone === 'error' ? 'alert' : 'status');

    var iconName = opts.tone === 'success' ? 'check-circle' : opts.tone === 'error' ? 'alert-circle' : opts.tone === 'warn' ? 'alert-triangle' : 'info';
    node.appendChild(el('span', { class: 'rb-i', html: icons.svg(iconName) }));

    var body = el('span', { class: 'rb-clamp-3' });
    body.textContent = message;
    node.appendChild(body);

    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(function () { node.remove(); }, 160);
    }

    if (opts.action && opts.action.label) {
      var btn = el('button', { class: 'rb-toast__action', type: 'button', text: opts.action.label });
      btn.addEventListener('click', function () {
        dismiss();
        try { opts.action.onClick(); } catch (e) { console.error(e); }
      });
      node.appendChild(btn);
    }

    var closeBtn = el('button', { class: 'rb-btn rb-btn--icon rb-btn--sm', type: 'button', 'aria-label': 'Dismiss', html: icons.svg('x', { size: 'sm' }) });
    closeBtn.style.cssText = 'flex:none;margin:-4px -6px -4px 0;filter:invert(1) opacity(.7)';
    closeBtn.addEventListener('click', dismiss);
    node.appendChild(closeBtn);

    toasts().appendChild(node);
    var timer = setTimeout(dismiss, opts.duration || (opts.tone === 'error' ? 8000 : 4000));
    bus.emit('toast', { message: message, tone: opts.tone });
    return dismiss;
  }

  /* ---------------- Modals ---------------- */

  function modal(config) {
    config = config || {};
    var lastFocused = doc.activeElement;

    var backdrop = el('div', { class: 'rb-modal-backdrop' });
    var dialog = el('div', {
      class: 'rb-modal' + (config.wide ? ' rb-modal--wide' : ''),
      role: 'dialog', 'aria-modal': 'true'
    });
    if (config.label) dialog.setAttribute('aria-label', config.label);
    if (config.labelledBy) dialog.setAttribute('aria-labelledby', config.labelledBy);

    var head = el('div', { class: 'rb-modal-head' });
    var heading = el('h2', { class: 'rb-panel-title', style: 'font-size:var(--rb-text-xl);flex:1;min-width:0' });
    heading.textContent = config.title || '';
    /* A caller that names the dialog by its own heading keeps that id. The
     * generated one is only a fallback, and writing it unconditionally would
     * replace a real reference with an empty one. */
    if (config.labelledBy) {
      dialog.setAttribute('aria-labelledby', config.labelledBy);
    } else {
      heading.id = 'rb-modal-title-' + Date.now();
      dialog.setAttribute('aria-labelledby', heading.id);
    }
    head.appendChild(heading);

    var closeBtn = el('button', { class: 'rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm', type: 'button', 'aria-label': 'Close', html: icons.svg('x') });
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    var body = el('div', { class: 'rb-modal-body' });
    if (typeof config.body === 'string') body.textContent = config.body;
    else if (config.body) body.appendChild(config.body);
    dialog.appendChild(body);

    var foot = null;
    if (config.actions && config.actions.length) {
      foot = el('div', { class: 'rb-modal-foot' });
      if (config.footNote) {
        var note = el('span', { class: 'rb-hint rb-truncate', text: config.footNote });
        foot.appendChild(note);
        foot.appendChild(el('span', { class: 'rb-spacer' }));
      }
      config.actions.forEach(function (action) {
        var b = el('button', {
          type: 'button',
          class: 'rb-btn ' + (action.primary ? 'rb-btn--primary' : action.tone === 'danger' ? 'rb-btn--secondary rb-btn--danger' : 'rb-btn--secondary'),
          text: action.label
        });
        b.addEventListener('click', function () {
          if (action.onClick) {
            var r = action.onClick(close);
            if (r === false) return;
          }
          if (action.keepOpen !== true) close();
        });
        foot.appendChild(b);
      });
      dialog.appendChild(foot);
    }

    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      var i = openStack.indexOf(handle);
      if (i !== -1) openStack.splice(i, 1);
      doc.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      if (!openStack.length && savedBodyOverflow !== null) {
        doc.body.style.overflow = savedBodyOverflow;
        savedBodyOverflow = null;
      }
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      if (config.onClose) config.onClose(result);
    }
    var handle = { close: close, dialog: dialog, body: body, foot: foot };

    closeBtn.addEventListener('click', function () { close(); });
    backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === backdrop && config.dismissable !== false) close();
    });

    function onKeydown(ev) {
      if (openStack[openStack.length - 1] !== handle) return;
      if (ev.key === 'Escape' && config.dismissable !== false) { ev.stopPropagation(); close(); return; }
      if (ev.key === 'Tab') { U.trapFocus(dialog, ev); }
    }
    doc.addEventListener('keydown', onKeydown, true);

    backdrop.appendChild(dialog);
    overlay().appendChild(backdrop);
    openStack.push(handle);
    if (savedBodyOverflow === null) savedBodyOverflow = doc.body.style.overflow || '';
    doc.body.style.overflow = 'hidden';

    U.requestIdle(function () {
      var first = U.qs('[data-autofocus]', dialog) || U.focusableIn(dialog)[0] || dialog;
      if (first && first.focus) first.focus();
    }, 50);

    return handle;
  }

  function confirm(config) {
    config = config || {};
    return new Promise(function (resolve) {
      var settled = false;
      modal({
        title: config.title || 'Are you sure?',
        body: config.message || '',
        wide: false,
        dismissable: true,
        actions: [
          { label: config.cancelLabel || 'Cancel', onClick: function () { settled = true; resolve(false); } },
          { label: config.confirmLabel || 'Confirm', primary: !config.tone || config.tone !== 'danger', tone: config.tone, onClick: function () { settled = true; resolve(true); } }
        ],
        onClose: function () { if (!settled) resolve(false); }
      });
    });
  }

  function prompt(config) {
    config = config || {};
    return new Promise(function (resolve) {
      var settled = false;
      var input = el('input', { class: 'rb-input', type: 'text', id: 'rb-prompt-input', value: config.value || '', placeholder: config.placeholder || '' });
      input.setAttribute('data-autofocus', '');
      var wrap = el('div', { class: 'rb-field' }, [el('label', { class: 'rb-label', for: 'rb-prompt-input', text: config.label || 'Value' }), input]);
      if (config.hint) wrap.appendChild(el('span', { class: 'rb-hint', text: config.hint }));

      var m = modal({
        title: config.title || 'Enter a value',
        body: wrap,
        actions: [
          { label: config.cancelLabel || 'Cancel', onClick: function () { settled = true; resolve(null); } },
          { label: config.confirmLabel || 'Save', primary: true, onClick: function () { settled = true; resolve(input.value); } }
        ],
        onClose: function () { if (!settled) resolve(null); }
      });

      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); settled = true; resolve(input.value); m.close(); }
      });
    });
  }

  /* ---------------- Popover ---------------- */

  function popover(anchor, content, opts) {
    opts = opts || {};
    closePopover();

    var label = opts.label ||
      ((anchor && (anchor.getAttribute('aria-label') || anchor.innerText || '')) || '').trim() || 'Menu';

    /* #rb-overlay-root sits outside every landmark, so a menu opened into it is
     * content no screen reader can reach by region. The popover is its own
     * region while it is open, named after the control that opened it — which
     * also keeps role=menu off the shell, because a menu has to own its
     * menuitems directly and the caller already built that element. */
    var pop = el('div', { class: 'rb-pop', role: 'region', 'aria-label': label });
    if (typeof content === 'string') pop.appendChild(el('div', { class: 'rb-col', html: content }));
    else {
      if (content && content.setAttribute && !content.getAttribute('role')) {
        /* A menuitem with no menu above it is not a menu. When the caller
         * built menuitems and did not name the container, it is a menu. */
        var isMenu = content.querySelector('[role="menuitem"]');
        content.setAttribute('role', opts.role || (isMenu ? 'menu' : 'presentation'));
        /* A named role needs a name. The shell's label comes from the
         * trigger, which is the right words for the thing the reader just
         * activated, so the content takes the same one. */
        if (content.getAttribute('role') === 'dialog' || content.getAttribute('role') === 'menu') {
          content.setAttribute('aria-label', label);
        }
      }
      pop.appendChild(content);
    }

    overlay().appendChild(pop);

    /* Re-place on every size change. Callers routinely paint their content
     * after the popover exists (the add-section list filters on input, menus
     * fill asynchronously), and a one-shot measurement positions the popover
     * for an empty box — it then grows off-screen and covers its own anchor. */
    function place() {
      var rect = anchor.getBoundingClientRect();
      var vw = global.innerWidth, vh = global.innerHeight;
      var pw = pop.offsetWidth, ph = pop.offsetHeight;
      var side = opts.side || 'bottom';

      var top = side === 'top' ? rect.top - ph - 6 : rect.bottom + 6;
      if (top + ph > vh - 8) top = Math.max(8, rect.top - ph - 6);
      if (top < 8) top = Math.min(rect.bottom + 6, vh - ph - 8);

      var left = opts.align === 'end' ? rect.right - pw : rect.left;
      left = U.clamp(left, 8, vw - pw - 8);

      pop.style.top = Math.round(top) + 'px';
      pop.style.left = Math.round(left) + 'px';
    }

    place();
    var ro = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver(place) : null;
    if (ro) ro.observe(pop);

    function onDocDown(ev) {
      if (!armed) return;
      if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
      close();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); anchor.focus(); }
      /* A popover is not a dialog. It has no aria-modal, nothing behind it is
         inert, and Tab is the way a keyboard user says "I am finished here" —
         so Tab closes it and carries on from the control that opened it. The
         trap that used to sit here made the add-section picker and every
         section menu a keyboard dead end: the only ways out were Escape and a
         click somewhere else. A modal keeps its own trap; that one is correct. */
      if (ev.key === 'Tab') { close(); if (anchor && anchor.focus) anchor.focus(); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        /* A menu moves focus between its items. A picker with a search box in
         * it does not: the user is in a field, and the arrow belongs to the
         * caret there. */
        if (isTypingTarget(ev.target)) return;
        var items = U.qsa('[role="menuitem"], button, a[href]', pop);
        if (!items.length) return;
        ev.preventDefault();
        var i = items.indexOf(doc.activeElement);
        var next = ev.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    }

    /* Attached here, not on a timer. A timer meant a popover closed in the
     * same task it was opened removed listeners that were not attached yet,
     * and the `if (!current) return` guard then made the second close
     * impossible — so the timeout attached them afterwards and they stayed
     * for the rest of the session, taking focus on every Escape and trapping
     * every Tab. The mousedown that opened this popover may still be
     * propagating, so onDocDown waits one task before it may close anything. */
    var armed = false;
    var armTimer = setTimeout(function () { armed = true; }, 0);
    doc.addEventListener('mousedown', onDocDown, true);
    doc.addEventListener('keydown', onKey, true);
    global.addEventListener('resize', close, { once: true });
    global.addEventListener('scroll', close, { once: true, capture: true });

    /* aria-haspopup says what the trigger opens; aria-expanded is what says it
     * is open right now, and the trigger has to carry both. */
    if (anchor && anchor.setAttribute && anchor.getAttribute('aria-haspopup')) {
      anchor.setAttribute('aria-expanded', 'true');
    }

    U.requestIdle(function () {
      var first = U.qs('[data-autofocus]', pop) || U.focusableIn(pop)[0];
      if (first) first.focus();
    }, 40);

    var current = null;
    function close() {
      if (!current) return;
      current = null;
      clearTimeout(armTimer);
      doc.removeEventListener('mousedown', onDocDown, true);
      doc.removeEventListener('keydown', onKey, true);
      /* once:true only detaches when the event fires. Without this the closure
       * pins the detached popover subtree until the next scroll anywhere. */
      global.removeEventListener('resize', close);
      global.removeEventListener('scroll', close, true);
      if (ro) ro.disconnect();
      if (anchor && anchor.setAttribute && anchor.getAttribute('aria-expanded') !== null) {
        anchor.setAttribute('aria-expanded', 'false');
      }
      pop.remove();
      if (opts.onClose) opts.onClose();
    }
    current = { close: close, element: pop };
    return current;
  }

  function closePopover() {
    if (activePopover) activePopover.close();
  }
  var activePopover = null;
  var _popover = popover;
  popover = function (a, c, o) { var h = _popover(a, c, o); activePopover = h; return h; };

  /* ---------------- Undo that tells the truth ---------------- */

  /* Undo is a linear stack: it takes back the most recent change, not the one
   * a toast is named after. A toast lives four seconds, and one keystroke on
   * the resume in that window is enough to make a bare undo() destroy an edit
   * the person never asked to lose — under a button labelled "Undo" on a toast
   * that said the change had been applied. isUnchanged() is re-read at click
   * time; when it is false the button says what is actually true instead. */
  function undoableToast(message, opts) {
    opts = opts || {};
    var isUnchanged = typeof opts.isUnchanged === 'function' ? opts.isUnchanged : function () { return true; };
    return toast(message, {
      tone: opts.tone || 'success',
      duration: opts.duration,
      action: {
        label: 'Undo',
        onClick: function () {
          if (!isUnchanged()) {
            toast('Something changed after this, so Undo would take that back instead. Use ' +
              (U.isMac() ? '⌘Z' : 'Ctrl+Z') + ' to step back one change at a time.', { tone: 'warn' });
            return;
          }
          opts.onUndo();
        }
      }
    });
  }

  /* ---------------- Confirm-on-danger ---------------- */
  function confirmDelete(label, onConfirm) {
    return confirm({
      title: 'Delete ' + label + '?',
      message: 'You can undo this with ' + (U.isMac() ? '⌘Z' : 'Ctrl+Z') + ' until you close this tab.',
      confirmLabel: 'Delete',
      tone: 'danger'
    }).then(function (yes) { if (yes) onConfirm(); return yes; });
  }

  /* ---------------- Dropdown helper ---------------- */

  function menu(anchor, items, opts) {
    var list = el('div', { role: 'menu', class: 'rb-col', style: 'gap:1px' });
    items.forEach(function (item) {
      /* A menu owns menuitems, separators and groups. A plain div in a menu is
       * not one of them, and assistive technology reads the gap as a missing
       * item. */
      if (item === '-') {
        list.appendChild(el('div', { class: 'rb-pop__sep', role: 'separator' }));
        return;
      }
      if (item && item.label && !item.onClick && !item.href) {
        list.appendChild(el('div', {
          class: 'rb-pop__label', role: 'presentation', text: item.label
        }));
        return;
      }
      var node = el(item && item.href ? 'a' : 'button', {
        class: 'rb-pop__item', role: 'menuitem', type: 'button', href: item && item.href || null
      });
      if (item && item.icon) node.appendChild(el('span', { 'aria-hidden': 'true', html: icons.svg(item.icon, { size: 'sm' }) }));
      node.appendChild(el('span', { text: item && item.label || '' }));
      if (item && item.kbd) node.appendChild(el('span', { class: 'rb-spacer' }));
      if (item && item.kbd) node.appendChild(el('span', { class: 'rb-kbd', text: item.kbd }));
      if (item && item.checked) node.setAttribute('aria-checked', 'true');
      node.addEventListener('click', function (ev) {
        ev.preventDefault();
        var keep = item.onClick && item.onClick(ev);
        if (keep !== false && (!item || item.keepOpen !== true)) p.close();
      });
      list.appendChild(node);
    });
    var p = popover(anchor, list, opts);
    return p;
  }

  global.RB = global.RB || {};
  global.RB.ui = {
    toast: toast,
    modal: modal,
    confirm: confirm,
    prompt: prompt,
    popover: popover,
    closePopover: closePopover,
    confirmDelete: confirmDelete,
    undoableToast: undoableToast,
    menu: menu,
    /* A modal owns Tab and Escape while it is up. Anything that would open a
       second focus trap over it has to ask first. */
    isModalOpen: function () { return openStack.length > 0; }
  };
})(window);
