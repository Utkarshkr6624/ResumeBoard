/* Resumeboard — structured form panel (panel id "edit")
 *
 * The keyboard-accessible twin of the inline binder: same model, same
 * data-bind dot paths, written only through RB.store.setField / RB.store.update.
 * The document stays the primary editing surface; this panel exists so the
 * whole resume can be filled in without touching it, and so every control has
 * a real <label>.
 *
 * This module owns no CSS file, so it injects its own token-only stylesheet
 * once. Nothing here hardcodes a colour: every value is var(--rb-*).
 */
(function (global) {
  'use strict';

  var doc = global.document;

  /* Resolved on mount, so script order in index.html stays the only coupling. */
  var U = null, model = null, bus = null, ui = null, icons = null, LOCALE = null;

  var active = null;
  var seq = 0;

  var CSS = [
    '.rbf{gap:var(--rb-space-3);padding:var(--rb-space-4)}',
    '.rbf-toolbar{gap:var(--rb-space-2)}',
    '.rbf-toolbar__field{flex:1 1 190px;min-width:0}',
    '.rbf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--rb-space-3);align-items:end}',
    '.rbf-group{border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rbf-group--nested{border:1px solid var(--rb-border-subtle);border-radius:var(--rb-radius-md);padding:var(--rb-space-3)}',
    '.rbf-group__legend{font-size:var(--rb-text-2xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--rb-text-muted);padding:0}',
    '.rbf-group--nested>.rbf-group__legend{padding:0 var(--rb-space-2);margin-left:calc(var(--rb-space-1) * -1)}',
    '.rbf-sec{border:1px solid var(--rb-border);border-radius:var(--rb-radius-lg);background:var(--rb-bg-elevated)}',
    '.rbf-sec__sum{display:flex;align-items:center;gap:var(--rb-space-2);padding:var(--rb-space-3) var(--rb-space-4);cursor:pointer;list-style:none;user-select:none;-webkit-tap-highlight-color:transparent}',
    '.rbf-sec__sum::-webkit-details-marker{display:none}',
    '.rbf-sec__title{flex:1 1 auto;font-weight:600;font-size:var(--rb-text-base)}',
    '.rbf-sec__body{display:flex;flex-direction:column;gap:var(--rb-space-4);padding:0 var(--rb-space-4) var(--rb-space-4)}',
    '.rbf-caret{display:inline-flex;color:var(--rb-text-muted);transition:transform var(--rb-dur-fast) var(--rb-ease-out)}',
    '.rbf-sec[open]>.rbf-sec__sum .rbf-caret{transform:rotate(90deg)}',
    '@media (prefers-reduced-motion: reduce){.rbf-caret{transition:none}}',
    '.rbf-rep{display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rbf-entry{padding:var(--rb-space-3);display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rbf-entry__head{gap:var(--rb-space-1)}',
    '.rbf-entry__title{font-weight:600;font-size:var(--rb-text-base)}',
    '.rbf-entry__body{display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rbf-chips{display:flex;flex-wrap:wrap;align-items:center;gap:var(--rb-space-1)}',
    '.rbf-chip{display:inline-flex;align-items:center;gap:var(--rb-space-1);max-width:100%;padding:2px var(--rb-space-1) 2px var(--rb-space-2);border:1px solid var(--rb-border);border-radius:var(--rb-radius-full);background:var(--rb-bg-sunken);font-size:var(--rb-text-xs);color:var(--rb-text-secondary)}',
    '.rbf-chip>.rb-btn{width:20px;height:20px}',
    '.rbf-findings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--rb-space-1)}',
    '.rbf-finding{display:flex;align-items:flex-start;gap:var(--rb-space-2);font-size:var(--rb-text-xs);color:var(--rb-text-secondary);line-height:1.45}',
    '.rbf-finding__msg{min-width:0}',
    '.rbf-photo{width:96px;height:96px;object-fit:cover;border-radius:var(--rb-radius-md);border:1px solid var(--rb-border);background:var(--rb-bg-sunken)}'
  ].join('\n');

  function ensureStyles() {
    if (!doc.head || doc.getElementById('rbf-styles')) return;
    var style = doc.createElement('style');
    style.id = 'rbf-styles';
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function bind() {
    var R = global.RB || {};
    U = R.utils; model = R.model; bus = R.bus; ui = R.ui; icons = R.icons;
    LOCALE = (U && U.LOCALE) || { lang: 'en-US', region: 'US', dateFormat: 'MMM YYYY', prefersPhoto: false };
    return !!(U && model && bus);
  }

  function nextId() { seq += 1; return 'rbf-' + seq; }

  function iconEl(name, size) {
    if (icons && icons.el) return icons.el(name, { size: size });
    return U.el('span', { class: 'rb-i', html: icons && icons.svg ? icons.svg(name, { size: size }) : '' });
  }

  function caret() {
    return U.el('span', { class: 'rbf-caret', 'aria-hidden': 'true' }, [iconEl('chevron-right', 'sm')]);
  }

  function toast(message, tone) {
    if (ui && ui.toast) ui.toast(message, { tone: tone || 'info' });
  }

  function needDialogs() {
    if (ui && ui.confirmDelete) return true;
    toast('Dialogs are still loading. Try again in a moment.', 'warn');
    return false;
  }

  /* ------------------------------------------------------------------ atoms */

  function iconButton(o) {
    var b = U.el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm rb-tip' + (o.danger ? ' rb-btn--danger' : ''),
      'aria-label': o.label,
      'data-tip': o.tip || o.label
    });
    b.appendChild(iconEl(o.icon, 'sm'));
    if (o.pressed != null) b.setAttribute('aria-pressed', o.pressed ? 'true' : 'false');
    if (o.key) b.setAttribute('data-key', o.key);
    if (o['data-flag']) b.setAttribute('data-flag', o['data-flag']);
    /* A toggle keeps its node across a patch, so both of its faces travel with
     * it and sync() can put the right one up. Without this the button keeps
     * saying "Hide" once the thing is hidden, and its handler keeps hiding. */
    if (o['data-on-icon']) b.setAttribute('data-on-icon', o['data-on-icon']);
    if (o['data-off-icon']) b.setAttribute('data-off-icon', o['data-off-icon']);
    if (o['data-on-label']) b.setAttribute('data-on-label', o['data-on-label']);
    if (o['data-off-label']) b.setAttribute('data-off-label', o['data-off-label']);
    if (o['data-on-tip']) b.setAttribute('data-on-tip', o['data-on-tip']);
    if (o['data-off-tip']) b.setAttribute('data-off-tip', o['data-off-tip']);
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', o.onClick);
    return b;
  }

  function textButton(o) {
    var b = U.el('button', {
      type: 'button',
      class: 'rb-btn ' + (o.variant || 'rb-btn--secondary') + ' rb-btn--sm' + (o.block ? ' rb-btn--block' : '')
    });
    if (o.icon) b.appendChild(iconEl(o.icon, 'sm'));
    b.appendChild(U.el('span', { class: 'rbf-btn__label', text: o.label }));
    if (o.key) b.setAttribute('data-key', o.key);
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', o.onClick);
    return b;
  }

  function group(legend, children) {
    var fs = U.el('fieldset', { class: 'rbf-group' });
    fs.appendChild(U.el('legend', { class: 'rbf-group__legend', text: legend }));
    (children || []).forEach(function (c) { if (c) fs.appendChild(c); });
    return fs;
  }

  function grid(children) {
    return U.el('div', { class: 'rbf-grid' }, children);
  }

  function fieldWrap(path) {
    return U.el('div', { class: 'rb-field rbf-field', 'data-field-path': path });
  }

  /* One labelled control with hint + linter findings wired through
   * aria-describedby. Every control in this panel is built here or in
   * chipsField, so nothing ships unlabelled. */
  function field(o) {
    var id = nextId();
    var wrap = fieldWrap(o.path);
    var described = [];
    var control;

    if (o.kind === 'check' || o.kind === 'switch') {
      control = U.el('input', { type: 'checkbox', id: id, 'data-path': o.path, 'data-kind': 'check' });
      control.checked = !!o.value;
      var lab = U.el('label', { class: o.kind === 'switch' ? 'rb-switch' : 'rb-checkbox' }, [control]);
      if (o.kind === 'switch') lab.appendChild(U.el('span', { class: 'rb-switch-track', 'aria-hidden': 'true' }));
      lab.appendChild(U.el('span', { text: o.label }));
      wrap.appendChild(lab);
    } else if (o.kind === 'select') {
      control = U.el('select', { class: 'rb-select', id: id, 'data-path': o.path, 'data-kind': 'select' });
      (o.options || []).forEach(function (opt) {
        control.appendChild(U.el('option', { value: opt.value, text: opt.label }));
      });
      control.value = o.value == null ? '' : String(o.value);
      wrap.appendChild(U.el('label', { class: 'rb-label', for: id, text: o.label }));
      wrap.appendChild(control);
    } else if (o.kind === 'lines') {
      control = U.el('textarea', {
        class: 'rb-textarea', id: id, rows: o.rows || 4, 'data-path': o.path, 'data-kind': 'lines',
        spellcheck: 'true', placeholder: o.placeholder || null
      });
      control.value = Array.isArray(o.value) ? o.value.join('\n') : (o.value == null ? '' : String(o.value));
      wrap.appendChild(U.el('label', { class: 'rb-label', for: id, text: o.label }));
      wrap.appendChild(control);
    } else {
      control = U.el('input', {
        class: 'rb-input', id: id, type: o.type || 'text', 'data-path': o.path, 'data-kind': 'text',
        placeholder: o.placeholder || null,
        spellcheck: (o.type === 'email' || o.type === 'tel') ? 'false' : 'true'
      });
      if (o.autocomplete) control.setAttribute('autocomplete', o.autocomplete);
      if (o.inputmode) control.setAttribute('inputmode', o.inputmode);
      if (o.maxlength) control.setAttribute('maxlength', o.maxlength);
      control.value = o.value == null ? '' : String(o.value);
      wrap.appendChild(U.el('label', { class: 'rb-label', for: id, text: o.label }));
      wrap.appendChild(control);
    }

    if (o.datalist && o.datalist.length) {
      var dlId = id + '-dl';
      var dl = U.el('datalist', { id: dlId });
      o.datalist.forEach(function (v) { dl.appendChild(U.el('option', { value: v })); });
      wrap.appendChild(dl);
      control.setAttribute('list', dlId);
    }

    if (o.hint) {
      described.push(id + '-h');
      wrap.appendChild(U.el('span', { class: 'rb-hint', id: id + '-h', text: o.hint }));
    }
    described.push(id + '-f');
    wrap.appendChild(U.el('ul', { class: 'rbf-findings', id: id + '-f', hidden: true }));
    control.setAttribute('aria-describedby', described.join(' '));

    var event = (o.kind === 'check' || o.kind === 'select') ? 'change' : 'input';

    /* Same rules as the document: strip what is never content silently, and
     * refuse a value that cannot be right out loud rather than storing it. */
    function write(value) {
      RB.store.setField(o.path, value);
    }
    function applyValue() {
      var V = RB.validate;
      if (!V || o.kind === 'check' || o.kind === 'chips') {
        if (o.kind === 'check') write(control.checked);
        else if (o.kind === 'lines') write(linesToArray(control.value));
        else write(control.value);
        return;
      }
      var raw = control.value;
      var clean = V.sanitize(raw, o.path);
      if (clean !== raw) control.value = clean;
      var verdict = V.accept(clean, o.path);
      if (!verdict.ok) {
        markInvalid(control, verdict.reason);
        control.value = model.getPath(RB.store.get(), o.path) || '';
        return;
      }
      var why = V.gibberish(verdict.value, o.path);
      if (why) {
        markInvalid(control, why);
        control.value = model.getPath(RB.store.get(), o.path) || '';
        return;
      }
      markInvalid(control, null);
      if (o.kind === 'lines') write(linesToArray(verdict.value));
      else write(verdict.value);
    }

    control.addEventListener(event, applyValue);
    if (event === 'change') control.addEventListener('blur', applyValue);
    return wrap;
  }

  function markInvalid(control, reason) {
    var wrap = control.closest('.rb-field') || control.parentElement;
    if (!wrap) return;
    control.setAttribute('aria-invalid', reason ? 'true' : 'false');
    var slot = wrap.querySelector('.rbf-error, [data-field-error]');
    if (!slot) {
      slot = U.el('p', { class: 'rbf-error' });
      slot.style.cssText = 'font-size:12px;color:#d92d20;display:none;margin:0';
      wrap.appendChild(slot);
    }
    slot.textContent = reason || '';
    slot.style.display = reason ? 'block' : 'none';
  }

  function markHint(control, message) {
    if (!message) return;
    if (window.RB.ui && RB.ui.toast) RB.ui.toast(message, { tone: 'info', duration: 4000 });
  }

  var BULLET = /^\s*(?:[\u2022\u2023\u25aa\u25cf\u2043\u25e6]|-|\u2013|\u2014)\s+/;

  function linesToArray(text) {
    var out = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      if (out.length >= 40) return;
      var v = line.replace(BULLET, '').replace(/^\s+/, '').replace(/\s+$/, '').trim();
      if (v) out.push(v);
    });
    return out;
  }

  /* ----------------------------------------------------------- chip editor */

  function chipsField(o) {
    var id = nextId();
    var path = o.path;
    var wrap = U.el('div', {
      class: 'rb-field rbf-field', 'data-field-path': path, 'data-path': path, 'data-kind': 'chips'
    });
    var list = U.el('div', { class: 'rbf-chips' });
    var input = U.el('input', {
      class: 'rb-input', id: id, type: 'text', autocomplete: 'off',
      placeholder: o.placeholder || 'Add one and press Enter',
      'aria-describedby': id + '-h ' + id + '-f'
    });

    var dl = U.el('datalist', { id: id + '-dl' });
    (o.suggestions || []).forEach(function (s) { dl.appendChild(U.el('option', { value: s })); });
    input.setAttribute('list', dl.id);

    wrap.appendChild(U.el('label', { class: 'rb-label', for: id, text: o.label }));
    wrap.appendChild(list);
    wrap.appendChild(input);
    wrap.appendChild(dl);
    wrap.appendChild(U.el('span', { class: 'rb-hint', id: id + '-h', text: o.hint || 'Press Enter or comma to add. Backspace on an empty box removes the last one.' }));
    wrap.appendChild(U.el('ul', { class: 'rbf-findings', id: id + '-f', hidden: true }));

    function current() {
      var v = model.getPath(RB.store.get(), path);
      return Array.isArray(v) ? v : [];
    }
    function paint(values) { renderChips(wrap, list, values); }
    function addChip() {
      var parts = input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      input.value = '';
      if (!parts.length) { paint(current()); return; }
      var next = current().concat(parts).filter(function (v, i, a) { return a.indexOf(v) === i; });
      RB.store.setField(path, next);
      paint(next);
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); addChip(); return; }
      if (ev.key === 'Backspace' && input.value === '') {
        var now = current();
        if (!now.length) return;
        ev.preventDefault();
        var next = now.slice(0, -1);
        RB.store.setField(path, next);
        paint(next);
      }
    });
    input.addEventListener('blur', function () { if (input.value.trim()) addChip(); });

    paint(current());
    return wrap;
  }

  function renderChips(wrap, list, values) {
    if (!list) return;
    list.textContent = '';
    (values || []).forEach(function (value, i) {
      var chip = U.el('span', { class: 'rbf-chip' }, [U.el('span', { class: 'rb-truncate', text: value })]);
      chip.appendChild(iconButton({
        icon: 'x', tip: 'Remove', label: 'Remove ' + value,
        key: 'chip:' + wrap.getAttribute('data-path') + ':' + i,
        onClick: function () {
          var next = (Array.isArray(values) ? values : []).slice();
          next.splice(i, 1);
          RB.store.setField(wrap.getAttribute('data-path'), next);
          renderChips(wrap, list, next);
          var box = U.qs('input', wrap);
          if (box) box.focus();
        }
      }));
      list.appendChild(chip);
    });
    if (!values || !values.length) {
      list.appendChild(U.el('span', { class: 'rb-hint', text: 'Nothing here yet.' }));
    }
  }

  /* --------------------------------------------------------- list plumbing */

  /* model.*Entry() only ever touches r[type], so a one-key wrapper lets the
   * same tested code drive nested arrays (roles, custom entries, profiles). */
  function listMutate(path, fn) {
    RB.store.update(function (draft) {
      var arr = model.getPath(draft, path);
      if (!Array.isArray(arr)) return false;
      return fn(arr);
    }, { source: 'update', coalesce: false });
  }

  function markPending(listPath, at) {
    if (active) active.pendingChild = { list: listPath, at: at };
  }

  function listAdd(path, type, make) {
    var arr = model.getPath(RB.store.get(), path);
    markPending(path, Array.isArray(arr) ? arr.length : 0);
    listMutate(path, function (a) {
      a.push(make ? make() : model.blankEntry(type));
      return true;
    });
  }

  function listDup(path, id) {
    var arr = model.getPath(RB.store.get(), path);
    var at = Array.isArray(arr) ? arr.findIndex(function (e) { return e && e.id === id; }) + 1 : 0;
    markPending(path, at < 1 ? 0 : at);
    listMutate(path, function (a) { return !!model.duplicateEntry({ x: a }, 'x', id); });
  }

  function listRemove(path, id) {
    listMutate(path, function (a) { return model.removeEntry({ x: a }, 'x', id); });
  }

  function listMove(path, id, delta) {
    listMutate(path, function (a) { return model.moveEntry({ x: a }, 'x', id, delta); });
  }

  /* The model exports no blank role / custom entry / profile factory. */
  function blankRole() {
    return {
      id: U.uid('role'), position: '', start: '', end: '', current: false,
      summary: '', highlights: [''], skills: [], visible: true
    };
  }
  function blankCustomEntry() {
    return { id: U.uid('ent'), title: '', org: '', start: '', end: '', text: '' };
  }
  function blankProfile() {
    return { id: U.uid('prf'), network: 'other', label: '', url: '' };
  }

  /* ---------------------------------------------------------------- repeater */

  var ADD_LABEL = {
    experience: 'Add a job', education: 'Add education', skills: 'Add a skill group',
    projects: 'Add a project', certifications: 'Add a certification', publications: 'Add a publication',
    awards: 'Add an award', volunteer: 'Add a role', languages: 'Add a language',
    interests: 'Add an interest', references: 'Add a reference', coursework: 'Add a course',
    presentations: 'Add a presentation', custom: 'Add a group'
  };

  function entryTitle(type, entry, i) {
    var e = entry || {};
    var fallback = 'Entry ' + (i + 1);
    switch (type) {
      case 'experience': return (e.roles && e.roles[0] && e.roles[0].position) || e.company || fallback;
      case 'volunteer': return e.role || e.organization || fallback;
      case 'languages': return e.language || fallback;
      case 'interests': return e.label || fallback;
      case 'skills': return e.label || fallback;
      case 'custom': return e.label || fallback;
      case 'awards': return e.title || fallback;
      default: return e.title || e.name || e.institution || e.label || fallback;
    }
  }

  function titlePaths(type, prefix) {
    switch (type) {
      case 'experience': return [prefix + '.roles.0.position', prefix + '.company'];
      case 'education': return [prefix + '.institution'];
      case 'skills': return [prefix + '.label'];
      case 'projects': return [prefix + '.name'];
      case 'certifications': return [prefix + '.name'];
      case 'publications': return [prefix + '.title'];
      case 'awards': return [prefix + '.title'];
      case 'volunteer': return [prefix + '.role', prefix + '.organization'];
      case 'languages': return [prefix + '.language'];
      case 'interests': return [prefix + '.label'];
      case 'references': return [prefix + '.name'];
      case 'coursework': return [prefix + '.name'];
      case 'presentations': return [prefix + '.title'];
      case 'custom': return [prefix + '.label'];
      default: return [prefix + '.title', prefix + '.name'];
    }
  }

  function repeater(o) {
    var list = model.sectionEntries(RB.store.get(), o.type);
    var box = U.el('div', { class: 'rbf-rep', 'data-list': o.path });

    if (!list.length) {
      box.appendChild(U.el('div', { class: 'rb-empty' }, [
        U.el('div', { class: 'rb-empty__icon' }, [iconEl(o.icon, 'xl')]),
        U.el('p', { class: 'rb-empty__title', text: 'No ' + model.typeMeta(o.type).label.toLowerCase() + ' yet' }),
        U.el('p', { class: 'rb-empty__text', text: o.emptyText }),
        textButton({ label: o.addLabel, icon: 'plus', variant: 'rb-btn--primary', onClick: o.onAdd })
      ]));
      return box;
    }

    list.forEach(function (entry, i) { box.appendChild(entryCard(o, entry, i, list.length)); });
    box.appendChild(textButton({
      label: o.addLabel, icon: 'plus', block: true, key: 'add:' + o.path, onClick: o.onAdd
    }));
    return box;
  }

  function entryCard(o, entry, i, total) {
    var id = entry && entry.id;
    var title = entryTitle(o.type, entry, i);
    var visible = !!entry && entry.visible !== false;

    var art = U.el('article', { class: 'rbf-entry rb-card', 'data-entry': id, 'aria-label': title });
    var head = U.el('div', { class: 'rbf-entry__head rb-row' });

    var titleEl = U.el('span', { class: 'rbf-entry__title rb-truncate' });
    titleEl.setAttribute('data-label-for', titlePaths(o.type, o.path + '.' + i).join(','));
    titleEl.setAttribute('data-fallback', 'Entry ' + (i + 1));
    titleEl.textContent = title;
    head.appendChild(titleEl);
    head.appendChild(U.el('span', { class: 'rb-spacer' }));

    head.appendChild(iconButton({
      icon: 'chevron-up', tip: 'Move up', key: 'up:' + o.path + ':' + id, label: 'Move ' + title + ' up',
      disabled: i === 0, onClick: function () { listMove(o.path, id, -1); }
    }));
    head.appendChild(iconButton({
      icon: 'chevron-down', tip: 'Move down', key: 'down:' + o.path + ':' + id, label: 'Move ' + title + ' down',
      disabled: i === total - 1, onClick: function () { listMove(o.path, id, 1); }
    }));
    head.appendChild(iconButton({
      icon: visible ? 'eye' : 'eye-off', tip: visible ? 'Hide on the page' : 'Show on the page',
      key: 'vis:' + o.path + ':' + id, label: (visible ? 'Hide ' : 'Show ') + title,
      pressed: visible, 'data-flag': o.path + '.' + i + '.visible',
      'data-on-icon': 'eye', 'data-off-icon': 'eye-off',
      'data-on-label': 'Hide ' + title, 'data-off-label': 'Show ' + title,
      'data-on-tip': 'Hide on the page', 'data-off-tip': 'Show on the page',
      /* Read the live value, not the one captured when this card was built:
       * the card outlives the click that hides the entry. */
      onClick: function () {
        var cur = RB.model.getPath(RB.store.get(), o.path + '.' + i + '.visible');
        RB.store.setField(o.path + '.' + i + '.visible', cur === false);
      }
    }));
    head.appendChild(iconButton({
      icon: 'copy', tip: 'Duplicate', key: 'dup:' + o.path + ':' + id, label: 'Duplicate ' + title,
      onClick: function () { listDup(o.path, id); }
    }));
    head.appendChild(iconButton({
      icon: 'trash', tip: 'Delete', danger: true, key: 'del:' + o.path + ':' + id, label: 'Delete ' + title,
      onClick: function () {
        if (!needDialogs()) return;
        ui.confirmDelete(title, function () { listRemove(o.path, id); });
      }
    }));
    art.appendChild(head);

    var body = U.el('div', { class: 'rbf-entry__body rb-col' });
    o.body(entry, o.path + '.' + i, body);
    art.appendChild(body);
    return art;
  }

  /* --------------------------------------------------------------- sections */

  function orderedWithIndex(resume) {
    return (resume.sections || []).map(function (s, i) { return { section: s, index: i }; })
      .sort(function (a, b) {
        if (!!a.section.pinned !== !!b.section.pinned) return a.section.pinned ? -1 : 1;
        return (a.section.order || 0) - (b.section.order || 0);
      });
  }

  function disclosure(idAttr, typeAttr, titleText, open) {
    var det = U.el('details', { class: 'rbf-sec', 'data-section': idAttr, 'data-section-type': typeAttr });
    if (open) det.setAttribute('open', '');
    var sum = U.el('summary', { class: 'rbf-sec__sum rb-row' });
    sum.appendChild(caret());
    sum.appendChild(iconEl(typeMetaIcon(typeAttr)));
    var t = U.el('span', { class: 'rbf-sec__title rb-truncate' });
    if (titleText.path) {
      t.setAttribute('data-label-for', titleText.path);
      t.setAttribute('data-fallback', titleText.fallback);
    } else {
      t.textContent = titleText.text;
    }
    sum.appendChild(t);
    det.appendChild(sum);
    var body = U.el('div', { class: 'rbf-sec__body rb-col' });
    det.appendChild(body);
    return { details: det, summary: sum, body: body };
  }

  function typeMetaIcon(type) {
    if (type === 'profile') return 'user';
    if (type === 'target') return 'target';
    return (model.typeMeta(type) || {}).icon || 'plus';
  }

  function sectionBlock(ref, resume, totalSections, displayIndex) {
    var sec = ref.section;
    var idx = ref.index;
    var m = model.typeMeta(sec.type);
    var d = disclosure(sec.id, sec.type, { path: 'sections.' + idx + '.label', fallback: m.defaultLabel }, sec.collapsed !== true);

    var count = model.sectionEntries(resume, sec.type).length;
    if (count) {
      var badge = U.el('span', { class: 'rb-badge rb-badge--accent rb-numeric', text: String(count) });
      badge.setAttribute('data-count', sec.type);
      d.summary.appendChild(badge);
    }

    d.body.appendChild(sectionToolbar(sec, m, idx, displayIndex, totalSections));
    d.body.appendChild(sectionContent(sec, resume));
    return d.details;
  }

  /* Pinned rows float to the top on every sort, so a move that crosses that
     boundary rewrites an `order` value the sort then ignores: the button
     claims to move the section and the list does not change. */
  function canMove(resume, sec, delta) {
    var ordered = model.orderedSections(resume);
    var i = ordered.map(function (s) { return s.id; }).indexOf(sec.id);
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return false;
    return !!ordered[j].pinned === !!sec.pinned;
  }

  function sectionToolbar(sec, m, idx, displayIndex, total) {
    var bar = U.el('div', { class: 'rbf-toolbar rb-row rb-wrap' });
    var labelField = field({ path: 'sections.' + idx + '.label', label: 'Section heading', value: sec.label });
    labelField.classList.add('rbf-toolbar__field');
    bar.appendChild(labelField);
    bar.appendChild(U.el('span', { class: 'rb-spacer' }));

    /* `displayIndex`, not `idx`: idx is the position in resume.sections and
       the list is drawn in pinned-then-order order, so the two disagree as
       soon as anything is pinned and the top row offers a move that cannot
       happen. */
    bar.appendChild(iconButton({
      icon: 'chevron-up', tip: 'Move section up', key: 'sec-up:' + sec.id,
      label: 'Move the ' + m.label + ' section up',
      disabled: displayIndex === 0 || !canMove(RB.store.get(), sec, -1),
      onClick: function () {
        RB.store.update(function (draft) { return model.moveSection(draft, sec.id, -1); }, { coalesce: false });
      }
    }));
    bar.appendChild(iconButton({
      icon: 'chevron-down', tip: 'Move section down', key: 'sec-down:' + sec.id,
      label: 'Move the ' + m.label + ' section down',
      disabled: displayIndex === total - 1 || !canMove(RB.store.get(), sec, 1),
      onClick: function () {
        RB.store.update(function (draft) { return model.moveSection(draft, sec.id, 1); }, { coalesce: false });
      }
    }));
    bar.appendChild(iconButton({
      icon: sec.visible === false ? 'eye-off' : 'eye',
      tip: sec.visible === false ? 'Show on the page' : 'Hide on the page',
      key: 'sec-vis:' + sec.id,
      label: (sec.visible === false ? 'Show the ' : 'Hide the ') + m.label + ' section',
      pressed: sec.visible !== false,
      'data-flag': 'sections.' + idx + '.visible',
      'data-on-icon': 'eye', 'data-off-icon': 'eye-off',
      'data-on-label': 'Hide the ' + m.label + ' section',
      'data-off-label': 'Show the ' + m.label + ' section',
      'data-on-tip': 'Hide on the page', 'data-off-tip': 'Show on the page',
      /* Live value, not the one captured when the panel built this bar — the
       * bar is patched, not rebuilt, when visibility changes. */
      onClick: function () {
        var cur = RB.model.getPath(RB.store.get(), 'sections.' + idx + '.visible');
        RB.store.setField('sections.' + idx + '.visible', cur === false);
      }
    }));
    bar.appendChild(iconButton({
      icon: 'trash', tip: 'Delete section', danger: true, key: 'sec-del:' + sec.id,
      label: 'Delete the ' + m.label + ' section',
      onClick: function () {
        if (!needDialogs()) return;
        ui.confirmDelete(m.label.toLowerCase() + ' section', function () {
          RB.store.update(function (draft) { return model.removeSection(draft, sec.id); }, { coalesce: false });
        });
      }
    }));
    return bar;
  }

  function sectionContent(sec, resume) {
    if (sec.type === 'summary') {
      return group('Summary', [field({
        path: 'basics.summary', kind: 'lines', label: 'Summary', rows: 6, value: resume.basics.summary,
        placeholder: 'What you do, the scale you have worked at, what you are good at.',
        hint: 'Written once, shown wherever the Summary section sits on the page.'
      })]);
    }
    var m = model.typeMeta(sec.type);
    return repeater({
      type: sec.type, path: sec.type, icon: m.icon,
      addLabel: ADD_LABEL[sec.type] || ('Add ' + m.label.toLowerCase()),
      emptyText: 'Add the ones you want on the page. Reorder or hide them at any time.',
      onAdd: function () { listAdd(sec.type, sec.type, null); },
      body: function (entry, prefix, into) { renderEntryFields(sec.type, entry, prefix, into); }
    });
  }

  /* ------------------------------------------------------------ date helper */

  var START_HINT = 'Free text. "Mar 2021", "2021" and "Summer 2019" all work.';

  function dateGroup(prefix, o) {
    var end = field({ path: prefix + '.end', label: 'End', value: o.end, placeholder: o.placeholder || 'Mar 2023' });
    if (o.current !== undefined) {
      end.setAttribute('data-blocked-by', prefix + '.current');
      if (o.current) end.hidden = true;
    }
    var children = [
      field({
        path: prefix + '.start', label: o.startLabel || 'Start', value: o.start,
        hint: START_HINT, placeholder: o.placeholder || 'Mar 2021'
      }),
      end
    ];
    if (o.current !== undefined) {
      children.push(field({
        path: prefix + '.current', kind: 'switch',
        label: o.currentLabel || 'I still work here', value: o.current
      }));
    }
    return group('Dates', [grid(children)]);
  }

  var FLUENCY = ['Native', 'Fluent', 'Professional working proficiency', 'Intermediate', 'Basic'];

  function collectSuggestions(resume) {
    var out = [];
    function push(list) {
      (Array.isArray(list) ? list : []).forEach(function (v) {
        var s = String(v == null ? '' : v).trim();
        if (s && out.indexOf(s) === -1) out.push(s);
      });
    }
    (resume.skills || []).forEach(function (e) { push(e && e.keywords); });
    (resume.projects || []).forEach(function (e) { push(e && e.keywords); });
    (resume.education || []).forEach(function (e) { push(e && e.courses); });
    (resume.experience || []).forEach(function (e) {
      ((e && e.roles) || []).forEach(function (r) { push(r && r.skills); });
    });
    return out.slice(0, 200);
  }

  /* -------------------------------------------------------- entry field maps */

  function renderEntryFields(type, entry, prefix, into) {
    var e = entry || {};
    var resume = RB.store.get();
    var suggestions = collectSuggestions(resume);

    switch (type) {
      case 'experience': {
        into.appendChild(group('Employer', [
          grid([
            field({ path: prefix + '.company', label: 'Company', value: e.company, placeholder: 'Northwind Labs' }),
            field({ path: prefix + '.companyEntity', label: 'Legal suffix', value: e.companyEntity, placeholder: 'Inc.' })
          ]),
          grid([
            field({ path: prefix + '.location', label: 'Location', value: e.location, placeholder: 'Remote, or Berlin' }),
            field({ path: prefix + '.url', label: 'Company site', value: e.url, placeholder: 'northwind.com' })
          ])
        ]));

        var roleBox = U.el('div', { class: 'rbf-rep', 'data-list': prefix + '.roles' });
        (e.roles || []).forEach(function (role, ri) {
          roleBox.appendChild(roleBlock(role, prefix + '.roles.' + ri, e.roles.length, ri));
        });
        roleBox.appendChild(textButton({
          label: 'Add a role at this company', icon: 'plus', block: true, key: 'addrole:' + prefix,
          onClick: function () { listAdd(prefix + '.roles', null, blankRole); }
        }));
        into.appendChild(roleBox);
        break;
      }
      case 'education':
        into.appendChild(grid([
          field({ path: prefix + '.institution', label: 'Institution', value: e.institution, placeholder: 'Rhode Island School of Design' }),
          field({ path: prefix + '.url', label: 'Website', value: e.url, placeholder: 'risd.edu' })
        ]));
        into.appendChild(grid([
          field({ path: prefix + '.studyType', label: 'Degree', value: e.studyType, placeholder: 'Bachelor of Fine Arts' }),
          field({ path: prefix + '.area', label: 'Field of study', value: e.area, placeholder: 'Graphic Design' }),
          field({ path: prefix + '.score', label: 'Grade', value: e.score, placeholder: '3.8 GPA' })
        ]));
        into.appendChild(dateGroup(prefix, { start: e.start, end: e.end, startLabel: 'Started', placeholder: '2012' }));
        into.appendChild(chipsField({
          path: prefix + '.courses', label: 'Relevant coursework', value: e.courses,
          suggestions: suggestions
        }));
        break;
      case 'skills':
        into.appendChild(grid([
          field({ path: prefix + '.label', label: 'Group name', value: e.label, placeholder: 'Design' }),
          field({
            path: prefix + '.level', kind: 'select', label: 'Level', value: e.level,
            options: [
              { value: '', label: 'Not stated' },
              { value: 'beginner', label: 'Beginner' },
              { value: 'intermediate', label: 'Intermediate' },
              { value: 'advanced', label: 'Advanced' },
              { value: 'expert', label: 'Expert' }
            ]
          })
        ]));
        into.appendChild(chipsField({
          path: prefix + '.keywords', label: 'Keywords', value: e.keywords, suggestions: suggestions
        }));
        break;
      case 'projects':
        into.appendChild(grid([
          field({ path: prefix + '.name', label: 'Project', value: e.name, placeholder: 'Open Checkout Kit' }),
          field({ path: prefix + '.url', label: 'Link', value: e.url, placeholder: 'github.com/you/project' })
        ]));
        into.appendChild(dateGroup(prefix, {
          start: e.start, end: e.end, current: e.current, startLabel: 'Started',
          currentLabel: 'Still going', placeholder: '2023'
        }));
        into.appendChild(field({
          path: prefix + '.summary', kind: 'lines', label: 'What it is', rows: 3, value: e.summary,
          hint: 'Two or three lines, including the scale: stars, users, downloads.'
        }));
        into.appendChild(field({
          path: prefix + '.highlights', kind: 'lines', label: 'Achievements', rows: 3, value: e.highlights,
          hint: 'One achievement per line. Each line becomes a bullet.'
        }));
        into.appendChild(chipsField({ path: prefix + '.keywords', label: 'Keywords', value: e.keywords, suggestions: suggestions }));
        break;
      case 'certifications':
        into.appendChild(grid([
          field({ path: prefix + '.name', label: 'Certification', value: e.name, placeholder: 'Certified Usability Analyst' }),
          field({ path: prefix + '.issuer', label: 'Issuer', value: e.issuer, placeholder: 'Human Factors International' })
        ]));
        into.appendChild(grid([
          field({ path: prefix + '.date', label: 'Date', value: e.date, placeholder: 'Mar 2023' }),
          field({ path: prefix + '.credentialId', label: 'Credential ID', value: e.credentialId, placeholder: 'CUA-44192' }),
          field({ path: prefix + '.url', label: 'Link', value: e.url, placeholder: 'Credential link' })
        ]));
        break;
      case 'publications':
        into.appendChild(field({ path: prefix + '.title', label: 'Title', value: e.title }));
        into.appendChild(grid([
          field({ path: prefix + '.authors', label: 'Authors', value: e.authors, hint: 'You first, then collaborators.' }),
          field({ path: prefix + '.venue', label: 'Venue', value: e.venue })
        ]));
        into.appendChild(grid([
          field({ path: prefix + '.date', label: 'Date', value: e.date, placeholder: 'Jun 2022' }),
          field({ path: prefix + '.doi', label: 'DOI', value: e.doi })
        ]));
        into.appendChild(field({ path: prefix + '.url', label: 'Link', value: e.url }));
        break;
      case 'awards':
        into.appendChild(field({ path: prefix + '.title', label: 'Award', value: e.title }));
        into.appendChild(grid([
          field({ path: prefix + '.awarder', label: 'Awarded by', value: e.awarder }),
          field({ path: prefix + '.date', label: 'Date', value: e.date, placeholder: '2021' })
        ]));
        break;
      case 'volunteer':
        into.appendChild(grid([
          field({ path: prefix + '.role', label: 'Role', value: e.role, placeholder: 'Mentor' }),
          field({ path: prefix + '.organization', label: 'Organization', value: e.organization })
        ]));
        into.appendChild(field({ path: prefix + '.location', label: 'Location', value: e.location }));
        into.appendChild(dateGroup(prefix, {
          start: e.start, end: e.end, current: e.current, currentLabel: 'Still volunteering'
        }));
        into.appendChild(field({
          path: prefix + '.highlights', kind: 'lines', label: 'Achievements', rows: 3, value: e.highlights,
          hint: 'One achievement per line. Each line becomes a bullet.'
        }));
        break;
      case 'languages':
        into.appendChild(grid([
          field({ path: prefix + '.language', label: 'Language', value: e.language, placeholder: 'Spanish' }),
          field({ path: prefix + '.fluency', label: 'Fluency', value: e.fluency, datalist: FLUENCY, placeholder: 'Native, or C1' })
        ]));
        break;
      case 'interests':
        into.appendChild(field({ path: prefix + '.label', label: 'Interest', value: e.label, placeholder: 'Cycling' }));
        break;
      case 'references':
        into.appendChild(field({ path: prefix + '.name', label: 'Name', value: e.name }));
        into.appendChild(grid([
          field({ path: prefix + '.label', label: 'Relationship', value: e.label, placeholder: 'Former manager' }),
          field({ path: prefix + '.contact', label: 'Contact', value: e.contact, hint: 'Only shown if you fill this in.' })
        ]));
        break;
      case 'coursework':
        into.appendChild(grid([
          field({ path: prefix + '.name', label: 'Course', value: e.name }),
          field({ path: prefix + '.institution', label: 'Institution', value: e.institution })
        ]));
        into.appendChild(grid([
          field({ path: prefix + '.date', label: 'Year', value: e.date, placeholder: '2019' }),
          field({ path: prefix + '.url', label: 'Link', value: e.url })
        ]));
        break;
      case 'presentations':
        into.appendChild(field({ path: prefix + '.title', label: 'Title', value: e.title }));
        into.appendChild(grid([
          field({ path: prefix + '.event', label: 'Event', value: e.event }),
          field({ path: prefix + '.date', label: 'Date', value: e.date, placeholder: 'Mar 2024' })
        ]));
        into.appendChild(grid([
          field({ path: prefix + '.location', label: 'Location', value: e.location }),
          field({ path: prefix + '.url', label: 'Link', value: e.url })
        ]));
        into.appendChild(field({
          path: prefix + '.highlights', kind: 'lines', label: 'Achievements', rows: 3, value: e.highlights,
          hint: 'One line per highlight.'
        }));
        break;
      case 'custom': {
        into.appendChild(field({ path: prefix + '.label', label: 'Group name', value: e.label, placeholder: 'Volunteering' }));
        var subBox = U.el('div', { class: 'rbf-rep', 'data-list': prefix + '.entries' });
        (e.entries || []).forEach(function (sub, si) {
          subBox.appendChild(customEntryBlock(sub, prefix + '.entries.' + si, e.entries.length, si));
        });
        subBox.appendChild(textButton({
          label: 'Add an item', icon: 'plus', block: true, key: 'addcus:' + prefix,
          onClick: function () { listAdd(prefix + '.entries', null, blankCustomEntry); }
        }));
        into.appendChild(subBox);
        break;
      }
      default:
        into.appendChild(field({ path: prefix + '.title', label: 'Title', value: e.title }));
    }
  }

  function roleBlock(role, path, total, i) {
    var r = role || {};
    var listPath = path.replace(/\.\d+$/, '');
    var name = r.position || 'Role ' + (i + 1);

    var fs = U.el('fieldset', { class: 'rbf-group rbf-group--nested', 'data-entry': r.id });
    var head = U.el('div', { class: 'rbf-toolbar rb-row rb-wrap' });
    head.appendChild(U.el('legend', { class: 'rbf-group__legend', text: name }));
    head.appendChild(U.el('span', { class: 'rb-spacer' }));
    head.appendChild(iconButton({
      icon: 'chevron-up', tip: 'Move up', key: 'up:' + path, label: 'Move ' + name + ' up', disabled: i === 0,
      onClick: function () { listMove(listPath, r.id, -1); }
    }));
    head.appendChild(iconButton({
      icon: 'chevron-down', tip: 'Move down', key: 'down:' + path, label: 'Move ' + name + ' down', disabled: i === total - 1,
      onClick: function () { listMove(listPath, r.id, 1); }
    }));
    head.appendChild(iconButton({
      icon: 'copy', tip: 'Duplicate', key: 'dup:' + path, label: 'Duplicate ' + name,
      onClick: function () { listDup(listPath, r.id); }
    }));
    head.appendChild(iconButton({
      icon: 'trash', tip: 'Delete', danger: true, key: 'del:' + path, label: 'Delete ' + name,
      onClick: function () {
        if (!needDialogs()) return;
        ui.confirmDelete(name, function () { listRemove(listPath, r.id); });
      }
    }));
    fs.appendChild(head);

    fs.appendChild(field({ path: path + '.position', label: 'Position', value: r.position, placeholder: 'Senior Product Designer' }));
    fs.appendChild(dateGroup(path, { start: r.start, end: r.end, current: r.current, currentLabel: 'I still work here' }));
    fs.appendChild(field({
      path: path + '.summary', kind: 'lines', label: 'Role summary', rows: 2, value: r.summary,
      hint: 'Optional. Scope of the role, before the bullets.'
    }));
    fs.appendChild(field({
      path: path + '.highlights', kind: 'lines', label: 'Achievements', rows: 5, value: r.highlights,
      placeholder: 'Cut checkout drop-off by 18%.',
      hint: 'One achievement per line. Each line becomes a bullet on the page.'
    }));
    fs.appendChild(chipsField({
      path: path + '.skills', label: 'Skills used here', value: r.skills,
      suggestions: collectSuggestions(RB.store.get())
    }));
    return fs;
  }

  function customEntryBlock(sub, path, total, i) {
    var s = sub || {};
    var listPath = path.replace(/\.\d+$/, '');
    var name = s.title || 'Item ' + (i + 1);

    var fs = U.el('fieldset', { class: 'rbf-group rbf-group--nested', 'data-entry': s.id });
    var head = U.el('div', { class: 'rbf-toolbar rb-row rb-wrap' });
    head.appendChild(U.el('legend', { class: 'rbf-group__legend', text: name }));
    head.appendChild(U.el('span', { class: 'rb-spacer' }));
    head.appendChild(iconButton({
      icon: 'chevron-up', tip: 'Move up', key: 'up:' + path, label: 'Move ' + name + ' up', disabled: i === 0,
      onClick: function () { listMove(listPath, s.id, -1); }
    }));
    head.appendChild(iconButton({
      icon: 'chevron-down', tip: 'Move down', key: 'down:' + path, label: 'Move ' + name + ' down', disabled: i === total - 1,
      onClick: function () { listMove(listPath, s.id, 1); }
    }));
    head.appendChild(iconButton({
      icon: 'trash', tip: 'Delete', danger: true, key: 'del:' + path, label: 'Delete ' + name,
      onClick: function () {
        if (!needDialogs()) return;
        ui.confirmDelete(name, function () { listRemove(listPath, s.id); });
      }
    }));
    fs.appendChild(head);

    fs.appendChild(field({ path: path + '.title', label: 'Title', value: s.title }));
    fs.appendChild(grid([
      field({ path: path + '.org', label: 'Organisation', value: s.org }),
      field({ path: path + '.start', label: 'Start', value: s.start, placeholder: '2019' }),
      field({ path: path + '.end', label: 'End', value: s.end, placeholder: '2021' })
    ]));
    fs.appendChild(field({ path: path + '.text', kind: 'lines', label: 'Detail', rows: 3, value: s.text }));
    return fs;
  }

  /* --------------------------------------------------------- profile group */

  function profileBlock(resume) {
    var b = resume.basics || {};
    var d = disclosure('profile', 'profile', { text: 'Your details' }, true);

    d.body.appendChild(group('Name', [
      field({ path: 'basics.name', label: 'Full name', value: b.name, autocomplete: 'name', placeholder: 'Alex Rivera' }),
      grid([
        field({ path: 'basics.givenName', label: 'Given name', value: b.givenName, autocomplete: 'given-name' }),
        field({ path: 'basics.familyName', label: 'Family name', value: b.familyName, autocomplete: 'family-name' })
      ]),
      field({
        path: 'basics.label', label: 'Headline', value: b.label, placeholder: 'Senior Product Designer',
        hint: 'The line under your name. Match the job you are applying for.'
      })
    ]));

    d.body.appendChild(group('Contact', [
      grid([
        field({ path: 'basics.email', label: 'Email', type: 'email', value: b.email, autocomplete: 'email', placeholder: 'you@example.com' }),
        field({ path: 'basics.phone', label: 'Phone', type: 'tel', value: b.phone, autocomplete: 'tel', placeholder: '+1 415 555 0142' })
      ]),
      field({
        path: 'basics.url', label: 'Website', value: b.url, autocomplete: 'url', placeholder: 'alexrivera.design',
        hint: 'Domain or full URL. It is linked on the page.'
      })
    ]));

    var loc = b.location || {};
    d.body.appendChild(group('Location', [grid([
      field({ path: 'basics.location.city', label: 'City', value: loc.city, autocomplete: 'address-level2' }),
      field({ path: 'basics.location.region', label: 'Region or state', value: loc.region, autocomplete: 'address-level1' }),
      field({ path: 'basics.location.countryCode', label: 'Country code', value: loc.countryCode, maxlength: 2, placeholder: LOCALE.region })
    ])]));

    d.body.appendChild(photoGroup(resume));

    if (!(resume.sections || []).some(function (s) { return s.type === 'summary'; })) {
      d.body.appendChild(group('Summary', [field({
        path: 'basics.summary', kind: 'lines', label: 'Summary', rows: 4, value: b.summary,
        hint: 'Add a Summary section from the left rail to place this on the page.'
      })]));
    }

    d.body.appendChild(group('Links', [profileRepeater(resume)]));
    return d.details;
  }

  var NETWORKS = [
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'github', label: 'GitHub' },
    { value: 'x', label: 'X' },
    { value: 'dribbble', label: 'Dribbble' },
    { value: 'behance', label: 'Behance' },
    { value: 'medium', label: 'Medium' },
    { value: 'devto', label: 'Dev.to' },
    { value: 'portfolio', label: 'Portfolio' },
    { value: 'other', label: 'Other' }
  ];

  function profileRepeater(resume) {
    var list = (resume.basics && resume.basics.profiles) || [];
    var box = U.el('div', { class: 'rbf-rep', 'data-list': 'basics.profiles' });

    if (!list.length) {
      box.appendChild(U.el('div', { class: 'rb-empty' }, [
        U.el('div', { class: 'rb-empty__icon' }, [iconEl('link', 'xl')]),
        U.el('p', { class: 'rb-empty__title', text: 'No links yet' }),
        U.el('p', { class: 'rb-empty__text', text: 'Add the profile a recruiter will check first.' }),
        textButton({ label: 'Add a link', icon: 'plus', variant: 'rb-btn--primary', onClick: addProfile })
      ]));
      return box;
    }

    list.forEach(function (p, i) {
      var name = p.label || p.network || 'link';
      var art = U.el('article', { class: 'rbf-entry rb-card', 'data-entry': p.id, 'aria-label': name });
      var head = U.el('div', { class: 'rbf-entry__head rb-row' });
      var t = U.el('span', { class: 'rbf-entry__title rb-truncate' });
      t.setAttribute('data-label-for', 'basics.profiles.' + i + '.label');
      t.setAttribute('data-fallback', p.network || 'Link');
      t.textContent = name;
      head.appendChild(t);
      head.appendChild(U.el('span', { class: 'rb-spacer' }));
      head.appendChild(iconButton({
        icon: 'chevron-up', tip: 'Move up', key: 'up:basics.profiles:' + p.id,
        label: 'Move ' + name + ' up', disabled: i === 0,
        onClick: function () { listMove('basics.profiles', p.id, -1); }
      }));
      head.appendChild(iconButton({
        icon: 'chevron-down', tip: 'Move down', key: 'down:basics.profiles:' + p.id,
        label: 'Move ' + name + ' down', disabled: i === list.length - 1,
        onClick: function () { listMove('basics.profiles', p.id, 1); }
      }));
      head.appendChild(iconButton({
        icon: 'trash', tip: 'Delete', danger: true, key: 'del:basics.profiles:' + p.id, label: 'Delete ' + name,
        onClick: function () {
          if (!needDialogs()) return;
          ui.confirmDelete(name, function () { listRemove('basics.profiles', p.id); });
        }
      }));
      art.appendChild(head);

      var body = U.el('div', { class: 'rbf-entry__body rb-col' });
      body.appendChild(grid([
        field({
          path: 'basics.profiles.' + i + '.network', kind: 'select', label: 'Network',
          value: p.network, options: NETWORKS
        }),
        field({ path: 'basics.profiles.' + i + '.url', label: 'URL', value: p.url, placeholder: 'linkedin.com/in/you' })
      ]));
      body.appendChild(field({ path: 'basics.profiles.' + i + '.label', label: 'Display text', value: p.label, placeholder: 'linkedin.com/in/you' }));
      art.appendChild(body);
      box.appendChild(art);
    });

    box.appendChild(textButton({
      label: 'Add a link', icon: 'plus', block: true, key: 'add:basics.profiles', onClick: addProfile
    }));
    return box;
  }

  function addProfile() { listAdd('basics.profiles', null, blankProfile); }

  /* ------------------------------------------------------------------ photo */

  var PHOTO_MAX_W = 400;
  var PHOTO_MAX_BYTES = 12 * 1024 * 1024;
  /* model.validate rejects a photo data URL at 3,000,000 characters. */
  var PHOTO_MAX_CHARS = 2900000;

  function photoGroup(resume) {
    var wrap = fieldWrap('basics.photo');
    wrap.appendChild(U.el('span', { class: 'rb-label', text: 'Photo' }));
    wrap.appendChild(U.el('ul', { class: 'rbf-findings', id: nextId() + '-f', hidden: true }));

    if (resume.basics.photo) {
      var row = U.el('div', { class: 'rb-row' });
      row.appendChild(U.el('img', {
        class: 'rbf-photo', src: resume.basics.photo, alt: 'Your photo as it will appear on the page'
      }));
      var acts = U.el('div', { class: 'rbf-entry__body' }, [
        textButton({ label: 'Replace', icon: 'upload', onClick: pickPhoto }),
        iconButton({
          icon: 'trash', tip: 'Remove photo', danger: true, label: 'Remove the photo',
          onClick: function () {
            if (!needDialogs()) return;
            ui.confirmDelete('photo', function () { RB.store.setField('basics.photo', null); });
          }
        })
      ]);
      row.appendChild(acts);
      wrap.appendChild(row);
    } else {
      wrap.appendChild(U.el('p', {
        class: 'rb-hint',
        text: LOCALE.prefersPhoto
          ? 'A photo is expected in your region. It is stored in this browser and never uploaded.'
          : 'Optional, and uncommon in your region. It is stored in this browser and never uploaded.'
      }));
      wrap.appendChild(textButton({ label: 'Upload a photo', icon: 'upload', onClick: pickPhoto }));
    }

    wrap.appendChild(field({
      path: 'design.photoSlot', kind: 'switch', label: 'Show the photo on the page',
      value: !!(resume.design && resume.design.photoSlot)
    }));
    return wrap;
  }

  function pickPhoto() {
    if (!U.readFile || !U.readAsDataURL) { toast('This browser cannot open a file picker.', 'error'); return; }
    U.readFile('image/png,image/jpeg,image/webp,image/gif,image/avif')
      .then(function (file) {
        if (file.size > PHOTO_MAX_BYTES) throw new Error('That image is over 12 MB. Pick a smaller one.');
        return U.readAsDataURL(file);
      })
      .then(function (dataUrl) { return shrinkImage(dataUrl, PHOTO_MAX_W); })
      .then(function (small) {
        if (small.length > PHOTO_MAX_CHARS) {
          throw new Error('That image is still too large to store. Try a smaller photo.');
        }
        RB.store.update(function (draft) {
          draft.basics.photo = small;
          draft.design.photoSlot = true;
        }, { source: 'field', coalesce: false });
        toast('Photo added. It is saved in this browser with your resume.', 'success');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        toast(err && err.message ? err.message : 'That image could not be read. Try a PNG or JPEG.', 'error');
      });
  }

  /* Downscaled on a canvas so a 12 MP phone photo still fits in local storage.
   * Falls back to the original data URL when canvas is unavailable. */
  function shrinkImage(dataUrl, maxWidth) {
    return new Promise(function (resolve) {
      var img = new global.Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(dataUrl); return; }
        var scale = Math.min(1, maxWidth / w);
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        try {
          var canvas = doc.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext('2d');
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  /* ------------------------------------------------------- target & format */

  /* Letter is the regional default only where it is actually printed;
   * everywhere else A4. No lookup is made, this is the browser locale. */
  var LETTER_REGIONS = [
    'US', 'CA', 'MX', 'CU', 'DO', 'GT', 'CR', 'NI', 'PA', 'PR', 'VI', 'BS', 'BZ', 'HT', 'CO',
    'VE', 'GY', 'SR', 'JM', 'TT', 'AG', 'DM', 'GD', 'KN', 'LC', 'VC', 'BM', 'PH'
  ];

  function defaultPageSize(region) {
    return LETTER_REGIONS.indexOf(String(region || '').toUpperCase()) === -1 ? 'A4' : 'Letter';
  }

  function targetBlock(resume) {
    var meta = resume.meta || {};
    var design = resume.design || {};
    var recommended = defaultPageSize(LOCALE.region);
    var d = disclosure('target', 'target', { path: 'meta.targetRole', fallback: 'Target and format' }, false);

    d.body.appendChild(group('Target', [
      field({
        path: 'meta.targetRole', label: 'Target role', value: meta.targetRole,
        placeholder: 'Senior Product Designer',
        hint: 'Used by the checks and the suggestions. Never printed on the page.'
      }),
      field({
        path: 'meta.targetCompany', label: 'Target company', value: meta.targetCompany,
        placeholder: 'Optional', hint: 'Also never printed on the page.'
      }),
      field({
        path: 'meta.experienceLevel', kind: 'select', label: 'Experience level', value: meta.experienceLevel,
        options: [
          { value: '', label: 'Not stated' },
          { value: 'entry', label: 'Entry level' },
          { value: 'mid', label: 'Mid level' },
          { value: 'senior', label: 'Senior' },
          { value: 'lead', label: 'Lead or principal' },
          { value: 'executive', label: 'Executive' }
        ]
      })
    ]));

    var applyDefault = textButton({
      label: 'Use the ' + recommended + ' default', icon: 'refresh',
      disabled: design.pageSize === recommended,
      onClick: function () {
        if (design.pageSize === recommended) return;
        RB.store.setField('design.pageSize', recommended);
        toast('Page size set to ' + recommended + '.', 'success');
      }
    });

    d.body.appendChild(group('Format', [
      field({
        path: 'meta.dateFormat', kind: 'select', label: 'Date format', value: meta.dateFormat,
        options: [
          { value: 'MMM YYYY', label: 'Mar 2021' },
          { value: 'MMMM YYYY', label: 'March 2021' },
          { value: 'MM/YYYY', label: '03/2021' },
          { value: 'YYYY', label: '2021' }
        ],
        hint: 'Applies to every date on the page. What you type is never rewritten.'
      }),
      field({
        path: 'design.pageSize', kind: 'select', label: 'Page size', value: design.pageSize,
        options: [
          { value: 'Letter', label: 'Letter, 8.5 by 11 in' },
          { value: 'A4', label: 'A4, 210 by 297 mm' }
        ],
        hint: 'Your browser reports ' + LOCALE.region + ', where ' + recommended + ' is the usual size.'
      }),
      applyDefault
    ]));
    return d.details;
  }

  /* -------------------------------------------------------------- linter UI */

  /* The analysis module is owned elsewhere and its surface is not fixed, so we
   * probe the plausible shapes and degrade to "no findings" rather than break.
   * Assumed finding shape: { path, message, severity, hint }. */
  function readFindings(resume) {
    var R = global.RB || {};
    var host = R.lint || R.analysis || R.linter || null;
    if (!host) return [];
    var out = null;
    try {
      if (typeof host === 'function') out = host(resume);
      else if (typeof host.findings === 'function') out = host.findings(resume);
      else if (typeof host.run === 'function') out = host.run(resume);
      else if (typeof host.lint === 'function') out = host.lint(resume);
      else if (typeof host.analyze === 'function') out = host.analyze(resume);
      else if (typeof host.check === 'function') out = host.check(resume);
      else out = host.findings || host.issues || host.results || null;
    } catch (e) {
      return [];
    }
    if (!out) return [];
    if (!Array.isArray(out)) out = out.findings || out.issues || out.results || out.problems || out.errors;
    if (!Array.isArray(out)) return [];
    return out.map(function (f) {
      if (!f) return null;
      if (typeof f === 'string') return { path: '', message: f, severity: 'warn' };
      return {
        path: String(f.path || f.field || f.bind || f.target || ''),
        message: String(f.message || f.text || f.title || f.detail || ''),
        severity: String(f.severity || f.level || 'warn').toLowerCase(),
        hint: f.hint || f.fix || f.suggestion || ''
      };
    }).filter(Boolean);
  }

  function findingsForPath(list, path) {
    return list.filter(function (f) {
      if (!f.path) return false;
      return f.path === path || path.indexOf(f.path) === 0 || f.path.indexOf(path) === 0;
    });
  }

  function severityTone(sev) {
    if (sev === 'error' || sev === 'fail' || sev === 'high') return 'fail';
    if (sev === 'warn' || sev === 'warning' || sev === 'medium') return 'warn';
    if (sev === 'pass' || sev === 'ok') return 'pass';
    return 'info';
  }

  function renderFindings() {
    if (!active) return;
    var list = active.findings || [];
    U.qsa('[data-field-path]', active.el).forEach(function (wrap) {
      var path = wrap.getAttribute('data-field-path');
      var ul = U.qs('.rbf-findings', wrap);
      if (!ul) return;
      var hits = findingsForPath(list, path);
      if (!hits.length) {
        if (ul.getAttribute('data-sig')) ul.removeAttribute('data-sig');
        if (!ul.hidden) { ul.hidden = true; ul.textContent = ''; }
        return;
      }
      var sig = hits.map(function (f) { return f.severity + '|' + f.message + '|' + f.hint; }).join('~');
      if (ul.getAttribute('data-sig') === sig) return;
      ul.setAttribute('data-sig', sig);
      ul.hidden = false;
      ul.textContent = '';
      hits.forEach(function (f) {
        var li = U.el('li', { class: 'rbf-finding' });
        li.appendChild(U.el('span', { class: 'rb-badge rb-badge--' + severityTone(f.severity), text: f.severity }));
        li.appendChild(U.el('span', { class: 'rbf-finding__msg', text: f.message + (f.hint ? ' ' + f.hint : '') }));
        ul.appendChild(li);
      });
    });
  }

  function refreshFindings() {
    if (!active) return;
    var resume = RB.store.get();
    if (!resume) return;
    active.findings = readFindings(resume);
    renderFindings();
  }

  function scheduleFindings() {
    if (!active || active.findingsScheduled) return;
    active.findingsScheduled = true;
    U.requestIdle(function () {
      if (!active) return;
      active.findingsScheduled = false;
      refreshFindings();
    }, 400);
  }

  /* ----------------------------------------------------------------- render */

  function shapeSignature(resume) {
    var parts = [];
    function ids(node, out) {
      if (Array.isArray(node)) { node.forEach(function (n) { ids(n, out); }); return; }
      if (node && typeof node === 'object') {
        if (node.id) out.push(node.id);
        Object.keys(node).forEach(function (k) { if (k !== 'id') ids(node[k], out); });
      }
    }
    (resume.sections || []).forEach(function (s) {
      parts.push('s:' + s.id + ':' + s.type + ':' + (s.order || 0) + ':' + (s.pinned ? 1 : 0));
    });
    model.SECTION_TYPES.forEach(function (def) {
      if (!def.hasMany) return;
      var out = [];
      ids(model.sectionEntries(resume, def.type), out);
      parts.push(def.type + ':' + out.join(','));
    });
    var profileIds = [];
    ids(resume.basics && resume.basics.profiles, profileIds);
    parts.push('p:' + profileIds.join(','));
    return parts.join('|');
  }

  function openAncestors(node) {
    var details = node.closest ? node.closest('details') : null;
    while (details) {
      details.setAttribute('open', '');
      var parent = details.parentElement;
      details = parent && parent.closest ? parent.closest('details') : null;
    }
  }

  function captureFocus() {
    var a = doc.activeElement;
    if (!active || !a || !active.el.contains(a)) return null;
    var snap = { key: a.getAttribute('data-key'), path: a.getAttribute('data-path') };
    try {
      if (typeof a.selectionStart === 'number') {
        snap.start = a.selectionStart;
        snap.end = a.selectionEnd;
      }
    } catch (e) { /* selection is unreadable on some input types */ }
    return snap;
  }

  function restoreFocus(snap) {
    if (!snap || !active) return;
    var node = null;
    if (snap.key) node = U.qs('[data-key="' + snap.key + '"]', active.el);
    if (!node && snap.path) node = U.qs('[data-path="' + snap.path + '"]', active.el);
    if (!node) return;
    openAncestors(node);
    if (typeof node.focus === 'function') node.focus();
    if (typeof snap.start === 'number' && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(snap.start, snap.end); } catch (e) { /* not supported here */ }
    }
  }

  function focusPendingChild() {
    var pending = active && active.pendingChild;
    if (!pending) return;
    active.pendingChild = null;
    var box = U.qs('[data-list="' + pending.list + '"]', active.el);
    if (!box) return;
    var kids = Array.prototype.filter.call(box.children, function (n) { return n.hasAttribute('data-entry'); });
    var node = kids[Math.max(0, Math.min(pending.at, kids.length - 1))];
    if (!node) return;
    openAncestors(node);
    if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    var control = U.qs('input, textarea, select', node);
    if (control && typeof control.focus === 'function') control.focus();
  }

  function render() {
    if (!active || !active.el) return;
    var resume = RB.store.get();
    if (!resume) return;

    var scrollTop = active.el.scrollTop;
    var focus = captureFocus();

    var frag = U.el('div', { class: 'rbf rb-col' });
    frag.appendChild(toolbar());
    frag.appendChild(profileBlock(resume));
    frag.appendChild(targetBlock(resume));
    var refs = orderedWithIndex(resume);
    refs.forEach(function (ref, displayIndex) { frag.appendChild(sectionBlock(ref, resume, refs.length, displayIndex)); });

    active.el.textContent = '';
    active.el.appendChild(frag);
    active.el.scrollTop = scrollTop;
    active.signature = shapeSignature(resume);
    active.findings = readFindings(resume);
    renderFindings();
    /* The rebuild leaves every [data-label-for] span empty — the disclosure
     * titles, the profile names — so the summaries would announce as bare
     * controls until the next keystroke. Same pass the live values need. */
    syncValues(resume);
    restoreFocus(focus);
    focusPendingChild();
  }

  function toolbar() {
    var bar = U.el('div', { class: 'rbf-toolbar rb-row rb-wrap' });
    var toggle = textButton({
      label: 'Collapse all', icon: 'chevron-down',
      onClick: function () {
        var blocks = U.qsa('details', active.el);
        var anyOpen = blocks.some(function (d) { return d.open; });
        blocks.forEach(function (d) { d.open = !anyOpen; });
        var label = U.qs('.rbf-btn__label', toggle);
        if (label) label.textContent = anyOpen ? 'Expand all' : 'Collapse all';
      }
    });
    bar.appendChild(toggle);
    bar.appendChild(U.el('span', { class: 'rb-spacer' }));
    bar.appendChild(U.el('span', { class: 'rb-hint rb-nowrap', text: 'Saved to this browser' }));
    return bar;
  }

  function syncValues(resume) {
    if (!active || !active.el) return;
    var focused = doc.activeElement;

    U.qsa('[data-path]', active.el).forEach(function (node) {
      var path = node.getAttribute('data-path');
      var kind = node.getAttribute('data-kind') || 'text';
      var v = model.getPath(resume, path);
      if (kind === 'chips') {
        renderChips(node, U.qs('.rbf-chips', node), Array.isArray(v) ? v : []);
        return;
      }
      if (node === focused) return;
      if (kind === 'check') {
        if (node.checked !== !!v) node.checked = !!v;
        return;
      }
      var text = kind === 'lines'
        ? (Array.isArray(v) ? v.join('\n') : (v == null ? '' : String(v)))
        : (v == null ? '' : String(v));
      if (node.value !== text) node.value = text;
    });

    U.qsa('[data-label-for]', active.el).forEach(function (node) {
      var paths = node.getAttribute('data-label-for').split(',');
      var label = '';
      for (var i = 0; i < paths.length; i++) {
        var v = model.getPath(resume, paths[i]);
        if (v != null && String(v).trim()) { label = String(v); break; }
      }
      if (!label) label = node.getAttribute('data-fallback') || '';
      if (node.textContent !== label) node.textContent = label;
    });

    U.qsa('[data-count]', active.el).forEach(function (node) {
      var text = String(model.sectionEntries(resume, node.getAttribute('data-count')).length);
      if (node.textContent !== text) node.textContent = text;
      node.hidden = text === '0';
    });

    U.qsa('[data-flag]', active.el).forEach(function (node) {
      var on = !!model.getPath(resume, node.getAttribute('data-flag'));
      var attr = on ? 'true' : 'false';
      if (node.getAttribute('aria-pressed') !== attr) node.setAttribute('aria-pressed', attr);
      var label = node.getAttribute(on ? 'data-on-label' : 'data-off-label');
      if (label && node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
      var tip = node.getAttribute(on ? 'data-on-tip' : 'data-off-tip');
      if (tip && node.getAttribute('data-tip') !== tip) node.setAttribute('data-tip', tip);
      var icon = node.getAttribute(on ? 'data-on-icon' : 'data-off-icon');
      if (icon && node.getAttribute('data-icon') !== icon) {
        node.setAttribute('data-icon', icon);
        var svg = iconEl(icon, 'sm');
        if (svg) { node.textContent = ''; node.appendChild(svg); }
      }
    });

    U.qsa('[data-blocked-by]', active.el).forEach(function (node) {
      var blocked = !!model.getPath(resume, node.getAttribute('data-blocked-by'));
      if (node.hidden !== blocked) node.hidden = blocked;
    });
  }

  /* ------------------------------------------------------------- bus wiring */

  function onChange() {
    if (!active) return;
    var resume = RB.store.get();
    if (!resume) return;
    if (shapeSignature(resume) !== active.signature) render();
    else syncValues(resume);
    scheduleFindings();
  }

  function scrollTo(node) {
    openAncestors(node);
    if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    /* Scrolling to the field is the point; taking the caret there is not. The
     * selection event fires while the person is typing on the page, and pulling
     * focus into this panel mid-sentence sends the next keystroke to the wrong
     * box — and makes the document's own undo shortcut read as typing, so the
     * browser's one-character undo takes the place of the real one. */
    if (doc.activeElement && doc.activeElement.isContentEditable) return;
    var control = node.matches && node.matches('input, textarea, select') ? node : U.qs('input, textarea, select', node);
    if (control && typeof control.focus === 'function') control.focus();
  }

  function onSelection(payload) {
    if (!active || !payload) return;
    if (payload.path) {
      var node = U.qs('[data-path="' + payload.path + '"]', active.el);
      if (node) { scrollTo(node); scheduleFindings(); return; }
    }
    var id = payload.roleId || payload.entryId;
    if (id) {
      var entry = U.qs('[data-entry="' + id + '"]', active.el);
      if (entry) scrollTo(entry);
    }
    scheduleFindings();
  }

  function onSectionFocus(payload) {
    if (!active || !payload || !payload.sectionId) return;
    var node = U.qs('[data-section="' + payload.sectionId + '"]', active.el);
    if (!node) return;
    node.setAttribute('open', '');
    var sum = U.qs('summary', node);
    if (sum && typeof sum.focus === 'function') sum.focus();
  }

  function dispose() {
    if (!active) return;
    (active.offs || []).forEach(function (off) { try { off(); } catch (e) { /* already gone */ } });
    active.offs = null;
    if (active.el && active.onFocusIn) active.el.removeEventListener('focusin', active.onFocusIn);
    active = null;
  }

  function mount(el) {
    if (!el || !bind()) return;
    dispose();
    ensureStyles();

    if (!RB.store.isReady()) {
      RB.store.whenReady().then(function () {
        if (el.isConnected !== false) mount(el);
      });
      return;
    }

    active = {
      el: el, offs: [], signature: '', findings: [],
      findingsScheduled: false, pendingChild: null, onFocusIn: scheduleFindings
    };
    active.offs.push(bus.on('change', onChange));
    active.offs.push(bus.on('selection', onSelection));
    active.offs.push(bus.on('section:focus', onSectionFocus));
    el.addEventListener('focusin', active.onFocusIn);

    render();
  }

  /* --------------------------------------------------------------- register */

  var definition = { id: 'edit', title: 'Edit', icon: 'file-text', mount: mount };
  var RB = global.RB;
  if (RB && RB.panels && typeof RB.panels.register === 'function') {
    RB.panels.register(definition);
    /* AGENTS.md documents register(id, definition); the shipped registry takes
     * a single definition object. Keep the documented form working too. */
    if (typeof RB.panels.all === 'function' && !RB.panels.all().some(function (p) { return p && p.id === 'edit'; })) {
      RB.panels.register('edit', definition);
    }
  }

  if (RB && RB.lifecycle && typeof RB.lifecycle.on === 'function') {
    /* 'unmount' also fires when another panel tab is swapped. */
    RB.lifecycle.on('unmount', function (payload) {
      if (payload && payload.scope === 'panel' && payload.panelId !== 'edit') return;
      dispose();
    });
  }

  global.RB.forms = {
    id: 'edit',
    focus: function (path) {
      if (!active || !path) return false;
      var node = U.qs('[data-path="' + path + '"]', active.el);
      if (!node) return false;
      scrollTo(node);
      return true;
    },
    refresh: function () { render(); },
    findings: function () { return (active && active.findings) || []; },
    sectionCount: function () {
      var r = RB.store.get();
      return r ? (r.sections || []).length : 0;
    },
    dispose: dispose
  };
})(window);
