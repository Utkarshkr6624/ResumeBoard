/* Resumeboard — motion behaviour
 *
 * Content reveals as it enters the viewport, accordions swing open, and
 * nothing ever animates for a reader who asked for less of it. Sits at the end
 * of the document so the first paint is never delayed.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var U = global.RB && global.RB.utils;
  function el(tag, attrs, kids) { return U.el(tag, attrs, kids); }

  /* Set before anything paints. Without this the reveal styles never apply and
   * the page is simply static, which is the correct fallback. */
  doc.documentElement.classList.add('js-motion');

  if (U && U.prefersReducedMotion && U.prefersReducedMotion()) {
    doc.documentElement.classList.remove('js-motion');
    return;
  }

  var EASE_MS = 460;

  /* ---------------- Reveal on enter ---------------- */

  var revealed = new WeakSet();

  function markRevealed(el) {
    if (revealed.has(el)) return;
    revealed.add(el);
    el.classList.add('is-revealed');
  }

  function setupReveal() {
    var targets = U.qsa('[data-reveal]');
    if (!targets.length) return;

    if (!('IntersectionObserver' in global)) {
      targets.forEach(markRevealed);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        /* One frame's delay so the transition has a start value to leave from;
           without it the first frame paints already-opaque and nothing moves. */
        global.requestAnimationFrame(function () { markRevealed(entry.target); });
        io.unobserve(entry.target);
      });
    }, {
      /* Start the move just before the element is fully on screen, so it is
         already settled by the time it reaches the reading position. */
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.01
    });

    targets.forEach(function (el) { io.observe(el); });

    /* Anything already on screen at load reveals at once — a reader must not
       have to scroll to make the page appear. */
    U.requestIdle(function () {
      targets.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < global.innerHeight && r.bottom > 0) markRevealed(el);
      });
    }, 200);
  }

  /* ---------------- Accordion ---------------- */

  function panelOf(details) {
    for (var i = 0; i < details.children.length; i++) {
      var child = details.children[i];
      if (child.tagName !== 'SUMMARY') return child;
    }
    return null;
  }

  function setupAccordions() {
    U.qsa('details').forEach(function (details) {
      var summary = details.querySelector(':scope > summary');
      if (!summary) return;
      var panel = panelOf(details);
      if (!panel) return;

      panel.classList.add('rb-faq__panel');
      details.setAttribute('rb-motion', '');

      function setOpen(open, animate) {
        if (!animate) {
          details.open = open;
          panel.style.height = '';
          return;
        }
        if (open) {
          details.open = true;
          panel.style.height = '0px';
          /* Force a frame so the 0 is committed before the target is set. */
          void panel.offsetHeight;
          panel.style.height = panel.scrollHeight + 'px';
        } else {
          /* Measure first, then close. The native toggle is prevented, so
           * `open` has to be set here or the next click reads the same state
           * and the panel can never be opened a second time. */
          panel.style.height = panel.scrollHeight + 'px';
          void panel.offsetHeight;
          details.open = false;
          panel.style.height = '0px';
          /* A closed <details> still lays out its children, so clear the
             inline height once the transition is done or the next open starts
             from a stale pixel value. */
          setTimeout(function () {
            if (!details.open) panel.style.height = '';
          }, EASE_MS + 40);
        }
      }

      if (details.open) {
        panel.style.height = 'auto';
      } else {
        panel.style.height = '0px';
      }

      /* Always own the toggle. A double click during the transition would
       * otherwise land one click on the native control and one on ours, and
       * the two fight over `open` — which is what made it go mad. */
      summary.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (details.hasAttribute('rb-animating')) return;
        details.setAttribute('rb-animating', '');
        setOpen(!details.open, true);
        setTimeout(function () { details.removeAttribute('rb-animating'); }, EASE_MS + 40);
      });

      /* Keyboard and assistive tech that toggles `open` directly. */
      details.addEventListener('toggle', function () {
        if (details.hasAttribute('rb-animating')) return;
        panel.style.height = details.open ? 'auto' : '0px';
        panel.style.opacity = details.open ? '1' : '0';
      });
    });
  }

  /* ---------------- Scroll behaviour ---------------- */

  /* A long smooth scroll across a long document reads as drift. Short jumps
     animate; anything long is instant, which is what a reader means by "take
     me there". */
  doc.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var target = doc.getElementById(id);
    if (!target) return;
    var far = Math.abs(target.getBoundingClientRect().top) > 2 * global.innerHeight;
    if (far) doc.documentElement.style.scrollBehavior = 'auto';
    global.setTimeout(function () { doc.documentElement.style.scrollBehavior = ''; }, far ? 60 : EASE_MS);
  }, true);

  /* ---------------- Site text size ---------------- */

  var SIZE_KEY = 'rb:site-scale';
  var SCALE_MIN = 0.9, SCALE_MAX = 1.5, SCALE_STEP = 0.1;

  function readScale() {
    try {
      var v = parseFloat(sessionStorage.getItem(SIZE_KEY) || localStorage.getItem(SIZE_KEY));
      if (isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX) return v;
    } catch (e) { /* private mode */ }
    return 1;
  }

  function applyScale(v) {
    doc.documentElement.style.setProperty('--rb-site-scale', String(v));
    doc.documentElement.setAttribute('data-site-scale', v.toFixed(2));
  }

  function setScale(v) {
    var next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100));
    try { sessionStorage.setItem(SIZE_KEY, String(next)); } catch (e) {}
    applyScale(next);
    U.qsa('[data-site-size-value]').forEach(function (n) { n.textContent = Math.round(next * 100) + '%'; });
    U.announce('Text size ' + Math.round(next * 100) + ' percent.');
    return next;
  }

  function setupSiteSize() {
    applyScale(readScale());
    var host = doc.querySelector('[data-site-size]');
    if (!host) return;

    var dec = el('button', { type: 'button', class: 'rb-sz__btn rb-sz__btn--sm', 'aria-label': 'Make all text smaller' });
    dec.textContent = 'A';
    var val = el('button', { type: 'button', class: 'rb-sz__val', 'data-site-size-value': '', 'aria-label': 'Text size. Activate to reset to 100 percent.' });
    var inc = el('button', { type: 'button', class: 'rb-sz__btn rb-sz__btn--lg', 'aria-label': 'Make all text larger' });
    inc.textContent = 'A';
    host.appendChild(el('div', { class: 'rb-sz', role: 'group', 'aria-label': 'Text size for the whole site' }, [dec, val, inc]));

    var cur = readScale();
    val.textContent = Math.round(cur * 100) + '%';
    dec.disabled = cur <= SCALE_MIN;
    inc.disabled = cur >= SCALE_MAX;
    dec.addEventListener('click', function () { cur = setScale(cur - SCALE_STEP); dec.disabled = cur <= SCALE_MIN; inc.disabled = false; });
    inc.addEventListener('click', function () { cur = setScale(cur + SCALE_STEP); inc.disabled = cur >= SCALE_MAX; dec.disabled = false; });
    val.addEventListener('click', function () { cur = setScale(1); dec.disabled = cur <= SCALE_MIN; inc.disabled = cur >= SCALE_MAX; });
  }

  function init() {
    setupReveal();
    setupAccordions();
    setupSiteSize();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  global.RB.motion = { init: init, revealAll: function () { U.qsa('[data-reveal]').forEach(markRevealed); } };
  global.RB = global.RB || {};
  global.RB.motion = { init: init, setScale: setScale, readScale: readScale };
})(window);
/*x*/
