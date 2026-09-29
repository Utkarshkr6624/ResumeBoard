/* Resumeboard — the "what will this do" step
 *
 * The one screen in the app where work can be lost, so it is the one screen
 * that says exactly what is about to happen before anything happens.
 *
 * It is a step inside the build dialog rather than a second dialog on top of
 * it: a modal stacked on a modal traps focus twice and puts two Escape
 * handlers in the same keypress. The host (autofill.js) owns the dialog and
 * swaps this in, which keeps one focus trap and one Back button.
 *
 *   RB.mergeStep.render({ current, incoming, source, onBack, onApply })
 *     -> HTMLElement
 *
 * The rules themselves live in assets/js/analysis/merge.js. Nothing here
 * writes to the store: onApply hands the merged resume back and the caller
 * performs the single store.replace.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  if (!U || !RB.merge || !RB.icons || !RB.ui) return;

  var doc = global.document;
  var el = U.el;
  var icons = RB.icons;

  var STYLE_ID = 'rb-merge-step-style';
  var ROW_LIMIT = 40;
  var seq = 0;

  /* Tokens only. Injected rather than shipped in a stylesheet, because the
   * file that owns this screen is this one. */
  var CSS = [
    '.rb-mg{display:flex;flex-direction:column;gap:var(--rb-space-4);min-width:0}',
    '.rb-mg__leadrow{display:flex;gap:var(--rb-space-2);align-items:flex-start}',
    '.rb-mg__list{display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0}',
    '.rb-mg__lead{font-size:var(--rb-text-base);line-height:1.55;color:var(--rb-text-secondary);margin:0}',
    '.rb-mg__modes{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0}',
    '.rb-mg__legend{padding:0;margin:0 0 var(--rb-space-2);font-size:var(--rb-text-sm);font-weight:650;color:var(--rb-text)}',
    '.rb-mg__mode{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--rb-space-3);align-items:start;',
    '  border:1px solid var(--rb-border);border-radius:var(--rb-radius-lg);background:var(--rb-bg-elevated);',
    '  padding:var(--rb-space-3);cursor:pointer;transition:border-color var(--rb-dur-fast) var(--rb-ease-out),background var(--rb-dur-fast) var(--rb-ease-out)}',
    '.rb-mg__mode:hover{border-color:var(--rb-border-strong)}',
    '.rb-mg__mode input{margin:3px 0 0;accent-color:var(--rb-accent-600)}',
    '.rb-mg__mode:has(input:checked){border-color:var(--rb-accent-600);background:var(--rb-accent-50)}',
    'html[data-theme="dark"] .rb-mg__mode:has(input:checked){background:var(--rb-accent-900)}',
    '@media (prefers-color-scheme: dark){',
    '  html:not([data-theme="light"]) .rb-mg__mode:has(input:checked){background:var(--rb-accent-900)}',
    '}',
    '.rb-mg__modetext{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.rb-mg__modetitle{font-size:var(--rb-text-base);font-weight:650;line-height:1.4}',
    '.rb-mg__modeblurb{font-size:var(--rb-text-sm);line-height:1.5;color:var(--rb-text-secondary)}',
    '.rb-mg__tally{font-size:var(--rb-text-xs);color:var(--rb-text-muted);font-variant-numeric:tabular-nums}',
    '.rb-mg__tally b{font-weight:650;color:var(--rb-text)}',
    '.rb-mg__head{display:flex;align-items:baseline;gap:var(--rb-space-2);flex-wrap:wrap}',
    '.rb-mg__head h3{margin:0;font-size:var(--rb-text-md);font-weight:650}',
    '.rb-mg__rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0}',
    '.rb-mg__row{border:1px solid var(--rb-border);border-left-width:3px;border-radius:var(--rb-radius-md);',
    '  padding:var(--rb-space-3);display:flex;flex-direction:column;gap:2px;min-width:0;background:var(--rb-bg-inset)}',
    '.rb-mg__row[data-kind="added"]{border-left-color:var(--rb-green-600)}',
    '.rb-mg__row[data-kind="changed"]{border-left-color:var(--rb-amber-600)}',
    '.rb-mg__row[data-kind="removed"]{border-left-color:var(--rb-red-500)}',
    '.rb-mg__where{font-size:var(--rb-text-xs);color:var(--rb-text-muted);margin:0;overflow-wrap:anywhere}',
    '.rb-mg__field{font-size:var(--rb-text-sm);font-weight:600;margin:0;overflow-wrap:anywhere}',
    '.rb-mg__diff{display:flex;flex-direction:column;gap:2px;margin:0;min-width:0}',
    '.rb-mg__diff span{display:block;font-size:var(--rb-text-sm);line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.rb-mg__del del{text-decoration:line-through;text-decoration-thickness:1px;color:var(--rb-text-secondary)}',
    '.rb-mg__ins ins{text-decoration:none;color:var(--rb-text);font-weight:550}',
    '.rb-mg__row[data-kind="added"] .rb-mg__ins ins{color:var(--rb-green-600)}',
    'html[data-theme="dark"] .rb-mg__row[data-kind="added"] .rb-mg__ins ins{color:var(--rb-green-200)}',
    '.rb-mg__empty{display:flex;flex-direction:column;align-items:center;gap:var(--rb-space-2);text-align:center;',
    '  padding:var(--rb-space-6) var(--rb-space-4);border:1px dashed var(--rb-border);border-radius:var(--rb-radius-lg);',
    '  color:var(--rb-text-muted);font-size:var(--rb-text-sm);line-height:1.55}',
    '.rb-mg__empty strong{color:var(--rb-text);font-size:var(--rb-text-md);font-weight:650}',
    /* Sticky: the diff can be forty rows long, and an Apply button at the
     * bottom of a scroll region is an Apply button nobody finds. */
    '.rb-mg__foot{display:flex;flex-wrap:wrap;gap:var(--rb-space-2);align-items:center;',
    '  position:sticky;bottom:0;z-index:2;margin-top:var(--rb-space-2);padding:var(--rb-space-3) 0;',
    '  background:var(--rb-bg-elevated);border-top:1px solid var(--rb-border-subtle)}',
    '.rb-mg__warn{font-size:var(--rb-text-sm);line-height:1.5;color:var(--rb-text-secondary);margin:0;',
    '  border-left:3px solid var(--rb-red-500);padding-left:var(--rb-space-3)}',
    '@media (max-width:480px){',
    '  /* One row, not two. A sticky bar that stacks at 360px is 129px tall and',
    '     covers the warning above it, which is the one line that has to be read. */',
    '  .rb-mg__foot .rb-btn{flex:1 1 auto;min-width:0}',
    '  .rb-mg__foot .rb-btn__label,.rb-mg__foot .rb-btn span:last-child{white-space:normal}',
    '  .rb-mg__foot{gap:var(--rb-space-2);padding:var(--rb-space-2) 0}',
    '  .rb-mg__mode{grid-template-columns:auto minmax(0,1fr);gap:var(--rb-space-2)}',
    '}'
  ].join('');

  function ensureStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    doc.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
  }

  function icon(name, size) { return el('span', { 'aria-hidden': 'true', html: icons.svg(name, { size: size || 'sm' }) }); }

  function clamp(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
  }

  function count(n, one, many) { return '<b>' + n + '</b> ' + (n === 1 ? one : many); }

  /* tally() is markup so the numbers can be bolded in the card. The live
     region is a text channel, so the same sentence needs a plain form: sent
     as-is it was announced as "less than b greater than 3 less than slash b
     greater than fields added". */
  function tallyText(counts) {
    return tally(counts).replace(/<\/?b>/g, '');
  }

  function tally(counts) {
    var bits = [];
    if (counts.added) bits.push(count(counts.added, 'field', 'fields') + ' added');
    if (counts.changed) bits.push(count(counts.changed, 'field', 'fields') + ' overwritten');
    if (counts.removed) bits.push(count(counts.removed, 'field', 'fields') + ' dropped');
    if (counts.kept) bits.push(count(counts.kept, 'field', 'fields') + ' untouched');
    if (!bits.length) return 'Nothing on this resume would change.';
    return bits.join(' · ') + '.';
  }

  function renderRow(row) {
    var where = el('p', { class: 'rb-mg__where', text: row.section + (row.entry ? ' · ' + row.entry : '') });
    var diff = el('div', { class: 'rb-mg__diff' });
    if (row.before) {
      diff.appendChild(el('span', { class: 'rb-mg__del' }, [
        el('span', { class: 'sr-only', text: 'Currently: ' }),
        el('del', { text: clamp(row.before, 240) })
      ]));
    }
    if (row.after) {
      diff.appendChild(el('span', { class: 'rb-mg__ins' }, [
        el('span', { class: 'sr-only', text: row.before ? 'Becomes: ' : 'Now: ' }),
        el('ins', { text: clamp(row.after, 240) })
      ]));
    }
    return el('li', { class: 'rb-mg__row', dataset: { kind: row.kind } }, [
      where,
      el('p', { class: 'rb-mg__field', text: row.field }),
      diff
    ]);
  }

  /* ------------------------------------------------------------------ */

  function render(opts) {
    opts = opts || {};
    ensureStyles();
    var current = opts.current;
    var incoming = opts.incoming;
    var source = opts.source || 'this import';

    var previews;
    try {
      previews = RB.merge.previews(current, incoming);
    } catch (err) {
      if (global.console) console.error('[merge-step] preview failed', err);
      return el('div', { class: 'rb-mg' }, [
        el('p', { class: 'rb-mg__lead', text: 'The comparison could not be run, so the import will replace what is on the page. You can undo it in one step afterwards.' })
      ]);
    }

    var mode = 'keep';
    var group = 'rb-mg-mode-' + (++seq);
    var root = el('div', { class: 'rb-mg' });
    var listHost = el('div', { class: 'rb-mg__list' });
    var headCount = el('span', { class: 'rb-hint' });
    var applyLabel = el('span', { text: 'Merge and continue' });
    var warnHost = el('div', {});

    root.appendChild(el('div', { class: 'rb-mg__leadrow' }, [
      icon('shield', 'lg'),
      el('p', {
        class: 'rb-mg__lead',
        text: 'You already have a resume, so this is not a blank page. Here is exactly what ' + source + ' would do to it. Nothing is written until you choose.'
      })
    ]));

    var fieldset = el('fieldset', { class: 'rb-mg__modes' }, [
      el('legend', { class: 'rb-mg__legend', text: 'What the import is allowed to do' })
    ]);

    RB.merge.MODE_ORDER.forEach(function (id) {
      var def = RB.merge.MODES[id];
      var inputId = group + '-' + id;
      var input = el('input', {
        type: 'radio', name: group, id: inputId, value: id,
        class: 'rb-mg__radio'
      });
      input.checked = id === mode;
      var card = el('label', { class: 'rb-mg__mode', for: inputId, dataset: { mode: id } }, [
        input,
        el('span', { class: 'rb-mg__modetext' }, [
          el('span', { class: 'rb-mg__modetitle', text: def.label }),
          el('span', { class: 'rb-mg__modeblurb', text: def.blurb }),
          el('span', { class: 'rb-mg__tally', html: tally(previews[id].counts) })
        ])
      ]);
      input.addEventListener('change', function () {
        if (!input.checked) return;
        mode = id;
        paint();
        U.announce(def.label + '. ' + tallyText(previews[id].counts));
      });
      fieldset.appendChild(card);
    });
    root.appendChild(fieldset);

    root.appendChild(el('div', { class: 'rb-mg__head' }, [
      el('h3', { text: 'Field by field' }),
      headCount
    ]));
    /* Above the list, not below it: the warning is about the option that was
     * just chosen, and it has to be read before the forty rows below it. */
    root.appendChild(warnHost);
    root.appendChild(listHost);

    var back = el('button', {
      type: 'button', class: 'rb-btn rb-btn--secondary', text: 'Back'
    });
    back.addEventListener('click', function () { if (opts.onBack) opts.onBack(); });

    var applyIcon = icon('check');
    var apply = el('button', { type: 'button', class: 'rb-btn rb-btn--primary' }, [applyIcon, applyLabel]);
    apply.addEventListener('click', function () {
      if (opts.onApply) opts.onApply(previews[mode].next, mode);
    });

    root.appendChild(el('div', { class: 'rb-mg__foot' }, [back, el('span', { class: 'rb-spacer' }), apply]));

    function paint() {
      var p = previews[mode];
      listHost.textContent = '';

      if (mode === 'replace' && p.counts.removed) {
        warnHost.textContent = '';
        warnHost.appendChild(el('p', {
          class: 'rb-mg__warn',
          text: p.counts.removed + ' ' + (p.counts.removed === 1 ? 'field' : 'fields') +
            ' on the page right now have nothing in the import. They will be gone. One undo takes the whole import back out.'
        }));
      } else {
        warnHost.textContent = '';
      }

      if (!p.rows.length) {
        listHost.appendChild(el('div', { class: 'rb-mg__empty' }, [
          el('strong', { text: 'Nothing changes' }),
          el('p', {
            class: 'rb-mg__lead',
            text: mode === 'replace'
              ? 'The import holds everything this resume already has.'
              : 'Everything this import found is already on the page, word for word.'
          })
        ]));
        headCount.textContent = '';
      } else {
        var total = p.counts.added + p.counts.changed + p.counts.removed + p.counts.kept;
        headCount.textContent = p.rows.length + ' of ' + total + ' ' + (total === 1 ? 'field' : 'fields') + ' differ';
        var ul = el('ul', { class: 'rb-mg__rows' });
        p.rows.slice(0, ROW_LIMIT).forEach(function (row) { ul.appendChild(renderRow(row)); });
        listHost.appendChild(ul);
        if (p.rows.length > ROW_LIMIT) {
          var more = el('button', {
            type: 'button', class: 'rb-btn rb-btn--secondary rb-btn--sm rb-btn--block',
            text: 'Show the remaining ' + (p.rows.length - ROW_LIMIT)
          });
          more.addEventListener('click', function () {
            p.rows.slice(ROW_LIMIT).forEach(function (row) { ul.appendChild(renderRow(row)); });
            more.remove();
          });
          listHost.appendChild(more);
        }
      }

      applyLabel.textContent = mode === 'replace' ? 'Replace everything' : 'Merge and continue';
      applyIcon.innerHTML = icons.svg(mode === 'replace' ? 'refresh' : 'check');
      apply.classList.toggle('rb-btn--primary', mode !== 'replace');
      apply.classList.toggle('rb-btn--secondary', mode === 'replace');
      apply.classList.toggle('rb-btn--danger', mode === 'replace');
    }

    paint();
    U.requestIdle(function () {
      var first = U.qs('input[name="' + group + '"]', root);
      if (first && first.focus) first.focus();
    }, 60);

    return root;
  }

  RB.mergeStep = { render: render };
})(window);
