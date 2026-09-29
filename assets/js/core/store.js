/* Resumeboard — the single write path
 *
 * Every mutation in the app goes through store.update(). That gives us, for
 * free: persistence, undo/redo, template-change reflow protection, and a
 * single place to emit "something changed" so no view can drift.
 *
 * Nothing outside this file writes to `resume` directly.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var bus = global.RB.bus;
  var idb = global.RB.idb;
  var model = global.RB.model;

  var KEY = 'resume:current';
  var UNDO_KEY = 'resume:undo';

  var state = null;
  var undoStack = [];
  var redoStack = [];
  var MAX_HISTORY = 100;
  var saveTimer = null;
  var ready = false;
  var readyResolve;
  var readyPromise = new Promise(function (res) { readyResolve = res; });

  function load() {
    return idb.get(KEY).then(function (stored) {
      if (stored && typeof stored === 'object') {
        var result = model.validate(model.migrate(stored));
        state = result.resume;
      } else {
        state = model.emptyResume();
      }
      return idb.get(UNDO_KEY).then(function (h) {
        if (Array.isArray(h)) {
          undoStack = h.slice(-MAX_HISTORY).filter(function (s) { return s && typeof s === 'object' && !model.isBlankResume(s); });
        }
      }).catch(function () {});
    }).catch(function (err) {
      /* The only way here is validate() or migrate() throwing on a record that
       * was already read back — so state is about to become an empty resume
       * that the next write persists over the user's real one. */
      reportStorage('read back your saved resume', err);
      state = state || model.emptyResume();
    }).then(function () {
      ready = true;
      readyResolve(state);
      return state;
    });
  }

  function get() { return state; }

  function isReady() { return ready; }
  function whenReady() { return readyPromise; }

  /* Coalesce rapid keystrokes into one undo entry. */
  var lastCoalesceKey = null;
  var lastCoalesceAt = 0;

  function update(mutator, opts) {
    opts = opts || {};
    /* Editing means the document is wanted again. */
    transient = false;

    var now = Date.now();
    var coalesce = opts.coalesce !== false && opts.coalesceKey === lastCoalesceKey && (now - lastCoalesceAt) < 900;

    /* The undo snapshot is a full deep clone, and a coalesced keystroke throws
     * it away. Clone only when the entry is actually going on the stack —
     * otherwise every character typed runs two clones where one would do. */
    var before = coalesce ? null : model.deepClone(state);
    var draft = model.deepClone(state);
    var result = mutator(draft);
    if (result === false) return state; // mutator bailed out

    var validated = model.validate(draft);
    if (!validated.ok && opts.strict) {
      console.warn('[store] validation failed, write rejected', validated.errors);
      return state;
    }
    draft = validated.resume;
    draft.meta.updatedAt = new Date().toISOString();
    state = draft;

    if (!coalesce) {
      undoStack.push(before);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    }
    lastCoalesceKey = opts.coalesceKey || null;
    lastCoalesceAt = now;

    persist();
    bus.emit('change', { state: state, source: opts.source || 'update', options: opts });
    return state;
  }

  /* Undo entries store coalesce metadata so a redo collapses the same way. */
  function undo() {
    if (!undoStack.length) return false;
    var previous = undoStack.pop();
    redoStack.push(model.deepClone(state));
    state = model.validate(model.migrate(previous)).resume;
    lastCoalesceKey = null;
    persist();
    bus.emit('change', { state: state, source: 'undo' });
    U.announce('Undid last change');
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    var next = redoStack.pop();
    undoStack.push(model.deepClone(state));
    state = model.validate(model.migrate(next)).resume;
    lastCoalesceKey = null;
    persist();
    bus.emit('change', { state: state, source: 'redo' });
    U.announce('Redid change');
    return true;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  var transient = false;

  /* idb.set() resolves false rather than rejecting when IndexedDB is
   * unavailable and localStorage is full or blocked, so a resume the browser
   * refused to keep used to disappear with nothing said. Once a session is
   * enough: the user needs to export, not to be told again every 400ms. */
  var storageWarned = false;

  /* History is a convenience, not the document, and it is a whole resume per
   * entry. A 1 MB photo is in every snapshot, so the 40 the store keeps cost
   * 40 MB — serialised and written on the same 400ms beat as the resume
   * itself, on every pause in typing. It gets its own slower beat and a byte
   * budget: the newest entries are the ones anyone undoes back to. */
  var UNDO_PERSIST_MS = 2500;
  var UNDO_PERSIST_BYTES = 2 * 1024 * 1024;
  var UNDO_PERSIST_MAX = 40;
  var undoTimer = null;

  function undoSnapshot() {
    var keep = undoStack.slice(-UNDO_PERSIST_MAX);
    var bytes = 0;
    for (var i = keep.length - 1; i >= 0; i--) {
      try { bytes += JSON.stringify(keep[i]).length; }
      catch (e) { continue; }
      /* Drop the oldest until the rest fits — but never drop the newest one.
       * A resume with a photo in it is over the budget on its own, and
       * slicing back from the last index would leave nothing at all. */
      if (bytes > UNDO_PERSIST_BYTES) { keep = keep.slice(Math.min(i + 1, keep.length - 1)); break; }
    }
    return keep;
  }

  function persistUndo() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    return idb.set(UNDO_KEY, undoSnapshot()).catch(function () {});
  }

  function scheduleUndoPersist() {
    if (transient) return;
    if (undoTimer) return;
    undoTimer = setTimeout(function () {
      undoTimer = null;
      persistUndo();
    }, UNDO_PERSIST_MS);
  }

  function reportStorage(what, err) {
    if (global.console && global.console.error) global.console.error('[store] could not ' + what, err || null);
    if (storageWarned) return;
    storageWarned = true;
    var ui = global.RB && global.RB.ui;
    if (ui && typeof ui.toast === 'function') {
      ui.toast('This browser would not save your resume. Export a copy now — closing the tab will lose it.', { tone: 'error' });
    }
  }

  function persist() {
    if (transient) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      idb.set(KEY, state).then(function (ok) {
        if (ok === false) reportStorage('save your resume');
      }, function (err) {
        reportStorage('save your resume', err);
      });
      scheduleUndoPersist();
    }, 400);
  }

  function persistNow() {
    if (transient && !arguments.length) return Promise.resolve(false);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return idb.set(KEY, state).then(function (ok) {
      if (ok === false) reportStorage('save your resume');
      return ok;
    }, function (err) {
      reportStorage('save your resume', err);
      return false;
    }).then(function (ok) {
      /* The resume is saved either way. A history write that fails must not
       * reject a promise the app uses to decide it may navigate — every
       * caller chains .then() with no .catch(). */
      return persistUndo().then(function () { return ok; });
    });
  }

  function replace(next, opts) {
    opts = opts || {};
    var validated = model.validate(model.migrate(next));
    if (!opts.noHistory) {
      undoStack.push(model.deepClone(state));
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    }
    state = validated.resume;
    state.meta.updatedAt = new Date().toISOString();
    lastCoalesceKey = null;
    persist();
    bus.emit('change', { state: state, source: opts.source || 'replace' });
    return state;
  }

  function reset(opts) {
    transient = !(opts && opts.persist);
    return replace(model.emptyResume(), Object.assign({ source: 'reset' }, opts));
  }

  function loadSample() {
    return replace(model.sampleResume(), { source: 'sample' });
  }

  /* Patch a dot-path field. The one call site the inline binder uses. */
  function setField(path, value, opts) {
    return update(function (draft) {
      model.setPath(draft, path, value);
    }, Object.assign({ source: 'field', coalesceKey: path }, opts));
  }

  function getField(path) { return model.getPath(state, path); }

  global.RB = global.RB || {};
  global.RB.store = {
    load: load,
    get: get,
    isReady: isReady,
    whenReady: whenReady,
    update: update,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    replace: replace,
    reset: reset,
    loadSample: loadSample,
    setField: setField,
    getField: getField,
    persistNow: persistNow,
    KEY: KEY
  };
})(window);
