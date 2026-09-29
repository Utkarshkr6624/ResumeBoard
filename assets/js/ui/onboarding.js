/* Resumeboard — first-run onboarding and the auto-build entry points
 *
 * One decision on arrival: build the resume from something you already have,
 * look at a worked example, or start typing. The heavy lifting (importing a
 * file, reading a posting, building a resume out of pasted text) lives in
 * RB.autofill and RB.importer; this dialog only chooses between them so the
 * first screen is three rows instead of a wall of options.
 *
 * The only thing this file persists is one localStorage flag. That is not a
 * cookie, it is never sent anywhere, and deleting it just brings the dialog
 * back — which is why it is also the honest place to record "seen".
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var RB = global.RB;
  if (!RB || !RB.utils || !doc) return;

  var U = RB.utils;
  var el = U.el;
  var icons = RB.icons || { svg: function () { return ''; } };

  var FLAG = 'rb:onboarding.v1';

  var live = null;        /* handle of the open dialog, so it opens at most once */
  var memoryFlag = false; /* localStorage throws in some locked-down browsers */
  var blankDocNode = null;/* last .rb-doc__blank we decorated, to stay idempotent */

  /* ---------------- the "have I seen this" flag ---------------- */

  function seen() {
    try { return global.localStorage.getItem(FLAG) === '1'; }
    catch (e) { return memoryFlag; }
  }

  function markSeen() {
    try { global.localStorage.setItem(FLAG, '1'); }
    catch (e) { memoryFlag = true; }
  }

  function clearFlag() {
    try { global.localStorage.removeItem(FLAG); } catch (e) { /* nothing to clear */ }
    memoryFlag = false;
  }

  function isFirstRun() {
    if (seen()) return false;
    if (!RB.store) return true;
    /* The blank-check predicate lives on the model, not the store. Tolerate a
     * future store.isBlankResume() so this keeps working either way. */
    var blank = typeof RB.store.isBlankResume === 'function'
      ? RB.store.isBlankResume()
      : RB.model && RB.model.isBlankResume
        ? RB.model.isBlankResume(RB.store.get())
        : true;
    return !!blank;
  }

  /* ---------------- helpers ---------------- */

  /* After any close, put the caret where the work actually starts. Programmatic
   * focus on a document field is handed to the matching form input by the
   * panel, so either destination is typing-ready — which is the point. */
  function focusResume() {
    U.requestIdle(function () {
      var target = U.qs('#rb-doc [data-bind="basics.name"]') || U.qs('#rb-doc') || U.qs('#rb-main');
      if (target && target.focus) target.focus();
    }, 80);
  }

  /* This dialog is reachable from the home page, where there is no editor to
   * look at. A finished resume with no route to the editor is a dead end, so
   * every way out of here hands off when the page is not the editor — and the
   * "start typing" row does too, rather than leaving the home page to close
   * the dialog and say nothing about what happens next. */
  function gotoEditor(opts) {
    if (opts && typeof opts.onGotoEditor === 'function') { opts.onGotoEditor(); return true; }
    return false;
  }

  /* The store debounces its write, so a navigation that follows a write has to
   * wait for it or the editor opens on an empty page. */
  function afterWrite(done) {
    var flushed = (RB.store && RB.store.persistNow) ? RB.store.persistNow() : Promise.resolve();
    Promise.resolve(flushed).then(done, done);
  }

  function icon(name) {
    return el('span', { class: 'rb-onb__icon', html: icons.svg(name) });
  }

  /* RB.autofill is a separate script; the dialog must not depend on load order
   * to be honest about what it can do. */
  function autofillAvailable() {
    return !!(RB.autofill && typeof RB.autofill.open === 'function');
  }

  function openAutofill(opts) {
    if (!autofillAvailable()) {
      if (RB.ui) RB.ui.toast('Auto-build is not available right now. Start typing, or import a file.', { tone: 'warn' });
      return null;
    }
    try {
      /* autofill has already flushed the store by the time onDone runs, so a
       * hand-off from here cannot land on a page that has not been written. */
      return RB.autofill.open({ onDone: function () {
        if (U.qs('#rb-doc')) { focusResume(); return; }
        gotoEditor(opts);
      } });
    } catch (err) {
      if (RB.ui) RB.ui.toast('Auto-build would not open. Start typing, or import a file from the menu.', { tone: 'error' });
      return null;
    }
  }

  /* ---------------- the dialog ---------------- */

  function show(opts) {
    opts = opts || {};
    if (live) return live;
    if (!RB.ui || !RB.ui.modal) return null;

    var body = el('div', { class: 'rb-onb' });
    var list = el('div', { class: 'rb-onb__list', role: 'group', 'aria-label': 'Ways to start' });
    var rows = [];

    body.appendChild(el('p', {
      class: 'rb-onb__intro',
      text: 'Three ways in. Nothing here is locked in — every word stays editable, and you can undo any of it.'
    }));
    body.appendChild(list);
    body.appendChild(el('p', { class: 'rb-onb__privacy' }, [
      el('span', { class: 'rb-onb__privacyicon', html: icons.svg('shield', { size: 'sm' }) }),
      el('span', { text: 'Your resume never leaves this browser. Nothing is uploaded, there is no account, and no cookies are set.' })
    ]));

    function close() {
      if (live) live.close();
    }

    function addRow(opts2) {
      var node = el('button', {
        class: 'rb-onb__choice rb-card' + (opts2.primary ? ' rb-onb__choice--primary' : '') + (opts2.cls ? ' ' + opts2.cls : ''),
        type: 'button'
      }, [
        icon(opts2.icon),
        el('span', { class: 'rb-onb__choicetext' }, [
          el('span', { class: 'rb-onb__choicetitle', text: opts2.title }),
          el('span', { class: 'rb-onb__choicedesc', text: opts2.desc })
        ])
      ]);
      node.addEventListener('click', function () {
        try { opts2.onClick(); }
        catch (e) {
          if (RB.ui) RB.ui.toast('That did not work. Try another option.', { tone: 'error' });
        }
      });
      rows.push(node);
      list.appendChild(node);
      return node;
    }

    addRow({
      icon: 'wand',
      title: 'Build it from my profile',
      desc: autofillAvailable()
        ? 'Paste a LinkedIn profile, an old resume, or a job posting. We read the facts out of it and you keep the wording.'
        : 'Auto-build is not available in this build. Import a file from the menu instead.',
      primary: true,
      onClick: function () { close(); openAutofill(opts); }
    });

    addRow({
      icon: 'spark',
      title: 'See a worked example',
      desc: 'A complete worked example, filled in. Every word is editable, and you can clear it later.',
      onClick: function () {
        if (!RB.store || !RB.store.loadSample) {
          if (RB.ui) RB.ui.toast('The worked example could not be loaded. Start from a blank resume instead.', { tone: 'error' });
          return;
        }
        RB.store.loadSample();
        close();
        afterWrite(function () {
          if (gotoEditor(opts)) return;
          if (RB.ui) RB.ui.toast('Example loaded. Replace it with your own details, or clear it from the menu.', { tone: 'success' });
          focusResume();
        });
      }
    });

    addRow({
      icon: 'type',
      title: 'Start typing',
      desc: 'A blank page and a caret in your name field. Nothing else to set up.',
      cls: 'rb-onb__skip',
      onClick: function () {
        close();
        /* This dialog is reachable from the home page now, so "start typing"
         * has to actually take you somewhere to type. */
        if (gotoEditor(opts)) return;
        focusResume();
      }
    });

    /* The rows are a single column, so the arrow keys walk them. */
    U.on(list, 'keydown', '.rb-onb__choice', function (ev, target) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      var i = rows.indexOf(target);
      if (i === -1) return;
      ev.preventDefault();
      rows[(i + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
    });

    var handle = RB.ui.modal({
      title: 'Start your resume',
      body: body,
      wide: false,
      dismissable: true,
      onClose: function () {
        live = null;
        markSeen();
        if (opts.onDismiss) opts.onDismiss();
        focusResume();
      }
    });
    live = handle;
    if (opts.onClose) opts.onClose(handle);
    return handle;
  }

  function maybeShow(opts) {
    if (live) return live;
    if (!isFirstRun()) return null;
    return show(opts);
  }

  /* ---------------- entry points in the editor ---------------- */

  /* The renderer owns the empty-document markup and has no idea about
   * auto-build, so the button is grafted on here and re-grafted whenever the
   * renderer replaces the block. */
  function decorateBlankDoc() {
    var host = U.qs('#rb-doc');
    if (!host) return;
    var blank = U.qs('.rb-doc__blank', host);
    if (blank === blankDocNode) return;
    blankDocNode = blank;
    if (!blank) return;
    if (!autofillAvailable() || U.qs('.rb-onb-doccta', blank)) return;

    var btn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--primary rb-onb-doccta',
      html: icons.svg('wand', { size: 'sm' }) + '<span>Build from my profile</span>'
    });
    btn.addEventListener('click', function () { openAutofill(); });

    var first = blank.firstElementChild;
    if (first) blank.insertBefore(btn, first);
    else blank.appendChild(btn);
  }

  function watchBlankDoc() {
    var host = U.qs('#rb-doc');
    if (!host || typeof global.MutationObserver !== 'function') return;
    /* subtree, not childList: the renderer keeps #rb-doc's own children and
     * swaps the body inside them. */
    var observer = new global.MutationObserver(decorateBlankDoc);
    observer.observe(host, { childList: true, subtree: true });
    decorateBlankDoc();
  }

  /* ---------------- registration ---------------- */

  RB.onboarding = {
    FLAG: FLAG,
    maybeShow: maybeShow,
    show: show,
    isFirstRun: isFirstRun,
    markSeen: markSeen,
    reset: clearFlag,
    openAutofill: openAutofill
  };

  /* Boot path: app.html loads this last, and RB.runBoot fires once the
   * store is hydrated. Absent that, maybeShow() is the manual entry point. */
  if (typeof RB.onBoot === 'function') {
    RB.onBoot(function () {
      watchBlankDoc();
      U.requestIdle(function () { maybeShow(); }, 240);
    });
  } else if (doc.readyState !== 'loading') {
    watchBlankDoc();
  }
})(window);
