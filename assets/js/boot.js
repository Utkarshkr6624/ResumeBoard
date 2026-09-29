/* Resumeboard — application entry point
 * Last script on the page. Hydrates the store, then lets every registered
 * module run in one deterministic pass.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var bus = global.RB.bus;
  var store = global.RB.store;

  /* Entry is authorised by the URL, never by stored state.
   *
   * A refresh is a reset: the saved resume, the undo history and the settings
   * are wiped and you are sent back to the front door. The editor is only
   * opened deliberately, and the proof of that intent lives in the URL — a
   * `#start` marker on a hand-off, or a payload such as `#p=` from the
   * bookmarklet. The marker is stripped from the address bar the moment it is
   * used, so a refresh finds a bare URL and goes home. Nothing is stored, so
   * nothing can survive a reload and quietly let you back in.
   */



  /* A load is a reset. There is no second page to fall back to and nothing worth
   * carrying: a payload in the hash (a bookmarklet capture, a share link, a
   * chosen template) is the only thing that survives. A bare URL means the
   * previous session is over, so the saved resume goes. */
  /* Navigation Timing is synchronous and available before first paint, unlike
   * the PerformanceObserver route. 'reload' and 'back_forward' are a revisitation;
   * 'navigate' and 'reload' on a typed URL are a fresh intent. */
  function isReload() {
    try {
      var navs = performance.getEntriesByType('navigation');
      if (!navs || !navs.length) return false;
      var type = navs[0].type;
      if (type === 'reload' || type === 'back_forward') return true;
      /* Chromium reports 'navigate' for a reload of a file:// URL in some
       * versions, so a planted session marker is the fallback signal. */
      if (type === 'navigate') {
        try { return !!sessionStorage.getItem('rb:on-visit'); } catch (e) { return false; }
      }
      return false;
    } catch (e) { return false; }
  }

  function claimEntry() {
    try { sessionStorage.setItem('rb:on-visit', '1'); } catch (e) { /* ignore */ }
    var hash = global.location.hash || '';
    if (/(?:^|[#&])(?:start(?:[=&]|$)|(?:p|r|example|template)=)/.test(hash)) {
      if (/(?:^|[#&])start(?:[=&]|$)/.test(hash)) {
        history.replaceState(null, '', global.location.pathname + global.location.search);
      }
      return Promise.resolve(true);
    }
    return hardWipe().then(function () { return true; });
  }

  /* A wipe has to be complete before the store reads, and nothing may write
   * after it — a debounced autosave from the previous page landing late is
   * exactly how typed data comes back from the dead. Returns a promise. */
  var epoch = 0;
  function hardWipe() {
    epoch += 1;
    var mine = epoch;
    try {
      Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('rb:') === 0 || k.indexOf('resumeboard') === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) { /* private mode */ }
    var jobs = [];
    if (global.RB.idb && global.RB.idb.clear) {
      try { jobs.push(global.RB.idb.clear()); } catch (e) { /* ignore */ }
    }
    return Promise.all(jobs)
      .catch(function () {})
      .then(function () {
        /* A write that was already in flight when the wipe started would put
         * the old data straight back. Sweep the store again once they settle. */
        if (mine !== epoch) return;
        if (global.RB.store && global.RB.store.reset) global.RB.store.reset({ noHistory: true });
        try {
          if (global.RB.idb && global.RB.idb.set) {
            return global.RB.idb.set('resume:current', null);
          }
        } catch (e) { /* ignore */ }
      })
      .catch(function () {});
  }

  /* The landing content is inlined in index.html so crawlers see it in the
   * initial response and there is no second request. All that is left is the
   * CTA wiring. */
  function wireLandingLinks() {
    U.qsa('a[data-cta]', U.qs('#rb-marketing')).forEach(function (a) {
      a.addEventListener('click', function () {
        var target = a.getAttribute('data-target');
        if (target) {
          var node = U.qs(target);
          if (node) { node.scrollIntoView({ behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' }); node.focus({ preventScroll: true }); }
        }
      });
    });
  }

  /* A template gallery page can deep-link here: /#template=classic */
  function applyTemplateDeepLink() {
    var hash = global.location.hash || '';
    var m = /(?:^|[#&])template=([a-z0-9-]+)/i.exec(hash);
    if (m && global.RB.templates) {
      var id = m[1].toLowerCase();
      if (global.RB.templates.get(id)) {
        global.RB.templates.apply(id);
        U.announce('Applied the ' + id + ' template.');
      }
      return;
    }
    /* An example page can hand over a whole finished resume: /#example=slug */
    var ex = /(?:^|[#&])example=([a-z0-9-]+)/i.exec(hash);
    if (ex) {
      var slug = ex[1].toLowerCase();
      if (global.RB.examples && global.RB.examples.get(slug)) {
        store.replace(global.RB.examples.get(slug), { source: 'import' });
        U.announce('Loaded the ' + slug + ' example.');
        return;
      }
    }

    /* The bookmarklet drops captured page text in the hash. Base64url, not
     * deflate: this has to survive a round trip through a URL bar, and a
     * long profile can overflow some browsers' hash limits unencoded. */
    var p = /(?:^|[#&])p=([^&]+)/.exec(hash);
    if (!p) return;
    var raw;
    try { raw = decodeURIComponent(p[1]); } catch (err) { raw = p[1]; }
    var text;
    try {
      text = new TextDecoder().decode(U.fromBase64Url(raw));
    } catch (err) {
      U.announce('That shared profile could not be read.');
      return;
    }
    if (!text || text.trim().length < 120) {
      U.announce('That shared profile was empty.');
      return;
    }
    try {
      var out = global.RB.importer.text(text, { filename: 'bookmarklet' });
      store.replace(out.resume, { source: 'import' });
      U.announce('Profile imported as a draft resume.');
      /* Drop the payload from the URL so a refresh does not re-import it and
       * so the link is not a two-megabyte address bar entry. */
      history.replaceState(null, '', global.location.pathname + global.location.search);
    } catch (err) {
      console.error('[boot] bookmarklet import failed', err);
      U.announce('That profile could not be turned into a resume.');
    }
  }

  /* One page: the pitch shows only while there is nothing to edit. */
  function syncEmptyState() {
    var empty = true;
    try {
      var r = store.get();
      empty = !r || (global.RB.model && global.RB.model.isBlankResume ? global.RB.model.isBlankResume(r) : !r.basics.name);
    } catch (e) { empty = true; }
    document.documentElement.setAttribute('data-rb-empty', empty ? 'true' : 'false');
  }

  function start(resume) {
    applyTemplateDeepLink();
    global.RB.runBoot(resume);
    bus.on('change', syncEmptyState);
    bus.emit('app:ready', { resume: resume });
    U.announce('Resume editor ready.');
  }

  /* A damaged record is repaired into a blank resume rather than rejected, so
   * the load path sees no failure at all. Without this the app would open to an
   * empty page and the user would have no way to know the work was still there
   * before this load replaced it. */
  function storedResumeWasLost(stored) {
    if (stored == null) return false;
    /* The store only ever writes a resume object here, so anything else in the
     * slot is damage rather than an empty resume. */
    if (typeof stored !== 'object' || Array.isArray(stored)) return true;
    try { return !global.RB.model.isBlankResume(stored); } catch (err) { return true; }
  }

  function reportLostSavedResume() {
    var RB = global.RB;
    if (!RB.idb || !RB.model || !RB.ui || !RB.ui.toast) return;
    if (!RB.model.isBlankResume(store.get())) return;
    RB.idb.get(RB.store.KEY).then(function (stored) {
      if (!storedResumeWasLost(stored)) return;
      RB.ui.toast('The resume saved in this browser could not be read, so this is a fresh start. A JSON export you made is unaffected.', {
        tone: 'error',
        duration: 0
      });
    }).catch(function () { /* the store already refused this once; say nothing twice */ });
  }

  /* With both IndexedDB and localStorage refused, the store keeps the resume in
   * memory and the status bar still says it saved. A write that reports failure
   * is the only signal that says otherwise, so probe for one once at boot. */
  function reportUnsavedStorage() {
    var RB = global.RB;
    if (!RB.idb || !RB.ui || !RB.ui.toast) return;
    var probe = 'resume:storage-probe';
    RB.idb.set(probe, 1).then(function (stored) {
      if (stored !== false) return RB.idb.del(probe);
      RB.ui.toast('This browser will not let Resumeboard save your resume, so it is lost when you close the tab. Export it as JSON to keep a copy.', {
        tone: 'warn',
        duration: 0
      });
    }).catch(function () { /* the store falls back to memory; the probe cannot tell us more */ });
  }

  function boot() {
    if (global.RB.__booted) return;
    global.RB.__booted = true;

    /* The editor is a destination, not a front door. Opened without a marker
     * or a payload it was reached by typing or refreshing, so the session is
     * over: wipe it and go home. */
    if (/editor.html$/.test(global.location.pathname) &&
        !/(?:^|[#&])(?:start(?:[=&]|$)|(?:p|r|example|template)=)/.test(global.location.hash || '')) {
      /* Distinguish a reload from a link click. A reload ends the session; a
       * link is a request to build, so it must not be thrown away. */
      if (isReload()) {
        hardWipe().then(function () { global.location.replace('index.html'); });
        return;
      }
    }

    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    global.scrollTo(0, 0);

    claimEntry().then(function (ok) { if (!ok) return; continueBoot(); });
  }

  function continueBoot() {

    /* A shared resume in the URL wins over whatever is in local storage, and
     * the current document is pushed into history so Back does not lose it.
     * readFromLocation() is async: it can be parked on a confirmation dialog,
     * so it resolves to a resume *or* null, never a promise of one. */
    var shared = null;
    try {
      if (global.RB.share && global.RB.share.readFromLocation) shared = global.RB.share.readFromLocation();
    } catch (err) {
      console.warn('[boot] share link could not be read', err);
    }

    store.load().then(function (resume) {
      if (U.LOCALE && !store.get().design.pageSize) {
        store.update(function (d) { d.design.pageSize = U.LOCALE.region === 'US' || U.LOCALE.region === 'CA' ? 'Letter' : 'A4'; }, { source: 'update', coalesce: false });
      }

      /* Ask the browser not to evict the resume under storage pressure. */
      if (global.RB.idb && global.RB.idb.persist) global.RB.idb.persist();

      var firstRun = false;
      try { firstRun = !localStorage.getItem('rb:onboarding.v1'); } catch (e) {}
      /* Anyone who followed a link here came to build something. */
      if (/(?:^|[#&])start(?:[=&]|$)/.test(global.location.hash || '') &&
          global.RB.onboarding && global.RB.onboarding.show) {
        firstRun = true;
      }
      if (firstRun) {
        setTimeout(function () {
          if (global.RB.onboarding && global.RB.onboarding.maybeShow) global.RB.onboarding.maybeShow();
        }, 500);
      }
      syncEmptyState();
      start(resume);
      U.requestIdle(function () { wireLandingLinks(); syncEmptyState(); }, 300);
      reportLostSavedResume();
      reportUnsavedStorage();

      if (shared) {
        Promise.resolve(shared).then(function (fromLink) {
          if (!fromLink) return;
          store.replace(fromLink, { source: 'share' });
          global.RB.ui.toast('Opened a shared resume.', {
            action: { label: 'Undo', onClick: function () { store.undo(); } }
          });
        });
      }
    }).catch(function (err) {
      console.error('[boot] failed', err);
      /* A corrupt store must never produce a blank page. */
      store.reset({ noHistory: true });
      start(store.get());
      global.RB.ui.toast('Started a fresh resume because the saved one could not be read.', { tone: 'error', duration: 9000 });
    });

    global.addEventListener('beforeunload', function () { store.persistNow(); });
    global.addEventListener('pagehide', function () { store.persistNow(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
