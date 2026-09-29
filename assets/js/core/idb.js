/* Resumeboard — persistence layer
 * IndexedDB with a localStorage fallback. No dependencies, promise-based.
 * Every read/write is wrapped: a corrupt record must never brick a resume.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'resumeboard';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var LS_PREFIX = 'rb:';

  var dbPromise = null;
  var memoryFallback = Object.create(null);
  var useFallback = false;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        useFallback = true;
        return resolve(null);
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        useFallback = true;
        return resolve(null);
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { useFallback = true; resolve(null); };
      req.onblocked = function () { useFallback = true; resolve(null); };
    });
    return dbPromise;
  }

  function lsGet(key) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch (err) {
      return memoryFallback[key];
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (err) {
      memoryFallback[key] = value;
      return false;
    }
  }

  function get(key) {
    return openDB().then(function (db) {
      if (!db) return lsGet(key);
      return new Promise(function (resolve) {
        var r;
        try {
          r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        } catch (err) {
          return resolve(lsGet(key));
        }
        r.onsuccess = function () { resolve(r.result === undefined ? lsGet(key) : r.result); };
        r.onerror = function () { resolve(lsGet(key)); };
      });
    }).catch(function () { return lsGet(key); });
  }

  function set(key, value) {
    memoryFallback[key] = value;
    return openDB().then(function (db) {
      if (!db) return lsSet(key, value);
      return new Promise(function (resolve) {
        var r;
        try {
          r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
        } catch (err) {
          return resolve(lsSet(key, value));
        }
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(lsSet(key, value)); };
      });
    }).catch(function () { return lsSet(key, value); });
  }

  function del(key) {
    delete memoryFallback[key];
    return openDB().then(function (db) {
      if (!db) {
        try { localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
        return true;
      }
      return new Promise(function (resolve) {
        var r;
        try {
          r = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
        } catch (err) { return resolve(false); }
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  function clearAll() {
    memoryFallback = Object.create(null);
    return openDB().then(function (db) {
      if (!db) {
        try {
          Object.keys(localStorage)
            .filter(function (k) { return k.indexOf(LS_PREFIX) === 0; })
            .forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {}
        return true;
      }
      return new Promise(function (resolve) {
        var r;
        try {
          r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        } catch (err) { return resolve(false); }
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  function persist() {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      return navigator.storage.persist().catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  global.RB = global.RB || {};
  global.RB.idb = {
    get: get,
    set: set,
    del: del,
    clear: clearAll,
    persist: persist,
    isFallback: function () { return useFallback; }
  };
})(window);
