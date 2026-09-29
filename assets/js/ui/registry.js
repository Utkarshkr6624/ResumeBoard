/* Resumeboard — module registries
 * Panels, the left rail, and the render lifecycle all self-register here so
 * script order in index.html is the only coupling between files.
 */
(function (global) {
  'use strict';

  var bus = global.RB.bus;

  var panelModules = [];
  var railModules = [];
  var lifecycleHooks = Object.create(null);
  var bootFns = [];

  function register(idOrDefinition, maybeDefinition) {
    /* Both call shapes exist in the codebase: register('edit', {...}) and
     * register({ id: 'edit', ... }). Normalize to one internal form. */
    var definition = typeof idOrDefinition === 'string' ? maybeDefinition : idOrDefinition;
    if (definition && typeof idOrDefinition === 'string') {
      definition = Object.assign({}, definition, { id: idOrDefinition });
    }
    if (!definition || !definition.id) return;
    definition.mount = definition.mount || function () {};
    var existing = panelModules.findIndex(function (p) { return p.id === definition.id; });
    if (existing !== -1) panelModules[existing] = definition;
    else panelModules.push(definition);
  }

  function panels() { return panelModules.slice(); }

  function setActive(id) { bus.emit('panel:active', { id: id }); }

  global.RB = global.RB || {};
  global.RB.rail = {
    register: function (def) { if (def) railModules.push(def); },
    modules: function () { return railModules.slice(); }
  };

  global.RB.panels = {
    register: register,
    all: panels,
    setActive: setActive
  };

  global.RB.lifecycle = {
    on: function (event, fn) {
      if (!lifecycleHooks[event]) lifecycleHooks[event] = [];
      lifecycleHooks[event].push(fn);
      return function () {
        var list = lifecycleHooks[event] || [];
        var i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      };
    },
    emit: function (event, payload) {
      (lifecycleHooks[event] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[lifecycle:' + event + ']', e); }
      });
    }
  };

  /* Anything that needs to run once the store is hydrated. */
  global.RB.onBoot = function (fn) { bootFns.push(fn); };
  global.RB.runBoot = function (state) {
    bootFns.forEach(function (fn) {
      try { fn(state); } catch (e) { console.error('[boot]', e); }
    });
  };
})(window);
