/* Resumeboard — event bus
 * One write path, many subscribers. Synchronous by design: the editor must
 * never lag a keystroke behind a microtask.
 */
(function (global) {
  'use strict';

  var channels = Object.create(null);

  function on(name, fn) {
    if (!channels[name]) channels[name] = [];
    channels[name].push(fn);
    return function off() { return RB.bus.off(name, fn); };
  }

  function once(name, fn) {
    var dispose = on(name, function (payload) {
      dispose();
      fn(payload);
    });
    return dispose;
  }

  function off(name, fn) {
    var list = channels[name];
    if (!list) return false;
    if (!fn) { delete channels[name]; return true; }
    var i = list.indexOf(fn);
    if (i === -1) return false;
    list.splice(i, 1);
    if (!list.length) delete channels[name];
    return true;
  }

  function emit(name, payload) {
    var list = channels[name];
    if (list) {
      var copy = list.slice();
      for (var i = 0; i < copy.length; i++) {
        try { copy[i](payload); } catch (err) {
          if (global.console) console.error('[bus] handler failed for "' + name + '"', err);
        }
      }
    }
    var star = channels['*'];
    if (star) {
      var starCopy = star.slice();
      for (var j = 0; j < starCopy.length; j++) {
        /* Same treatment as a named subscriber: a debug hook that dies is a
         * bug, and a swallowed one is a bug nobody finds. */
        try { starCopy[j](name, payload); }
        catch (e) { if (global.console) console.error('[bus] handler failed for "' + name + '"', e); }
      }
    }
  }

  global.RB = global.RB || {};
  global.RB.bus = { on: on, off: off, once: once, emit: emit };
})(window);
