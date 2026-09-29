/* Resumeboard — service worker
 *
 * Three rules, and nothing else:
 *   1. The two front doors — index.html and app.html — are precached in full,
 *      so the editor boots with no network at all.
 *   2. Same-origin static assets are served cache-first.
 *   3. Navigations go to the network first, so a deploy is picked up at once.
 *
 * The user's resume never travels over HTTP — RB.idb keeps it in IndexedDB —
 * so the only thing that can land in a cache is a file PRECACHE or the fetch
 * listener allows. That allowlist is the destination check below: a fetch/XHR
 * has an empty destination and is always passed straight through.
 *
 * Versioning: the cache name is a hash of this file's own source combined with
 * the ASSET_REVISION stamp. Editing this file changes the hash by itself, and
 * a deploy that changes a precached file but not this file is covered by the
 * stamp, because a browser only reinstalls a worker whose bytes differ. Every
 * cache under this prefix except the current name is deleted on activate, so
 * a new version replaces the old one instead of accumulating beside it.
 */
(function (self) {
  'use strict';

  var PREFIX = 'rb-static-';

  /* Bump this whenever a file in PRECACHE changes without sw.js changing.
   * Without it a deploy would leave cache-first serving the old bytes. */
  var ASSET_REVISION = '2026-09-29.6';

  /* Everything the home page and the editor need to render and boot. Order
   * mirrors the two documents so a reader of this file can check it against
   * their <link> and <script src> tags. A missing entry is logged at install
   * rather than thrown, so one broken file cannot cost the user the worker. */
  var PRECACHE = [
    // documents
    './',
    './index.html',
    './editor.html',

    // install icons
    './manifest.webmanifest',
    './favicon.svg',
    './assets/img/icon-192.png',
    './assets/img/icon-512.png',

    // stylesheets (home + editor)
    './assets/css/tokens.css',
    './assets/css/base.css',
    './assets/css/site.css',
    './assets/css/home.css',
    './assets/css/app.css',
    './assets/css/editor.css',
    './assets/css/templates.css',
    './assets/css/autofill.css',
    './assets/css/onboarding.css',
    './assets/css/a11y-fixes.css',
    './assets/css/polish-fixes.css',
    './assets/css/documents.css',
    './assets/css/print.css',

    // core
    './assets/js/core/utils.js',
    './assets/js/core/events.js',
    './assets/js/core/idb.js',
    './assets/js/core/model.js',
    './assets/js/core/store.js',

    // ui primitives
    './assets/js/ui/icons.js',
    './assets/js/ui/registry.js',
    './assets/js/ui/ui.js',

    // analysis (pure, no DOM)
    './assets/js/analysis/linter.js',
    './assets/js/analysis/ats.js',
    './assets/js/analysis/jdmatch.js',
    './assets/js/analysis/score.js',
    './assets/js/analysis/merge.js',
    './assets/js/analysis/proof.js',

    // render
    './assets/js/render/templates.js',
    './assets/js/render/paginator.js',
    './assets/js/render/renderer.js',
    './assets/js/render/binder.js',

    // export + import
    './assets/js/export/txt.js',
    './assets/js/export/markdown.js',
    './assets/js/export/json.js',
    './assets/js/export/docx.js',
    './assets/js/export/pdf.js',
    './assets/js/import/docx.js',
    './assets/js/import/text.js',
    './assets/js/share.js',

    // panels + chrome
    './assets/js/ui/forms.js',
    './assets/js/ui/design.js',
    './assets/js/ui/analysis-panel.js',
    './assets/js/ui/panel.js',
    './assets/js/ui/rail.js',
    './assets/js/ui/autofill.js',
    './assets/js/ui/chrome.js',
    './assets/js/ui/commandbar.js',
    './assets/js/ui/importer.js',
    './assets/js/ui/typescale.js',
    './assets/js/ui/onboarding.js',

    // documents workspace (cover letter + interview prep)
    './assets/js/documents/letter.js',
    './assets/js/documents/prep.js',
    './assets/js/documents/workspace.js',

    // import comparison + the proof pass
    './assets/js/ui/merge-step.js',
    './assets/js/ui/proof.js',

    // home page + boot
    './assets/js/home.js',
    './assets/js/pwa.js',
    './assets/js/boot.js',

    /* reset-guard and responsive are loaded by a <script> tag in the document,
     * not by boot.js, so listing them under "core" or "panels" would read as
     * though something else pulled them in. They are here because both pages
     * need them to work offline: without reset-guard a reload taken with no
     * network would skip the wipe-and-return guard, and without responsive the
     * editor would lose its phone sheet. */
    './assets/js/reset-guard.js',
    './assets/js/ui/responsive.js'
  ];

  var CACHEABLE_DESTINATIONS = ['script', 'style', 'image', 'font', 'worker', 'manifest'];

  /* A hard reload or an explicit revalidate must reach the network. Answering
   * those from the cache is how a user gets stuck on bytes they cannot shake. */
  var BYPASS_CACHE_MODES = ['no-store', 'reload', 'no-cache'];

  var OFFLINE_NOTICE = [
    'Resumeboard is offline and this page was never saved to this browser.',
    '',
    'The landing page and the editor both work without a network once they',
    'have been opened once while you were online. Reconnect and reload to',
    'get this page, or go to the editor at /app.html.'
  ].join('\n');

  var cacheName = null;

  function logError(message, err) {
    if (!self.console) return;
    if (err === undefined || err === null) self.console.error('[sw] ' + message);
    else self.console.error('[sw] ' + message, err);
  }

  function scopeUrl(path) {
    return new URL(path, self.registration.scope).href;
  }

  /* FNV-1a, only ever used as a cache-name discriminator, never as a digest. */
  function hashSource(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36) + '.' + text.length.toString(36);
  }

  function resolveCacheName() {
    if (cacheName) return Promise.resolve(cacheName);
    return fetch(self.location.href, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (text) {
        cacheName = PREFIX + hashSource(ASSET_REVISION + '|' + text);
        return cacheName;
      })
      .catch(function () {
        /* Reading our own source failed, so the revision stamp is the only
         * version signal left. It still moves when the site changes. */
        cacheName = PREFIX + 'r-' + ASSET_REVISION;
        return cacheName;
      });
  }

  function openCache() {
    return resolveCacheName().then(function (name) { return caches.open(name); });
  }

  /* The exact URLs the documents request, read out of the documents.
   *
   * A hand-maintained list was wrong in both directions: it missed files, and
   * because the pages stamp every asset with ?v=, a hand list of unversioned
   * paths can only be matched back with ignoreSearch — which silently defeats
   * the stamp and pins the reader to whatever was cached first. Reading the
   * real URLs means cache keys and request URLs are identical, so a version
   * bump genuinely changes the key and a stale worker genuinely misses. */
  var DOCS = ['./', './index.html', './editor.html'];

  function collectAssets() {
    return Promise.all(DOCS.map(function (doc) {
      return fetch(new Request(scopeUrl(doc), { cache: 'reload', credentials: 'same-origin' }))
        .then(function (res) { return res && res.ok ? res.text() : ''; })
        .catch(function () { return ''; });
    })).then(function (docs) {
      var out = PRECACHE.slice();
      docs.forEach(function (html) {
        var re = /(?:href|src)="([^"]+)"/g;
        var m;
        while ((m = re.exec(html))) {
          var href = m[1];
          if (/^(https?:|data:|mailto:|tel:|#)/i.test(href)) continue;
          if (href.slice(0, 2) === '//') continue;
          out.push(href);
        }
      });
      /* The reset guard is loaded before the documents render, so it is always
       * needed offline even though no <script> tag is guaranteed to precede it
       * in an early parse. */
      out.push('assets/js/reset-guard.js');
      return out.filter(function (u, i) { return out.indexOf(u) === i; });
    });
  }

  function precache() {
    return collectAssets().then(function (urls) {
      return openCache().then(function (cache) {
        return Promise.all(urls.map(function (path) {
          var url = scopeUrl(path);
          return fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }))
            .then(function (res) {
              if (res && res.ok) return cache.put(url, res.clone());
              return null;
            })
            .catch(function () { return null; });
        }));
      });
    }).then(function () { return verifyPrecache(); });
  }

  /* Install is deliberately tolerant so one 404 cannot cost the user the
   * worker, which means a gap has to be reported rather than swallowed: an
   * entry that is missing is an entry the editor will fail to load offline. */
  function verifyPrecache() {
    return openCache().then(function (cache) {
      return cache.keys().then(function (keys) {
        var have = {};
        keys.forEach(function (req) { have[req.url] = true; });
        var missing = PRECACHE.filter(function (path) { return !have[scopeUrl(path)]; });
        if (missing.length) logError('precache incomplete, offline boot will fail for: ' + missing.join(', '));
      });
    });
  }

  function fromNetwork(cache, request) {
    return fetch(request).then(function (res) {
      if (cache && res && res.ok && res.type === 'basic') {
        cache.put(request, res.clone()).catch(function () { /* quota, or evicted mid-flight */ });
      }
      return res;
    });
  }

  function cacheFirst(request) {
    return openCache()
      .catch(function () { return null; })
      .then(function (cache) {
        if (!cache) return fetch(request);
        return cache.match(request).then(function (hit) {
          return hit || fromNetwork(cache, request);
        });
      });
  }

  function matchFirst(cache, urls) {
    if (!cache) return Promise.resolve(null);
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.resolve(null);
      var url = urls[i++];
      return cache.match(url).then(function (hit) { return hit || next(); });
    }
    return next();
  }

  /* Offline we can only answer with a document we stored under this exact URL.
   * A directory request also tries its index.html, because a server that
   * redirects /guides/ to /guides/index.html stores the response under the
   * second URL while the address bar keeps the first. Substituting the landing
   * page for the editor is never correct. */
  function cachedOffline(cache, request) {
    var urls = [request.url];
    var pathname = new URL(request.url).pathname;
    if (pathname.charAt(pathname.length - 1) === '/') {
      var index = new URL('index.html', request.url).href;
      if (index !== request.url) urls.push(index);
    }
    return matchFirst(cache, urls).then(function (hit) {
      if (hit) return hit;
      /* The documents request their assets with a ?v= build stamp, so the
       * literal key never matches the unversioned precache entry. */
      return caches.match(request.url);
    });
  }

  function offlineNotice() {
    return new Response(OFFLINE_NOTICE, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  function handleNavigation(request) {
    return openCache()
      .catch(function () { return null; })
      .then(function (cache) {
        return fetch(request)
          .then(function (res) {
            /* Stored under the URL that was asked for, never under the shell:
             * writing app.html's body to '/' would serve the editor at the
             * landing page's address the next time the network is gone. */
            if (cache && res && res.ok && res.type === 'basic') {
              cache.put(request, res.clone()).catch(function () {});
            }
            return res;
          })
          .catch(function () {
            return cachedOffline(cache, request).catch(function () { return null; });
          })
          .then(function (hit) { return hit || offlineNotice(); });
      });
  }

  self.addEventListener('install', function (event) {
    // No skipWaiting here: an update must never swap the worker out from under
    // an edit in progress. The page asks for it once the user accepts.
    event.waitUntil(precache().catch(function (err) { logError('precache failed', err); }));
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(
      resolveCacheName()
        .then(function (name) {
          return caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) {
              if (key.indexOf(PREFIX) === 0 && key !== name) return caches.delete(key);
              return null;
            }));
          });
        })
        .then(function () { return self.clients.claim(); })
        .catch(function (err) { logError('activate failed', err); })
    );
  });

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return;
    }

    // Cross-origin (the lazy pdf.js on the import path) is never ours to cache.
    if (url.origin !== self.location.origin) return;
    if (request.headers.has('range')) return;
    if (BYPASS_CACHE_MODES.indexOf(request.cache) !== -1 && request.mode !== 'navigate') {
      if (CACHEABLE_DESTINATIONS.indexOf(request.destination) === -1) return;
      event.respondWith(fromNetwork(openCache().catch(function () { return null; }), request));
      return;
    }

    // 'document' excludes iframes, which share navigate mode but must not be
    // answered with a cached shell.
    if (request.mode === 'navigate' && request.destination === 'document') {
      event.respondWith(handleNavigation(request));
      return;
    }

    if (CACHEABLE_DESTINATIONS.indexOf(request.destination) === -1) return;
    event.respondWith(cacheFirst(request));
  });

  self.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.type !== 'SKIP_WAITING') return;
    if (event.source && event.source.url && event.source.url.indexOf(self.registration.scope) !== 0) return;
    self.skipWaiting();
  });
})(self);
