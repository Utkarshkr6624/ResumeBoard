/* Resumeboard — document text size, page count and preview zoom
 *
 * Three controls that sit together in the toolstrip because they answer the
 * same question — "is this page right?".
 *
 *   Text size  One multiplier on top of the template's own base size, so a
 *              template keeps its identity and the user only expresses intent.
 *              Every other measurement in the document is derived from that
 *              base in templates.css (--_name-size, --_small, --_indent …), so
 *              headings, gaps and rules all move with it and the layout stays
 *              coherent instead of merely getting bigger.
 *   Page count Measured, not estimated: RB.paginator walks the real flow.
 *   Zoom       Purely a viewing aid — `zoom` on #rb-page-frame, never a model
 *              write, and print.css zeroes it.
 *
 * The multiplier is deliberately NOT stored in resume.design. model.migrate
 * rebuilds design from a whitelist, so a private key would be dropped on the
 * next load and the multiplier would compound with itself. Instead the last
 * authored base and the last applied size are kept in localStorage, which is
 * what lets us tell "the design panel moved the size" apart from "this is our
 * own write echoing back" — and therefore lets the two controls stay honest
 * about the same number.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var store = RB.store;
  var model = RB.model;
  var el = U.el;

  var SCALE_KEY = 'rb.typescale';
  var BASE_KEY = 'rb.typescale.base';
  var APPLIED_KEY = 'rb.typescale.applied';
  var ZOOM_KEY = 'rb.doczoom';

  /* model.validate clamps baseSizePt to 9pt. Offering less than that put the
   * bottom of both the "smaller" button and the design panel's base-size slider
   * in a range the store refuses: the write lands, the value comes back clamped,
   * reconcile() re-anchors, and the control reads 100% having just been pressed. */
  var MIN_PT = 9;
  var MAX_PT = 13.5;
  var STEP_PT = 0.5;
  var MIN_SCALE = 0.6;
  var MAX_SCALE = 1.6;
  var EPS = 0.06;            /* the store rounds to 2dp; anything nearer is us */
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 2;
  var ZOOM_STEP = 0.1;
  var reconciling = false;

  var mounted = null;        /* one bar per page; mount is idempotent */

  /* ------------------------------------------------------------- storage */

  function readNum(key) {
    try {
      var raw = parseFloat(global.localStorage.getItem(key));
      if (isFinite(raw)) return raw;
    } catch (e) { /* private mode: fall through to the model */ }
    return null;
  }

  function writeNum(key, value) {
    try { global.localStorage.setItem(key, String(value)); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- scale
   *
   * Three numbers, and confusing them is the whole bug surface:
   *   base      the body size the template (or the design panel) authored.
   *             Never read back from design.baseSizePt, because that is where
   *             the *result* of the multiplier is written.
   *   applied   what design.baseSizePt currently holds, i.e. the size on the
   *             page right now. Nudging moves this.
   *   scale     applied / base. What the percentage in the toolstrip means.
   */

  function designOf(resume) {
    var r = resume || store.get();
    return (r && r.design) ? r.design : null;
  }

  function appliedSize() {
    var d = designOf();
    if (!d) return model.DEFAULT_DESIGN.baseSizePt;
    return Number(d.baseSizePt) || model.DEFAULT_DESIGN.baseSizePt;
  }

  /* The authored base. Falls back to the live size the first time, which is
   * correct: before anything has been scaled, the two are the same number. */
  function baseSize() {
    var base = readNum(BASE_KEY);
    if (base != null && base > 0) return base;
    base = appliedSize();
    writeNum(BASE_KEY, base);
    return base;
  }

  function readScale() {
    var applied = appliedSize();
    var base = baseSize();
    if (base <= 0) return 1;
    return U.clamp(+(applied / base).toFixed(3), MIN_SCALE, MAX_SCALE);
  }

  function current() {
    return readScale();
  }

  function label() {
    var s = current();
    if (Math.abs(s - 1) < 0.005) return '100%';
    return Math.round(s * 100) + '%';
  }

  function set(scale, opts) {
    var s = U.clamp(+(+scale).toFixed(3), MIN_SCALE, MAX_SCALE);
    var base = baseSize();
    var next = U.clamp(+(base * s).toFixed(2), MIN_PT, MAX_PT);
    /* The clamps can pull the applied size away from base*scale; the scale
     * that is actually on the page is the one to show and to remember. */
    var real = U.clamp(+(next / base).toFixed(3), MIN_SCALE, MAX_SCALE);
    writeNum(SCALE_KEY, real);
    writeNum(BASE_KEY, base);
    if (!store.update(function (draft) {
      draft.design.baseSizePt = next;
      writeNum(APPLIED_KEY, next);
      return true;
    }, { source: 'design', coalesce: false })) {
      return current();
    }
    if (!opts || !opts.silent) {
      announceSize(real, next);
      RB.bus.emit('typescale:change', { scale: real, sizePt: next });
    }
    if (mounted) mounted.sync();
    return real;
  }

  /* The bounds the two buttons are disabled at. The Design panel's own
     base-size slider reaches 14pt and this bar's ceiling is 13.5pt, so at
     14pt the clamp on the way up is a step down: "Make the resume text
     bigger" made the text smaller. The keys and the buttons have to agree. */
  function atMin() { return appliedSize() <= MIN_PT + EPS; }
  function atMax() { return appliedSize() >= MAX_PT - EPS; }

  /* deltaPt is in points of body text, not in multiplier units: a user
     pressing "bigger" once should get the same half-point whatever the
     template's base size happens to be. */
  function nudge(deltaPt) {
    if (deltaPt > 0 && atMax()) return current();
    if (deltaPt < 0 && atMin()) return current();
    var base = baseSize();
    var target = U.clamp(+(appliedSize() + deltaPt).toFixed(2), MIN_PT, MAX_PT);
    if (Math.abs(target - appliedSize()) < 0.01) return current();
    return set(target / base);
  }

  function reset() { return set(1); }

  /* Decide which authored base the multiplier belongs to.
   *  - our own write is still the stored one  → keep the stored base
   *  - anything else moved the size          → re-anchor on it, multiplier 1
   * Re-anchoring rather than re-multiplying is what stops a template switch,
   * a design-panel edit or a reload from stacking the scale on itself. */
  function reconcile() {
    /* Called from a bus handler, so it can itself trigger a write. The guard
     * keeps that from recursing; the second pass is a no-op anyway. */
    if (reconciling) return;
    reconciling = true;
    try {
      if (!designOf()) return;
      var now = appliedSize();
      var applied = readNum(APPLIED_KEY);
      var base = readNum(BASE_KEY);
      if (applied != null && base != null && base > 0 && Math.abs(now - applied) < EPS) {
        var s = readNum(SCALE_KEY);
        if (s == null) return;
        var next = U.clamp(+(base * s).toFixed(2), MIN_PT, MAX_PT);
        if (Math.abs(next - now) < EPS) return;
        store.update(function (draft) {
          draft.design.baseSizePt = next;
          writeNum(APPLIED_KEY, next);
          return true;
        }, { source: 'design', coalesce: false });
        return;
      }
      /* The stored resume disagrees with our record: the base was authored
       * somewhere else. The two controls show the same number, so the
       * multiplier resets rather than hiding behind the new base. */
      writeNum(SCALE_KEY, 1);
      writeNum(BASE_KEY, now);
      writeNum(APPLIED_KEY, now);
    } finally {
      reconciling = false;
    }
  }

  function announceSize(s, sizePt) {
    U.announce('Resume text size ' + Math.round(s * 100) + ' percent. Body text is now ' + sizePt.toFixed(1) + ' point.');
  }

  /* ---------------------------------------------------------------- zoom */

  /* A contact fact carries its separator as a leading span, and the renderer
   * drops that separator on the items that open a wrapped line — a mark it
   * computes while paginating. Zoom is a view-only transform and deliberately
   * does not re-paginate, yet it re-wraps the contact line all the same, so
   * the marks go stale: a line opens with an orphan middot and two facts end up
   * jammed together with nothing between them. Re-derive them from the same
   * documented contract after the new zoom has been painted. */
  function remarkContactSeparators() {
    var docEl = U.qs('#rb-doc');
    if (!docEl) return;
    U.requestIdle(function () {
      U.qsa('.rb-doc__contact', docEl).forEach(function (list) {
        var items = list.children;
        var prevTop = null;
        for (var i = 0; i < items.length; i++) {
          var top = items[i].getBoundingClientRect().top;
          var sep = items[i].querySelector('.rb-doc__sep');
          if (sep) {
            if (prevTop === null || top - prevTop <= 1) sep.removeAttribute('data-lead');
            else sep.setAttribute('data-lead', 'true');
          }
          prevTop = top;
        }
      });
    }, 80);
  }

  function readZoom() {
    var z = readNum(ZOOM_KEY);
    if (z == null) return 1;
    return U.clamp(+(+z).toFixed(2), ZOOM_MIN, ZOOM_MAX);
  }

  function zoomFrame(zoom) {
    var frame = U.qs('#rb-page-frame');
    if (!frame) return readZoom();
    var z = U.clamp(+(+zoom).toFixed(2), ZOOM_MIN, ZOOM_MAX);    frame.style.setProperty('--rb-doc-zoom', String(z));
    writeNum(ZOOM_KEY, z);
    return z;
  }

  /* `zoom` is a layout property: it scales offsetHeight, so a measurement
   * taken at 120% reports more pages than the same page measured at 100%.
   * The page count is a property of the document, not of the preview, so
   * every measurement is taken with the zoom lifted and put back after. */
  function measurePages() {
    if (!RB.paginator || typeof RB.paginator.measure !== 'function') return null;
    var frame = U.qs('#rb-page-frame');
    var prev = frame ? frame.style.getPropertyValue('--rb-doc-zoom') : '';
    if (frame) frame.style.setProperty('--rb-doc-zoom', '1');
    var out;
    try { out = RB.paginator.measure(U.qs('#rb-doc')); }
    catch (e) { out = null; }
    if (frame) {
      if (prev) frame.style.setProperty('--rb-doc-zoom', prev);
      else frame.style.removeProperty('--rb-doc-zoom');
    }
    return out;
  }

  /* The sheets in the document are the pages. The renderer measures once and
   * then pushes, pulls and grows sheets until the layout settles, so a fresh
   * measurement taken here is a second opinion about a layout that has already
   * moved on — in a two-column template, or anywhere a break was nudged to
   * avoid a stranded heading, the two disagree and the number on the toolbar
   * stops matching the paper. Count what is rendered; measure only for the
   * facts the count cannot give on its own. */
  function renderedPages() {
    var el = U.qs('#rb-doc');
    if (!el) return 0;
    return el.querySelectorAll(':scope > .rb-page-sheet').length;
  }

  /* Zoom until the sheet exactly fills the scroller's content box. Measured
   * with the zoom temporarily lifted, because `zoom` changes the used width.
   *
   * The frame is already `width: min(100%, paper)` (polish-fixes.css), so on
   * a stage narrower than the paper the sheet is fitted and the ratio comes
   * back as 0.99x. That has to round to 1, not floor to the step below it —
   * flooring a fitted page would shrink it for nothing. */
  function fitWidth() {
    var frame = U.qs('#rb-page-frame');
    var stage = U.qs('#rb-stage');
    if (!frame || !stage) return readZoom();
    var prev = frame.style.getPropertyValue('--rb-doc-zoom');
    frame.style.setProperty('--rb-doc-zoom', '1');
    var natural = frame.offsetWidth || 1;
    var cs = global.getComputedStyle(stage);
    var avail = stage.clientWidth
      - (parseFloat(cs.paddingLeft) || 0)
      - (parseFloat(cs.paddingRight) || 0);
    frame.style.setProperty('--rb-doc-zoom', prev || String(readZoom()));
    if (avail <= 0 || natural <= 0) return readZoom();
    return zoomFrame(U.clamp(Math.round((avail / natural) * 20) / 20, ZOOM_MIN, ZOOM_MAX));
  }

  /* --------------------------------------------------------------- chrome */

  /* Plain text in the button, not a wrapped span: autofill.css sizes the
   * "A" pair through .rb-typectl__btn--sm / --lg font-size, and that only
   * reads as a size difference if the glyph is the button's own text. */
  function iconBtn(cls, glyph, labelText, tip, onClick) {
    var b = el('button', {
      class: cls, type: 'button',
      'aria-label': labelText, 'data-tip': tip,
      title: labelText,
      text: glyph
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function buildTypeControl() {
    var dec = iconBtn('rb-typectl__btn rb-typectl__btn--sm', 'A', 'Make the resume text smaller', 'Smaller text', function () { nudge(-STEP_PT); });
    var inc = iconBtn('rb-typectl__btn rb-typectl__btn--lg', 'A', 'Make the resume text bigger', 'Bigger text', function () { nudge(STEP_PT); });

    /* role="slider" on a button is the accessible way to get native arrow-key
     * semantics on a control that is also a click target (Enter resets). */
    var value = el('button', {
      class: 'rb-typectl__value rb-numeric', type: 'button',
      role: 'slider',
      'aria-label': 'Resume text size',
      'aria-valuemin': String(Math.round(MIN_SCALE * 100)),
      'aria-valuemax': String(Math.round(MAX_SCALE * 100)),
      'aria-valuenow': '100',
      'aria-valuetext': '100 percent',
      'data-tip': 'Click to reset to 100%',
      title: 'Text size — click to reset to 100%'
    });
    value.addEventListener('click', function () { reset(); });
    value.addEventListener('keydown', function (e) {
      var handled = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': nudge(STEP_PT); break;
        case 'ArrowDown': case 'ArrowLeft': nudge(-STEP_PT); break;
        case 'PageUp': nudge(STEP_PT * 4); break;
        case 'PageDown': nudge(-STEP_PT * 4); break;
        case 'Home': set(MIN_SCALE); break;
        case 'End': set(MAX_SCALE); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });

    return { root: el('div', { class: 'rb-typectl', role: 'group', 'aria-label': 'Resume text size' }, [dec, value, inc]),
      dec: dec, inc: inc, value: value };
  }

  function buildZoomControl() {
    var out = iconBtn('rb-zoom__btn', '−', 'Zoom out', 'Zoom out', function () { setZoom(readZoom() - ZOOM_STEP); });
    var value = el('button', {
      class: 'rb-zoom__value rb-numeric', type: 'button',
      'aria-label': 'Preview zoom. Activate to reset to 100 percent.',
      'data-tip': 'Click to reset to 100%', title: 'Preview zoom — click to reset to 100%'
    });
    value.addEventListener('click', function () { setZoom(1); });
    value.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setZoom(readZoom() + ZOOM_STEP); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setZoom(readZoom() - ZOOM_STEP); }
    });
    var inn = iconBtn('rb-zoom__btn', '+', 'Zoom in', 'Zoom in', function () { setZoom(readZoom() + ZOOM_STEP); });
    var fit = iconBtn('rb-zoom__btn', '↔', 'Fit the page to the window', 'Fit to width', function () { setZoom(fitWidth()); });

    return {
      root: el('div', { class: 'rb-zoom', role: 'group', 'aria-label': 'Preview zoom' }, [out, value, inn, fit]),
      out: out, inn: inn, value: value, fit: fit
    };
  }

  function setZoom(z) {
    var applied = zoomFrame(z);
    if (mounted) mounted.sync();
    remarkContactSeparators();
    U.announce('Preview zoom ' + Math.round(applied * 100) + ' percent.');
    return applied;
  }

  function buildPageCount() {
    var value = el('span', { class: 'rb-pagecount__value rb-numeric' });
    var note = el('span', { class: 'rb-pagecount__note' });
    return {
      root: el('div', {
        class: 'rb-pagecount', role: 'status',
        'aria-label': 'Page count'
      }, [value, note]),
      value: value,
      note: note
    };
  }

  function mount(host) {
    var node = typeof host === 'string' ? U.qs(host) : host;
    if (!node) return null;
    if (mounted) mounted.destroy();

    node.textContent = '';

    var title = el('span', { class: 'rb-toolstrip__title rb-toolstrip__title--ctl', text: 'Text size' });
    var type = buildTypeControl();
    var pages = buildPageCount();
    var spacer = el('div', { class: 'rb-toolstrip__group rb-toolstrip__group--grow', 'aria-hidden': 'true' });
    var zoom = buildZoomControl();

    node.appendChild(title);
    node.appendChild(type.root);
    node.appendChild(el('div', { class: 'rb-toolstrip__sep', 'aria-hidden': 'true' }));
    node.appendChild(pages.root);
    node.appendChild(spacer);
    node.appendChild(zoom.root);

    function syncZoom() {
      var z = readZoom();
      zoom.value.textContent = Math.round(z * 100) + '%';
      zoom.value.title = Math.round(z * 100) + '% preview zoom — click to reset to 100%';
      zoom.out.disabled = z <= ZOOM_MIN + 0.001;
      zoom.inn.disabled = z >= ZOOM_MAX - 0.001;
    }

    function syncType() {
      var s = current();
      var sizePt = appliedSize();
      type.value.textContent = label();
      type.value.setAttribute('aria-valuenow', String(Math.round(s * 100)));
      type.value.setAttribute('aria-valuetext', Math.round(s * 100) + ' percent, ' + sizePt.toFixed(1) + ' point body text');
      type.value.title = sizePt.toFixed(1) + 'pt body text — click to reset to 100%';
      type.dec.disabled = atMin();
      type.inc.disabled = atMax();
    }

    function syncPages() {
      var r = measurePages();
      var sheets = renderedPages();
      var pages_ = sheets || (r ? r.pages : 0);
      if (!pages_ || !r || !r.valid) {
        pages.value.textContent = '—';
        pages.note.textContent = 'pages';
        pages.root.removeAttribute('data-state');
        pages.root.removeAttribute('title');
        return;
      }
      pages.value.textContent = String(pages_);
      pages.note.textContent = pages_ === 1 ? 'page' : 'pages';
      pages.root.setAttribute('data-state', pages_ > 1 ? 'over' : 'ok');
      pages.root.setAttribute('title', pages_ === 1
        ? 'Fits on one ' + r.pageSize + ' page'
        : U.pluralize(pages_, 'page', 'pages') + ' at ' + r.pageSize + ' size — ' + Math.round(r.fill * 100) + '% full');
    }

    function sync() { syncType(); syncZoom(); }

    var offs = [];
    /* The sheet count is only final once the renderer has finished paginating,
     * which happens in the same idle slot the write lands in. Reading on the
     * event itself would report the page count of the layout it just replaced. */
    var syncPagesSoon = U.debounce(function () { syncPages(); }, 80);
    offs.push(RB.bus.on('change', function () {
      /* Every write path can move design.baseSizePt, including undo. Re-anchor
       * first so the readout can never drift from what the design panel shows. */
      reconcile();
      syncType();
      syncPagesSoon();
    }));
    /* The paginator measures the zoomed box, so its event is only a prompt to
     * re-measure unzoomed, never a number to display. */
    offs.push(RB.bus.on('paginator:update', syncPages));
    offs.push(RB.bus.on('typescale:change', function () { syncType(); syncPages(); }));

    var onResize = U.debounce(function () { syncPages(); syncZoom(); }, 160);
    global.addEventListener('resize', onResize, { passive: true });

    sync();
    syncPages();
    if (RB.paginator && RB.paginator.schedule) RB.paginator.schedule(U.qs('#rb-doc'));

    mounted = {
      sync: sync,
      syncPages: syncPages,
      destroy: function () {
        syncPagesSoon.cancel();
        offs.forEach(function (off) { off(); });
        global.removeEventListener('resize', onResize);
        if (mounted && mounted.node === node) mounted = null;
      },
      node: node
    };
    return mounted;
  }

  RB.typescale = {
    mount: mount,
    set: set,
    nudge: nudge,
    reset: reset,
    current: current,
    label: label,
    reconcile: reconcile,
    setZoom: setZoom,
    fitWidth: fitWidth,
    MIN: MIN_PT,
    MAX: MAX_PT,
    STEP: STEP_PT
  };

  /* ------------------------------------------------------------------ boot */

  /* Order matters: re-anchor the size first so the bar's first render shows
   * the number that is actually on the page, then build the bar, then put the
   * stored preview zoom back once the first layout has settled. */
  RB.onBoot(function () {
    reconcile();
    mount('#rb-typescale-host');
    var z = readZoom();
    if (z !== 1) U.requestIdle(function () { zoomFrame(z); remarkContactSeparators(); }, 500);
  });
})(window);
