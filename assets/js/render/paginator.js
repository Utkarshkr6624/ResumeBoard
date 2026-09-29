/* Resumeboard — paginator
 * Real page measurement for #rb-doc.
 *
 * The document is one continuous flow of blocks, not a stack of page divs, so
 * pagination is computed by walking that flow: the height of every breakable
 * unit (offsetHeight plus its vertical margins) is accumulated with sibling
 * margin collapsing, and a page break is placed wherever the running total
 * crosses the printable height.
 *
 * Two rules that matter and are easy to get wrong:
 *  - Sibling margins collapse, so consecutive units are joined by
 *    max(prevMarginBottom, nextMarginTop), never by the sum.
 *  - A unit is atomic. When one does not fit in the space left on a page the
 *    page ends inside it, which is a real page (counted, and reported as a
 *    'split' break) rather than a silent overflow.
 *
 * Everything here is measurement only. Applying a fit writes CSS custom
 * properties on the document element, never the resume model — persisting the
 * fitted type size is the design panel's call.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  if (!U) return;

  var doc = global.document;

  var PX_PER_IN = 96;
  var PX_PER_PT = PX_PER_IN / 72;

  var PAGE_SIZES = {
    Letter: { name: 'Letter', label: 'Letter', inches: [8.5, 11], mm: [215.9, 279.4] },
    A4:     { name: 'A4',     label: 'A4',     inches: [210 / 25.4, 297 / 25.4], mm: [210, 297] }
  };
  var DEFAULT_SIZE = 'Letter';

  /* The type-size bounds are RB.model.validate's clamps for design.baseSizePt
   (9–16pt); anything outside them is rewritten to the nearest legal value on
   the next write, which would silently undo the fit. The gaps mirror
   design.sectionGapPt and design.entryGapPt the same way.
   Note what these govern: --rb-doc-size, the RENDERED size, which
   RB.templates.docVars has already scaled by the face's optical factor. It
   equals design.baseSizePt only for a face whose standardSizePt is REF_PT. */
  var BOUNDS = {
    minSizePt: 9, maxSizePt: 16,
    minSectionGapPt: 0, maxSectionGapPt: 40,
    minEntryGapPt: 0, maxEntryGapPt: 30
  };

  var DEFAULT_MARGIN_IN = 0.6;
  var FALLBACK_SIZE_PT = 10.5;
  var FALLBACK_SECTION_GAP_PT = 14;
  var FALLBACK_ENTRY_GAP_PT = 7;

  var EPS = 0.5;              /* sub-pixel layout noise, not a real change */
  var COARSE_BREAK_RATIO = 0.6;  /* descend into a unit larger than this share of a page */
  var MAX_WALK_DEPTH = 3;
  var MIN_ORPHAN_FILL = 0.12;    /* never strand a heading by emptying a page this far */
  var MAX_FIT_STEPS = 8;
  var SHRINK_DAMPING = 0.8;
  var IDLE_TIMEOUT_MS = 250;
  var RESIZE_DEBOUNCE_MS = 120;

  var SIZE_PROPS = { size: '--rb-doc-size', sectionGap: '--rb-doc-section-gap', entryGap: '--rb-doc-entry-gap' };

  /* ---------------------------------------------------------------- units */

  /* Returns px for an absolute CSS length. Font-relative and percentage
   * lengths are refused: page maths needs an absolute box. */
  function lengthPx(value) {
    if (value == null) return null;
    var s = String(value).trim();
    if (!s) return null;
    var m = /^(-?[\d.]+)\s*(px|in|pt|pc|cm|mm|q|em|rem|%)?$/.exec(s);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    switch (m[2] || 'px') {
      case 'in': return n * PX_PER_IN;
      case 'pt': return n * PX_PER_PT;
      case 'pc': return n * 16;
      case 'cm': return n * PX_PER_IN / 2.54;
      case 'mm': return n * PX_PER_IN / 25.4;
      case 'q': return n * PX_PER_IN / 101.6;
      case 'em': case 'rem': case '%': return null;
      default: return n;
    }
  }

  function pxToPt(px, fallback) {
    if (px == null || !isFinite(px)) return fallback;
    return px / PX_PER_PT;
  }

  function pageRect(pageSize) {
    var raw = pageSize == null ? '' : String(pageSize).trim();
    var key = raw.toLowerCase().replace(/[\s_]+/g, '');
    var name = key === 'letter' || key === 'usletter' ? 'Letter'
      : key === 'a4' || key === 'a430' ? 'A4'
      : null;
    var def = name ? PAGE_SIZES[name] : PAGE_SIZES[DEFAULT_SIZE];
    return {
      name: def.name,
      label: def.label,
      width: def.inches[0] * PX_PER_IN,
      height: def.inches[1] * PX_PER_IN,
      widthPt: def.inches[0] * 72,
      heightPt: def.inches[1] * 72,
      widthMm: def.mm[0],
      heightMm: def.mm[1],
      widthIn: def.inches[0],
      heightIn: def.inches[1],
      known: !!name,
      pxPerIn: PX_PER_IN
    };
  }

  function designPageSize() {
    try {
      var s = RB.store && RB.store.isReady() ? RB.store.get() : null;
      var d = s && s.design;
      return d && d.pageSize ? d.pageSize : null;
    } catch (e) { return null; }
  }

  /* The printable box for one page, in document coordinates. */
  function pageBox(el) {
    var cs = global.getComputedStyle(el);
    var rect = pageRect(el.getAttribute('data-page-size') || designPageSize() || DEFAULT_SIZE);

    var pageW = lengthPx(cs.getPropertyValue('--rb-doc-page-w'));
    var pageH = lengthPx(cs.getPropertyValue('--rb-doc-page-h'));
    if (pageW == null) pageW = rect.width;
    if (pageH == null) pageH = rect.height;

    var margin = lengthPx(cs.getPropertyValue('--rb-doc-margin'));
    if (margin == null) {
      var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      margin = pad > 0 ? pad / 2 : DEFAULT_MARGIN_IN * PX_PER_IN;
    }

    var contentHeight = Math.max(1, pageH - margin * 2);
    var contentWidth = el.clientWidth || Math.max(1, pageW - margin * 2);
    return {
      size: rect.name,
      known: rect.known,
      pageWidth: pageW,
      pageHeight: pageH,
      margin: margin,
      contentHeight: contentHeight,
      contentWidth: contentWidth,
      /* A doc rendered wider than its printable width paginates differently on
       * paper than on screen; surface it instead of hiding it. */
      widthMismatch: Math.abs(contentWidth - (pageW - margin * 2)) > 1
    };
  }

  function inFlow(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('data-rb-no-paginate')) return false;
    var cs = global.getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.position === 'absolute' || cs.position === 'fixed') return false;
    return true;
  }

  function blockChildren(node) {
    var out = [];
    var kids = node.children;
    for (var i = 0; i < kids.length; i++) if (inFlow(kids[i])) out.push(kids[i]);
    return out;
  }

  /* #rb-doc may wrap its content in a single flow container. Descend so the
   * walk starts where the flow starts, not at a wrapper. */
  function flowRoot(el) {
    var node = el;
    for (var i = 0; i < 3; i++) {
      var kids = blockChildren(node);
      if (kids.length !== 1) break;
      node = kids[0];
    }
    return node;
  }

  function unitKey(el) {
    return el.getAttribute('data-section-id') ||
      el.getAttribute('data-entry-id') ||
      el.getAttribute('data-bind') ||
      el.id || null;
  }

  function isHeading(el) {
    var tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return true;
    if (el.hasAttribute('data-rb-heading')) return true;
    return /(^|[\s-])(head|heading|title)([\s-]|$)/i.test(el.getAttribute('class') || '');
  }

  function makeUnit(el, depth) {
    var cs = global.getComputedStyle(el);
    return {
      el: el,
      key: unitKey(el),
      depth: depth,
      height: el.offsetHeight,
      marginTop: Math.max(0, parseFloat(cs.marginTop) || 0),
      marginBottom: Math.max(0, parseFloat(cs.marginBottom) || 0),
      heading: isHeading(el)
    };
  }

  /* The height of a run of units, joined the way the page joins them: sibling
   * margins collapse, the first unit's leading margin goes with the container
   * edge. */
  function flowHeight(units) {
    var h = 0;
    var prevBottom = 0;
    for (var i = 0; i < units.length; i++) {
      var gap = i === 0 ? 0 : Math.max(prevBottom, units[i].marginTop);
      h += gap + units[i].height;
      prevBottom = units[i].marginBottom;
    }
    return h;
  }

  function indexOfToken(value, token) {
    return (' ' + String(value || '') + ' ').indexOf(' ' + token + ' ');
  }

  /* A two-column body is a grid: .rb-doc__side and .rb-doc__main sit side by
   * side, so the page is as long as the LONGER of the two. Adding them, which
   * is what a sequential walk over the body does, calls a one-page resume two
   * pages — and the page count is what the design panel and the type-scale
   * readout tell the user, so it has to be the real one.
   *
   * Only a grid is parallel. Below the sheet breakpoint the same two elements
   * are stacked in a block, and there the sequential walk is the honest one. */
  function columnBodyOf(node) {
    if (!node || node.nodeType !== 1 || !node.classList) return null;
    if (!node.classList.contains('rb-doc__body')) return null;
    if (indexOfToken(global.getComputedStyle(node).display, 'grid') === -1) return null;
    var side = node.querySelector(':scope > .rb-doc__side');
    var main = node.querySelector(':scope > .rb-doc__main');
    return (side && main) ? [side, main] : null;
  }

  /* Breakable units, coarse by default. A unit that is large relative to a
   * page is descended into so a long section can still break at its entries
   * instead of being pushed whole onto the next page.
   *
   * A column body is never descended into: its height is the taller column,
   * and a sequential walk inside it would add the columns back together. The
   * renderer places the breaks inside each column itself — it has to hide one
   * to measure the other — so what this owes the rest of the app is an honest
   * page count, a real fill and a real total height. */
  function collectUnits(root, contentHeight) {
    var units = [];
    (function walk(container, depth) {
      blockChildren(container).forEach(function (child) {
        var unit = makeUnit(child, depth);
        var cols = columnBodyOf(child);
        if (cols) {
          var tallest = 0;
          for (var c = 0; c < cols.length; c++) {
            var h = flowHeight(collectUnits(cols[c], contentHeight));
            if (h > tallest) tallest = h;
          }
          unit.height = tallest;
          units.push(unit);
          return;
        }
        if (depth < MAX_WALK_DEPTH && blockChildren(child).length && unit.height > contentHeight * COARSE_BREAK_RATIO) {
          walk(child, depth + 1);
        } else {
          units.push(unit);
        }
      });
    })(root, 0);
    return units;
  }

  function lineHeightPx(el) {
    var cs = global.getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (isFinite(lh) && lh > 0) return lh;
    var size = lengthPx(cs.getPropertyValue(SIZE_PROPS.size)) || parseFloat(cs.fontSize) || FALLBACK_SIZE_PT * PX_PER_PT;
    return size * 1.32;
  }

  function invalidResult(box, reason) {
    return {
      valid: false,
      reason: reason,
      pages: 0,
      overflow: false,
      breaks: [],
      units: 0,
      totalHeight: 0,
      usedHeight: 0,
      fill: 0,
      lineHeight: 0,
      pageSize: box ? box.size : DEFAULT_SIZE,
      pageWidth: box ? box.pageWidth : 0,
      pageHeight: box ? box.pageHeight : 0,
      contentWidth: box ? box.contentWidth : 0,
      contentHeight: box ? box.contentHeight : 0,
      margin: box ? box.margin : 0,
      widthMismatch: false,
      oversized: false,
      tallest: 0
    };
  }

  /* ---------------------------------------------------------------- measure */

  var measuring = false;

  /* Callers pass the document element. A missing or non-element argument (the
     PDF preflight calls with a resume and an options object) falls back to the
     mounted document rather than reporting "no document". */
  function measure(docEl) {
    if (!docEl || docEl.nodeType !== 1) docEl = U.qs('#rb-doc');
    if (!docEl || !docEl.isConnected) return invalidResult(null, 'no-document');
    var box = pageBox(docEl);
    if (!box.contentHeight) return invalidResult(box, 'unavailable');

    var units = collectUnits(flowRoot(docEl), box.contentHeight);
    if (units.length && !units.some(function (u) { return u.height > 0 || u.marginTop > 0 || u.marginBottom > 0; })) {
      /* Every block measures zero: the document is not laid out (hidden panel,
       * detached stage). Reporting "1 page" here would be a lie. */
      return invalidResult(box, 'not-rendered');
    }
    if (!units.length) {
      return {
        valid: true, reason: 'empty', pages: 1, overflow: false, breaks: [],
        units: 0, totalHeight: 0, usedHeight: 0, fill: 0,
        lineHeight: lineHeightPx(docEl),
        pageSize: box.size, pageWidth: box.pageWidth, pageHeight: box.pageHeight,
        contentWidth: box.contentWidth, contentHeight: box.contentHeight, margin: box.margin,
        widthMismatch: box.widthMismatch, oversized: false, tallest: 0
      };
    }

    if (measuring) return invalidResult(box, 'reentrant');
    measuring = true;

    var breaks = [];
    var y = 0;
    var page = 0;
    var total = 0;
    var prevBottom = 0;
    var tallest = 0;

    try {
      for (var i = 0; i < units.length; i++) {
        var u = units[i];
        if (u.height > tallest) tallest = u.height;
        /* Leading margin collapses with the container edge. */
        var gap = i === 0 ? 0 : Math.max(prevBottom, u.marginTop);

        if (i > 0 && y + gap > box.contentHeight + EPS) {
          var shifted = false;
          var carried = 0;
          /* A heading stranded at the foot of a page reads as a mistake. Push
           * it to the next page unless that would nearly empty this one, and
           * never touch page 1 (an empty first page is worse). */
          if (breaks.length && units[i - 1].heading) {
            var prev = units[i - 1];
            var prevGap = i - 1 === 0 ? 0 : Math.max(units[i - 2].marginBottom, prev.marginTop);
            var prevTopY = y - prevGap - prev.height;
            if (prevTopY >= box.contentHeight * MIN_ORPHAN_FILL) {
              breaks[breaks.length - 1] = {
                index: i - 1, y: prevTopY, page: page, key: prev.key,
                reason: 'orphan-avoided', el: prev.el
              };
              shifted = true;
              /* The heading travels to the new page, so the new page opens
               * with its height and the gap under it. Starting the page at
               * zero instead places every unit after it as though the heading
               * were not there, and the page overflows with no break to show
               * for it. */
              carried = prev.height + Math.max(prev.marginBottom, u.marginTop);
            }
          }
          if (!shifted) {
            breaks.push({ index: i, y: y, page: page, key: u.key, reason: 'flow', el: u.el });
          }
          page += 1;
          y = carried;
          gap = 0;
        }

        y += gap + u.height;
        total += gap + u.height;
        prevBottom = u.marginBottom;

        /* A unit is atomic: when it does not fit in what is left of the page,
         * the page ends inside it. Count the pages it spans and say so, rather
         * than pretending the content fits. */
        while (y > box.contentHeight + EPS) {
          breaks.push({ index: i, y: y, page: page, key: u.key, reason: 'split', el: u.el });
          page += 1;
          y -= box.contentHeight;
        }
      }
    } finally {
      measuring = false;
    }

    var pages = page + 1;
    var capacity = pages * box.contentHeight;

    return {
      valid: true,
      reason: 'ok',
      pages: pages,
      overflow: pages > 1,
      breaks: breaks,
      units: units.length,
      totalHeight: total,
      usedHeight: y,
      fill: capacity > 0 ? Math.min(1, total / capacity) : 0,
      lineHeight: lineHeightPx(docEl),
      pageSize: box.size,
      pageWidth: box.pageWidth,
      pageHeight: box.pageHeight,
      contentWidth: box.contentWidth,
      contentHeight: box.contentHeight,
      margin: box.margin,
      widthMismatch: box.widthMismatch,
      oversized: tallest > box.contentHeight + EPS,
      tallest: tallest
    };
  }

  /* ------------------------------------------------------------------- fit */

  var state = {
    docEl: null,
    pending: null,
    timer: null,
    resizeTimer: null,
    sig: '',
    last: null,
    ro: null,
    offs: [],
    errored: false
  };

  function readApplied(el) {
    var cs = global.getComputedStyle(el);
    return {
      sizePt: pxToPt(lengthPx(cs.getPropertyValue(SIZE_PROPS.size)), FALLBACK_SIZE_PT),
      sectionGapPt: pxToPt(lengthPx(cs.getPropertyValue(SIZE_PROPS.sectionGap)), FALLBACK_SECTION_GAP_PT),
      entryGapPt: pxToPt(lengthPx(cs.getPropertyValue(SIZE_PROPS.entryGap)), FALLBACK_ENTRY_GAP_PT)
    };
  }

  function applyValues(el, values) {
    el.style.setProperty(SIZE_PROPS.size, values.sizePt.toFixed(2) + 'pt');
    el.style.setProperty(SIZE_PROPS.sectionGap, values.sectionGapPt.toFixed(2) + 'pt');
    el.style.setProperty(SIZE_PROPS.entryGap, values.entryGapPt.toFixed(2) + 'pt');
  }

  function bounds(opts) {
    return {
      minSizePt: opts.minSizePt != null ? opts.minSizePt : BOUNDS.minSizePt,
      maxSizePt: opts.maxSizePt != null ? opts.maxSizePt : BOUNDS.maxSizePt,
      minSectionGapPt: opts.minSectionGapPt != null ? opts.minSectionGapPt : BOUNDS.minSectionGapPt,
      maxSectionGapPt: opts.maxSectionGapPt != null ? opts.maxSectionGapPt : BOUNDS.maxSectionGapPt,
      minEntryGapPt: opts.minEntryGapPt != null ? opts.minEntryGapPt : BOUNDS.minEntryGapPt,
      maxEntryGapPt: opts.maxEntryGapPt != null ? opts.maxEntryGapPt : BOUNDS.maxEntryGapPt
    };
  }

  function fitFail(targetPages, reason, applied, last) {
    return {
      ok: false, fitted: false, reason: reason, targetPages: targetPages,
      pages: last ? last.pages : 0, steps: 0, applied: applied, result: last || null
    };
  }

  /* Shrink (or, in 'exact' mode, grow) the document so it occupies no more than
   * targetPages. Type size moves first — it is what the eye reads as quality —
   * and whitespace only once type has hit its floor.
   *
   * Synchronous by necessity (it must read layout between steps), so call it
   * from an idle callback, never from an input handler. fitWhenIdle wraps it.
   */
  function fit(docEl, targetPages, opts) {
    opts = opts || {};
    var el = opts.target || docEl;
    if (!el || el.nodeType !== 1 || !el.isConnected) return fitFail(targetPages, 'no-document', null, null);

    var target = U.clamp(Math.round(Number(targetPages) || 1), 1, 10);
    var mode = opts.mode === 'exact' ? 'exact' : 'shrink';
    var b = bounds(opts);
    var maxSteps = opts.maxSteps || MAX_FIT_STEPS;

    var applied = readApplied(el);
    applied.sizePt = U.clamp(applied.sizePt, b.minSizePt, b.maxSizePt);
    applied.sectionGapPt = U.clamp(applied.sectionGapPt, b.minSectionGapPt, b.maxSectionGapPt);
    applied.entryGapPt = U.clamp(applied.entryGapPt, b.minEntryGapPt, b.maxEntryGapPt);

    var last = measure(el);
    if (!last.valid) return fitFail(target, last.reason, applied, last);

    var steps = 0;
    var grow = mode === 'exact' && last.pages < target;

    /* Phase 1 — type size. Phase 2 — whitespace, only once size is at its floor. */
    var phase = grow ? 'grow-size' : 'shrink-size';
    while (steps < maxSteps) {
      if (!grow) {
        if (last.pages <= target) break;
        if (applied.sizePt <= b.minSizePt + EPS) { phase = 'shrink-gap'; }
      } else if (last.pages >= target) {
        break;
      } else if (applied.sizePt >= b.maxSizePt - EPS) {
        phase = 'grow-gap';
      }

      var capacity = target * last.contentHeight;
      var ratio = last.totalHeight > 0 ? capacity / last.totalHeight : 1;
      var damped = Math.pow(ratio, SHRINK_DAMPING);
      var prevSize = applied.sizePt, prevSection = applied.sectionGapPt, prevEntry = applied.entryGapPt;

      if (phase === 'shrink-size' || phase === 'grow-size') {
        var next = applied.sizePt * damped;
        if (Math.abs(next - applied.sizePt) < 0.05) next = applied.sizePt - 0.25;
        applied.sizePt = U.clamp(next, b.minSizePt, b.maxSizePt);
      } else {
        var shrink = U.clamp(damped, 0.6, 1);
        applied.sectionGapPt = U.clamp(applied.sectionGapPt * shrink, b.minSectionGapPt, b.maxSectionGapPt);
        applied.entryGapPt = U.clamp(applied.entryGapPt * shrink, b.minEntryGapPt, b.maxEntryGapPt);
      }

      /* Everything is already at a legal bound: another step changes nothing. */
      if (Math.abs(applied.sizePt - prevSize) < 0.01 &&
        Math.abs(applied.sectionGapPt - prevSection) < 0.01 &&
        Math.abs(applied.entryGapPt - prevEntry) < 0.01) break;

      applyValues(el, applied);
      steps += 1;
      last = measure(el);
      if (!last.valid) return fitFail(target, last.reason, applied, last);
    }

    var fitted = grow ? last.pages === target : last.pages <= target;
    var reason = 'ok';
    if (!fitted) {
      if (last.oversized) reason = 'entry-longer-than-page';
      else if (applied.sizePt <= b.minSizePt + EPS &&
        applied.sectionGapPt <= b.minSectionGapPt + EPS &&
        applied.entryGapPt <= b.minEntryGapPt + EPS) reason = 'too-much-content';
      else reason = 'step-limit';
    }

    var payload = {
      ok: true,
      fitted: fitted,
      reason: reason,
      targetPages: target,
      pages: last.pages,
      steps: steps,
      applied: {
        sizePt: applied.sizePt,
        sectionGapPt: applied.sectionGapPt,
        entryGapPt: applied.entryGapPt
      },
      result: last
    };
    if (opts.emit !== false) emit(payload.result);
    return payload;
  }

  function fitWhenIdle(docEl, targetPages, opts) {
    return new Promise(function (resolve) {
      var el = (opts && opts.target) || docEl || U.qs('#rb-doc');
      if (!el) { resolve(fitFail(targetPages, 'no-document', null, null)); return; }
      U.requestIdle(function () {
        var out;
        try { out = fit(el, targetPages, opts); }
        catch (e) { report(e, 'fit'); out = fitFail(targetPages, 'error', null, null); }
        resolve(out);
      }, IDLE_TIMEOUT_MS);
    });
  }

  /* Drop the paginator's inline overrides and hand spacing back to the tokens. */
  function clearFit(docEl) {
    var el = docEl || state.docEl || U.qs('#rb-doc');
    if (!el) return false;
    el.style.removeProperty(SIZE_PROPS.size);
    el.style.removeProperty(SIZE_PROPS.sectionGap);
    el.style.removeProperty(SIZE_PROPS.entryGap);
    invalidate();
    return true;
  }

  /* ------------------------------------------------------------- scheduling */

  function eventPayload(result) {
    return {
      pages: result.pages,
      overflow: result.overflow,
      fill: result.fill,
      pageSize: result.pageSize,
      contentHeight: result.contentHeight,
      contentWidth: result.contentWidth,
      usedHeight: result.usedHeight,
      oversized: result.oversized,
      widthMismatch: result.widthMismatch,
      reason: result.reason,
      breaks: result.breaks.map(function (b) {
        return { index: b.index, y: b.y, page: b.page, key: b.key, reason: b.reason };
      })
    };
  }

  function emit(result) {
    if (!result || !result.valid) return;
    state.last = result;
    state.sig = signature(result);
    if (RB.bus && typeof RB.bus.emit === 'function') RB.bus.emit('paginator:update', eventPayload(result));
  }

  function signature(result) {
    return [result.pages, Math.round(result.totalHeight), result.pageSize, Math.round(result.contentWidth)].join('|');
  }

  function report(err, where) {
    /* A measurement failure is not user-actionable, but silence hides bugs.
     * Log once per session so a render loop cannot spam the console. */
    if (state.errored) return;
    state.errored = true;
    if (global.console && global.console.error) global.console.error('[paginator] ' + where + ' failed', err);
  }

  function flush() {
    state.timer = null;
    var el = state.pending;
    state.pending = null;
    if (!el || !el.isConnected) return;
    var result;
    try { result = measure(el); }
    catch (e) { report(e, 'measure'); return; }
    if (!result.valid) return;
    if (signature(result) === state.sig) return;
    emit(result);
  }

  /* The only entry point other modules should call from an event handler:
   * coalesces to one measurement per idle slot, so typing never triggers
   * layout work. */
  function schedule(docEl) {
    var el = docEl || state.docEl || U.qs('#rb-doc');
    if (!el) return;
    state.pending = el;
    if (state.timer) return;
    state.timer = U.requestIdle(flush, IDLE_TIMEOUT_MS);
  }

  function invalidate(docEl) {
    state.sig = '';
    schedule(docEl);
  }

  function last() { return state.last; }

  function onResize() {
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(function () { state.resizeTimer = null; invalidate(); }, RESIZE_DEBOUNCE_MS);
  }

  function onBeforePrint() {
    /* Print is synchronous: refresh the cache now so anything reading it
     * during print sees the truth, but do not emit. */
    var el = state.docEl;
    if (!el || !el.isConnected) return;
    try {
      var result = measure(el);
      if (result.valid) { state.last = result; state.sig = signature(result); }
    } catch (e) { report(e, 'measure'); }
  }

  function detach() {
    if (state.timer && typeof state.timer === 'number') clearTimeout(state.timer);
    if (state.timer && global.cancelIdleCallback) global.cancelIdleCallback(state.timer);
    state.timer = null;
    state.pending = null;
    if (state.resizeTimer) { clearTimeout(state.resizeTimer); state.resizeTimer = null; }
    if (state.ro) { state.ro.disconnect(); state.ro = null; }
    state.offs.forEach(function (off) { try { off(); } catch (e) {} });
    state.offs = [];
    state.docEl = null;
  }

  /* Wire measurement to the document for the life of the page. Safe to call
   * again: it tears the previous wiring down first. Returns the detach fn. */
  function attach(docEl) {
    detach();
    var el = docEl || U.qs('#rb-doc');
    if (!el) return function () {};
    state.docEl = el;

    if (global.ResizeObserver) {
      state.ro = new global.ResizeObserver(function () { schedule(el); });
      state.ro.observe(el);
    }
    if (RB.bus && typeof RB.bus.on === 'function') {
      state.offs.push(RB.bus.on('change', function () { invalidate(el); }));
    }
    global.addEventListener('resize', onResize, { passive: true });
    global.addEventListener('beforeprint', onBeforePrint);
    state.offs.push(function () { global.removeEventListener('resize', onResize); });
    state.offs.push(function () { global.removeEventListener('beforeprint', onBeforePrint); });

    if (RB.lifecycle && typeof RB.lifecycle.on === 'function') {
      /* Panel tab swaps emit 'unmount' as well. Measurement must survive them. */
      state.offs.push(RB.lifecycle.on('unmount', function (payload) {
        if (payload && (payload.scope === 'panel' || payload.panelId != null)) return;
        detach();
      }));
    }

    invalidate(el);
    return detach;
  }

  RB.paginator = {
    PAGE_SIZES: PAGE_SIZES,
    BOUNDS: BOUNDS,
    pageRect: pageRect,
    measure: measure,
    fit: fit,
    fitWhenIdle: fitWhenIdle,
    clearFit: clearFit,
    apply: applyValues,
    read: readApplied,
    schedule: schedule,
    invalidate: invalidate,
    last: last,
    attach: attach,
    detach: detach
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { attach(); }, { once: true });
  } else {
    attach();
  }
})(window);
