/* Resumeboard — reset guard
 *
 * Loaded by every page. A reload is a reset: the saved resume, the undo
 * history and the settings are wiped, and you land on the home page.
 *
 * This is a deliberate product decision, not an accident. The tool keeps
 * nothing between page loads, so a reload always starts over and never lands
 * the reader on a page showing a document they think still exists.
 *
 * It has to be tiny and it has to be synchronous where it can be: the wipe
 * starts before anything else runs, and the guard is inlined-capable so a page
 * can carry it without a round trip.
 */
(function (global) {
  'use strict';

  var HOME = 'index.html';
  var FLAG = 'rb:seen-session';

  /* Read this now. document.currentScript is only set while a script is being
   * evaluated, and the IndexedDB wipe below does not finish until long after
   * that, so it has to be captured up front or it is gone. */
  var SELF = (global.document && global.document.currentScript && global.document.currentScript.src) || '';

  /* The home page is at the site root, which is the current directory only for
   * the root pages themselves. /guides/index.html would otherwise count as home,
   * and a reload there would land the reader back on the page they just left.
   *
   * Every page reaches this file by a path relative to itself, so the root is
   * the directory above the assets/js/ the guard was served from. That holds
   * on file:// and on any static host, at whatever depth it is deployed. */
  function root() {
    try {
      if (SELF) {
        var m = /^(.*\/)assets\/js\/$/.exec(new URL(SELF).pathname.replace(/[^/]*$/, ''));
        if (m) return m[1];
      }
    } catch (e) { /* an inlined guard, or a src the URL parser will not take */ }
    return (global.location.pathname || '').replace(/[^/]*$/, '');
  }

  function home() {
    return root() + HOME;
  }

  function isHome() {
    var path = global.location.pathname || '';
    return path === home() || path === root();
  }

  /* A payload in the hash is a deliberate hand-off — a bookmarklet capture, a
   * share link, a chosen template — and is the one thing that survives. */
  function hasPayload() {
    return /(?:^|[#&])(?:start(?:[=&]|$)|(?:p|r|example|template)=)/.test(global.location.hash || '');
  }

  function here() {
    return (global.location.pathname || '') + (global.location.search || '');
  }

  function mark() {
    try { sessionStorage.setItem(FLAG, here()); } catch (e) { /* private mode */ }
  }

  /* A reload and a first visit both hand the script a brand new document, so
   * something has to say which one this is. The Navigation Timing entry does,
   * synchronously, at document start, and it costs nothing. Browsers without it
   * fall back to the per-session marker: the same URL twice in one session is
   * a reload. */
  function isReload() {
    var entry = null;
    try {
      var nav = global.performance && global.performance.getEntriesByType &&
        global.performance.getEntriesByType('navigation');
      if (nav && nav.length) entry = nav[0];
    } catch (e) { /* no Navigation Timing */ }
    if (entry && entry.type) return entry.type === 'reload';
    try { return sessionStorage.getItem(FLAG) === here(); } catch (e) { return false; }
  }

  function wipe() {
    try {
      Object.keys(localStorage)
        .filter(function (k) { return k.indexOf('rb:') === 0 || k.indexOf('resumeboard') === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) { /* private mode */ }

    /* IndexedDB is async; the redirect must not outrun it or the next load
     * would read the row we are trying to delete. */
    try {
      var req = indexedDB.deleteDatabase('resumeboard');
      if (req && req.onsuccess !== undefined) {
        req.onsuccess = function () { go(); };
        req.onerror = function () { go(); };
        req.onblocked = function () { go(); };
        return;
      }
    } catch (e) { /* no IndexedDB */ }
    go();
  }

  var gone = false;
  function go() {
    if (gone) return;
    gone = true;
    if (!isHome()) global.location.replace(home());
  }

  if (global.RB && global.RB.__resetGuard) return;
  if (global.RB) global.RB.__resetGuard = true;

  if (hasPayload()) {
    /* Let it through, and mark the session so the next load resets. */
    mark();
    return;
  }

  /* Following a link is not reloading. Only a reload ends the session; a fresh
   * navigation has to be let through, or the guides, the ATS reference and the
   * examples could never be read. */
  if (!isReload()) {
    mark();
    return;
  }

  wipe();
})(window);
