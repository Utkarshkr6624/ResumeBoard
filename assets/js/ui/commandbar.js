/* Resumeboard — command palette + global keyboard map
 *
 * The palette is a thin index over everything the app can do. It owns none of
 * it: panels come from RB.panels, sections from the store, and export / linter
 * / top-bar rows are contributed by whichever modules exist at open time. A
 * missing module yields an absent group, never a dead row.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var bus = global.RB.bus;
  var store = global.RB.store;
  var model = global.RB.model;
  var doc = global.document;
  var el = U.el;
  var icons = global.RB.icons;

  var RECENT_KEY = 'rb:commands:recents';
  var MAX_RECENT = 6;
  var MAX_RESULTS = 60;

  var GROUP_ORDER = ['Recent', 'Actions', 'Panels', 'Sections', 'Top bar', 'Export', 'Fixes', 'More'];

  var commands = [];
  var shortcuts = [];
  var recents = [];

  var view = null;        /* { backdrop, dialog, input, list } */
  var state = { open: false, query: '', mode: 'all', items: [], activeId: '', lastFocused: null };

  /* ---------------- Styling ----------------
   * This module owns no stylesheet, so it ships its own rules once, built
   * entirely from tokens. Scoped under .rb-cmd / .rb-keys so nothing leaks. */
  var CSS = [
    '.rb-cmd-backdrop{position:fixed;inset:0;z-index:var(--rb-z-modal);display:flex;',
    'justify-content:center;align-items:flex-start;padding:10vh var(--rb-space-4) var(--rb-space-4);',
    'background:color-mix(in srgb, var(--rb-gray-900) 45%, transparent);',
    'backdrop-filter:blur(2px);animation:rb-fade var(--rb-dur-base) var(--rb-ease-out)}',
    '.rb-cmd{width:min(640px,100%);max-height:min(72vh,640px);display:flex;flex-direction:column;',
    'background:var(--rb-bg-elevated);border:1px solid var(--rb-border);border-radius:var(--rb-radius-xl);',
    'box-shadow:var(--rb-shadow-xl);overflow:hidden;animation:rb-pop var(--rb-dur-base) var(--rb-ease-out)}',
    '.rb-cmd__search{display:flex;align-items:center;gap:var(--rb-space-2);padding:var(--rb-space-3);',
    'border-bottom:1px solid var(--rb-border-subtle)}',
    '.rb-cmd__icon{display:flex;color:var(--rb-text-faint)}',
    '.rb-cmd__input{flex:1;min-width:0;background:transparent;border-color:transparent;height:34px;font-size:var(--rb-text-lg)}',
    '.rb-cmd__input:hover{border-color:transparent}',
    '.rb-cmd__input:focus{border-color:transparent;',
    'box-shadow:0 0 0 2px color-mix(in srgb, var(--rb-accent-500) 38%, transparent)}',
    '.rb-cmd__list{padding:var(--rb-space-2);flex:1;min-height:0}',
    '.rb-cmd__group{padding:var(--rb-space-3) var(--rb-space-2) var(--rb-space-1);font-size:var(--rb-text-2xs);',
    'font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--rb-text-faint)}',
    '.rb-cmd__opt{display:flex;align-items:center;gap:var(--rb-space-3);width:100%;padding:var(--rb-space-2) var(--rb-space-3);',
    'border-radius:var(--rb-radius-sm);text-align:left;color:var(--rb-text);cursor:pointer;',
    'scroll-margin:var(--rb-space-2)}',
    '.rb-cmd__opt .rb-i{color:var(--rb-text-muted)}',
    '.rb-cmd__opt[aria-selected="true"]{background:var(--rb-bg-active)}',
    '.rb-cmd__opt[aria-selected="true"] .rb-i{color:var(--rb-text-accent)}',
    '.rb-cmd__title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rb-cmd__title mark{background:transparent;color:var(--rb-text-accent);font-weight:650}',
    '.rb-cmd__hint{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:var(--rb-text-xs);color:var(--rb-text-muted)}',
    '.rb-cmd__empty{padding:var(--rb-space-8) var(--rb-space-4);text-align:center;color:var(--rb-text-muted)}',
    '.rb-cmd__empty-title{font-size:var(--rb-text-md);font-weight:600;color:var(--rb-text);margin-bottom:var(--rb-space-1)}',
    '.rb-cmd__foot{display:flex;align-items:center;gap:var(--rb-space-4);flex-wrap:wrap;',
    'padding:var(--rb-space-2) var(--rb-space-4);border-top:1px solid var(--rb-border-subtle);',
    'background:var(--rb-bg-inset);font-size:var(--rb-text-xs);color:var(--rb-text-muted)}',
    '.rb-cmd__foot b{color:var(--rb-text-secondary);font-weight:600}',
    '.rb-cmd__k{display:inline-flex;align-items:center;gap:var(--rb-space-1)}',
    '.rb-keys{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:0 var(--rb-space-6);align-items:center}',
    '.rb-keys__head{font-size:var(--rb-text-2xs);font-weight:700;text-transform:uppercase;',
    'letter-spacing:.06em;color:var(--rb-text-faint);padding-bottom:var(--rb-space-2)}',
    '.rb-keys__label{border-top:1px solid var(--rb-border-subtle);padding:var(--rb-space-2) 0;font-size:var(--rb-text-base)}',
    '.rb-keys__cell{border-top:1px solid var(--rb-border-subtle);padding:var(--rb-space-2) 0}'
  ].join('');

  function installStyle() {
    if (doc.getElementById('rb-commandbar-style')) return;
    var style = el('style', { id: 'rb-commandbar-style' });
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* ---------------- Fuzzy subsequence matching ---------------- */

  var SEP = /[\s\-_/.,:;()[\]+&]/;

  function boundaryAt(text, i) {
    if (i === 0) return 2;
    return SEP.test(text.charAt(i - 1)) ? 1 : 0;
  }

  /* Returns { score, ranges } or null. The score is a rank, not a percentage:
   * an exact substring always outranks a scattered subsequence. */
  function fuzzy(query, text) {
    if (!query) return { score: 0, ranges: [] };
    var q = query.toLowerCase();
    var t = text.toLowerCase();

    var at = t.indexOf(q);
    if (at !== -1) {
      return {
        score: 1200 - at * 3 + boundaryAt(t, at) * 60 - Math.min(280, (t.length - q.length) * 0.5),
        ranges: [[at, at + q.length - 1]]
      };
    }

    var score = 100;
    var ranges = [];
    var ti = 0, prev = -2;
    for (var qi = 0; qi < q.length; qi++) {
      var ch = q.charAt(qi);
      var found = -1;
      while (ti < t.length) {
        if (t.charAt(ti) === ch) { found = ti; break; }
        ti++;
      }
      if (found === -1) return null;
      score += 20 + boundaryAt(t, found) * 30;
      if (found === prev + 1) {
        score += 40;
        if (ranges.length) ranges[ranges.length - 1][1] = found;
        else ranges.push([found, found]);
      } else {
        if (found - prev > 8) score -= 15;
        ranges.push([found, found]);
      }
      prev = found;
      ti = found + 1;
    }
    return { score: score - Math.min(120, (t.length - q.length) * 0.25), ranges: ranges };
  }

  /* ---------------- Key bindings ---------------- */

  var KEY_LABELS = {
    arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→',
    enter: '↵', escape: 'Esc', backspace: 'Backspace', tab: 'Tab', space: 'Space',
    backslash: '\\', del: 'Del'
  };

  function parseBinding(combo) {
    var parts = String(combo).toLowerCase().split('+');
    var key = parts.pop();
    var b = { key: key, mod: false, meta: false, ctrl: false, shift: false, alt: false };
    parts.forEach(function (p) {
      if (p === 'mod') b.mod = true;
      else if (p === 'cmd' || p === 'meta' || p === 'command') b.meta = true;
      else if (p === 'ctrl' || p === 'control') b.ctrl = true;
      else if (p === 'shift') b.shift = true;
      else if (p === 'alt' || p === 'opt' || p === 'option') b.alt = true;
    });
    if (b.key === 'shift') b.shift = false;
    return b;
  }

  function resolveMods(binding) {
    var mac = U.isMac();
    return {
      meta: binding.meta || (binding.mod && mac),
      ctrl: binding.ctrl || (binding.mod && !mac),
      shift: binding.shift,
      alt: binding.alt
    };
  }

  /* U.hotkey compares shift strictly, which would leave "?" unmatchable — the
   * character only exists as shift+/ — so that one key is special-cased. */
  function matchBinding(binding, event) {
    if (binding.key === '?') {
      if (event.key !== '?') return false;
      var m = resolveMods(binding);
      return !!event.metaKey === m.meta && !!event.ctrlKey === m.ctrl && !!event.altKey === m.alt;
    }
    return U.hotkey(event, binding.key, resolveMods(binding));
  }

  function keyLabel(key, platform) {
    var lower = String(key).toLowerCase();
    if (platform === 'mac' && KEY_LABELS[lower]) return KEY_LABELS[lower];
    if (KEY_LABELS[lower]) return KEY_LABELS[lower];
    return key.length === 1 ? key.toUpperCase() : U.titleCase(key);
  }

  function formatBinding(binding, platform) {
    var mac = platform === 'mac';
    var mods = resolveMods(binding);
    var out = [];
    if (mods.ctrl) out.push(mac ? '⌃' : 'Ctrl');
    if (mods.alt) out.push(mac ? '⌥' : 'Alt');
    if (mods.shift) out.push(mac ? '⇧' : 'Shift');
    if (mods.meta) out.push('⌘');
    out.push(keyLabel(binding.key, platform));
    return out.join(mac ? '' : '+');
  }

  function formatCombo(combo, platform) {
    return formatBinding(parseBinding(combo), platform || (U.isMac() ? 'mac' : 'win'));
  }

  function combinationsFor(shortcutEntry) {
    var mac = [], win = [];
    shortcutEntry.bindings.forEach(function (b) {
      var a = formatBinding(b, 'mac');
      var w = formatBinding(b, 'win');
      if (mac.indexOf(a) === -1) mac.push(a);
      if (win.indexOf(w) === -1) win.push(w);
    });
    return { mac: mac, win: win };
  }

  /* ---------------- Shortcut registry ---------------- */

  function registerShortcut(def) {
    if (!def || !def.id || typeof def.run !== 'function') return null;
    unregisterShortcut(def.id);
    var keys = def.keys || (def.shortcut ? [def.shortcut] : []);
    var entry = {
      id: def.id,
      label: def.label || def.title || def.id,
      group: def.group || 'Global',
      run: def.run,
      bindings: keys.map(parseBinding)
    };
    shortcuts.push(entry);
    return entry;
  }

  function unregisterShortcut(id) {
    for (var i = shortcuts.length - 1; i >= 0; i--) {
      if (shortcuts[i].id === id) { shortcuts.splice(i, 1); return true; }
    }
    return false;
  }

  function getShortcut(id) {
    return shortcuts.filter(function (s) { return s.id === id; })[0] || null;
  }

  /* Also reports which binding fired, so the key handler can tell an explicit
     chord from a bare character. */
  function matchEntry(event) {
    for (var i = 0; i < shortcuts.length; i++) {
      var sc = shortcuts[i];
      for (var b = 0; b < sc.bindings.length; b++) {
        if (matchBinding(sc.bindings[b], event)) return { entry: sc, binding: sc.bindings[b] };
      }
    }
    return null;
  }

  function matchShortcut(event) {
    var hit = matchEntry(event);
    return hit ? hit.entry : null;
  }

  function bindingIsChord(binding) {
    var m = resolveMods(binding);
    return !!(m.ctrl || m.meta || m.alt);
  }

  /* ---------------- Command registry ---------------- */

  function normalizeCommand(def, groupFallback) {
    if (!def || !def.title) return null;
    return {
      id: def.id || ('cmd:' + def.title + ':' + commands.length),
      title: def.title,
      group: def.group || groupFallback || 'More',
      icon: def.icon || 'chevron-right',
      hint: def.hint || '',
      keywords: def.keywords || '',
      shortcut: def.shortcut || '',
      when: def.when || null,
      run: def.run
    };
  }

  function registerCommand(def) {
    var cmd = normalizeCommand(def, 'More');
    if (!cmd || typeof cmd.run !== 'function') return null;
    var existing = commands.map(function (c) { return c.id; }).indexOf(cmd.id);
    if (existing !== -1) commands.splice(existing, 1, cmd);
    else commands.push(cmd);
    var keys = Array.isArray(def.shortcut) ? def.shortcut : (def.shortcut ? [def.shortcut] : []);
    if (keys.length) {
      registerShortcut({ id: 'cmd:' + cmd.id, label: cmd.title, group: 'Commands', keys: keys, run: cmd.run });
    }
    return cmd;
  }

  function unregisterCommand(id) {
    for (var i = commands.length - 1; i >= 0; i--) {
      if (commands[i].id === id) {
        commands.splice(i, 1);
        unregisterShortcut('cmd:' + id);
        return true;
      }
    }
    return false;
  }

  function getCommand(id) {
    return commands.filter(function (c) { return c.id === id; })[0] || null;
  }

  /* ---------------- Dynamic providers ----------------
   * A provider is a function returning command-shaped objects. Providers are
   * called at open time, so a module that registers late still shows up. */

  var providers = {
    panels: { group: 'Panels', fn: panelCommands },
    sections: { group: 'Sections', fn: sectionCommands },
    topbar: { group: 'Top bar', fn: emptyCommands },
    export: { group: 'Export', fn: exportCommands },
    fix: { group: 'Fixes', fn: fixCommands }
  };

  function emptyCommands() { return []; }

  function setProvider(name, fn) {
    if (!name || typeof fn !== 'function') return false;
    if (!providers[name]) providers[name] = { group: U.titleCase(name), fn: fn };
    else providers[name].fn = fn;
    return true;
  }

  function firstModule() {
    for (var i = 0; i < arguments.length; i++) {
      var mod = global.RB[arguments[i]];
      if (mod && typeof mod === 'object') return mod;
    }
    return null;
  }

  function callFirst(mod, names, arg) {
    for (var i = 0; i < names.length; i++) {
      if (typeof mod[names[i]] === 'function') return mod[names[i]](arg);
    }
    return undefined;
  }

  function panelCommands() {
    var host = global.RB.panels;
    var panels = host && typeof host.all === 'function' ? host.all() : [];
    return panels.filter(Boolean).map(function (p) {
      return {
        id: 'panel:' + p.id,
        title: p.title || p.label || p.id,
        icon: p.icon || 'panel',
        hint: 'Panel',
        keywords: 'panel open ' + (p.keywords || ''),
        run: function () {
          if (global.RB.panels && typeof global.RB.panels.setActive === 'function') global.RB.panels.setActive(p.id);
        }
      };
    });
  }

  function resume() {
    return (store && typeof store.get === 'function') ? store.get() : null;
  }

  function sectionCommands() {
    var r = resume();
    if (!r) return [];
    var sections = model.orderedSections(r);
    var out = sections.map(function (s) {
      var meta = model.typeMeta(s.type);
      return {
        id: 'section:' + s.id,
        title: s.label || meta.label,
        icon: meta.icon,
        hint: meta.label,
        keywords: 'section go to jump ' + s.type,
        run: function () { focusSection(s.id, s.type, s.label || meta.label); }
      };
    });

    var shown = {};
    sections.forEach(function (s) { if (s.visible !== false) shown[s.type] = true; });

    model.SECTION_TYPES.forEach(function (def) {
      if (def.type === 'custom') {
        out.push({
          id: 'section:add:custom',
          title: shown[def.type] ? 'Go to ' + def.label : 'Add ' + def.label,
          icon: def.icon,
          hint: 'Section',
          keywords: 'add new custom',
          run: shown[def.type]
            ? function () { var s = sections.filter(function (x) { return x.type === def.type; })[0]; if (s) focusSection(s.id, s.type, s.label); }
            : function () { addSection(def.type); }
        });
        return;
      }
      out.push({
        id: 'section:add:' + def.type,
        title: (shown[def.type] ? 'Go to ' : 'Add ') + def.label,
        icon: def.icon,
        hint: 'Section',
        keywords: 'add new ' + def.type,
        run: shown[def.type]
          ? function () { var s = sections.filter(function (x) { return x.type === def.type; })[0]; if (s) focusSection(s.id, s.type, s.label); }
          : function () { addSection(def.type); }
      });
    });
    return out;
  }

  function addSection(type) {
    var created = null;
    store.update(function (draft) {
      created = model.addSection(draft, type);
      if (!created) return false;
      model.normalizeOrders(draft);
    }, { source: 'update', coalesce: false });
    if (!created) {
      toast(model.typeMeta(type).label + ' could not be added.', 'warn');
      return false;
    }
    focusSection(created.id, created.type, created.label);
    toast(model.typeMeta(type).label + ' added.', 'success');
    return true;
  }

  function cssEscape(value) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(value);
    return String(value).replace(/(["\\\]\[])/g, '\\$1');
  }

  function focusSection(sectionId, type, label) {
    bus.emit('section:focus', { sectionId: sectionId, type: type });
    var id = cssEscape(sectionId);
    var candidates = ['[data-section-id="' + id + '"]', '[data-section="' + id + '"]', '#' + id];
    var node = null;
    for (var i = 0; i < candidates.length && !node; i++) node = doc.querySelector(candidates[i]);
    if (!node && type) node = doc.querySelector('[data-bind^="' + cssEscape(type) + '."]');
    if (node && typeof node.scrollIntoView === 'function') {
      try { node.scrollIntoView({ block: 'start', behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' }); }
      catch (e) { /* engines that reject the options object still scroll */ }
    }
    if (node && typeof node.focus === 'function' && node.tabIndex >= 0) {
      try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
    }
    U.announce('Jumped to ' + (label || type || 'section'));
  }

  /* Only formats the app actually writes, and only those whose writer is
   * registered. PDF is here rather than only as a separate command: it is a
   * first-class export, and the same catalogue drives the top-bar menu. */
  var EXPORT_FALLBACK = [
    { id: 'pdf', label: 'PDF', icon: 'printer', fn: 'preflightAndPrint', ext: 'pdf', keywords: 'pdf print' },
    { id: 'txt', label: 'Plain text', fn: 'txtDownload', ext: 'txt', keywords: 'txt plain' },
    { id: 'md', label: 'Markdown', fn: 'markdownDownload', ext: 'md', keywords: 'md markdown' },
    { id: 'json', label: 'JSON backup', fn: 'jsonDownload', ext: 'json', keywords: 'json data backup' },
    { id: 'docx', label: 'Word document', fn: 'docxDownload', ext: 'docx', keywords: 'word docx' }
  ];

  function exportCommands() {
    var mod = firstModule('export', 'exporter', 'exports', 'exporters');
    if (!mod) return [];
    /* RB.exporters.list() is the shared catalogue (see export/pdf.js). The
     * older `formats` spelling is kept for a module that ships one. */
    var list = typeof mod.list === 'function' ? mod.list()
      : (Array.isArray(mod.formats) ? mod.formats
        : (typeof mod.formats === 'function' ? mod.formats() : null));
    if (!Array.isArray(list) || !list.length) {
      list = EXPORT_FALLBACK.filter(function (f) { return typeof mod[f.fn] === 'function'; })
        .map(function (f) {
          return { id: f.id, label: f.label, icon: f.icon, ext: f.ext, keywords: f.keywords, download: f.fn };
        });
    }
    return list.filter(Boolean).map(function (f) {
      var id = f.id || f.format || (typeof f === 'string' ? f : String(f.label || '').toLowerCase());
      var label = typeof f === 'string' ? f : (f.label || f.name || id);
      var direct = (f && typeof f.run === 'function') ? f.run : null;
      return {
        id: 'export:' + id,
        title: 'Export ' + label,
        icon: (typeof f === 'object' && f.icon) || 'download',
        hint: (typeof f === 'object' && f.ext) ? '.' + f.ext : 'Export',
        keywords: 'export download save ' + ((typeof f === 'object' && f.keywords) || id),
        run: function () {
          if (direct) {
            try { direct(store && store.get ? store.get() : undefined); }
            catch (e) {
              if (global.console) console.error('[commands] export "' + id + '" failed', e);
              if (global.RB.ui && global.RB.ui.toast) global.RB.ui.toast('The ' + label + ' export failed. Try again from the export menu.', { tone: 'error' });
            }
            return;
          }
          runExport(mod, id, label, f && f.download);
        }
      };
    });
  }

  function runExport(mod, id, label, download) {
    var resume = global.RB && RB.store && RB.store.get ? RB.store.get() : undefined;
    try {
      /* The explicit download name wins: mod.txt is a renderer, not a writer,
         so resolving by id alone silently produces no file. */
      if (download && typeof mod[download] === 'function') { mod[download](resume); return; }
      if (typeof mod.run === 'function') { mod.run(id); return; }
      if (typeof mod[id] === 'function') { mod[id](resume); return; }
      if (typeof mod.download === 'function') { mod.download(id); return; }
      if (typeof mod.export === 'function') { mod.export(id); return; }
    } catch (e) {
      if (global.console) console.error('[commands] export "' + id + '" failed', e);
      toast('The ' + label + ' export failed. Try again from the export menu.', 'error');
      return;
    }
    toast(label + ' cannot be exported from here.', 'warn');
  }

  /* The linter owns fix execution; this only indexes what it reports. */
  function fixCommands() {
    var mod = firstModule('lint', 'linter', 'checks');
    if (!mod) return [];
    var list = null;
    var names = ['getFixes', 'fixes', 'availableFixes', 'listFixes'];
    for (var i = 0; i < names.length && !Array.isArray(list); i++) {
      if (typeof mod[names[i]] === 'function') list = mod[names[i]]();
      else if (Array.isArray(mod[names[i]])) list = mod[names[i]];
    }
    if (!Array.isArray(list)) return [];
    return list.filter(Boolean).map(function (f, index) {
      var run = f.run || f.apply || f.fix;
      return {
        id: 'fix:' + (f.id || f.fixId || index),
        title: f.title || f.label || f.message || 'Fix issue',
        icon: f.icon || 'wand',
        hint: f.detail || f.description || f.hint || 'Fix',
        keywords: 'fix lint issue ' + (f.keywords || ''),
        run: typeof run === 'function' ? function () { run(f); } : null
      };
    }).filter(function (c) { return !!c.run; });
  }

  /* ---------------- Collecting the index ---------------- */

  function enabled(cmd) {
    if (!cmd.when) return true;
    try { return !!cmd.when(); } catch (e) { return false; }
  }

  function collect() {
    var out = [];
    commands.forEach(function (c) { if (enabled(c)) out.push(c); });
    Object.keys(providers).forEach(function (name) {
      var p = providers[name];
      var list = null;
      try { list = p.fn(); } catch (e) {
        if (global.console) console.error('[commands] provider "' + name + '" failed', e);
        list = null;
      }
      if (!Array.isArray(list)) return;
      list.forEach(function (def) {
        var cmd = normalizeCommand(def, p.group);
        if (cmd && typeof cmd.run === 'function' && enabled(cmd)) out.push(cmd);
      });
    });
    return out;
  }

  function groupRank(group) {
    var i = GROUP_ORDER.indexOf(group);
    return i === -1 ? GROUP_ORDER.length : i;
  }

  function search(list, query, mode) {
    var recentIds = recents.map(function (r) { return r.id; });
    var seen = Object.create(null);
    var out = [];

    list.forEach(function (cmd) {
      if (mode === 'section' && cmd.group !== 'Sections') return;
      if (mode === 'export' && cmd.group !== 'Export') return;
      if (mode === 'fix' && cmd.group !== 'Fixes') return;
      if (seen[cmd.id]) return;

      var title = fuzzy(query, cmd.title);
      if (query && !title && cmd.keywords) title = fuzzy(query, cmd.keywords);
      if (query && !title) return;
      seen[cmd.id] = true;

      var recency = recentIds.indexOf(cmd.id);
      var score = title ? title.score : 0;
      if (recency !== -1) score += 260 - recency * 24;
      out.push({
        cmd: cmd,
        score: score,
        ranges: title ? title.ranges : [],
        recent: recency
      });
    });

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.cmd.group !== b.cmd.group) return groupRank(a.cmd.group) - groupRank(b.cmd.group);
      return a.cmd.title.localeCompare(b.cmd.title);
    });
    return out.slice(0, MAX_RESULTS);
  }

  /* ---------------- Recents ---------------- */

  function loadRecents() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(RECENT_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      recents = Array.isArray(parsed)
        ? parsed.filter(function (r) { return r && r.id && r.title; }).slice(0, MAX_RECENT)
        : [];
    } catch (e) { recents = []; }
  }

  function saveRecents() {
    try {
      if (global.localStorage) global.localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (e) { /* private mode: recents simply do not persist */ }
  }

  function pushRecent(cmd) {
    if (!cmd) return;
    recents = [{ id: cmd.id, title: cmd.title, group: cmd.group, icon: cmd.icon }]
      .concat(recents.filter(function (r) { return r.id !== cmd.id; }))
      .slice(0, MAX_RECENT);
    saveRecents();
  }

  function clearRecents() {
    recents = [];
    saveRecents();
  }

  /* ---------------- Palette ---------------- */

  function ensureView() {
    if (view) return view;
    installStyle();

    var input = el('input', {
      class: 'rb-input rb-cmd__input',
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'rb-cmd-list',
      'aria-autocomplete': 'list',
      'aria-label': 'Search commands, sections, exports and fixes',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'Search commands, sections and fixes'
    });

    var closeBtn = el('button', {
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm rb-tip',
      type: 'button',
      'aria-label': 'Close command palette',
      'data-tip': 'Close (Esc)',
      html: icons.svg('x', { size: 'sm' })
    });

    var searchRow = el('div', { class: 'rb-cmd__search' }, [
      el('span', { class: 'rb-cmd__icon', html: icons.svg('search') }),
      input,
      closeBtn
    ]);

    var list = el('div', {
      class: 'rb-cmd__list rb-scroll',
      id: 'rb-cmd-list',
      role: 'listbox',
      'aria-label': 'Commands'
    });

    var helpBtn = el('button', {
      class: 'rb-btn rb-btn--ghost rb-btn--sm',
      type: 'button',
      text: 'Keyboard shortcuts'
    });

    var foot = el('div', { class: 'rb-cmd__foot' }, [
      el('span', { class: 'rb-cmd__k' }, [el('span', { class: 'rb-kbd', text: '↑' }), el('span', { class: 'rb-kbd', text: '↓' }), el('b', { text: 'navigate' })]),
      el('span', { class: 'rb-cmd__k' }, [el('span', { class: 'rb-kbd', text: '↵' }), el('b', { text: 'run' })]),
      el('span', { class: 'rb-cmd__k' }, [el('span', { class: 'rb-kbd', text: 'Esc' }), el('b', { text: 'close' })]),
      el('span', { class: 'rb-spacer' }),
      helpBtn
    ]);

    var dialog = el('div', { class: 'rb-cmd', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, [searchRow, list, foot]);
    var backdrop = el('div', { class: 'rb-cmd-backdrop' }, [dialog]);

    closeBtn.addEventListener('click', function () { closePalette(); });
    helpBtn.addEventListener('click', function () { closePalette(); openHelp(); });
    backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === backdrop) closePalette();
    });

    /* Scoring is not a keystroke-latency problem, but it must never run in the
     * input handler itself — that path is shared with inline resume editing. */
    var schedule = U.debounce(function () { U.requestIdle(function () { render(); }); }, 50);

    input.addEventListener('input', function () {
      state.query = input.value;
      schedule();
    });

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (ev.key === 'Home') { ev.preventDefault(); selectId(state.items.length ? state.items[0].cmd.id : ''); }
      else if (ev.key === 'End') { ev.preventDefault(); selectId(lastItemId()); }
      else if (ev.key === 'Enter') { ev.preventDefault(); runActive(); }
      else if (U.hotkey(ev, 'k', resolveMods(parseBinding('mod+k')))) { ev.preventDefault(); closePalette(); }
    });

    /* Tab and Escape belong to the dialog, not to the search box. Trapping
     * only from the input let focus walk out through the Close button, the
     * option list and the help link and out into the page behind — which then
     * made Escape, still bound to the input, do nothing from there. */
    dialog.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab') { U.trapFocus(dialog, ev); return; }
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      closePalette();
    });

    view = { backdrop: backdrop, dialog: dialog, input: input, list: list };
    return view;
  }

  function lastItemId() {
    return state.items.length ? state.items[state.items.length - 1].cmd.id : '';
  }

  function optionNode(entry, index) {
    var cmd = entry.cmd;
    var title = el('span', { class: 'rb-cmd__title' });
    highlightInto(title, cmd.title, entry.ranges);

    var node = el('div', {
      class: 'rb-cmd__opt',
      role: 'option',
      id: 'rb-cmd-opt-' + index,
      'aria-selected': 'false',
      'data-cmd-id': cmd.id
    }, [icons.el(cmd.icon || 'chevron-right', { size: 'sm' }), title]);

    if (cmd.shortcut) node.appendChild(el('span', { class: 'rb-kbd', text: formatCombo(cmd.shortcut) }));
    else if (cmd.hint) node.appendChild(el('span', { class: 'rb-cmd__hint', text: cmd.hint }));

    node.addEventListener('mousemove', function () { selectId(cmd.id); });
    node.addEventListener('click', function () { runCommand(entry); });
    return node;
  }

  function highlightInto(node, text, ranges) {
    if (!ranges || !ranges.length) { node.textContent = text; return; }
    var pos = 0;
    ranges.forEach(function (r) {
      if (r[0] > pos) node.appendChild(doc.createTextNode(text.slice(pos, r[0])));
      node.appendChild(el('mark', { text: text.slice(r[0], r[1] + 1) }));
      pos = r[1] + 1;
    });
    if (pos < text.length) node.appendChild(doc.createTextNode(text.slice(pos)));
  }

  function selectId(id) {
    var nodes = U.qsa('.rb-cmd__opt', view.list);
    var target = -1;
    for (var i = 0; i < nodes.length; i++) {
      var on = nodes[i].getAttribute('data-cmd-id') === id;
      nodes[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) target = i;
    }
    if (target === -1) {
      view.input.removeAttribute('aria-activedescendant');
      return;
    }
    state.activeId = id;
    view.input.setAttribute('aria-activedescendant', nodes[target].id);
    try { nodes[target].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
  }

  function move(delta) {
    if (!state.items.length) return;
    var i = state.items.map(function (e) { return e.cmd.id; }).indexOf(state.activeId);
    var next = i === -1 ? 0 : U.clamp(i + delta, 0, state.items.length - 1);
    selectId(state.items[next].cmd.id);
  }

  function runActive() {
    var entry = state.items.filter(function (e) { return e.cmd.id === state.activeId; })[0] || state.items[0];
    if (entry) runCommand(entry);
  }

  function runCommand(entry) {
    var cmd = entry.cmd;
    closePalette();
    pushRecent(cmd);
    try { cmd.run(); }
    catch (e) {
      if (global.console) console.error('[commands] "' + cmd.title + '" failed', e);
      toast('“' + cmd.title + '” could not run. Try it from the panel instead.', 'error');
    }
  }

  function render() {
    if (!view) return;
    var query = state.query.trim();
    state.items = search(collect(), query, state.mode);
    view.list.textContent = '';

    if (!state.items.length) {
      view.input.removeAttribute('aria-activedescendant');
      state.activeId = '';
      view.list.appendChild(el('div', { class: 'rb-cmd__empty' }, [
        el('p', { class: 'rb-cmd__empty-title', text: query ? 'No matches' : 'Nothing to show' }),
        el('p', {
          text: query
            ? 'Nothing matches “' + query + '”. Try a section name, or press ' + formatCombo('?') + ' for the shortcut list.'
            : 'Load the sample resume, or add a section from the left rail.'
        })
      ]));
      return;
    }

    var recent = state.items.filter(function (e) { return e.recent !== -1; });
    var buckets = [];
    function push(group, entry) {
      var b = buckets.filter(function (x) { return x.group === group; })[0];
      if (!b) { b = { group: group, entries: [] }; buckets.push(b); }
      b.entries.push(entry);
    }
    state.items.forEach(function (entry) {
      if (entry.recent !== -1) { push('Recent', entry); return; }
      push(entry.cmd.group === 'Recent' ? 'More' : entry.cmd.group, entry);
    });
    buckets.sort(function (a, b) {
      if (a.group === b.group) return 0;
      return groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group);
    });

    var index = 0;
    buckets.forEach(function (bucket) {
      if (bucket.group !== 'Recent' && !bucket.entries.length) return;
      var label = el('div', { class: 'rb-cmd__group', role: 'presentation', text: bucket.group });
      view.list.appendChild(label);
      bucket.entries.forEach(function (entry) {
        view.list.appendChild(optionNode(entry, index));
        index++;
      });
    });

    /* Keep the highlighted row stable while the user keeps typing. */
    var keep = state.items.map(function (e) { return e.cmd.id; }).indexOf(state.activeId) === -1
      ? (recent.length ? recent[0].cmd.id : state.items[0].cmd.id)
      : state.activeId;
    selectId(keep);
  }

  /* ---------------- Open / close ---------------- */

  var MODE_PLACEHOLDER = {
    all: 'Search commands, sections and fixes',
    section: 'Add or go to a section',
    export: 'Choose an export format',
    fix: 'Choose a fix'
  };

  function openPalette(opts) {
    opts = opts || {};
    var v = ensureView();
    state.lastFocused = doc.activeElement;
    state.open = true;
    state.mode = MODE_PLACEHOLDER[opts.mode] ? opts.mode : 'all';
    state.query = opts.query || '';
    state.activeId = '';
    v.input.value = state.query;
    v.input.placeholder = MODE_PLACEHOLDER[state.mode];
    v.backdrop.style.display = 'flex';
    render();
    v.input.focus();
    if (v.input.select) v.input.select();
    U.announce('Command palette opened. Type to search.');
  }

  function closePalette() {
    if (!view || !state.open) return;
    state.open = false;
    state.query = '';
    state.items = [];
    view.backdrop.style.display = 'none';
    view.input.value = '';
    var back = state.lastFocused;
    state.lastFocused = null;
    if (back && typeof back.focus === 'function' && doc.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
    }
    U.announce('Command palette closed.');
  }

  function togglePalette(opts) {
    if (state.open) closePalette();
    else openPalette(opts);
  }

  function isOpen() { return state.open; }

  function mount() {
    var v = ensureView();
    v.backdrop.style.display = 'none';
    if (!v.backdrop.isConnected) (doc.getElementById('rb-overlay-root') || doc.body).appendChild(v.backdrop);
  }

  /* ---------------- Actions behind the shortcuts ---------------- */

  function runUndo() {
    if (!store.canUndo()) {
      toast('Nothing to undo.', 'info');
      return;
    }
    store.undo();
  }

  function runRedo() {
    if (!store.canRedo()) {
      toast('Nothing to redo.', 'info');
      return;
    }
    store.redo();
  }

  function runSave() {
    Promise.resolve(store.persistNow()).then(function () {
      toast('Saved to this browser.', 'success');
    }).catch(function (e) {
      if (global.console) console.error('[commands] save failed', e);
      toast('Could not save. This browser may be blocking storage.', 'error');
    });
  }

  function runPrint() {
    if (typeof global.print !== 'function') {
      toast('Printing is not available here.', 'warn');
      return;
    }
    global.print();
  }

  function resumeToText(r) {
    if (!r) return '';
    var lines = [];
    var b = r.basics || {};
    if (b.name) lines.push(b.name);
    if (b.label) lines.push(b.label);
    var contact = [b.email, b.phone, b.url].filter(Boolean);
    if (contact.length) lines.push(contact.join('  ·  '));
    var where = [(b.location || {}).city, (b.location || {}).region, (b.location || {}).countryCode].filter(Boolean);
    if (where.length) lines.push(where.join(', '));
    if (b.summary) lines.push('', b.summary);

    model.orderedSections(r).forEach(function (s) {
      if (s.visible === false || s.type === 'summary') return;
      lines.push('', s.label || model.typeMeta(s.type).label, '');
      model.sectionEntries(r, s.type).forEach(function (entry) {
        var head = [
          entry.company, (entry.roles && entry.roles[0] && entry.roles[0].position) || entry.position,
          entry.institution, entry.name, entry.title, entry.label, entry.language,
          entry.role, entry.organization
        ].filter(Boolean).join(' — ');
        if (head) lines.push(head);
        var detail = [entry.studyType, entry.area, entry.fluency, entry.awarder, entry.issuer, entry.venue]
          .filter(Boolean).join(', ');
        if (detail) lines.push(detail);
        (entry.roles || []).slice(1).forEach(function (role) {
          if (role.position) lines.push('  · ' + role.position);
        });
        if (entry.summary) lines.push(entry.summary);
        (entry.highlights || []).forEach(function (h) { if (h) lines.push('  - ' + h); });
        (entry.keywords || []).forEach(function (k) { if (k) lines.push('  - ' + k); });
        (entry.courses || []).forEach(function (k) { if (k) lines.push('  - ' + k); });
        (entry.entries || []).forEach(function (x) {
          if (x.title) lines.push(x.title + (x.org ? ' — ' + x.org : ''));
          if (x.text) lines.push(x.text);
        });
        lines.push('');
      });
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* Prefers the real share surface the top-bar Share button opens, then a
     share module with a dialog of its own, then plain text so the command is
     never a no-op. RB.share is a codec and not a dialog, so probing it for an
     `open` always missed, and this quietly overwrote the clipboard with the
     whole resume while showing nothing at all. */
  function runShare() {
    var chrome = global.RB.chrome;
    if (chrome && typeof chrome.openShare === 'function') { chrome.openShare(); return; }
    var mod = firstModule('share', 'sharing', 'shareLink', 'shareSheet');
    if (mod && callFirst(mod, ['open', 'show', 'dialog', 'copyLink', 'start']) !== undefined) return;
    var exporter = firstModule('export', 'exporter');
    if (exporter && typeof exporter.run === 'function' && (exporter.formats || exporter.txt || exporter.text)) {
      runExport(exporter, 'txt', 'Plain text');
      return;
    }
    U.copyText(resumeToText(resume())).then(function () {
      toast('Copied your resume as plain text.', 'success');
    }).catch(function (e) {
      if (global.console) console.error('[commands] share copy failed', e);
      toast('Could not copy. Select the resume and copy it from there.', 'error');
    });
  }

  /* The panel shell owns the panel, collapsed state included. This used to set
   * a second, private state — html[data-rb-panel] plus `aside.hidden` — and
   * nothing cleared it afterwards, so once this command had hidden the panel
   * the panel's own expand control reported "expanded" while the panel stayed
   * at zero width and could not be brought back by anything but this command
   * again. One owner, one state. */
  function togglePanel(force) {
    var shell = global.RB.panel;
    if (shell && typeof shell.setCollapsed === 'function') {
      var open = !shell.isCollapsed();
      var next = typeof force === 'boolean' ? !force : !open;
      shell.setCollapsed(next);
      return open;
    }
    var root = doc.documentElement;
    if (!root) return false;
    var isOpen = root.getAttribute('data-rb-panel') !== 'closed';
    var want = typeof force === 'boolean' ? force : !isOpen;
    var aside = doc.getElementById('rb-panel');
    root.setAttribute('data-rb-panel', want ? 'open' : 'closed');
    if (aside) {
      if (!want && aside.contains(doc.activeElement)) {
        var main = doc.getElementById('rb-main');
        if (main && typeof main.focus === 'function') main.focus();
      }
      aside.hidden = !want;
    }
    U.announce(want ? 'Panel shown.' : 'Panel hidden.');
    return want;
  }

  function toggleTheme() {
    /* RB.chrome owns the theme: the data-theme attribute, the storage key, and
       the label the theme button announces. Setting the attribute from here
       left the button describing a mode the page was not in ("Theme: system"
       on a dark page) and wrote a second storage key the button never reads,
       so the choice was gone again on the next load. */
    var chrome = global.RB.chrome;
    if (chrome && typeof chrome.cycleTheme === 'function') { chrome.cycleTheme(); return; }
    var theme = firstModule('theme', 'appearance');
    if (theme && typeof theme.toggle === 'function') { theme.toggle(); return; }
    var root = doc.documentElement;
    var current = root.getAttribute('data-theme');
    if (!current) {
      current = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { if (global.localStorage) global.localStorage.setItem('rb:theme', next); } catch (e) { /* not persisted */ }
    U.announce(next === 'dark' ? 'Dark theme on.' : 'Light theme on.');
  }

  /* Only a search field counts here. A loose `#rb-topbar input` also matches
     the resume title, so "find text on the page" put the caret in the title
     box and the first thing typed renamed the resume. Anything that is not a
     declared search field falls through to the command palette below, which
     says so rather than silently hijacking another input. */
  var SEARCH_SELECTORS = [
    '[data-role="search"]', 'input[type="search"]', '#rb-search',
    '#rb-topbar [data-role="search"]', '#rb-toolstrip [data-role="search"]',
    '#rb-rail [data-role="search"]', '#rb-panel input[type="search"]',
    '#rb-panel [data-role="search"]'
  ];

  function focusSearch() {
    for (var i = 0; i < SEARCH_SELECTORS.length; i++) {
      var node = doc.querySelector(SEARCH_SELECTORS[i]);
      if (!node || node.disabled || node.type === 'hidden') continue;
      node.focus();
      if (typeof node.select === 'function') node.select();
      return true;
    }
    openPalette({});
    toast('No search field on this screen, so the command palette is open instead.', 'info');
    return false;
  }

  /* ---------------- Help overlay ---------------- */

  function kbdCombo(combo) {
    if (!combo) return el('span', { class: 'rb-hint', text: '—' });
    return el('span', { class: 'rb-row-tight' }, combo.split(' ').map(function (token) {
      return el('span', { class: 'rb-kbd', text: token });
    }));
  }

  function helpBody() {
    var grid = el('div', { class: 'rb-keys' }, [
      el('div', { class: 'rb-keys__head', text: 'Shortcut' }),
      el('div', { class: 'rb-keys__head', text: 'Mac' }),
      el('div', { class: 'rb-keys__head', text: 'Windows' })
    ]);

    shortcuts.slice().sort(function (a, b) {
      var g = groupRank(a.group) - groupRank(b.group);
      return g !== 0 ? g : a.label.localeCompare(b.label);
    }).forEach(function (sc) {
      if (!sc.bindings.length) return;
      var combos = combinationsFor(sc);
      grid.appendChild(el('div', { class: 'rb-keys__label', text: sc.label }));
      var rows = Math.max(combos.mac.length, combos.win.length);
      for (var i = 0; i < rows; i++) {
        grid.appendChild(el('div', { class: 'rb-keys__cell' }, [kbdCombo(combos.mac[i] || combos.mac[0])]));
        grid.appendChild(el('div', { class: 'rb-keys__cell' }, [kbdCombo(combos.win[i] || combos.win[0])]));
      }
    });

    return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
      el('p', { class: 'rb-hint', text: 'Shortcuts are ignored while you are typing in a field. Close this list with Esc or ' + formatCombo('?') + '.' }),
      grid
    ]);
  }

  function openHelp() {
    if (!global.RB.ui || typeof global.RB.ui.modal !== 'function') return null;
    return global.RB.ui.modal({
      title: 'Keyboard shortcuts',
      wide: true,
      body: helpBody(),
      actions: [{ label: 'Close', primary: true }]
    });
  }

  /* ---------------- Static commands + global shortcuts ---------------- */

  var ACTIONS = [
    { id: 'palette', title: 'Open command palette', icon: 'search', shortcut: 'mod+k', keywords: 'search find commands', run: function () { togglePalette(); } },
    { id: 'save', title: 'Save now', icon: 'save', shortcut: 'mod+s', keywords: 'persist store backup', run: runSave },
    { id: 'print', title: 'Print or save as PDF', icon: 'printer', shortcut: 'mod+p', keywords: 'pdf paper', run: runPrint },
    { id: 'share', title: 'Share or copy resume', icon: 'share', shortcut: 'mod+shift+s', keywords: 'link copy clipboard', run: runShare },
    { id: 'undo', title: 'Undo', icon: 'undo', shortcut: 'mod+z', keywords: 'revert back', when: function () { return store.canUndo(); }, run: runUndo },
    { id: 'redo', title: 'Redo', icon: 'redo', shortcut: ['mod+shift+z', 'mod+y'], keywords: 'again forward', when: function () { return store.canRedo(); }, run: runRedo },
    { id: 'addSection', title: 'Add a section', icon: 'plus', shortcut: 'mod+shift+n', keywords: 'new experience education skills', run: function () { openPalette({ mode: 'section' }); } },
    { id: 'togglePanel', title: 'Show or hide the panel', icon: 'panel', shortcut: 'mod+\\', keywords: 'sidebar dock collapse', run: function () { togglePanel(); } },
    { id: 'toggleTheme', title: 'Switch light or dark theme', icon: 'moon', shortcut: 'mod+shift+d', keywords: 'theme dark light appearance', run: toggleTheme },
    { id: 'focusSearch', title: 'Focus search', icon: 'search', shortcut: ['mod+f', '/'], keywords: 'find filter', run: focusSearch },
    { id: 'help', title: 'Keyboard shortcuts', icon: 'help', shortcut: '?', keywords: 'help keys', run: function () { openHelp(); } }
  ];

  function installActions() {
    ACTIONS.forEach(function (def) {
      registerCommand({
        id: def.id,
        title: def.title,
        group: 'Actions',
        icon: def.icon,
        keywords: def.keywords,
        shortcut: def.shortcut,
        when: def.when,
        run: def.run
      });
    });
  }

  function isTypingTarget(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    var tag = (node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  /* Every message this module raises goes through here. The toast helper lives
     on RB.ui, not on RB.utils, so the old `if (U.toast) U.toast(...)` guards
     were never true and every one of them — "Saved to this browser.", "Nothing
     to undo.", the export-failed notice, the command-failed notice — was
     dropped on the floor. A palette action that finishes in silence reads as
     a dead control. */
  function toast(message, tone) {
    if (global.RB && global.RB.ui && typeof global.RB.ui.toast === 'function') {
      global.RB.ui.toast(message, { tone: tone || 'info' });
    }
  }

  /* The resume is edited in place, so the field under the caret is a
   * contenteditable and looks like any other typing target. Leaving Ctrl+Z to
   * the browser there means one character per press, and the binder writes
   * each of those keystrokes back to the store as a new edit. A bound field
   * is ours, so the app takes the key and the browser never sees it. A real
   * <input> still keeps the browser's behaviour, where typing a "z" must not
   * undo the resume. */
  function isBoundField(node) {
    return !!(node && node.nodeType === 1 && node.isContentEditable &&
      typeof node.closest === 'function' && node.closest('[data-bind]'));
  }

  function onKeydown(event) {
    if (event.defaultPrevented) return;
    if (state.open) return;              /* the palette owns its own keys */
    var hit = matchEntry(event);
    if (!hit) return;
    /* The resume is edited in place, so a bound field looks like any other
       typing target. A chord is an unambiguous instruction and has to work
       there — Ctrl+Z in particular, or the browser takes one character at a
       time. A bare key is a character being typed: "/" and "?" are bound to
       the palette and the help dialog, and letting them through opened a
       dialog in the middle of a word and swallowed the character. */
    if (isTypingTarget(event.target) && !(isBoundField(event.target) && bindingIsChord(hit.binding))) return;
    /* A modal traps Tab and takes Escape in the capture phase. Opening a second
       focus trap over it would leave Escape closing the wrong layer. */
    if (global.RB && global.RB.ui && global.RB.ui.isModalOpen && global.RB.ui.isModalOpen()) return;
    event.preventDefault();
    try { hit.entry.run(); }
    catch (e) {
      if (global.console) console.error('[shortcuts] "' + hit.entry.id + '" failed', e);
      toast('That shortcut could not run. Try it from the command palette.', 'error');
    }
  }

  /* ---------------- Boot ---------------- */

  function init() {
    loadRecents();
    installStyle();
    installActions();
    mount();
    doc.addEventListener('keydown', onKeydown);
    if (global.RB.lifecycle && typeof global.RB.lifecycle.on === 'function') {
      /* Panel tab swaps emit 'unmount' too; the palette is app-level. */
      global.RB.lifecycle.on('unmount', function (payload) {
        if (payload && (payload.scope === 'panel' || payload.panelId != null)) return;
        closePalette();
      });
    }
  }

  global.RB = global.RB || {};
  global.RB.commands = {
    register: registerCommand,
    unregister: unregisterCommand,
    get: getCommand,
    all: function () { return commands.slice(); },
    setProvider: setProvider,
    open: openPalette,
    close: closePalette,
    toggle: togglePalette,
    isOpen: isOpen,
    mount: mount,
    recents: {
      list: function () { return recents.slice(); },
      clear: clearRecents
    },
    actions: {
      save: runSave,
      print: runPrint,
      share: runShare,
      undo: runUndo,
      redo: runRedo,
      addSection: addSection,
      togglePanel: togglePanel,
      toggleTheme: toggleTheme,
      focusSearch: focusSearch
    }
  };
  global.RB.shortcuts = {
    register: registerShortcut,
    unregister: unregisterShortcut,
    get: getShortcut,
    all: function () { return shortcuts.slice(); },
    match: matchShortcut,
    format: formatCombo,
    openHelp: openHelp
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
