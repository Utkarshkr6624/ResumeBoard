/* Resumeboard — the Proof panel
 *
 * A consistency pass over the whole resume: one date format, one word for an
 * open end, one entry per employer, no role running backwards. The rules live
 * in assets/js/analysis/proof.js; this file only presents them and applies
 * them, and every apply is a single store.write so the whole pass is one
 * undo.
 *
 * The rules are deterministic and offline. Nothing here sends anything
 * anywhere, and nothing is written until a button is pressed.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  if (!U || !RB.store || !RB.model || !RB.icons) return;

  var doc = global.document;
  var el = U.el;
  var icons = RB.icons;
  var store = RB.store;
  var model = RB.model;

  var STYLE_ID = 'rb-proof-style';
  var formatSeq = 0;

  var CSS = [
    '.rb-pr{display:flex;flex-direction:column;gap:var(--rb-space-4);padding:var(--rb-space-4);min-width:0}',
    '.rb-pr__lead{margin:0;font-size:var(--rb-text-sm);line-height:1.55;color:var(--rb-text-secondary)}',
    '.rb-pr__head{display:flex;flex-wrap:wrap;gap:var(--rb-space-2);align-items:center}',
    '.rb-pr__card{border:1px solid var(--rb-border);border-radius:var(--rb-radius-lg);background:var(--rb-bg-elevated);overflow:hidden}',
    '.rb-pr__cardhead{display:flex;align-items:center;gap:var(--rb-space-2);padding:var(--rb-space-3);',
    '  background:var(--rb-bg-inset);border-bottom:1px solid var(--rb-border-subtle)}',
    '.rb-pr__cardtitle{font-size:var(--rb-text-sm);font-weight:650;min-width:0}',
    '.rb-pr__body{padding:var(--rb-space-3);display:flex;flex-direction:column;gap:var(--rb-space-3);min-width:0}',
    '.rb-pr__issue{display:flex;flex-direction:column;gap:var(--rb-space-2);padding:var(--rb-space-3) 0;',
    '  border-top:1px solid var(--rb-border-subtle);min-width:0}',
    '.rb-pr__issue:first-child{padding-top:0;border-top:0}',
    '.rb-pr__msg{font-size:var(--rb-text-sm);line-height:1.5;color:var(--rb-text);overflow-wrap:anywhere}',
    '.rb-pr__where{font-size:var(--rb-text-xs);color:var(--rb-text-muted);margin:0;overflow-wrap:anywhere}',
    '.rb-pr__ev{font-family:var(--rb-font-mono);font-size:var(--rb-text-xs);line-height:1.5;color:var(--rb-text-secondary);',
    '  background:var(--rb-bg-inset);border-left:2px solid var(--rb-border-strong);',
    '  border-radius:0 var(--rb-radius-xs) var(--rb-radius-xs) 0;padding:var(--rb-space-2) var(--rb-space-3);',
    '  white-space:pre-wrap;overflow-wrap:anywhere;margin:0}',
    '.rb-pr__row{display:flex;flex-wrap:wrap;gap:var(--rb-space-2);align-items:center}',
    '.rb-pr__empty{display:flex;flex-direction:column;align-items:center;gap:var(--rb-space-2);text-align:center;',
    '  padding:var(--rb-space-7) var(--rb-space-4);color:var(--rb-text-muted);font-size:var(--rb-text-sm);line-height:1.55}',
    '.rb-pr__emptyic{width:40px;height:40px;display:grid;place-items:center;border-radius:var(--rb-radius-lg);',
    '  background:var(--rb-bg-sunken);color:var(--rb-green-600)}',
    '.rb-pr__emptytitle{font-size:var(--rb-text-md);font-weight:650;color:var(--rb-text);margin:0}',
    '.rb-pr__emptytext{margin:0;max-width:42ch}',
    '.rb-pr__fmt{display:flex;flex-direction:column;gap:var(--rb-space-1)}',
    '.rb-pr__status{min-height:1.2em;font-size:var(--rb-text-xs);color:var(--rb-text-muted);margin:0}',
    '@media (max-width:480px){.rb-pr{padding:var(--rb-space-3)}',
    '  .rb-pr__row .rb-btn{flex:1 1 auto}}'
  ].join('');

  function ensureStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    doc.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
  }

  function icon(name, size) { return el('span', { 'aria-hidden': 'true', html: icons.svg(name, { size: size || 'sm' }) }); }

  function badge(tone, label) {
    return el('span', { class: 'rb-badge rb-badge--' + tone, text: label });
  }

  function button(label, variant, onClick, tip) {
    var b = el('button', { type: 'button', class: 'rb-btn rb-btn--' + variant + ' rb-btn--sm', text: label });
    if (tip) b.setAttribute('data-tip', tip);
    b.addEventListener('click', onClick);
    return b;
  }

  /* "Experience · end" is a path, not a sentence. */
  var FIELD_NAMES = {
    start: 'Start date', end: 'End date', date: 'Date', company: 'Company',
    position: 'Position', title: 'Title', name: 'Name', institution: 'Institution',
    organization: 'Organization', role: 'Role', summary: 'Summary',
    highlights: 'Highlights', label: 'Group', keywords: 'Skills', issuer: 'Issuer',
    area: 'Field of study', score: 'Grade', studyType: 'Degree', fluency: 'Fluency',
    url: 'Link', location: 'Location'
  };

  function fieldLabel(path) {
    var parts = String(path).split('.').filter(function (p) { return p && !/^\d+$/.test(p); });
    if (!parts.length) return '';
    var meta = model.typeMeta(parts[0]);
    var head = meta ? meta.label : parts[0];
    var tail = parts[parts.length - 1];
    return parts.length > 1
      ? head + ' · ' + (FIELD_NAMES[tail] || tail)
      : (FIELD_NAMES[head] || head);
  }

  /* Every write goes through the store. One update, one undo entry. */
  function applyDraft(mutator, opts) {
    var ran = false;
    try {
      store.update(function (draft) {
        mutator(draft);
        ran = true;
      }, { source: 'update', coalesce: false });
    } catch (err) {
      RB.ui.toast('That change could not be saved. Your resume is unchanged.', { tone: 'error' });
      return false;
    }
    return ran;
  }

  function goto(path) {
    var host = U.qs('#rb-doc');
    if (!host || !path) return false;
    var target = host.querySelector('[data-bind="' + String(path).replace(/"/g, '') + '"]');
    if (!target) return false;
    if (target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    if (target.focus) target.focus({ preventScroll: true });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Groups
   * ------------------------------------------------------------------ */

  var GROUPS = [
    { id: 'date', label: 'Dates', note: 'One format, one word for an open end, and no range that runs backwards.', ids: ['date.format', 'date.present', 'date.reversed', 'date.future'] },
    { id: 'employer', label: 'Employers', note: 'Each employer appears once, written the same way every time.', ids: ['employer.duplicate', 'employer.spelling'] },
    { id: 'overlap', label: 'Overlaps', note: 'Two roles at one employer cannot both be running at the same time.', ids: ['overlap.role'] }
  ];

  function severityTone(sev) {
    if (sev === 'error') return 'fail';
    if (sev === 'warn') return 'warn';
    return 'info';
  }

  function severityWord(sev) {
    if (sev === 'error') return 'Needs a look';
    if (sev === 'warn') return 'Inconsistent';
    return 'Worth knowing';
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  var host = null;
  var scheduled = false;
  var pending = null;
  /* Held across repaints. A store write repaints this panel, and a status line
   * that only lives in the DOM vanishes under the reader's cursor the moment
   * their own change lands — taking the only confirmation they were given. */
  var formatNote = '';

  /* The panel container is the scroll region and belongs to the shell; the
   * padded, gapped column inside it is ours. */
  function paint(viewport) {
    if (!viewport) return;
    viewport.textContent = '';
    var root = el('div', { class: 'rb-pr' });
    viewport.appendChild(root);
    var resume = store.get();

    if (!RB.proof) {
      root.appendChild(empty('alert-circle', 'Proof is unavailable',
        'The consistency module did not load, so nothing is being checked. The rest of the editor is unaffected.'));
      return;
    }

    var result;
    try {
      result = RB.proof.run(resume);
    } catch (err) {
      root.appendChild(empty('alert-circle', 'The check stopped', 'The resume could not be read for consistency. Nothing has been changed.'));
      return;
    }

    root.appendChild(el('p', {
      class: 'rb-pr__lead',
      text: 'A pass over the whole document, not one line at a time. It reads nothing off the network and writes nothing until you press a button.'
    }));

    if (!result.issues.length) {
      root.appendChild(empty('check-circle', 'Nothing inconsistent',
        'Every date reads the same way, each employer appears once, and no two roles overlap. You can close this.'));
      root.appendChild(formatControl(resume));
      return;
    }

    var errors = result.issues.filter(function (f) { return f.severity === 'error'; }).length;
    var head = el('div', { class: 'rb-pr__head' }, [
      badge(errors ? 'fail' : 'warn', result.issues.length + ' to go over'),
      result.fixable ? badge('info', result.fixable + ' can be fixed at once') : null
    ].filter(Boolean));

    if (result.fixable) {
      var fixAll = el('button', { type: 'button', class: 'rb-btn rb-btn--primary rb-btn--sm' }, [
        icon('wand'),
        el('span', { text: 'Fix all ' + result.fixable })
      ]);
      fixAll.addEventListener('click', function () { fixEverything(); });
      head.appendChild(el('span', { class: 'rb-spacer' }));
      head.appendChild(fixAll);
    }
    root.appendChild(head);

    GROUPS.forEach(function (group) {
      var list = result.issues.filter(function (f) { return group.ids.indexOf(f.id) !== -1; });
      if (!list.length) return;
      root.appendChild(renderGroup(group, list));
    });

    /* Always offered, not only when a date is wrong: the format is a setting
     * that decides what every exported file prints, and a clean resume is
     * exactly when someone wants to change it. */
    root.appendChild(formatControl(resume));
  }

  function renderGroup(group, list) {
    var body = el('div', { class: 'rb-pr__body' }, [
      el('p', { class: 'rb-pr__where', text: group.note })
    ]);
    list.forEach(function (f) { body.appendChild(renderIssue(f)); });
    return el('section', { class: 'rb-pr__card', 'aria-label': group.label }, [
      el('div', { class: 'rb-pr__cardhead' }, [
        el('h3', { class: 'rb-pr__cardtitle', text: group.label }),
        el('span', { class: 'rb-spacer' }),
        el('span', { class: 'rb-tab__count rb-an__num', text: String(list.length) })
      ]),
      body
    ]);
  }

  function renderIssue(f) {
    var actions = el('div', { class: 'rb-pr__row' });
    if (f.fix) {
      actions.appendChild(button(f.fix.label, 'primary', function () { runOne(f); },
        f.fix.bulk ? 'Undo with ' + (U.isMac() ? 'Cmd+Z' : 'Ctrl+Z') : 'One undo takes this back'));
    } else {
      actions.appendChild(el('span', { class: 'rb-pr__where', text: 'No automatic fix for this one.' }));
    }
    if (f.path && gotoWorks(f.path)) {
      actions.appendChild(button('Show on resume', 'secondary', function () { goto(f.path); }));
    }

    var node = el('article', { class: 'rb-pr__issue' }, [
      el('div', { class: 'rb-pr__row' }, [
        badge(severityTone(f.severity), severityWord(f.severity)),
        el('p', { class: 'rb-pr__msg', text: f.message })
      ])
    ]);
    if (f.evidence) node.appendChild(el('p', { class: 'rb-pr__ev', text: f.evidence }));
    var where = fieldLabel(f.path);
    if (where) node.appendChild(el('p', { class: 'rb-pr__where', text: where }));
    node.appendChild(actions);
    return node;
  }

  function gotoWorks(path) {
    var doc_ = U.qs('#rb-doc');
    if (!doc_ || !path) return false;
    return !!doc_.querySelector('[data-bind="' + String(path).replace(/"/g, '') + '"]');
  }

  function empty(iconName, title, text) {
    return el('div', { class: 'rb-pr__empty' }, [
      el('span', { class: 'rb-pr__emptyic', html: icons.svg(iconName, { size: 'xl' }) }),
      el('p', { class: 'rb-pr__emptytitle', text: title }),
      el('p', { class: 'rb-pr__emptytext', text: text })
    ]);
  }

  /* ------------------------------------------------------------------ *
   * The date format control
   * ------------------------------------------------------------------ */

  function dominantFormat() {
    var counts = Object.create(null);
    var resume = store.get();
    if (!resume) return 'MMM YYYY';
    var all = [];
    (Array.isArray(resume.experience) ? resume.experience : []).forEach(function (e) {
      (Array.isArray(e && e.roles) ? e.roles : []).forEach(function (r) {
        if (!r) return;
        all.push(r.start, r.end);
      });
    });
    (Array.isArray(resume.education) ? resume.education : []).forEach(function (e) {
      if (!e) return;
      all.push(e.start, e.end);
    });
    all.forEach(function (v) {
      var f = RB.proof.formatOf(v);
      if (f) counts[f] = (counts[f] || 0) + 1;
    });
    var keys = Object.keys(counts);
    if (!keys.length) return resume.meta && resume.meta.dateFormat ? resume.meta.dateFormat : 'MMM YYYY';
    return keys.sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })[0];
  }

  function formatControl(resume) {
    formatSeq += 1;
    var id = 'rb-pr-format-' + formatSeq;
    var wanted = resume.meta ? resume.meta.dateFormat : '';
    var known = RB.proof.DATE_FORMATS.some(function (f) { return f.id === wanted; });
    var current = known ? wanted : dominantFormat();
    var select = el('select', { id: id, class: 'rb-select rb-select--sm' });
    RB.proof.DATE_FORMATS.forEach(function (f) {
      var opt = el('option', { value: f.id, text: f.id + ' — ' + f.label });
      if (f.id === current) opt.selected = true;
      select.appendChild(opt);
    });
    select.value = current;
    var status = el('p', { class: 'rb-pr__status', role: 'status', 'aria-live': 'polite', text: formatNote });

    select.addEventListener('change', function () {
      var plan = RB.proof.setDateFormat(store.get(), select.value);
      if (!plan) {
        formatNote = 'Every date already reads that way.';
        status.textContent = formatNote;
        return;
      }
      var applied = applyDraft(function (draft) {
        plan.writes.forEach(function (w) { model.setPath(draft, w.path, w.value); });
        draft.meta.dateFormat = plan.format;
      });
      formatNote = applied
        ? U.pluralize(plan.changed, 'date') + ' rewritten as ' + select.value + '.'
        : 'That change could not be saved.';
      status.textContent = formatNote;
      if (applied) U.announce(formatNote);
    });

    var wrap = el('div', { class: 'rb-pr__card' }, [
      el('div', { class: 'rb-pr__cardhead' }, [
        el('h3', { class: 'rb-pr__cardtitle', text: 'Date format' })
      ]),
      el('div', { class: 'rb-pr__body' }, [
        el('p', { class: 'rb-pr__where', text: 'Every date on the resume follows one format, and it is the one printed in your exported files.' }),
        el('div', { class: 'rb-pr__fmt' }, [
          el('label', { class: 'rb-label', for: id, text: 'Use this format everywhere' }),
          select
        ]),
        status
      ])
    ]);
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * Mutations
   * ------------------------------------------------------------------ */

  /* Read at click time, not at toast time: a keystroke on the resume while the
     toast was on screen must not be what the Undo button takes back. Undo is a
     linear stack, so a bare undo() there destroys the newer edit instead. */
  function snapshot() { return JSON.stringify(store.get()); }

  /* One store.write for the whole pass, so one undo takes all of it back.
   * replace() rather than update() because some of the repairs splice entries
   * out of the document, which is not something a setField-shaped write can
   * express. */
  function fixEverything() {
    var before = store.get();
    if (!before) return;
    var next = RB.proof.fixAll(before);
    var afterFixAll;
    try {
      store.replace(next, { source: 'update' });
      afterFixAll = snapshot();
    } catch (err) {
      RB.ui.toast('That pass could not be saved. Your resume is unchanged.', { tone: 'error' });
      return;
    }
    var left = RB.proof.run(store.get());
    var n = left.issues.length;
    RB.ui.undoableToast(n ? 'Fixed what could be fixed. ' + U.pluralize(n, 'thing') + ' left to look at.' : 'Everything reads consistently now.', {
      tone: 'success',
      isUnchanged: function () { return snapshot() === afterFixAll; },
      onUndo: function () { store.undo(); }
    });
    U.announce(n ? 'Fixed. ' + n + ' left.' : 'Everything consistent.');
  }

  function runOne(f) {
    var ok = applyDraft(function (draft) { f.fix.apply(draft); });
    if (!ok) {
      RB.ui.toast('That fix had nothing left to change.', { tone: 'warn' });
      return;
    }
    var afterOne = snapshot();
    RB.ui.undoableToast('Fixed.', {
      tone: 'success',
      isUnchanged: function () { return snapshot() === afterOne; },
      onUndo: function () { store.undo(); }
    });
    U.announce('Fixed. ' + f.title + '.');
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function schedule() {
    if (scheduled || !host) return;
    scheduled = true;
    U.requestIdle(function () {
      scheduled = false;
      if (!host) return;
      if (!host.isConnected) { teardown(); return; }
      paint(host);
    }, 280);
  }

  /* The store subscription outlives the panel on purpose, so this only drops
   * the paint that was in flight. Nothing is left listening. */
  function teardown() {
    if (pending) { pending.cancel(); pending = null; }
    host = null;
  }

  function mount(container) {
    teardown();
    if (!container) return;
    ensureStyles();
    container.textContent = '';
    host = container;

    if (!store.get()) {
      host.appendChild(el('div', { class: 'rb-pr' }, [
        empty('clock', 'Loading your resume', 'Proof reads from the saved resume, which is still opening.')
      ]));
      store.whenReady().then(function () { schedule(); });
      return;
    }
    paint(host);
  }

  if (RB.panels && typeof RB.panels.register === 'function') {
    RB.panels.register({
      id: 'proof',
      title: 'Proof',
      icon: 'check',
      mount: mount
    });
  }

  /* The store fires `change` on every keystroke, so the repaint is debounced
   * and lands on an idle slot. Nothing is computed in the input handler. The
   * subscription is held for the life of the page on purpose: the panel is
   * torn down and rebuilt on every tab swap, and re-subscribing on each mount
   * is how a panel ends up with five listeners and five repaints a keystroke. */
  if (RB.bus && typeof RB.bus.on === 'function') {
    RB.bus.on('change', function () {
      if (!host) return;
      if (pending) pending.cancel();
      pending = U.debounce(function () { pending = null; schedule(); }, 400);
      pending();
    });
  }

  RB.lifecycle.on('unmount', function (payload) {
    if (payload && payload.scope === 'panel' && payload.panelId !== 'proof') return;
    teardown();
  });

  RB.proofPanel = {
    show: function () { if (RB.panel && RB.panel.show) RB.panel.show('proof'); },
    mount: mount
  };
})(window);
