/* Resumeboard — PWA shell
 *
 * Owns the service worker lifecycle: registration, the install prompt, and the
 * update handshake. An update is never applied behind the user's back — a new
 * worker waits, and the user reloads when the document is not mid-edit.
 *
 * Everything degrades quietly. On file:// there is no service worker, no
 * beforeinstallprompt, and no manifest install; the app is fully usable and
 * this module reports status() === 'unsupported'.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var doc = global.document;
  var nav = global.navigator;

  var UNSUPPORTED = 'unsupported';
  var updateListeners = [];
  var deferredPrompt = null;
  var registration = null;
  var updateReady = false;
  var reloadRequested = false;

  function supportsServiceWorker() {
    if (!nav || !('serviceWorker' in nav)) return false;
    /* A service worker needs a real origin. From file:// the origin is opaque
     * ("null") and register() always rejects, so treat it as unsupported
     * rather than logging a failure on every page load. */
    var protocol = global.location && global.location.protocol;
    return protocol === 'http:' || protocol === 'https:';
  }

  function status() {
    if (!supportsServiceWorker()) return UNSUPPORTED;
    if (nav.onLine === false) return 'offline';
    if (updateReady) return 'update-ready';
    if (registration && registration.active) return 'ready';
    return 'registering';
  }

  function isOffline() {
    return !!(nav && nav.onLine === false);
  }

  /* Resolved at call time, not at load time: pwa.js is early in the document
   * and RB.ui may not exist yet when this file runs. */
  function toast(message, opts) {
    var ui = RB.ui;
    if (!ui || typeof ui.toast !== 'function') return;
    try { ui.toast(message, opts); } catch (err) { /* the toast is a courtesy, not a requirement */ }
  }

  function reportError(err) {
    if (global.console && global.console.warn) global.console.warn('[pwa]', err);
  }

  function notifyUpdate() {
    updateReady = true;
    updateListeners.slice().forEach(function (fn) {
      try { fn(); } catch (err) { reportError(err); }
    });
  }

  function applyUpdate() {
    var waiting = registration && (registration.waiting || registration.installing);
    if (!waiting) return false;
    reloadRequested = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  function checkForUpdate() {
    if (!registration || typeof registration.update !== 'function') return Promise.resolve(false);
    return registration.update().catch(function (err) {
      reportError(err);
      return false;
    });
  }

  function onUpdate(fn) {
    if (typeof fn !== 'function') return function () {};
    updateListeners.push(fn);
    return function () {
      var i = updateListeners.indexOf(fn);
      if (i !== -1) updateListeners.splice(i, 1);
    };
  }

  function canInstall() {
    return !!deferredPrompt;
  }

  function install() {
    if (!deferredPrompt) return Promise.resolve('unavailable');
    var deferred = deferredPrompt;
    deferredPrompt = null;
    return deferred.prompt().then(function () {
      return deferred.userChoice;
    }).then(function (choice) {
      return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    }).catch(function (err) {
      reportError(err);
      return 'unavailable';
    });
  }

  function watchWorker(reg) {
    if (reg.waiting && nav.serviceWorker.controller) notifyUpdate();

    reg.addEventListener('updatefound', function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', function () {
        // No controller on first install means this is the initial precache,
        // not an update, and there is nothing to offer the user.
        if (installing.state === 'installed' && nav.serviceWorker.controller) notifyUpdate();
      });
    });
  }

  function register() {
    if (!supportsServiceWorker()) return Promise.resolve(null);
    if (!doc) return Promise.resolve(null);
    if (registration) return Promise.resolve(registration);

    var swUrl;
    var scope;
    try {
      swUrl = new URL('sw.js', doc.baseURI).href;
      scope = new URL('./', doc.baseURI).href;
    } catch (err) {
      reportError(err);
      return Promise.resolve(null);
    }

    // updateViaCache 'none' is the whole update story: without it the HTTP cache
    // is allowed to answer with an old sw.js and a new deploy never lands.
    return nav.serviceWorker.register(swUrl, { scope: scope, updateViaCache: 'none' })
      .then(function (reg) {
        registration = reg;
        watchWorker(reg);
        return reg;
      })
      .catch(function (err) {
        reportError(err);
        return null;
      });
  }

  function start() {
    if (!nav) return;

    if (supportsServiceWorker()) {
      nav.serviceWorker.addEventListener('controllerchange', function () {
        if (!reloadRequested) return;
        reloadRequested = false;
        global.location.reload();
      });
    }

    global.addEventListener('beforeinstallprompt', function (event) {
      // Chromium offers the prompt once per page load; the shell decides when
      // to surface it via canInstall()/install().
      event.preventDefault();
      deferredPrompt = event;
    });

    global.addEventListener('appinstalled', function () {
      deferredPrompt = null;
    });

    global.addEventListener('offline', function () {
      toast('You are offline. Your resume still saves in this browser.', { tone: 'warn' });
    });

    global.addEventListener('online', function () {
      checkForUpdate();
      toast('Back online.', { tone: 'info' });
    });

    onUpdate(function () {
      toast('A new version is ready.', {
        tone: 'info',
        duration: 0,
        action: {
          label: 'Reload',
          onClick: function () { applyUpdate(); }
        }
      });
    });

    register();
  }

  RB.pwa = {
    register: register,
    status: status,
    isOffline: isOffline,
    checkForUpdate: checkForUpdate,
    applyUpdate: applyUpdate,
    onUpdate: onUpdate,
    canInstall: canInstall,
    install: install
  };

  if (doc) start();
})(window);
