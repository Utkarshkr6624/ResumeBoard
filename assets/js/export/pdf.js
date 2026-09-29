/* Resumeboard — PDF export and the pre-flight self-test
 *
 * There is no PDF writer here on purpose. The browser's print pipeline is the
 * only thing that produces a real, selectable text layer, so export == print
 * CSS + window.print(). Anything that rasterizes (canvas snapshot, html2canvas)
 * is banned: it destroys text selection, inflates the file and looks wrong.
 *
 * This module also owns the print stylesheet itself, because base.css has no
 * @media print block and the document stylesheet belongs to the renderer.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var RB = global.RB = global.RB || {};
  var U = RB.utils;                       /* loaded before every other module */
  var model = RB.model;

  var STYLE_ID = 'rb-print-style';
  var PRINT_ATTR = 'data-rb-printing';
  var PX_PER_IN = 96;
  var PHOTO_PRINT_IN = 1.0;              /* assumed printed width of the photo slot */
  var PRINT_DPI_WARN = 150;
  var PHOTO_FIX_LABEL = 'Leave the photo out of this PDF';

  var PAGE_SIZES = {
    Letter: { heightIn: 11, widthIn: 8.5, css: 'letter' },
    A4: { heightIn: 11.6929, widthIn: 8.2677, css: 'A4' }
  };

  var SEVERITY_RANK = { error: 0, warn: 1, note: 2 };
  var SEVERITY_ICON = { error: 'alert-circle', warn: 'alert-triangle', note: 'info' };
  /* Tokens only — no literal colors reach the DOM from here. */
  var SEVERITY_COLOR = {
    error: 'var(--rb-red-600)',
    warn: 'var(--rb-amber-600)',
    note: 'var(--rb-text-muted)'
  };

  /* Everything in this sheet is @media print, so a plain Ctrl+P (which never
   * goes through print()) still gets a correct document. */
  var PRINT_CSS = [
    '@page { size: %SIZE%; margin: %MARGIN%; }',
    '@media print {',
    '  html, body {',
    '    background: #fff !important;',
    '    color: #111 !important;',
    '    height: auto !important;',
    '    min-height: 0 !important;',
    '    max-height: none !important;',
    '    overflow: visible !important;',
    '    margin: 0 !important;',
    '    padding: 0 !important;',
    '  }',
    '  html { color-scheme: light !important; }',
    '',
    '  /* App chrome never reaches paper. */',
    '  #rb-topbar, #rb-rail, #rb-panel, #rb-toolstrip, #rb-statusbar,',
    '  #rb-marquee, #rb-toasts, #rb-overlay-root, #rb-live-region,',
    '  .rb-modal-backdrop, .rb-pop, .rb-toasts, .rb-print-hide, .no-print {',
    '    display: none !important;',
    '  }',
    '',
    '  /* The stage is a scrolling viewport on screen; on paper it is a column. */',
    '  #rb-shell, #rb-main, #rb-stage, #rb-page-frame, #rb-doc {',
    '    display: block !important;',
    '    position: static !important;',
    '    float: none !important;',
    '    transform: none !important;',
    '    overflow: visible !important;',
    '    box-shadow: none !important;',
    '    border: 0 !important;',
    '    border-radius: 0 !important;',
    '    background: transparent !important;',
    '    margin: 0 !important;',
    '    width: auto !important;',
    '    height: auto !important;',
    '    min-height: 0 !important;',
    '    max-height: none !important;',
    '  }',
    '',
    '  /* @page already owns the margin. Left in place, a block that fragments',
    '     across pages paints its padding on the first and last fragment only,',
    '     so page 2 onwards would run to the very edge of the paper. */',
    '  #rb-page-frame > #rb-doc, #rb-page-frame > .rb-doc { padding: 0 !important; }',
    '',
    '  #rb-doc, .rb-doc {',
    '    background: #fff !important;',
    '    color: #111 !important;',
    '    -webkit-print-color-adjust: exact;',
    '    print-color-adjust: exact;',
    '  }',
    '  #rb-doc *, .rb-doc * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '',
    '  /* Dark themes and some editors invert the document to stay readable on',
    '     screen. That would turn a photograph into a photographic negative. */',
    '  #rb-doc img, .rb-doc img, #rb-doc svg, .rb-doc svg { filter: none !important; }',
    '  #rb-doc img, .rb-doc img { max-width: 100% !important; height: auto !important; }',
    '',
    '  /* Keep a heading with what it introduces, and an entry in one piece. */',
    '  #rb-doc h1, #rb-doc h2, #rb-doc h3, #rb-doc h4, .rb-doc h1, .rb-doc h2,',
    '  .rb-doc h3, .rb-doc h4 {',
    '    break-after: avoid-page;',
    '    page-break-after: avoid;',
    '    break-inside: avoid-page;',
    '    page-break-inside: avoid;',
    '  }',
    '  #rb-doc [data-entry-id], #rb-doc .rb-entry, .rb-doc [data-entry-id],',
    '  .rb-doc .rb-entry, #rb-doc li, #rb-doc p {',
    '    break-inside: avoid-page;',
    '    page-break-inside: avoid;',
    '  }',
    '  #rb-doc p, #rb-doc li { orphans: 3; widows: 3; }',
    '',
    '  /* Editing affordances have no meaning on paper. */',
    '  #rb-doc [contenteditable], .rb-doc [contenteditable] {',
    '    outline: none !important;',
    '    background: transparent !important;',
    '  }',
    '  #rb-doc [data-rb-handle], #rb-doc .rb-doc__handle, #rb-doc [aria-hidden="true"] {',
    '    display: none !important;',
    '  }',
    '',
    '  /* Per-export options, toggled on #rb-doc by enterPrintState(). */',
    '  #rb-doc[data-rb-print-photo="off"] [data-bind="basics.photo"],',
    '  #rb-doc[data-rb-print-photo="off"] .rb-photo,',
    '  #rb-doc[data-rb-print-photo="off"] img { display: none !important; }',
    '  #rb-doc[data-rb-print-accent="safe"] { --rb-doc-accent: var(--rb-gray-900) !important; }',
    '  #rb-doc[data-rb-print-accent="safe"] [data-bind$=".url"] { color: inherit !important; }',
    '  a[href]::after { content: none !important; }',
    '}'
  ].join('\n');

  /* ---------------- lazy references ----------------
   * ui.js, icons.js and the paginator are owned by other agents and may load
   * after this file, so they are resolved per call, never captured. */

  function uiKit() { return RB.ui || null; }
  function iconKit() { return RB.icons || null; }
  function icon(name, size) {
    var k = iconKit();
    return k && typeof k.svg === 'function' ? k.svg(name, { size: size || 'sm' }) : '';
  }

  function toast(message, tone) {
    var ui = uiKit();
    if (ui && typeof ui.toast === 'function') ui.toast(message, { tone: tone || 'info' });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function resolveResume(resume) {
    if (resume && typeof resume === 'object' && (resume.basics || resume.sections)) return resume;
    var store = RB.store;
    if (store && typeof store.get === 'function') {
      var current = store.get();
      if (current) return current;
    }
    return model && typeof model.emptyResume === 'function' ? model.emptyResume() : { basics: {}, sections: [], design: {} };
  }

  /* ---------------- page geometry ---------------- */

  function pageBox(design) {
    var d = design || {};
    var page = PAGE_SIZES[d.pageSize] || PAGE_SIZES.Letter;
    var marginIn = U.clamp(Number(d.marginsIn) || 0.6, 0.2, 1.5);
    return {
      pageSize: d.pageSize === 'A4' ? 'A4' : 'Letter',
      css: page.css,
      marginIn: marginIn,
      heightPx: page.heightIn * PX_PER_IN,
      widthPx: page.widthIn * PX_PER_IN,
      printablePx: Math.max(120, (page.heightIn - marginIn * 2) * PX_PER_IN),
      printableWidthPx: Math.max(120, (page.widthIn - marginIn * 2) * PX_PER_IN)
    };
  }

  /* ---------------- print stylesheet ---------------- */

  function stylesheetNode() { return U.qs('#' + STYLE_ID); }

  function ensureStylesheet(state) {
    var node = stylesheetNode();
    if (!node) {
      if (!doc.head) return null;
      node = U.el('style', { id: STYLE_ID, type: 'text/css', 'aria-hidden': 'true' });
      doc.head.appendChild(node);
    }
    var opts = state || {};
    var box = pageBox(opts.design);
    var css = PRINT_CSS
      .replace('%SIZE%', box.css)
      .replace('%MARGIN%', box.marginIn + 'in');
    /* Only rewrite when something actually moved: the sheet is re-synced on
     * every store change and clobbering it resets the whole cascade. */
    if (node.textContent !== css) node.textContent = css;
    return node;
  }

  /* ---------------- print state ---------------- */

  var printState = { active: false, saved: null };

  function isPrinting() { return printState.active; }

  function enterPrintState(resume, opts) {
    var docEl = U.qs('#rb-doc');
    if (!docEl) return null;
    var options = opts || {};
    var design = (resume && resume.design) || {};

    var edits = U.qsa('[contenteditable]', docEl).map(function (node) {
      return { node: node, value: node.getAttribute('contenteditable') };
    });

    printState.saved = {
      edits: edits,
      docAttrs: {
        print: docEl.getAttribute('data-rb-print'),
        photo: docEl.getAttribute('data-rb-print-photo'),
        accent: docEl.getAttribute('data-rb-print-accent')
      },
      rootAttr: doc.documentElement.getAttribute(PRINT_ATTR)
    };
    printState.active = true;

    /* A caret in a contenteditable prints as a stray cursor. The lock marker
     * is what the post-export self-test checks, so a crash mid-print is
     * detectable rather than leaving the document read-only forever. */
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    edits.forEach(function (e) {
      e.node.setAttribute('contenteditable', 'false');
      e.node.setAttribute('data-rb-print-locked', '1');
    });

    docEl.setAttribute('data-rb-print', '1');
    docEl.setAttribute('data-rb-print-photo', options.hidePhoto ? 'off' : 'on');
    docEl.setAttribute('data-rb-print-accent', options.safeAccent ? 'safe' : 'keep');
    doc.documentElement.setAttribute(PRINT_ATTR, '1');
    if (doc.body) doc.body.classList.add('is-printing');

    ensureStylesheet({ design: design, hidePhoto: options.hidePhoto, safeAccent: options.safeAccent });
    return docEl;
  }

  function exitPrintState() {
    var saved = printState.saved;
    printState.active = false;
    printState.saved = null;
    if (!saved) return;
    var docEl = U.qs('#rb-doc');
    if (docEl) {
      restoreAttr(docEl, 'data-rb-print', saved.docAttrs.print);
      restoreAttr(docEl, 'data-rb-print-photo', saved.docAttrs.photo);
      restoreAttr(docEl, 'data-rb-print-accent', saved.docAttrs.accent);
    }
    saved.edits.forEach(function (e) {
      e.node.removeAttribute('data-rb-print-locked');
      restoreAttr(e.node, 'contenteditable', e.value);
    });
    if (saved.rootAttr === null) doc.documentElement.removeAttribute(PRINT_ATTR);
    else doc.documentElement.setAttribute(PRINT_ATTR, saved.rootAttr);
    if (doc.body) doc.body.classList.remove('is-printing');
  }

  function restoreAttr(node, name, value) {
    if (value === null || value === undefined) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }

  /* ---------------- settle, print, restore ---------------- */

  function nextFrame() {
    return new Promise(function (resolve) {
      var raf = global.requestAnimationFrame || function (fn) { setTimeout(fn, 16); };
      raf(function () { raf(resolve); });
    });
  }

  function fontsReady() {
    if (doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === 'function') {
      return Promise.resolve(doc.fonts.ready).catch(function () {});
    }
    return Promise.resolve();
  }

  function waitForImages() {
    var docEl = U.qs('#rb-doc');
    if (!docEl) return Promise.resolve();
    var imgs = U.qsa('img', docEl);
    if (!imgs.length) return Promise.resolve();
    var jobs = imgs.map(function (img) {
      if (img.complete) return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    });
    return Promise.race([Promise.all(jobs), delay(1500)]);
  }

  function settle() {
    return fontsReady()
      .then(waitForImages)
      .then(nextFrame)
      .then(function () { return delay(20); })
      .catch(function () { /* printing a half-loaded page beats not printing */ });
  }

  /* afterprint is the only signal every engine agrees on, and Firefox has
   * shipped versions that never fire it — hence the hard cap. */
  function waitForPrintEnd() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        global.removeEventListener('afterprint', onAfter);
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onChange);
        clearTimeout(timer);
        resolve();
      };
      var onAfter = function () { finish(); };
      var mq = global.matchMedia ? global.matchMedia('print') : null;
      var seenPrint = false;
      var onChange = function (ev) {
        if (ev.matches) seenPrint = true;
        else if (seenPrint) finish();
      };
      global.addEventListener('afterprint', onAfter);
      if (mq && mq.addEventListener) mq.addEventListener('change', onChange);
      var timer = setTimeout(finish, 30000);
    });
  }

  /* ---------------- filename ---------------- */

  function titleCaseSegments(slug) {
    return slug.split('-').map(function (part) {
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : part;
    }).join('-');
  }

  function pdfFilename(resume) {
    var r = resolveResume(resume);
    var b = r.basics || {};
    var meta = r.meta || {};

    var raw = (b.name || '').trim();
    if (!raw) raw = [b.givenName, b.familyName].filter(Boolean).join(' ').trim();
    if (!raw) raw = (meta.targetRole || '').trim();
    if (!raw) raw = (meta.title || '').trim();

    var slug = U.slugify(raw);
    if (!slug || slug === 'resume') return 'Resume.pdf';
    var base = titleCaseSegments(slug.slice(0, 60).replace(/-+$/, ''));
    return base === 'Resume' ? 'Resume.pdf' : base + '-Resume.pdf';
  }

  /* ---------------- measurement ---------------- */

  function sectionNodes(docEl) {
    return U.qsa('[data-section-id]', docEl)
      .concat(U.qsa('.rb-section', docEl))
      .concat(U.qsa('section', docEl))
      .filter(function (n, i, all) { return all.indexOf(n) === i; });
  }

  function entryNodes(docEl) {
    return U.qsa('[data-entry-id]', docEl)
      .concat(U.qsa('.rb-entry', docEl))
      .filter(function (n, i, all) { return all.indexOf(n) === i; });
  }

  function labelFor(r, node, type) {
    var id = node.getAttribute('data-section-id') || node.getAttribute('data-entry-id') || node.id || '';
    var sections = (r && r.sections) || [];
    var match = sections.filter(function (s) { return s.id === id; })[0];
    if (match && match.label) return match.label;
    if (type && model && typeof model.typeMeta === 'function') {
      var meta = model.typeMeta(type);
      if (meta && meta.label) return meta.label;
    }
    var heading = U.qs('h1, h2, h3, h4, .rb-section__label, .rb-section__title', node);
    var text = heading ? (heading.textContent || '').trim() : '';
    return text || 'Untitled section';
  }

  /* DOM fallback. Works off the same shape a paginator is expected to return,
   * so everything downstream is source-agnostic. */
  function domScan(r) {
    var empty = { mounted: false, layout: null, entries: [], emptyFields: 0, unlinkedUrls: 0 };
    var docEl = U.qs('#rb-doc');
    if (!docEl || !docEl.getBoundingClientRect) return empty;

    var rect = docEl.getBoundingClientRect();
    if (!rect.height) return empty;
    empty.mounted = true;

    var style = global.getComputedStyle ? global.getComputedStyle(docEl) : null;
    var padTop = style ? (parseFloat(style.paddingTop) || 0) : 0;
    var padBottom = style ? (parseFloat(style.paddingBottom) || 0) : 0;
    var origin = rect.top + padTop;

    function box(node) {
      var r2 = node.getBoundingClientRect();
      return { top: r2.top - origin, bottom: r2.bottom - origin, height: r2.height };
    }

    var sections = sectionNodes(docEl).map(function (node) {
      var b = box(node);
      return {
        id: node.getAttribute('data-section-id') || node.id || '',
        type: node.getAttribute('data-section-type') || '',
        label: labelFor(r, node, node.getAttribute('data-section-type')),
        top: b.top, bottom: b.bottom, height: b.height
      };
    }).filter(function (s) { return s.height > 0; });

    var entries = entryNodes(docEl).map(function (node) {
      var b = box(node);
      return {
        id: node.getAttribute('data-entry-id') || node.id || '',
        label: labelFor(r, node, node.getAttribute('data-entry-type')),
        top: b.top, bottom: b.bottom, height: b.height
      };
    }).filter(function (e) { return e.height > 0; });

    var contentHeight = Math.max(
      rect.height - padTop - padBottom,
      sections.reduce(function (m, s) { return Math.max(m, s.bottom); }, 0)
    );

    var design = (r && r.design) || {};
    var box2 = pageBox(design);
    var pages = Math.max(1, Math.ceil(Math.max(0, contentHeight - 2) / box2.printablePx));

    empty.layout = {
      source: 'dom',
      pages: pages,
      printablePx: box2.printablePx,
      contentHeightPx: contentHeight,
      sections: sections,
      entries: entries
    };
    empty.entries = entries;

    /* Placeholder pseudo-content prints. So do URLs that are not real links. */
    empty.emptyFields = U.qsa('[data-bind]', docEl).filter(function (node) {
      if ((node.textContent || '').trim()) return false;
      if (!global.getComputedStyle) return false;
      var before = global.getComputedStyle(node, '::before').content;
      var after = global.getComputedStyle(node, '::after').content;
      return visiblePseudo(before) || visiblePseudo(after);
    }).length;

    empty.unlinkedUrls = U.qsa('[data-bind$=".url"]', docEl).filter(function (node) {
      return !(node.closest && node.closest('a[href]'));
    }).length;

    return empty;
  }

  function visiblePseudo(content) {
    if (!content || content === 'none' || content === 'normal') return false;
    return !/^url\(["']?about:blank/.test(content);
  }

  /* Expected paginator contract (all fields optional, aliases accepted):
   *   RB.paginator.measure(resume, opts) -> { pageCount|pages, pageHeightPx,
   *     printablePx, contentHeightPx, sections:[{id,label,top,bottom}] }
   * opts gets { pageSize, marginsIn, printablePx, dom }.
   */
  function paginate(r, box, scan) {
    var p = RB.paginator;
    if (!p) return Promise.resolve(null);
    var fn = p.measure || p.paginate || p.compute || p.layout;
    if (typeof fn !== 'function') return Promise.resolve(null);
    var raw;
    try {
      raw = fn.call(p, r, {
        pageSize: box.pageSize,
        marginsIn: box.marginIn,
        printablePx: box.printablePx,
        dom: U.qs('#rb-doc')
      });
    } catch (e) {
      return Promise.resolve(null);
    }
    if (raw && typeof raw.then === 'function') {
      return raw.then(function (v) { return normalizeMeasure(v, box, scan); }, function () { return null; });
    }
    return Promise.resolve(normalizeMeasure(raw, box, scan));
  }

  function normalizeMeasure(raw, box, scan) {
    if (!raw || typeof raw !== 'object') return null;
    var sections = raw.sections || raw.blocks || raw.items || null;
    var entries = raw.entries || null;
    var pages = Number(raw.pageCount || raw.pages || raw.count);
    if (!isFinite(pages) || pages < 1) {
      var printable = Number(raw.printablePx) || box.printablePx;
      var content = Number(raw.contentHeightPx || raw.contentHeight);
      pages = isFinite(content) ? Math.max(1, Math.ceil(Math.max(0, content - 2) / printable)) : 0;
    }
    if (!pages) return null;

    var scanned = (scan && scan.layout) || { sections: [], entries: [] };
    return {
      source: 'paginator',
      pages: Math.max(1, Math.round(pages)),
      printablePx: Number(raw.printablePx) || box.printablePx,
      contentHeightPx: Number(raw.contentHeightPx || raw.contentHeight) || 0,
      sections: Array.isArray(sections) ? sections.filter(Boolean).map(normBlock) : scanned.sections,
      entries: Array.isArray(entries) ? entries.filter(Boolean).map(normBlock) : scanned.entries
    };
  }

  function normBlock(b) {
    return {
      id: b.id || '',
      type: b.type || '',
      label: b.label || b.name || '',
      top: Number(b.top) || 0,
      bottom: Number(b.bottom != null ? b.bottom : (Number(b.top) + Number(b.height || 0))) || 0,
      height: Number(b.height) || 0
    };
  }

  /* ---------------- photo analysis ---------------- */

  function analyzePhoto(r) {
    var src = r && r.basics && r.basics.photo;
    if (!src || typeof src !== 'string' || src.indexOf('data:image/') !== 0) return Promise.resolve(null);
    if (typeof global.Image !== 'function' || !doc.createElement) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (info) { if (!settled) { settled = true; resolve(info); } };
      var img = new Image();
      img.onload = function () {
        try { finish(measurePhoto(img)); }
        catch (e) { finish({ present: true, error: true, width: img.naturalWidth, height: img.naturalHeight }); }
      };
      img.onerror = function () { finish({ present: true, error: true }); };
      setTimeout(function () { finish({ present: true, error: true, timedOut: true }); }, 4000);
      img.src = src;
    });
  }

  /* Sample the image the way a greyscale printer will: luminance only. A photo
   * with no luminance spread has no detail left once colour is thrown away. */
  function measurePhoto(img) {
    var w = img.naturalWidth || 0;
    var h = img.naturalHeight || 0;
    var N = 48;
    var canvas = doc.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    var ctx = canvas.getContext('2d');
    if (!ctx) return { present: true, error: true, width: w, height: h };
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, N, N);
    ctx.drawImage(img, 0, 0, N, N);
    var data = ctx.getImageData(0, 0, N, N).data;
    var sum = 0, sumSq = 0, n = N * N;
    for (var i = 0; i < data.length; i += 4) {
      var lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      sum += lum;
      sumSq += lum * lum;
    }
    var mean = sum / n;
    return {
      present: true,
      width: w,
      height: h,
      dpi: Math.round(w / PHOTO_PRINT_IN),
      mean: mean,
      std: Math.sqrt(Math.max(0, sumSq / n - mean * mean))
    };
  }

  /* ---------------- pre-flight ---------------- */

  function recommendedPages(r) {
    var level = (r && r.meta && r.meta.experienceLevel) || 'mid';
    return (level === 'junior' || level === 'mid') ? 1 : 2;
  }

  function straddle(list, printable) {
    if (!printable || printable <= 0) return [];
    return (list || []).filter(function (b) {
      if (!(b.bottom > b.top)) return false;
      return Math.floor(b.top / printable) !== Math.floor((b.bottom - 1) / printable);
    });
  }

  function check(id, severity, title, detail, fix, fixLabel) {
    return { id: id, severity: severity, title: title, detail: detail, fix: fix || null, fixLabel: fixLabel || null };
  }

  function buildChecks(r, layout, photo, scan) {
    var checks = [];
    var design = (r && r.design) || {};

    if (model && typeof model.isBlankResume === 'function' && model.isBlankResume(r)) {
      checks.push(check('empty', 'error', 'There is nothing to print',
        'Add a name and at least one role, then export again.'));
      return checks;
    }

    /* --- page count --- */
    var max = recommendedPages(r);
    if (layout && layout.pages) {
      var pages = layout.pages;
      var hardMax = max + 1;
      if (pages > hardMax) {
        checks.push(check('pages', 'error', U.pluralize(pages, 'page') + ' is more than a resume should be',
          'Recruiters usually stop reading at ' + U.pluralize(hardMax, 'page') +
          '. Cut the oldest roles, or drop the ' + (sectionsToTrim(r)).join(' and ') + ' section.'));
      } else if (pages > max) {
        checks.push(check('pages', 'warn', U.pluralize(pages, 'page'), 'Most roles fit on ' +
          U.pluralize(max, 'page') + '. Keep it there unless your experience level justifies more.'));
      }
    } else {
      checks.push(check('unmeasured', 'note', 'Page count could not be measured',
        'The resume is not on screen yet, so page breaks were not checked. Everything else was still checked.'));
    }

    /* --- page breaks --- */
    if (layout && layout.printablePx) {
      var splitSections = straddle(layout.sections, layout.printablePx);
      var splitEntries = straddle(layout.entries, layout.printablePx);
      var offenders = splitSections.concat(splitEntries).slice(0, 3);
      if (offenders.length) {
        var names = offenders.map(function (b) { return b.label || 'An entry'; });
        checks.push(check('page-break', 'warn',
          offenders.length === 1 ? 'One block splits across a page break' : U.pluralize(offenders.length, 'block') + ' split across page breaks',
          names.join(', ') + ' will be cut in half by the page break. Shorten ' +
          (offenders.length === 1 ? 'it' : 'them') + ', or move ' + (offenders.length === 1 ? 'it' : 'them') + ' above a section that starts higher on the page.'));
      }
    }

    /* --- photo --- */
    if (photo && photo.present) {
      if (photo.error) {
        checks.push(check('photo-load', 'warn', 'The photo could not be read',
          'The image failed to decode, so it will print as an empty box. Remove it or upload a plain PNG or JPEG.'));
      } else {
        var flat = photo.std < 0.05;
        var tooLight = photo.mean > 0.9;
        var tooDark = photo.mean < 0.08;
        var tiny = photo.width < 8 || photo.height < 8;
        if (tiny) {
          checks.push(check('photo-grey', 'warn', 'The photo will print as a grey box',
            'This is a ' + photo.width + ' by ' + photo.height + ' pixel image, which has no detail left to print.',
            'hidePhoto', PHOTO_FIX_LABEL));
        } else if (flat) {
          checks.push(check('photo-grey', 'warn', 'The photo will print as a grey box',
            'The image is close to a flat colour, so a greyscale printer has nothing to show. Use a photo with contrast, or leave it out.',
            'hidePhoto', PHOTO_FIX_LABEL));
        } else if (tooLight) {
          checks.push(check('photo-grey', 'warn', 'The photo is too light to print',
            'Most of the image is near white, so it will fade out on paper. A darker photo, or none at all, reads better.',
            'hidePhoto', PHOTO_FIX_LABEL));
        } else if (tooDark) {
          checks.push(check('photo-grey', 'warn', 'The photo is too dark to print',
            'Most of the image is near black, so it will print as a solid block and waste toner.',
            'hidePhoto', PHOTO_FIX_LABEL));
        } else if (photo.dpi < PRINT_DPI_WARN) {
          checks.push(check('photo-dpi', 'warn', 'The photo will look soft on paper',
            'At about ' + photo.dpi + ' dpi in a ' + PHOTO_PRINT_IN + ' inch slot, a laser printer will magnify it visibly. ' +
            'Use at least ' + PRINT_DPI_WARN + ' dpi.', 'hidePhoto', PHOTO_FIX_LABEL));
        }
      }
    }

    /* --- accent under greyscale --- */
    var accent = design.accent;
    if (U.isValidHexColor(accent) && !design.printSafe) {
      var c = U.contrast(accent);
      var ratio = c ? c.ratio('#ffffff') : null;
      if (c && c.l > 0.55) {
        checks.push(check('accent', 'warn', 'The accent colour is too light for some printers',
          'On a greyscale printer "' + accent + '" comes out as a pale grey rule that nearly disappears. The safe fix below only applies to this PDF.',
          'safeAccent', 'Print this one with a dark accent'));
      } else if (ratio != null && ratio < 3) {
        checks.push(check('accent', 'warn', 'The accent colour has low contrast on white paper',
          'Section headings in "' + accent + '" will read weakly once printed. Consider a darker accent.',
          'safeAccent', 'Print this one with a dark accent'));
      }
    }

    /* --- placeholders and dead links --- */
    if (scan.mounted) {
      if (scan.emptyFields > 0) {
        checks.push(check('placeholders', 'warn',
          scan.emptyFields === 1 ? 'One empty field still shows its placeholder' : U.pluralize(scan.emptyFields, 'empty field') + ' still show their placeholders',
          'Placeholder text is real text as far as the printer is concerned, so it lands in the PDF. Fill the field in, or clear the section.'));
      }
      if (scan.unlinkedUrls > 0) {
        checks.push(check('links', 'note',
          scan.unlinkedUrls === 1 ? 'One URL will print as plain text' : U.pluralize(scan.unlinkedUrls, 'URL') + ' will print as plain text',
          'Text that is not a real link is not clickable in the PDF and some screen readers ignore it. Link the URL in the editor.'));
      }
    }

    if (design.columns === 2) {
      checks.push(check('columns', 'note', 'Two-column layout on paper',
        'Columns are reflowed by each PDF reader, so the split can land somewhere different than the preview.'));
    }

    return checks;
  }

  function sectionsToTrim(r) {
    var order = ['interests', 'languages', 'presentations', 'coursework', 'publications', 'volunteer'];
    var blank = model && typeof model.isBlankEntry === 'function' ? model.isBlankEntry : function () { return false; };
    var present = order.filter(function (t) {
      var s = (r.sections || []).filter(function (x) { return x.type === t; })[0];
      return s && (r[t] || []).some(function (e) { return !blank(e); });
    });
    if (!present.length) present = ['least relevant'];
    return present.slice(0, 2).map(function (t) {
      return model && typeof model.typeMeta === 'function' ? model.typeMeta(t).label.toLowerCase() : t;
    });
  }

  function buildReport(r, layout, photo, scan) {
    var checks = buildChecks(r, layout, photo, scan);
    checks.sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; });
    var counts = { error: 0, warn: 0, note: 0 };
    checks.forEach(function (c) { counts[c.severity] = (counts[c.severity] || 0) + 1; });
    return {
      ok: counts.error === 0 && counts.warn === 0,
      pages: layout ? layout.pages : null,
      recommendedMax: recommendedPages(r),
      measured: !!layout,
      source: layout ? layout.source : null,
      filename: pdfFilename(r),
      checks: checks,
      counts: counts
    };
  }

  function preflight(resume) {
    var r = resolveResume(resume);
    var box = pageBox(r.design);
    var scan;
    try { scan = domScan(r); }
    catch (e) { scan = { mounted: false, layout: null, entries: [], emptyFields: 0, unlinkedUrls: 0 }; }

    return Promise.all([paginate(r, box, scan), analyzePhoto(r)])
      .then(function (out) {
        return buildReport(r, out[0] || scan.layout, out[1], scan);
      })
      .catch(function () {
        return buildReport(r, scan.layout, null, scan);
      });
  }

  /* ---------------- pre-flight UI ---------------- */

  function summaryLine(report) {
    var pages = report.pages
      ? U.pluralize(report.pages, 'page')
      : 'An unmeasured number of pages';
    if (report.ok) return pages + '. Nothing known to go wrong on paper.';
    var bits = [];
    if (report.counts.error) bits.push(U.pluralize(report.counts.error, 'problem'));
    if (report.counts.warn) bits.push(U.pluralize(report.counts.warn, 'thing') + ' to look at');
    return pages + '. ' + bits.join(' and ') + ' before you print.';
  }

  function fixToggle(item, options) {
    var id = 'rb-pf-fix-' + item.id;
    var input = U.el('input', { type: 'checkbox', id: id });
    input.checked = options[item.fix] !== false;
    options[item.fix] = input.checked;
    input.addEventListener('change', function () { options[item.fix] = input.checked; });
    return U.el('label', { class: 'rb-checkbox', for: id, style: 'flex:none;max-width:14rem' }, [
      input,
      U.el('span', { class: 'rb-hint', text: item.fixLabel })
    ]);
  }

  function checkRow(item, options) {
    var row = U.el('div', {
      class: 'rb-row',
      style: 'align-items:flex-start;gap:var(--rb-space-3);padding:var(--rb-space-3) 0;border-top:1px solid var(--rb-border-subtle)'
    });
    row.appendChild(U.el('span', {
      class: 'rb-i',
      style: 'color:' + (SEVERITY_COLOR[item.severity] || SEVERITY_COLOR.note) + ';margin-top:2px',
      html: icon(SEVERITY_ICON[item.severity] || 'info')
    }));
    var text = U.el('div', { class: 'rb-col', style: 'gap:var(--rb-space-1);flex:1;min-width:0' }, [
      U.el('strong', { text: item.title, style: 'font-size:var(--rb-text-base);font-weight:600;color:var(--rb-text)' }),
      U.el('span', { class: 'rb-hint', text: item.detail, style: 'white-space:normal' })
    ]);
    row.appendChild(text);
    if (item.fix) row.appendChild(fixToggle(item, options));
    return row;
  }

  function reportBody(report, options) {
    var body = U.el('div', { class: 'rb-col', style: 'gap:var(--rb-space-1)' });
    body.appendChild(U.el('p', { class: 'rb-hint', text: summaryLine(report), style: 'margin:0 0 var(--rb-space-2)' }));
    report.checks.forEach(function (item) { body.appendChild(checkRow(item, options)); });
    return body;
  }

  function askToPrint(report) {
    var ui = uiKit();
    if (!ui || typeof ui.modal !== 'function') return Promise.resolve({ ok: true, options: {} });
    var options = { hidePhoto: false, safeAccent: false };
    return new Promise(function (resolve) {
      ui.modal({
        title: report.ok ? 'Ready to print' : 'Before you print',
        body: reportBody(report, options),
        footNote: 'Choose "Save as PDF" in the print dialog. The text stays selectable.',
        dismissable: true,
        actions: [
          { label: 'Cancel' },
          {
            label: report.ok ? 'Print' : 'Print anyway',
            primary: true,
            onClick: function () { resolve({ ok: true, options: options }); }
          }
        ],
        onClose: function () { resolve({ ok: false, options: {} }); }
      });
    });
  }

  function preflightAndPrint(resume, opts) {
    var r = resolveResume(resume);
    var options = (opts || {});
    return preflight(r)
      .then(function (report) {
        if (report.ok && !uiKit()) return { proceed: true, options: options, report: report };
        return askToPrint(report).then(function (answer) {
          if (!answer.ok) return { proceed: false, options: {}, report: report };
          return {
            proceed: true,
            options: {
              hidePhoto: answer.options.hidePhoto || !!options.hidePhoto,
              safeAccent: answer.options.safeAccent || !!options.safeAccent
            },
            report: report
          };
        });
      })
      .then(function (decision) {
        if (!decision.proceed) return { ok: false, cancelled: true, report: decision.report };
        return print(r, decision.options).then(function (result) {
          result.report = decision.report;
          return result;
        });
      });
  }

  /* ---------------- post-export self-test ---------------- */

  /* Runs after the print dialog closes. It asserts the two promises this
   * module makes: the PDF was produced from live text, and print state was
   * handed back to the editor untouched. */
  function selfTest(resume) {
    var r = resolveResume(resume);
    var docEl = U.qs('#rb-doc');
    var checks = [];

    function assert(id, ok, label) { checks.push({ id: id, ok: !!ok, label: label }); }

    assert('stylesheet', !!stylesheetNode(), 'The print stylesheet is installed.');
    assert('not-printing', !isPrinting(), 'Print state was released after printing.');
    assert('mounted', !!docEl, 'The resume document is still mounted.');

    if (docEl) {
      assert('editable-restored', U.qsa('[data-rb-print-locked]', docEl).length === 0,
        'Inline editing is switched back on.');
      assert('no-raster', U.qsa('canvas', docEl).length === 0,
        'The export is not rasterized, so the PDF keeps a selectable text layer.');
      var blank = model && typeof model.isBlankResume === 'function' ? model.isBlankResume(r) : !r.basics;
      assert('text-present', !blank, 'The document still holds real text.');
      var hasPhoto = !!(r.basics && r.basics.photo);
      assert('photo-is-image', !hasPhoto || U.qsa('img', docEl).length > 0,
        'The photo is an image element, not painted onto a canvas.');
    }

    var failed = checks.filter(function (c) { return !c.ok; });
    return Promise.resolve({
      ok: failed.length === 0,
      checks: checks,
      failed: failed.map(function (c) { return c.label; })
    });
  }

  function announceSelfTest(result) {
    if (result.ok) return;
    var message = 'The PDF may not be what you expected. ' + result.failed[0] +
      (result.failed.length > 1 ? ' (and ' + (result.failed.length - 1) + ' more)' : '');
    toast(message, 'error');
  }

  /* ---------------- public entry ---------------- */

  function print(resume, opts) {
    var r = resolveResume(resume);
    var filename = pdfFilename(r);

    if (typeof global.print !== 'function') {
      toast('This browser cannot print. Save the page as a PDF from its menu instead.', 'error');
      return Promise.resolve({ ok: false, error: 'unsupported', filename: filename });
    }
    if (!U.qs('#rb-doc')) {
      toast('The resume is not on screen yet. Open it and try again.', 'error');
      return Promise.resolve({ ok: false, error: 'not-mounted', filename: filename });
    }

    var entered;
    try {
      entered = enterPrintState(r, opts);
    } catch (e) {
      entered = null;
    }
    if (!entered) {
      toast('The resume could not be prepared for printing. Try again.', 'error');
      return Promise.resolve({ ok: false, error: 'state', filename: filename });
    }

    return settle()
      .then(function () {
        global.print();
        return waitForPrintEnd();
      })
      .then(function () {
        exitPrintState();
        return selfTest(r);
      })
      .then(function (result) {
        announceSelfTest(result);
        return {
          ok: result.ok,
          filename: filename,
          selfTest: result
        };
      })
      .catch(function () {
        exitPrintState();
        toast('Printing was interrupted. Nothing was changed in your resume.', 'error');
        return { ok: false, error: 'failed', filename: filename };
      });
  }

  /* Keep @page in step with the design, so Ctrl+P is correct even though it
   * never goes through print(). */
  var syncStyle = U.debounce(function (state) {
    if (isPrinting()) return;
    var r = state && (state.resume || state);
    if (r && r.basics) ensureStylesheet({ design: r.design });
  }, 200);

  if (RB.bus && typeof RB.bus.on === 'function') {
    RB.bus.on('change', function (payload) { syncStyle(payload && payload.state); });
  }

  var bootResume = RB.store && typeof RB.store.get === 'function' ? RB.store.get() : null;
  if (doc.head) ensureStylesheet({ design: (bootResume || {}).design });

  /* The export catalogue, in the order a reader wants them.
   *
   * The other four exporters are four separate files that each register a
   * `*Download`; nothing joined them, so every surface that listed formats had
   * to guess from a hard-coded list. PDF registers `preflightAndPrint` rather
   * than a download, so those guesses dropped it — the Export button offered
   * Word, Markdown, plain text and JSON and no PDF, which is the one format
   * the product leads with. One catalogue, built from what is actually
   * registered, and both the top-bar menu and the command palette read it.
   */
  var CATALOGUE = [
    { id: 'pdf', label: 'PDF', icon: 'printer', ext: 'pdf', run: preflightAndPrint },
    { id: 'docx', label: 'Word document', icon: 'file-text', ext: 'docx', run: function (r) { return RB.exporters.docxDownload(r); } },
    { id: 'md', label: 'Markdown', icon: 'file-down', ext: 'md', run: function (r) { return RB.exporters.markdownDownload(r); } },
    { id: 'txt', label: 'Plain text', icon: 'file-text', ext: 'txt', run: function (r) { return RB.exporters.txtDownload(r); } },
    { id: 'json', label: 'JSON backup', icon: 'file-down', ext: 'json', run: function (r) { return RB.exporters.jsonDownload(r); } }
  ];

  function list() {
    return CATALOGUE.map(function (entry) {
      if (entry.id === 'pdf') return entry;
      var fn = RB.exporters[entry.id === 'md' ? 'markdownDownload' : entry.id + 'Download'];
      return typeof fn === 'function' ? entry : null;
    }).filter(Boolean);
  }

  /* Merge, never assign: the other exporters register before this file. */
  RB.exporters = RB.exporters || {};
  Object.assign(RB.exporters, {
    print: print,
    preflight: preflight,
    preflightAndPrint: preflightAndPrint,
    pdfFilename: pdfFilename,
    selfTest: selfTest,
    isPrinting: isPrinting,
    pageBox: pageBox,
    PAGE_SIZES: PAGE_SIZES,
    list: list
  });
})(window);
