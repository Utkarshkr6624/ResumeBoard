/* Resumeboard — Check panel
 *
 * Presentation only. Every rule, threshold, citation and term list lives in
 * assets/js/analysis/*.js, which this panel probes for and degrades around: a
 * module that has not loaded (or has not finished loading, since script order
 * is the only coupling) renders an honest "not available" state with a retry,
 * never a fake zero.
 *
 * Assumed contract for RB.analysis (kept deliberately narrow):
 *   RB.analysis.score(resume)            -> { content: Grade, design: Grade }
 *   RB.analysis.lint(resume)             -> Finding[]
 *   RB.analysis.ats(resume, { vendor })  -> { vendors: [{id,label,note}], checks: [...] }
 *   RB.analysis.jdMatch(resume, jdText)  -> { percent, present, available, missing }
 * Each shape is normalised in the adapter section below, so a module that adds
 * fields or omits optional ones does not break the panel.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var bus = RB.bus;
  var store = RB.store;
  var model = RB.model;
  var icons = RB.icons;
  var doc = global.document;
  var el = U.el;

  var STYLE_ID = 'rb-check-styles';
  var TAB_LABEL = 'Resume checks';
  var EASE = 'var(--rb-ease-out)';

  /* ---------------------------------------------------------------- styles
   * Injected rather than shipped in a stylesheet this module does not own.
   * Colors are referenced as tokens only — nothing here is a literal. */

  var CSS = [
    '.rb-an{display:flex;flex-direction:column;height:100%;min-height:0}',
    '.rb-an__tabs{display:flex;gap:var(--rb-space-1);padding:0 var(--rb-space-3);border-bottom:1px solid var(--rb-border);overflow-x:auto;scrollbar-width:none}',
    '.rb-an__tabs::-webkit-scrollbar{display:none}',
    '.rb-an__body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:var(--rb-space-4);display:flex;flex-direction:column;gap:var(--rb-space-5)}',
    '.rb-an__h{margin:0 0 var(--rb-space-2);font-size:var(--rb-text-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--rb-text-faint)}',
    '.rb-an__note{font-size:var(--rb-text-xs);color:var(--rb-text-muted);line-height:1.55}',
    '.rb-an__num{font-variant-numeric:tabular-nums}',
    '.rb-an__card{background:var(--rb-bg-elevated);border:1px solid var(--rb-border);border-radius:var(--rb-radius-lg);padding:var(--rb-space-4);display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rb-an__card--flat{border:0;padding:0;background:none;gap:var(--rb-space-4)}',
    '.rb-an__card-head{display:flex;align-items:baseline;gap:var(--rb-space-2)}',
    '.rb-an__card-name{font-size:var(--rb-text-md);font-weight:650;letter-spacing:-.01em}',
    '.rb-an__card-num{margin-left:auto;font-size:var(--rb-text-2xl);font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
    '.rb-an__meter{height:6px;border-radius:var(--rb-radius-full);background:var(--rb-bg-sunken);overflow:hidden}',
    '.rb-an__meter-fill{height:100%;border-radius:var(--rb-radius-full);background:var(--rb-accent-600);transition:width var(--rb-dur-slow) ' + EASE + '}',
    '.rb-an__meter-fill--pass{background:var(--rb-green-600)}',
    '.rb-an__meter-fill--warn{background:var(--rb-amber-600)}',
    '.rb-an__meter-fill--fail{background:var(--rb-red-500)}',
    '.rb-an__meter-fill--none{background:var(--rb-border-strong)}',
    '.rb-an__items{display:flex;flex-direction:column}',
    '.rb-an__item{display:flex;align-items:flex-start;gap:var(--rb-space-2);padding:var(--rb-space-2) 0;border-top:1px solid var(--rb-border-subtle)}',
    '.rb-an__item:first-child{border-top:0;padding-top:0}',
    '.rb-an__item-ic{flex:none;width:16px;height:16px;margin-top:1px;color:var(--rb-text-faint)}',
    '.rb-an__item-ic--pass{color:var(--rb-green-600)}',
    '.rb-an__item-ic--warn{color:var(--rb-amber-600)}',
    '.rb-an__item-ic--fail{color:var(--rb-red-500)}',
    '.rb-an__item-ic--skip{color:var(--rb-text-faint)}',
    '.rb-an__item-body{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:var(--rb-space-1)}',
    '.rb-an__item-label{font-size:var(--rb-text-base);font-weight:550;line-height:1.4}',
    '.rb-an__item-detail{font-size:var(--rb-text-xs);color:var(--rb-text-muted);line-height:1.5}',
    '.rb-an__msg{font-weight:550;min-width:0;line-height:1.4}',
    '.rb-an__pts{flex:none;margin-left:auto;padding:1px var(--rb-space-2);border-radius:var(--rb-radius-full);background:var(--rb-bg-sunken);color:var(--rb-text-muted);font-size:var(--rb-text-2xs);font-variant-numeric:tabular-nums}',
    '.rb-an__ev{font-family:var(--rb-font-mono);font-size:var(--rb-text-xs);color:var(--rb-text-secondary);background:var(--rb-bg-inset);border-left:2px solid var(--rb-border-strong);border-radius:0 var(--rb-radius-xs) var(--rb-radius-xs) 0;padding:var(--rb-space-2) var(--rb-space-3);white-space:pre-wrap;word-break:break-word}',
    '.rb-an__cite{margin:0;font-size:var(--rb-text-2xs);color:var(--rb-text-faint);line-height:1.5}',
    '.rb-an__group{border:1px solid var(--rb-border);border-radius:var(--rb-radius-lg);background:var(--rb-bg-elevated);overflow:hidden}',
    '.rb-an__group-head{display:flex;align-items:center;gap:var(--rb-space-2);padding:var(--rb-space-3);border-bottom:1px solid var(--rb-border-subtle);background:var(--rb-bg-inset)}',
    '.rb-an__group-title{font-size:var(--rb-text-sm);font-weight:650}',
    '.rb-an__group-body{padding:var(--rb-space-3);display:flex;flex-direction:column;gap:var(--rb-space-3)}',
    '.rb-an__finding{padding:var(--rb-space-3) 0;border-top:1px solid var(--rb-border-subtle);display:flex;flex-direction:column;gap:var(--rb-space-2)}',
    '.rb-an__finding:first-child{border-top:0;padding-top:0}',
    '.rb-an__finding:last-child{padding-bottom:0}',
    '.rb-an__row{display:flex;align-items:center;gap:var(--rb-space-2);flex-wrap:wrap}',
    '.rb-an__chips{display:flex;flex-wrap:wrap;gap:var(--rb-space-1)}',
    '.rb-an__chip{display:inline-flex;align-items:center;gap:var(--rb-space-1);padding:2px var(--rb-space-2);border:1px solid var(--rb-border);border-radius:var(--rb-radius-full);background:var(--rb-bg-elevated);font-size:var(--rb-text-xs);max-width:100%}',
    '.rb-an__chip-term{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rb-an__empty{padding:var(--rb-space-8) var(--rb-space-4);display:flex;flex-direction:column;align-items:center;gap:var(--rb-space-3);text-align:center;color:var(--rb-text-muted);font-size:var(--rb-text-base);line-height:1.55}',
    '.rb-an__empty-ic{width:44px;height:44px;display:grid;place-items:center;border-radius:var(--rb-radius-lg);background:var(--rb-bg-sunken);color:var(--rb-text-faint)}',
    '.rb-an__empty-title{font-size:var(--rb-text-md);font-weight:650;color:var(--rb-text)}',
    '.rb-an__empty-text{max-width:44ch}',
    '@media (max-width:480px){.rb-an__body{padding:var(--rb-space-3);gap:var(--rb-space-4)}}'
  ].join('');

  function ensureStyles() {
    if (doc.getElementById(STYLE_ID)) return;
    doc.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
  }

  /* ------------------------------------------------------------- adapters
   * Normalise whatever shape a module returns, and fail loudly-but-quietly
   * when it is absent. Callers only ever see { ok:true, value } or
   * { ok:false, reason }. */

  function mod(name) {
    var A = RB.analysis;
    return A && typeof A[name] === 'function' ? A[name] : null;
  }

  function text(v) { return v == null ? '' : String(v); }

  /* Evidence arrives as an array. String(['a','b']) gives "a,b", which reads
   * as one run-on string on screen. */
  function textList(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(function (x) { return text(x); }).filter(Boolean).join(', ');
    return text(v);
  }

  function clampScore(v) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    return U.clamp(Math.round(n), 0, 100);
  }

  var STATUS = {
    pass:   { icon: 'check-circle',  ic: 'pass', badge: 'rb-badge--pass', meter: 'pass', word: 'Pass' },
    fail:   { icon: 'alert-circle',  ic: 'fail', badge: 'rb-badge--fail', meter: 'fail', word: 'Fail' },
    error:  { icon: 'alert-circle',  ic: 'fail', badge: 'rb-badge--fail', meter: 'fail', word: 'Fail' },
    warn:   { icon: 'alert-triangle', ic: 'warn', badge: 'rb-badge--warn', meter: 'warn', word: 'Warning' },
    warning:{ icon: 'alert-triangle', ic: 'warn', badge: 'rb-badge--warn', meter: 'warn', word: 'Warning' },
    skip:   { icon: 'minus',         ic: 'skip', badge: '', meter: 'none', word: 'Skipped' },
    skipped:{ icon: 'minus',         ic: 'skip', badge: '', meter: 'none', word: 'Skipped' },
    info:   { icon: 'info',          ic: '', badge: 'rb-badge--info', meter: 'none', word: 'Note' }
  };

  function statusOf(value) {
    var key = String(value || 'info').toLowerCase();
    return STATUS[key] || { icon: 'info', ic: '', badge: 'rb-badge--info', meter: 'none', word: key };
  }

  function normalizeItem(raw) {
    var st = statusOf(raw && raw.status);
    return {
      label: text(raw && raw.label) || 'Check',
      detail: text(raw && raw.detail),
      reason: text(raw && raw.reason),
      status: st,
      points: raw && raw.points != null ? Number(raw.points) : null,
      max: raw && raw.max != null ? Number(raw.max) : null
    };
  }

  function normalizeGrade(raw, fallbackLabel) {
    if (!raw || typeof raw !== 'object') return null;
    var list = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.checks) ? raw.checks : []);
    var items = list.map(normalizeItem);
    var skipped = (Array.isArray(raw.skipped) ? raw.skipped : [])
      .map(function (s) { return { label: text(s && (s.label || s.id)), reason: text(s && s.reason) }; })
      .filter(function (s) { return s.label || s.reason; });
    /* A check that reports status "skip" is a skipped check, whether or not
     * the module also listed it separately. */
    items.forEach(function (it) {
      if (it.status.ic === 'skip') skipped.push({ label: it.label, reason: it.reason });
    });
    return {
      label: text(raw.label) || fallbackLabel,
      score: clampScore(raw.score),
      items: items,
      skipped: skipped
    };
  }

  function getScore() {
    return cached('score', 'v1', function () {
      var fn = mod('score');
      if (!fn) return { ok: false, reason: 'The scoring module is not loaded.' };
      try {
        var raw = fn(store.get());
        if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The scoring module returned nothing usable.' };
        var content = normalizeGrade(raw.content, 'Content');
        var design = normalizeGrade(raw.design, 'Design');
        if (!content && !design) return { ok: false, reason: 'The scoring module returned no grades.' };
        return { ok: true, content: content, design: design };
      } catch (err) {
        return { ok: false, reason: describeError(err) };
      }
    });
  }

  function normalizeFinding(raw, i) {
    var sev = statusOf(raw && (raw.severity || raw.level));
    return {
      key: 'f' + i,
      severity: String((raw && (raw.severity || raw.level)) || 'info').toLowerCase(),
      status: sev,
      message: text(raw && (raw.message || raw.detail)) || 'Unlabelled finding.',
      evidence: textList(raw && (raw.evidence || raw.excerpt)),
      path: text(raw && raw.path),
      fix: (raw && raw.fix) || null
    };
  }

  function getLint() {
    return cached('lint', 'v1', function () {
      var fn = mod('lint');
      if (!fn) return { ok: false, reason: 'The linter module is not loaded.' };
      try {
        var raw = fn(store.get());
        if (raw && !Array.isArray(raw) && Array.isArray(raw.findings)) raw = raw.findings;
        if (!Array.isArray(raw)) return { ok: false, reason: 'The linter module returned no finding list.' };
        return { ok: true, findings: raw.map(normalizeFinding) };
      } catch (err) {
        return { ok: false, reason: describeError(err) };
      }
    });
  }

  function getAts(vendor) {
    return cached('ats', vendor || '', function () {
      var fn = mod('ats');
      if (!fn) return { ok: false, reason: 'The ATS module is not loaded.' };
      try {
        var raw = fn(store.get(), { vendor: vendor || null });
        if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The ATS module returned nothing usable.' };
        var vendors = (Array.isArray(raw.vendors) ? raw.vendors : []).map(function (v) {
          return { id: text(v && v.id), label: text(v && (v.label || v.name)) || text(v && v.id), note: text(v && v.note) };
        }).filter(function (v) { return v.id; });
        var list = Array.isArray(raw.checks) ? raw.checks : (Array.isArray(raw.results) ? raw.results : []);
        return {
          ok: true,
          vendors: vendors,
          vendor: text(raw.vendor) || (vendors[0] ? vendors[0].id : ''),
          checks: list.map(function (c) {
            return {
              id: text(c && c.id),
              label: text(c && (c.label || c.name || c.id)) || 'Check',
              status: statusOf(c && c.status),
              evidence: textList(c && (c.evidence || c.detail)),
              source: (c && c.source && typeof c.source === 'object') ? c.source : null
            };
          })
        };
      } catch (err) {
        return { ok: false, reason: describeError(err) };
      }
    });
  }

  function termList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (t) {
      if (typeof t === 'string') return { term: t, path: '', revealPath: '', count: 0 };
      return {
        term: text(t && (t.term || t.label || t.text)),
        path: text(t && (t.path || t.targetPath)),
        revealPath: text(t && (t.revealPath || t.hiddenPath)) || text(t && t.path),
        count: t && t.count != null ? Number(t.count) : 0
      };
    }).filter(function (t) { return t.term; });
  }

  function getJd() {
    return cached('jd', state.jd, function () {
      var fn = mod('jdMatch');
      if (!fn) return { ok: false, reason: 'The job-match module is not loaded.' };
      try {
        var raw = fn(store.get(), state.jd);
        if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The job-match module returned nothing usable.' };
        var present = termList(raw.present);
        var available = termList(raw.available != null ? raw.available : raw.hidden);
        var missing = termList(raw.missing);
        return {
          ok: true,
          percent: clampScore(raw.percent != null ? raw.percent : raw.match),
          total: Number(raw.total) || (present.length + available.length + missing.length),
          present: present,
          available: available,
          missing: missing
        };
      } catch (err) {
        return { ok: false, reason: describeError(err) };
      }
    });
  }

  function describeError(err) {
    if (err && err.message) return 'The analysis module stopped: ' + err.message;
    return 'The analysis module stopped unexpectedly.';
  }

  /* ----------------------------------------------------------------- state
   * Module scope, not mount scope: the JD text must survive the panel being
   * torn down and rebuilt on every tab switch. */

  var state = { active: 'score', vendor: '', jd: '' };
  var memo = { score: null, lint: null, ats: null, jd: null };
  var host = null;      // { tabs, body, active }
  var disposers = [];
  var scheduled = false;
  var jdRefs = null;    // { textarea, result } — kept so refresh never steals a caret

  function invalidate(key) { memo[key] = null; }

  /* Analysis is pure but not free: a score pass walks every bullet. Results are
   * memoized per store revision and re-derived on the next idle tick, never
   * inside an input handler. */
  function cached(key, sig, compute) {
    var hit = memo[key];
    if (hit && hit.sig === sig) return hit.value;
    var value = compute();
    memo[key] = { sig: sig, value: value };
    return value;
  }

  function schedule() {
    if (scheduled || !host) return;
    scheduled = true;
    U.requestIdle(function () {
      scheduled = false;
      if (!host) return;
      /* The panel host may empty its container without emitting `unmount` (a
       * tab switch elsewhere, a re-render of #rb-panel). Detached means gone. */
      if (!host.element || !host.element.isConnected) { teardown(); return; }
      if (!store.get()) {
        renderLoading();
        return;
      }
      flush();
    }, 300);
  }

  function flush() {
    if (!host || !host.body) return;
    var key = snapshotFocus();
    /* The JD view owns a textarea. Re-rendering it on every store keystroke
     * would move the caret to the end mid-word, so only its result region is
     * replaced once the view exists. */
    if (state.active === 'jd' && jdRefs && jdRefs.result && jdRefs.result.isConnected) {
      jdRefs.result.textContent = '';
      jdRefs.result.appendChild(renderJdResult());
      updateCounts();
      return;
    }
    var view = findView(state.active) || findView('score');
    host.body.textContent = '';
    host.body.appendChild(view.render());
    updateCounts();
    restoreFocus(key);
  }

  /* Focus survives a re-render, so keyboard users are not dropped to <body>
   * every time a fix is applied. */
  function snapshotFocus() {
    if (!host || !host.body) return null;
    var a = doc.activeElement;
    if (!a || !host.body.contains(a)) return null;
    return a.getAttribute('data-fk') || null;
  }

  function restoreFocus(key) {
    if (!key || !host || !host.body) return;
    var next = host.body.querySelector('[data-fk="' + key + '"]');
    if (next && next.focus) next.focus();
  }

  /* ------------------------------------------------------------- primitives */

  function head(text_) { return el('p', { class: 'rb-an__h', text: text_ }); }

  function note(text_) { return el('p', { class: 'rb-an__cite', text: text_ }); }

  function badge(status, label) {
    return el('span', {
      class: 'rb-badge' + (status.badge ? ' ' + status.badge : ''),
      text: label || status.word
    });
  }

  function button(label, opts) {
    opts = opts || {};
    var b = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--' + (opts.variant || 'secondary') + (opts.small ? ' rb-btn--sm' : ''),
      text: label
    });
    if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
    if (opts.fk) b.setAttribute('data-fk', opts.fk);
    if (opts.tip) b.setAttribute('data-tip', opts.tip);
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    if (opts.disabled) b.disabled = true;
    return b;
  }

  function emptyState(opts) {
    var node = el('div', { class: 'rb-an__empty' }, [
      el('span', { class: 'rb-an__empty-ic', html: icons.svg(opts.icon || 'info', { size: 'xl' }) }),
      el('p', { class: 'rb-an__empty-title', text: opts.title }),
      el('p', { class: 'rb-an__empty-text', text: opts.text })
    ]);
    if (opts.action) {
      node.appendChild(el('div', { class: 'rb-row' }, [button(opts.action.label, {
        variant: 'primary', small: true, onClick: opts.action.onClick
      })]));
    }
    return node;
  }

  function meter(percent, statusKey) {
    var wrap = el('div', {
      class: 'rb-an__meter',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100'
    });
    if (percent == null) {
      wrap.setAttribute('aria-label', 'Not scored');
      return wrap;
    }
    wrap.setAttribute('aria-valuenow', String(percent));
    wrap.setAttribute('aria-valuetext', percent + ' out of 100');
    var tone = STATUS[statusKey] ? STATUS[statusKey].meter : '';
    wrap.appendChild(el('div', {
      class: 'rb-an__meter-fill' + (tone ? ' rb-an__meter-fill--' + tone : ''),
      style: 'width:' + percent + '%'
    }));
    return wrap;
  }

  /* -------------------------------------------------------------- mutations
   * Every write goes through store.update. Nothing here touches the model. */

  function applyStore(mutator) {
    var ran = false;
    try {
      store.update(function (draft) {
        var result = mutator(draft);
        if (result === false) return false;
        ran = true;
        return result;
      }, { source: 'update' });
    } catch (err) {
      RB.ui.toast('That change could not be saved. Your resume is unchanged.', { tone: 'error' });
      return false;
    }
    if (!ran) return false;
    /* store.update already emitted `change`, which invalidated the memo and
     * scheduled a re-render. Nothing to do here. */
    return true;
  }

  function invalidateAll() {
    invalidate('score'); invalidate('lint'); invalidate('ats'); invalidate('jd');
  }

  /* Reveal every ancestor on a dot path that is currently hidden. Modules point
   * at the leaf ("sections.2" or "experience.1"); the parent section or entry
   * is frequently hidden too, and adding to a hidden entry would look broken.
   * Returns false when nothing was hidden, so the caller does not push a
   * no-op undo entry. */
  function revealPath(draft, path) {
    var parts = String(path).split('.');
    var changed = false;
    for (var i = 1; i <= parts.length; i++) {
      var node = model.getPath(draft, parts.slice(0, i).join('.'));
      if (node && typeof node === 'object' && node.visible === false) { node.visible = true; changed = true; }
    }
    return changed;
  }

  /* A keyword list created by blankEntry is ['']; appending beside the empty
   * string would leave a stray blank chip in the rendered resume. */
  function pushTerm(draft, path, term) {
    var parts = String(path).split('.');
    var listPath = parts.slice(0, -1).join('.');
    var list = model.getPath(draft, listPath);
    if (!Array.isArray(list)) return false;
    var already = list.some(function (v) { return String(v).trim().toLowerCase() === term.toLowerCase(); });
    if (already) return false;
    revealPath(draft, listPath);
    if (list.length === 1 && !String(list[0]).trim()) list[0] = term;
    else list.push(term);
    return true;
  }

  function focusField(path) {
    var doc_ = U.qs('#rb-doc');
    if (!doc_ || !path) return;
    var target = doc_.querySelector('[data-bind="' + path.replace(/"/g, '') + '"]');
    if (!target) return;
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' });
    if (target.focus) target.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------- score view */

  function renderScore() {
    var wrap = el('div', { class: 'rb-an__card' });
    var result = getScore();
    if (!result.ok) return moduleMissing('Scoring', result.reason, 'score');

    var grades = [result.content, result.design].filter(Boolean);
    if (!grades.length) return moduleMissing('Scoring', 'The scoring module returned no grades.', 'score');

    grades.forEach(function (g) { wrap.appendChild(renderGrade(g)); });

    var skipped = [];
    grades.forEach(function (g) { skipped = skipped.concat(g.skipped); });
    if (skipped.length) wrap.appendChild(renderSkipped(skipped));

    wrap.appendChild(note('The two grades are independent. Content grades what you wrote; design grades how it is laid out and set. Neither can raise the other.'));
    return wrap;
  }

  function renderGrade(grade) {
    var card = el('section', { class: 'rb-an__card', 'aria-label': grade.label + ' grade' });

    var head_ = el('div', { class: 'rb-an__card-head' }, [
      el('h3', { class: 'rb-an__card-name', text: grade.label }),
      el('span', {
        class: 'rb-an__card-num',
        text: grade.score == null ? '—' : String(grade.score)
      })
    ]);
    /* A number with no breakdown is a bare score. Refuse to show one. */
    if (grade.score == null || !grade.items.length) {
      head_.lastChild.textContent = '—';
    }
    card.appendChild(head_);

    var tone = null;
    if (grade.score != null) tone = grade.score >= 80 ? 'pass' : (grade.score >= 55 ? 'warn' : 'fail');
    var m = meter(grade.score, tone);
    m.setAttribute('aria-label', grade.label + ': ' + (grade.score == null ? 'not scored' : grade.score + ' out of 100'));
    card.appendChild(m);

    if (!grade.items.length) {
      card.appendChild(el('p', {
        class: 'rb-an__item-detail',
        text: 'No breakdown was returned for this grade, so it is left unscored rather than guessed.'
      }));
      return card;
    }

    var items = el('div', { class: 'rb-an__items' });
    grade.items.forEach(function (it) { items.appendChild(renderGradeItem(it)); });
    card.appendChild(items);
    return card;
  }

  function renderGradeItem(item) {
    var pts = null;
    if (item.points != null && isFinite(item.points)) {
      pts = item.max != null && isFinite(item.max) ? item.points + ' / ' + item.max : String(item.points);
    }
    var children = [
      el('span', { class: 'rb-an__item-ic' + (item.status.ic ? ' rb-an__item-ic--' + item.status.ic : ''), html: icons.svg(item.status.icon) }),
      el('div', { class: 'rb-an__item-body' }, [el('span', { class: 'rb-an__item-label', text: item.label })])
    ];
    if (pts) children.push(el('span', { class: 'rb-an__pts rb-an__num', text: pts }));
    var node = el('div', { class: 'rb-an__item' }, children);
    if (item.detail) node.children[1].appendChild(el('span', { class: 'rb-an__item-detail', text: item.detail }));
    if (item.status.ic === 'skip' && item.reason) {
      node.children[1].appendChild(el('span', { class: 'rb-an__item-detail', text: 'Skipped: ' + item.reason }));
    }
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', item.label + ' — ' + item.status.word);
    return node;
  }

  function renderSkipped(skipped) {
    var card = el('section', { class: 'rb-an__card', 'aria-label': 'Skipped checks' });
    card.appendChild(head('Skipped checks'));
    card.appendChild(note('These did not run. They are not counted for or against you, and fixing them will not move a grade.'));
    var list = el('div', { class: 'rb-an__items' });
    skipped.forEach(function (s) {
      list.appendChild(el('div', { class: 'rb-an__item' }, [
        el('span', { class: 'rb-an__item-ic rb-an__item-ic--skip', html: icons.svg('minus') }),
        el('div', { class: 'rb-an__item-body' }, [
          el('span', { class: 'rb-an__item-label', text: s.label || 'Check' }),
          s.reason ? el('span', { class: 'rb-an__item-detail', text: s.reason }) : null
        ].filter(Boolean))
      ]));
    });
    card.appendChild(list);
    return card;
  }

  /* ------------------------------------------------------------ linter view */

  var SEVERITY_ORDER = ['error', 'warn', 'info'];

  var STATUS_TALLY = { pass: 'pass', fail: 'fail', warn: 'warn', skip: 'skip' };

  function renderLint() {
    var wrap = el('div', { class: 'rb-an__card' });
    var result = getLint();
    if (!result.ok) return moduleMissing('Linting', result.reason, 'lint');

    var findings = result.findings;
    if (!findings.length) {
      return emptyState({ icon: 'check-circle', title: 'Nothing flagged', text: 'No rule in the linter fired against this resume right now.' });
    }

    wrap.appendChild(head('Findings'));
    wrap.appendChild(note('Grouped by severity. Each fix is a real edit to your resume and is undoable.'));

    var groups = SEVERITY_ORDER.map(function (sev) {
      return { severity: sev, list: findings.filter(function (f) { return f.severity === sev; }) };
    }).filter(function (g) { return g.list.length; });

    var known = SEVERITY_ORDER.join('|');
    var other = findings.filter(function (f) { return known.indexOf(f.severity) === -1; });
    if (other.length) groups.push({ severity: null, list: other });

    groups.forEach(function (g) { wrap.appendChild(renderFindingGroup(g.severity, g.list)); });
    return wrap;
  }

  function renderFindingGroup(sev, group) {
    var st = sev ? statusOf(sev) : { word: 'Other', badge: 'rb-badge--info' };
    var body = el('div', { class: 'rb-an__group-body' });
    group.forEach(function (f) { body.appendChild(renderFinding(f)); });
    return el('section', { class: 'rb-an__group', 'aria-label': st.word + ' findings' }, [
      el('div', { class: 'rb-an__group-head' }, [
        el('span', { class: 'rb-an__group-title', text: st.word }),
        el('span', { class: 'rb-tab__count rb-an__num', text: String(group.length) })
      ]),
      body
    ]);
  }

  function fixRunner(fix) {
    if (!fix) return null;
    if (typeof fix === 'function') return fix;
    if (typeof fix.apply === 'function') return fix.apply;
    if (fix.path) {
      return function (draft) { model.setPath(draft, fix.path, fix.value); };
    }
    return null;
  }

  /* Findings carry a dot path so "Show on resume" can find the node, but
   * "education.0.end" is not something a reader can act on. */
  var PATH_FIELDS = {
    start: 'Start date', end: 'End date', current: 'Current', date: 'Date',
    name: 'Name', position: 'Position', title: 'Title', company: 'Company',
    organization: 'Organization', school: 'School', degree: 'Degree',
    location: 'Location', summary: 'Summary', description: 'Description',
    text: 'Text', url: 'Link', email: 'Email', phone: 'Phone'
  };

  function pathLabel(path) {
    var parts = String(path).split('.').filter(function (s) { return s && !/^\d+$/.test(s); });
    if (!parts.length) return '';
    var first = parts[0];
    var meta = RB.model && typeof RB.model.typeMeta === 'function' ? RB.model.typeMeta(first) : null;
    var head = (meta && meta.label) || (first.charAt(0).toUpperCase() + first.slice(1));
    var tail = parts[parts.length - 1];
    var label = PATH_FIELDS[tail] || (tail.charAt(0).toUpperCase() + tail.slice(1));
    return parts.length > 1 ? head + ' · ' + label : label;
  }

  function renderFinding(f) {
    var node = el('div', { class: 'rb-an__finding' });

    node.appendChild(el('div', { class: 'rb-an__row' }, [
      badge(f.status),
      el('span', { class: 'rb-an__msg', text: f.message })
    ]));
    if (f.evidence) node.appendChild(el('div', { class: 'rb-an__ev', text: f.evidence }));
    if (f.path) {
      var where = pathLabel(f.path);
      if (where) node.appendChild(note('Field: ' + where));
    }

    var actions = el('div', { class: 'rb-an__row' });
    var runner = fixRunner(f.fix);
    if (runner) {
      var label = (f.fix && typeof f.fix === 'object' && f.fix.label) || 'Fix';
      actions.appendChild(button(label, {
        variant: 'primary', small: true, fk: 'fix-' + f.key,
        ariaLabel: 'Apply the suggested fix: ' + f.message,
        tip: 'Undo with ' + (U.isMac() ? 'Cmd+Z' : 'Ctrl+Z'),
        onClick: function () { runFix(runner); }
      }));
    } else {
      actions.appendChild(el('span', { class: 'rb-an__cite', text: 'No automatic fix for this one.' }));
    }
    if (f.path) {
      actions.appendChild(button('Show on resume', {
        small: true, fk: 'goto-' + f.key,
        ariaLabel: 'Scroll the resume to ' + f.path,
        onClick: function () { focusField(f.path); }
      }));
    }
    node.appendChild(actions);
    return node;
  }

  function runFix(runner) {
    var applied = applyStore(function (draft) { return runner(draft); });
    if (!applied) {
      RB.ui.toast('That fix had nothing left to change.', { tone: 'warn' });
      return;
    }
    undoToast('Fix applied.');
  }

  /* --------------------------------------------------------------- ATS view */

  function renderAts() {
    var wrap = el('div', { class: 'rb-an__card' });
    var result = getAts(state.vendor);
    if (!result.ok) return moduleMissing('ATS simulation', result.reason, 'ats');

    if (result.vendors.length) {
      wrap.appendChild(renderVendorSelect(result));
    } else {
      wrap.appendChild(note('Every check below is the shared baseline: the rules all five parsers documented in the ATS section agree on. The per-vendor rules are on those pages.'));
    }

    if (!result.checks.length) {
      wrap.appendChild(emptyState({ icon: 'info', title: 'No checks returned', text: 'The ATS module reported nothing for this resume.' }));
      return wrap;
    }

    var tally = { pass: 0, fail: 0, warn: 0, skip: 0 };
    result.checks.forEach(function (c) {
      /* Anything the module reports outside pass/fail/warn/skip is a warning
       * for counting purposes; its own badge still shows the real status. */
      var key = STATUS_TALLY[c.status.ic] || 'warn';
      tally[key]++;
    });

    wrap.appendChild(el('div', { class: 'rb-an__row' }, [
      badge(statusOf('pass'), tally.pass + ' pass'),
      badge(statusOf('fail'), tally.fail + ' fail'),
      badge(statusOf('warn'), tally.warn + ' warn'),
      badge(statusOf('skip'), tally.skip + ' skipped')
    ]));

    wrap.appendChild(head('Every check'));
    wrap.appendChild(note('Each line shows the text the parser would have read, and where the rule behind it comes from. This is a simulation of a published parser profile, not a live submission.'));

    var list = el('div', { class: 'rb-an__items' });
    result.checks.forEach(function (c) { list.appendChild(renderAtsCheck(c, result.vendor)); });
    wrap.appendChild(list);
    return wrap;
  }

  function renderVendorSelect(result) {
    var id = 'rb-ats-vendor-' + U.uid('v');
    var select = el('select', { class: 'rb-select rb-select--sm', id: id });
    result.vendors.forEach(function (v) {
      var opt = el('option', { value: v.id, text: v.label });
      if (v.id === result.vendor) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      state.vendor = select.value;
      invalidate('ats');
      schedule();
      U.announce('Simulating ' + select.options[select.selectedIndex].text);
    });

    var field = el('div', { class: 'rb-field' }, [
      el('label', { class: 'rb-label', for: id, text: 'Simulate a parser' }),
      select
    ]);
    var active = result.vendors.filter(function (v) { return v.id === result.vendor; })[0];
    if (active && active.note) field.appendChild(el('span', { class: 'rb-hint', text: active.note }));
    return field;
  }

  function renderAtsCheck(check, vendorId) {
    var node = el('div', { class: 'rb-an__item' });
    var body = el('div', { class: 'rb-an__item-body' }, [
      el('span', { class: 'rb-an__item-label', text: check.label })
    ]);
    if (check.evidence) body.appendChild(el('div', { class: 'rb-an__ev', text: check.evidence }));
    body.appendChild(renderCitation(check.source, vendorId));
    node.appendChild(el('span', {
      class: 'rb-an__item-ic' + (check.status.ic ? ' rb-an__item-ic--' + check.status.ic : ''),
      html: icons.svg(check.status.icon)
    }));
    node.appendChild(body);
    node.appendChild(el('span', { class: 'rb-badge ' + (check.status.badge || ''), text: check.status.word }));
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', check.label + ' — ' + check.status.word);
    return node;
  }

  function renderCitation(source, vendorId) {
    if (!source || !text(source.label || source.title)) {
      return note('Source not provided for this check. ' + (vendorId ? 'Profile: ' + vendorId + '.' : ''));
    }
    var line = el('p', { class: 'rb-an__cite' }, [
      el('span', { text: 'Source: ' }),
      el('cite', { text: text(source.label || source.title) })
    ]);
    var url = model.safeUrl(source.url || '');
    var bits = [];
    if (source.publisher) bits.push(text(source.publisher));
    if (source.ref) bits.push(text(source.ref));
    if (source.accessed) bits.push('accessed ' + text(source.accessed));
    if (vendorId) bits.push('profile ' + vendorId);
    if (url) bits.push(url);
    if (bits.length) line.appendChild(el('span', { text: ' · ' + bits.join(' · ') }));
    if (source.note) line.appendChild(el('span', { text: ' — ' + text(source.note) }));
    return line;
  }

  /* ----------------------------------------------------------------- JD view */

  var CHIP_LIMIT = 60;

  function renderJd() {
    var wrap = el('div', { class: 'rb-an__card' });
    var id = 'rb-jd-text';

    var textarea = el('textarea', {
      class: 'rb-textarea', id: id, rows: '7',
      placeholder: 'Paste the job description here — the whole posting works best.'
    });
    textarea.value = state.jd;
    textarea.setAttribute('aria-describedby', 'rb-jd-hint');
    textarea.addEventListener('input', function () {
      state.jd = textarea.value;
      invalidate('jd');
      schedule();
    });

    wrap.appendChild(el('div', { class: 'rb-field' }, [
      el('label', { class: 'rb-label', for: id, text: 'Job description' }),
      textarea,
      el('span', { class: 'rb-hint', id: 'rb-jd-hint', text: 'Stays in this browser. Nothing is uploaded, and the text is not saved with your resume.' })
    ]));

    var result = el('div', { class: 'rb-an__card' });
    wrap.appendChild(result);
    jdRefs = { textarea: textarea, result: result };
    result.appendChild(renderJdResult());
    return wrap;
  }

  function renderJdResult() {
    if (!state.jd.trim()) {
      return emptyState({
        icon: 'search',
        title: 'No job description yet',
        text: 'Paste a posting above to see which of its terms your resume already covers, which ones are hidden, and which are missing.'
      });
    }
    var result = getJd();
    if (!result.ok) return moduleMissing('Job match', result.reason, 'jd');

    var node = el('div', { class: 'rb-an__card rb-an__card--flat' });
    var total = result.total || (result.present.length + result.available.length + result.missing.length);
    var covered = result.present.length + result.available.length;

    node.appendChild(el('div', { class: 'rb-an__card-head' }, [
      el('h3', { class: 'rb-an__card-name', text: 'Match' }),
      el('span', { class: 'rb-an__card-num', text: result.percent == null ? '—' : result.percent + '%' })
    ]));
    var m = meter(result.percent, result.percent == null ? null : (result.percent >= 75 ? 'pass' : result.percent >= 45 ? 'warn' : 'fail'));
    m.setAttribute('aria-label', 'Job match: ' + (result.percent == null ? 'not scored' : result.percent + ' percent'));
    node.appendChild(m);
    node.appendChild(note(total
      ? covered + ' of ' + total + ' terms are on the resume. ' + result.present.length + ' are visible, ' + result.available.length + ' are hidden.'
      : 'The job-match module found no terms to compare.'));

    node.appendChild(renderTermGroup('Present', 'Already on the resume, in a visible section. Nothing to do.', result.present, null));
    node.appendChild(renderTermGroup('On the resume but hidden', 'The term is in your data, but the entry or section is hidden. One click reveals it.', result.available, 'show'));
    node.appendChild(renderTermGroup('Missing', 'Not anywhere in the resume. One click adds it to a skills list you already have.', result.missing, 'add'));
    return node;
  }

  function renderTermGroup(title, subtitle, terms, action) {
    var body = el('div', { class: 'rb-an__group-body' });
    if (!terms.length) {
      body.appendChild(el('p', { class: 'rb-an__item-detail', text: action ? 'Nothing in this group.' : 'No terms from the job description are visible in your resume yet.' }));
    } else {
      body.appendChild(el('p', { class: 'rb-an__item-detail', text: subtitle }));
      var chips = el('div', { class: 'rb-an__chips' });
      terms.slice(0, CHIP_LIMIT).forEach(function (t, i) {
        chips.appendChild(renderChip(t, action, 'term-' + (action || 'p') + '-' + i));
      });
      body.appendChild(chips);
      if (terms.length > CHIP_LIMIT) {
        body.appendChild(note((terms.length - CHIP_LIMIT) + ' more terms not shown.'));
      }
    }
    return el('section', { class: 'rb-an__group', 'aria-label': title }, [
      el('div', { class: 'rb-an__group-head' }, [
        el('span', { class: 'rb-an__group-title', text: title }),
        el('span', { class: 'rb-tab__count rb-an__num', text: String(terms.length) })
      ]),
      body
    ]);
  }

  function renderChip(term, action, fk) {
    var chip = el('span', { class: 'rb-an__chip' }, [
      el('span', { class: 'rb-an__chip-term', text: term.term, title: term.term })
    ]);
    if (term.count > 0) chip.appendChild(el('span', { class: 'rb-an__cite', text: '×' + term.count }));

    if (action === 'show') {
      chip.appendChild(button('Show', {
        small: true, fk: fk, ariaLabel: 'Reveal the section containing ' + term.term,
        tip: 'Reveals the hidden entry or section',
        onClick: function () { runReveal(term); }
      }));
    } else if (action === 'add') {
      var label = term.path ? 'Add' : 'No slot';
      chip.appendChild(button(label, {
        small: true, fk: fk,
        ariaLabel: term.path ? 'Add ' + term.term + ' to your skills' : 'No place to put ' + term.term + ' automatically',
        tip: term.path ? term.path : 'Add it yourself where it belongs',
        disabled: !term.path,
        onClick: function () { if (term.path) runAdd(term); }
      }));
    }
    return chip;
  }

  /* Every toast here that offers Undo reads the store at click time first.
     Without it, a keystroke made while the toast was on screen made the button
     take back that keystroke instead of the reveal. */
  function snapshot() { return JSON.stringify(store.get()); }
  function undoToast(message) {
    var after = snapshot();
    RB.ui.undoableToast(message, {
      isUnchanged: function () { return snapshot() === after; },
      onUndo: function () { store.undo(); }
    });
  }

  function runReveal(term) {
    var path = term.revealPath || term.path;
    if (!path) {
      RB.ui.toast('The matcher did not say where that term lives, so it could not be revealed.', { tone: 'warn' });
      return;
    }
    var applied = applyStore(function (draft) { return revealPath(draft, path); });
    if (!applied) {
      RB.ui.toast('That is already visible on your resume.', { tone: 'warn' });
      return;
    }
    undoToast('Revealed.');
  }

  function runAdd(term) {
    var applied = applyStore(function (draft) { return pushTerm(draft, term.path, term.term); });
    if (!applied) {
      RB.ui.toast('“' + term.term + '” is already there, or that list is not editable yet.', { tone: 'warn' });
      return;
    }
    undoToast('Added “' + term.term + '”.');
  }

  /* ---------------------------------------------------------------- shared */

  function moduleMissing(title, reason, key) {
    return emptyState({
      icon: 'alert-circle',
      title: title + ' is unavailable',
      text: reason + ' The rest of the panel still works.',
      action: {
        label: 'Check again',
        onClick: function () {
          invalidate(key);
          schedule();
        }
      }
    });
  }

  function renderLoading() {
    if (!host || !host.body) return;
    host.body.textContent = '';
    host.body.appendChild(emptyState({ icon: 'clock', title: 'Loading your resume', text: 'The check panel reads from the saved resume, which is still opening.' }));
  }

  /* ------------------------------------------------------------------ tabs */

  var VIEWS = [
    { id: 'score', label: 'Score', render: renderScore, count: function () { return null; } },
    { id: 'lint', label: 'Linter', render: renderLint, count: countLint },
    { id: 'ats', label: 'ATS', render: renderAts, count: countAts },
    { id: 'jd', label: 'Job match', render: renderJd, count: function () { return null; } }
  ];

  function findView(id) {
    for (var i = 0; i < VIEWS.length; i++) if (VIEWS[i].id === id) return VIEWS[i];
    return null;
  }

  function countLint() {
    var r = getLint();
    if (!r.ok) return null;
    var n = r.findings.filter(function (f) { return f.severity !== 'info'; }).length;
    return n || null;
  }

  function countAts() {
    var r = getAts(state.vendor);
    if (!r.ok) return null;
    var n = r.checks.filter(function (c) { return c.status.ic === 'fail'; }).length;
    return n || null;
  }

  function selectTab(id, focusTab) {
    var view = findView(id);
    if (!view) return;
    state.active = id;
    jdRefs = null;
    if (host && host.setActive) host.setActive(id);
    flush();
    if (focusTab && host && host.focusTab) host.focusTab(id);
    U.announce(view.label + ' view');
  }

  /* RB.tabs lives in another module. The contract used here is
   *   RB.tabs.create({ tabs:[{id,label}], onSelect, ariaLabel })
   *     -> an element carrying setActive(id) and setCount(id, n|null)
   * If any part of that is missing the local implementation below runs, built
   * on the .rb-tabs / .rb-tab primitives in base.css. */
  function buildTabs() {
    var T = RB.tabs;
    if (T && typeof T.create === 'function') {
      try {
        var node = T.create({
          tabs: VIEWS.map(function (v) { return { id: v.id, label: v.label }; }),
          ariaLabel: TAB_LABEL,
          onSelect: function (id) { selectTab(id, false); }
        });
        if (node && node.nodeType === 1 && typeof node.setActive === 'function' && typeof node.setCount === 'function' && node.querySelector('[role="tab"]')) {
          return { element: node, setActive: function (id) { node.setActive(id); }, setCount: function (id, n) { node.setCount(id, n); } };
        }
      } catch (err) {
        if (global.console) console.error('[check] RB.tabs.create failed, using the built-in tab bar', err);
      }
    }
    return buildLocalTabs();
  }

  function buildLocalTabs() {
    var list = el('div', { class: 'rb-tabs rb-an__tabs', role: 'tablist', 'aria-label': TAB_LABEL });
    var buttons = {};
    var counts = {};

    VIEWS.forEach(function (v) {
      var id = 'rb-check-tab-' + v.id;
      var count = el('span', { class: 'rb-tab__count', hidden: true });
      var btn = el('button', {
        type: 'button', class: 'rb-tab', id: id, role: 'tab',
        'aria-selected': 'false', 'aria-controls': 'rb-check-tabpanel',
        tabindex: '-1', 'data-fk': 'tab-' + v.id
      }, [el('span', { text: v.label }), count]);
      btn.addEventListener('click', function () { selectTab(v.id, false); });
      btn.addEventListener('keydown', function (ev) { onTabKey(ev, v.id); });
      list.appendChild(btn);
      buttons[v.id] = btn;
      counts[v.id] = count;
    });

    var panel = el('div', {
      class: 'rb-an__body', role: 'tabpanel', id: 'rb-check-tabpanel',
      tabindex: '0', 'aria-labelledby': 'rb-check-tab-score'
    });

    function setActive(id) {
      VIEWS.forEach(function (v) {
        var on = v.id === id;
        buttons[v.id].setAttribute('aria-selected', on ? 'true' : 'false');
        buttons[v.id].tabIndex = on ? 0 : -1;
      });
      panel.setAttribute('aria-labelledby', 'rb-check-tab-' + id);
    }

    function onTabKey(ev, id) {
      var i = VIEWS.map(function (v) { return v.id; }).indexOf(id);
      var next = null;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % VIEWS.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + VIEWS.length) % VIEWS.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = VIEWS.length - 1;
      if (next == null) return;
      ev.preventDefault();
      selectTab(VIEWS[next].id, true);
    }

    return {
      element: el('div', { class: 'rb-an' }, [list, panel]),
      setActive: setActive,
      setCount: function (id, n) {
        var node = counts[id];
        if (!node) return;
        if (n == null) { node.hidden = true; node.textContent = ''; return; }
        node.hidden = false;
        node.textContent = String(n);
      },
      focusTab: function (id) { if (buttons[id]) buttons[id].focus(); }
    };
  }

  function updateCounts() {
    if (!host || !host.setCount) return;
    VIEWS.forEach(function (v) { host.setCount(v.id, v.count()); });
  }

  /* ----------------------------------------------------------------- mount */

  function teardown() {
    disposers.forEach(function (off) { try { off(); } catch (e) { /* already gone */ } });
    disposers = [];
    /* The memo outlives the panel on purpose, but nothing invalidates it while
       the panel is closed — the `change` listener that does that is one of the
       disposers. Re-opening then replayed the score, the linter findings and
       the ATS checks of a resume that no longer existed, because the sig
       ("v1") had not moved. Dropping it here is the one point every exit path
       passes through, so a stale reading cannot survive a tab switch. */
    invalidateAll();
    host = null;
    jdRefs = null;
  }

  function mount(container) {
    teardown();
    if (!container) return;
    ensureStyles();
    /* The contract promises a fresh, empty container. Clearing is cheap and
     * makes a re-mount (a hotkey jumping to this panel, a host that reuses
     * the node) impossible to get wrong. */
    container.textContent = '';

    var tabs = buildTabs();
    container.appendChild(tabs.element);
    host = tabs;
    host.body = tabs.element.querySelector('[role="tabpanel"]');
    if (!host.body) { teardown(); return; }

    disposers.push(bus.on('change', function () {
      invalidateAll();
      schedule();
    }));

    tabs.setActive(state.active);
    if (store.get()) flush();
    else {
      renderLoading();
      store.whenReady().then(function () { invalidateAll(); schedule(); });
    }
  }

  RB.panels.register({
    id: 'check',
    title: 'Check',
    icon: 'check-circle',
    mount: mount,
    /* Exposed so the rail or a hotkey can jump straight to a sub-view. */
    show: function (id) { selectTab(id, false); }
  });

  /* The panel shell calls this for whichever tab is closing, so only stand down
     when the payload is ours. */
  RB.lifecycle.on('unmount', function (payload) {
    if (payload && payload.scope === 'panel' && payload.panelId !== 'check') return;
    teardown();
  });
})(window);
