/* Resumeboard — documents workspace
 *
 * A second surface beside the resume: a cover letter and an interview-prep
 * checklist, both derived from the same resume, both printable, neither stored
 * in the resume model.
 *
 * It is an overlay rather than a third view inside the editor shell on
 * purpose. The stage, the paginator, the type-size control and the panel rail
 * all describe *the resume*; swapping the document under them would make every
 * one of them report on something they cannot see. An overlay leaves the
 * editor exactly as it was underneath.
 *
 * Entry points: the Documents control in the toolstrip, and RB.documents.open().
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var doc = global.document;
  if (!U || !doc) return;

  var el = U.el;

  var TABS = [
    { id: 'letter', label: 'Cover letter', icon: 'file-text', title: 'Cover letter' },
    { id: 'prep', label: 'Interview prep', icon: 'list', title: 'Interview prep' }
  ];

  var MOBILE_MAX = 760;
  var PRINT_HOST_ID = 'rb-doc-print-host';
  var PRINT_FLAG = 'data-rb-print-doc';

  var state = { open: false, tab: 'letter', returnFocus: null, sideOpen: false, disposers: [], pending: null, cleanup: null };
  var els = {};

  /* --------------------------------------------------------------- printing
   * The print host lives inside #rb-overlay-root rather than as a child of
   * body: templates.css hides every body child except four named ids, and
   * that rule is far more specific than anything this file could write. Inside
   * the overlay root it is out of that selector's reach, and the root is put
   * back in normal flow for the duration of the print. */
  function printHost() {
    var node = U.qs('#' + PRINT_HOST_ID);
    if (node) return node;
    var root = U.qs('#rb-overlay-root');
    if (!root) return null;
    node = el('div', {
      id: PRINT_HOST_ID,
      class: 'rb-print-only rb-doc-print-host',
      'aria-hidden': 'true',
      dataset: { pageSize: 'letter' }
    });
    root.appendChild(node);
    return node;
  }

  function waitForPrintEnd() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        global.removeEventListener('afterprint', finish);
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onChange);
        clearTimeout(timer);
        resolve();
      };
      var onChange = function (ev) { if (!ev.matches) finish(); };
      var mq = global.matchMedia ? global.matchMedia('print') : null;
      global.addEventListener('afterprint', finish);
      if (mq && mq.addEventListener) mq.addEventListener('change', onChange);
      var timer = setTimeout(finish, 20000);
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      var raf = global.requestAnimationFrame || function (fn) { setTimeout(fn, 16); };
      raf(function () { raf(resolve); });
    });
  }

  /* Print an arbitrary node on its own sheet. The clone is stripped of
   * editing affordances: a caret in a contenteditable prints as a stray
   * cursor, and the tick boxes are re-drawn by the checklist stylesheet. */
  function printNode(node, size) {
    var host = printHost();
    if (!host || !node) {
      toast('Nothing to print yet.', 'warn');
      return Promise.resolve(false);
    }
    if (typeof global.print !== 'function') {
      toast('This browser cannot print. Save the page as a PDF from its menu instead.', 'error');
      return Promise.resolve(false);
    }

    var root = doc.documentElement;
    var page = (size === 'A4') ? 'a4' : 'letter';
    host.textContent = '';
    var clone = node.cloneNode(true);
    U.qsa('[contenteditable]', clone).forEach(function (n) { n.removeAttribute('contenteditable'); });
    clone.setAttribute('data-rb-print-clone', '');
    host.appendChild(clone);
    host.setAttribute('data-page-size', page);
    root.setAttribute(PRINT_FLAG, page);

    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();

    return nextFrame().then(function () {
      global.print();
      return waitForPrintEnd();
    }).then(function () {
      host.textContent = '';
      root.removeAttribute(PRINT_FLAG);
      return true;
    }).catch(function () {
      host.textContent = '';
      root.removeAttribute(PRINT_FLAG);
      toast('Printing was interrupted. Nothing was changed.', 'error');
      return false;
    });
  }

  /* ------------------------------------------------------------------ chrome */

  function toast(message, tone) {
    if (RB.ui && typeof RB.ui.toast === 'function') RB.ui.toast(message, { tone: tone || 'info' });
  }

  function icon(name, size) {
    if (RB.icons && typeof RB.icons.svg === 'function') return RB.icons.svg(name, size ? { size: size } : null);
    return '';
  }

  function iconButton(opts) {
    return el('button', {
      type: 'button',
      class: 'rb-btn ' + (opts.cls || 'rb-btn--ghost') + ' rb-tip rb-ds__ibtn',
      'aria-label': opts.label,
      'data-tip': opts.tip || opts.label,
      'aria-haspopup': opts.haspopup || null,
      'aria-expanded': opts.expanded == null ? null : String(opts.expanded),
      'aria-controls': opts.controls || null,
      html: icon(opts.icon, opts.small ? 'sm' : null)
    });
  }

  function labelled(id, labelText, control, hint) {
    return el('div', { class: 'rb-field rb-ds__field' }, [
      el('label', { class: 'rb-label', for: id, text: labelText }),
      control,
      hint ? el('span', { class: 'rb-hint', text: hint }) : null
    ].filter(Boolean));
  }

  function textInput(id, value, placeholder, onInput) {
    var input = el('input', {
      type: 'text', id: id, class: 'rb-input', value: value || '',
      placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'true'
    });
    input.addEventListener('input', function () { onInput(input.value); });
    return input;
  }

  function selectInput(id, value, options, onChange) {
    var node = el('select', { id: id, class: 'rb-select' });
    options.forEach(function (opt) {
      node.appendChild(el('option', { value: opt.id, text: opt.label, selected: opt.id === value ? true : null }));
    });
    node.value = value;
    node.addEventListener('change', function () { onChange(node.value); });
    return node;
  }

  function sectionTitle(text, note) {
    return el('div', { class: 'rb-ds__section' }, [
      el('h3', { class: 'rb-ds__section-title', text: text }),
      note ? el('p', { class: 'rb-hint', text: note }) : null
    ].filter(Boolean));
  }

  /* ------------------------------------------------------------------ letter */

  function designVars(design) {
    var d = design || {};
    return {
      '--rb-doc-size': (Number(d.baseSizePt) || 10.5) + 'pt',
      '--rb-doc-leading': String(Number(d.lineHeight) || 1.32),
      '--rb-doc-accent': d.accent || 'var(--rb-gray-900)',
      '--rb-doc-margin': (Number(d.marginsIn) || 0.6) + 'in',
      '--rb-doc-font': RB.letter.FONT_STACKS[d.fontFamily] || RB.letter.FONT_STACKS.system,
      '--rb-doc-section-gap': (Number(d.sectionGapPt) || 14) + 'pt',
      '--rb-doc-entry-gap': (Number(d.entryGapPt) || 7) + 'pt',
      '--rb-doc-tracking': (Number(d.letterSpacing) || 0) + 'em'
    };
  }

  var LETTER_PARAGRAPHS = [
    { key: 'opening', label: 'Why this role' },
    { key: 'evidence', label: 'What you have done' },
    { key: 'fit', label: 'Why this company' },
    { key: 'close', label: 'Close' }
  ];

  function letterPage(r) {
    var letter = RB.letter;
    var draft = letter.get();
    var name = letter.senderName(r);
    var contact = letter.contactLine(r);

    var page = el('article', {
      class: 'rb-letter',
      dataset: { pageSize: letter.pageSizeOf(r) },
      'aria-label': 'Cover letter'
    });
    var vars = designVars((r || {}).design);
    Object.keys(vars).forEach(function (k) { page.style.setProperty(k, vars[k]); });

    var sheet = el('div', { class: 'rb-letter__sheet' });

    if (name) sheet.appendChild(el('p', { class: 'rb-letter__sender', text: name }));
    if (contact) sheet.appendChild(el('p', { class: 'rb-letter__sender-meta', text: contact }));
    sheet.appendChild(el('hr', { class: 'rb-letter__rule' }));

    sheet.appendChild(el('p', {
      class: 'rb-letter__line rb-letter__date', dataset: { lpath: 'date' },
      'data-placeholder': 'Add a date', text: draft.date
    }));

    var to = el('address', { class: 'rb-letter__to' });
    ['toName', 'toCompany', 'toAddress'].forEach(function (key) {
      to.appendChild(el('p', {
        class: 'rb-letter__line',
        dataset: { lpath: key },
        'data-placeholder': key === 'toName' ? 'Who is this for?' : ' ',
        text: draft[key]
      }));
    });
    sheet.appendChild(to);

    sheet.appendChild(el('p', {
      class: 'rb-letter__p rb-letter__greeting', dataset: { lpath: 'greeting' },
      'data-placeholder': 'Add a greeting', text: draft.greeting
    }));

    LETTER_PARAGRAPHS.forEach(function (para) {
      sheet.appendChild(el('p', {
        class: 'rb-letter__p', dataset: { lpath: para.key },
        'data-placeholder': 'Write this paragraph, or use “Write it for me”.',
        text: draft[para.key]
      }));
    });

    sheet.appendChild(el('p', {
      class: 'rb-letter__p rb-letter__signoff', dataset: { lpath: 'signoff' },
      'data-placeholder': 'Sign-off', text: draft.signoff
    }));
    if (name) sheet.appendChild(el('p', { class: 'rb-letter__line rb-letter__signer', text: name }));

    page.appendChild(sheet);
    return page;
  }

  /* Inline editing on the page, the same contract the resume uses: a
   * data-lpath attribute is the only coupling between the document and the
   * draft. Pasting is forced back to plain text so a Word paragraph cannot
   * smuggle markup into the draft. */
  function bindLetterPage(root, r, onChange) {
    var edits = [];
    U.qsa('[data-lpath]', root).forEach(function (node) {
      node.setAttribute('contenteditable', 'plaintext-only');
      node.setAttribute('spellcheck', 'true');
      node.setAttribute('role', 'textbox');
      node.setAttribute('aria-multiline', 'false');
      node.setAttribute('aria-label', ariaLabelFor(node.dataset.lpath));

      var push = function () {
        var value = U.htmlToText(node.innerHTML).replace(/\s+/g, ' ').trim();
        RB.letter.set(node.dataset.lpath, value);
        if (onChange) onChange();
      };
      var debounced = U.debounce(push, 300);
      var onInput = function () { debounced(); };
      var onPaste = function (ev) {
        ev.preventDefault();
        var text = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || '';
        doc.execCommand('insertText', false, text.replace(/\s+/g, ' '));
      };
      var onKey = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        node.blur();
      };
      var onBlur = function () { debounced.cancel(); push(); };

      node.addEventListener('input', onInput);
      node.addEventListener('paste', onPaste);
      node.addEventListener('keydown', onKey);
      node.addEventListener('blur', onBlur);
      edits.push(function () {
        node.removeEventListener('input', onInput);
        node.removeEventListener('paste', onPaste);
        node.removeEventListener('keydown', onKey);
        node.removeEventListener('blur', onBlur);
        debounced.cancel();
      });
    });
    return function () { edits.forEach(function (off) { off(); }); };
  }

  function ariaLabelFor(path) {
    var found = LETTER_PARAGRAPHS.filter(function (p) { return p.key === path; })[0];
    if (found) return 'Cover letter: ' + found.label;
    if (path === 'greeting') return 'Cover letter: greeting';
    if (path === 'signoff') return 'Cover letter: sign-off';
    if (path === 'date') return 'Cover letter: date';
    return 'Cover letter: ' + path;
  }

  function wordBadge(r) {
    var out = RB.letter.compose(RB.letter.get(), r);
    var badge = el('span', {
      class: 'rb-badge rb-ds__count', role: 'status', 'aria-live': 'polite',
      text: U.pluralize(out.words, 'word')
    });
    var state_ = RB.letter.lengthState(out.words);
    badge.classList.add(state_ === 'ok' ? 'rb-badge--pass' : (state_ === 'long' ? 'rb-badge--warn' : 'rb-badge--fail'));
    var note = state_ === 'over'
      ? ' This is running onto a second page.'
      : (state_ === 'long'
        ? ' A cover letter reads best under ' + RB.letter.SOFT_MAX_WORDS + ' words.'
        : ' Fits on one page.');
    badge.appendChild(el('span', { class: 'rb-ds__count-note', text: note }));
    return badge;
  }

  /* The job description is one scratch field shared by both documents: paste
   * it once in either tab and the other one uses it too. It lives with the
   * prep state in IndexedDB, so it shares the session lifetime and the reload
   * guard clears it with everything else. */
  function jdText() { return (RB.prep.get().jd || ''); }

  function jdField(id, rows, onChange) {
    var box = el('textarea', {
      id: id, class: 'rb-textarea', rows: String(rows || 4), spellcheck: 'false',
      placeholder: 'Paste the job description. Optional — the letter reads fine without it.',
      'aria-describedby': id + '-hint'
    });
    box.value = jdText();
    var push = U.debounce(function () {
      RB.prep.set({ jd: box.value });
      if (onChange) onChange();
    }, 500);
    box.addEventListener('input', push);
    return labelled(id, 'Job description', box,
      'Stays in this browser, is never uploaded, and is not saved with your resume.');
  }

  function borrowButton(onDone) {
    var borrow = U.qs('#rb-jd-text');
    if (!borrow || !String(borrow.value || '').trim()) return null;
    var use = el('button', {
      type: 'button', class: 'rb-btn rb-btn--secondary rb-btn--sm',
      text: 'Use the description already in Job match'
    });
    use.addEventListener('click', function () {
      RB.prep.set({ jd: String(borrow.value || '') });
      onDone();
      toast('Job description copied over.', 'success');
    });
    return use;
  }

  function letterSide() {
    var letter = RB.letter;
    var side = el('div', { class: 'rb-ds__side-inner' });

    side.appendChild(sectionTitle('Who it is for', 'The address, the role, and how you heard about it. Everything after that is filled from your resume.'));

    var draft = letter.get();
    /* Every field that changes who the letter is addressed to re-derives the
     * prose, but only while the prose is still the one the generator wrote.
     * Once the user has a letter they care about, typing a company name must
     * not overwrite their sentences. */
    var repaint = function () { refreshMain(); };

    side.appendChild(labelled('rb-lt-name', 'Hiring manager or recipient', textInput('rb-lt-name', draft.toName, 'Jordan Lee', function (v) {
      letter.set({ toName: v });
      if (letter.get().generated) regenerate(true);
    }), 'Leave it empty and the letter is addressed to the hiring team.'));

    side.appendChild(labelled('rb-lt-company', 'Company', textInput('rb-lt-company', draft.toCompany, 'Northwind Labs', function (v) {
      letter.set({ toCompany: v });
      if (letter.get().generated) regenerate(true);
    })));

    side.appendChild(labelled('rb-lt-address', 'Address', textInput('rb-lt-address', draft.toAddress, '100 Market St, San Francisco', function (v) {
      letter.set({ toAddress: v });
      if (letter.get().generated) regenerate(true);
    }), 'Optional. A city is enough.'));

    side.appendChild(labelled('rb-lt-role', 'Role', textInput('rb-lt-role', draft.role, 'Senior Product Designer', function (v) {
      letter.set({ role: v });
      if (letter.get().generated) regenerate(true);
    })));

    side.appendChild(labelled('rb-lt-source', 'How you heard about it', selectInput('rb-lt-source', draft.source, RB.letter.SOURCES.map(function (s) {
      return { id: s.id, label: s.label + ' — ' + s.blurb };
    }), function (v) {
      letter.set({ source: v });
      regenerate(true);
    })));

    side.appendChild(labelled('rb-lt-referrer', 'Who referred you', textInput('rb-lt-referrer', draft.referrer, 'Priya Raman', function (v) {
      letter.set({ referrer: v });
      if (letter.get().generated) regenerate(true);
    }), 'Only used when you pick “A referral”. Leave it empty and the letter says someone referred you.'));

    side.appendChild(labelled('rb-lt-tone', 'Tone', selectInput('rb-lt-tone', draft.tone, [
      { id: 'direct', label: 'Direct — plain and brief' },
      { id: 'warm', label: 'Warm — a little more conversational' }
    ], function (v) {
      letter.set({ tone: v });
      regenerate(true);
    })));

    side.appendChild(labelled('rb-lt-length', 'Length', selectInput('rb-lt-length', draft.length, RB.letter.LENGTHS.map(function (l) {
      return { id: l.id, label: l.label };
    }), function (v) {
      letter.set({ length: v });
      regenerate(true);
    })));

    side.appendChild(sectionTitle('Write it for me',
      'Rebuilds the paragraphs from your resume and this posting. It never invents a claim: every sentence it writes is one you already wrote.'));

    side.appendChild(jdField('rb-lt-jd', 4, repaint));
    var borrow = borrowButton(repaint);
    if (borrow) side.appendChild(el('div', { class: 'rb-ds__row' }, [borrow]));

    var write = el('button', { type: 'button', class: 'rb-btn rb-btn--primary rb-btn--block' }, [
      el('span', { html: icon('wand', 'sm') }),
      el('span', { text: 'Write it for me' })
    ]);
    write.addEventListener('click', function () { regenerate(false); });
    side.appendChild(el('div', { class: 'rb-ds__row' }, [write]));

    var start = el('button', { type: 'button', class: 'rb-btn rb-btn--ghost rb-btn--block' }, [
      el('span', { html: icon('plus', 'sm') }),
      el('span', { text: 'Start an empty letter' })
    ]);
    start.addEventListener('click', function () {
      confirmThen('Start an empty letter?', 'The current letter is cleared. Your resume is not touched.', function () {
        letter.set(letter.blank());
        refreshMain();
      });
    });
    side.appendChild(el('div', { class: 'rb-ds__row' }, [start]));

    side.appendChild(el('p', {
      class: 'rb-hint rb-ds__note',
      text: 'The letter is kept in this browser only. Reloading the page clears it along with your resume.'
    }));
    return side;

    function regenerate(quiet) {
      RB.letter.set(RB.letter.generate(RB.store.get(), jdText(), { keep: {} }));
      if (!quiet) toast('Letter rebuilt from your resume.', 'success');
      refreshMain();
    }
  }

  function letterActions() {
    var wrap = el('div', { class: 'rb-ds__actions' });

    var printBtn = el('button', { type: 'button', class: 'rb-btn rb-btn--primary rb-btn--sm rb-ds__printbtn' }, [
      el('span', { html: icon('printer', 'sm') }),
      el('span', { class: 'rb-btn__label', text: 'Print or save as PDF' })
    ]);
    printBtn.addEventListener('click', function () {
      var page = U.qs('[data-rb-letter-page]');
      if (!page) { toast('The letter is not on screen yet.', 'warn'); return; }
      printNode(page, RB.letter.pageSizeOf(RB.store.get()));
    });

    var copy = iconButton({ icon: 'copy', label: 'Copy the letter as text', tip: 'Copy as text', small: true, cls: 'rb-btn--secondary' });
    copy.addEventListener('click', function () {
      var out = RB.letter.compose(RB.letter.get(), RB.store.get());
      if (!out.text.trim()) { toast('There is nothing on the page to copy yet.', 'warn'); return; }
      U.copyText(out.text).then(function () {
        toast('Letter copied.', 'success');
      }, function () {
        toast('This browser would not let the page copy. Select the text on the page and copy it by hand.', 'error');
      });
    });

    var dl = iconButton({ icon: 'download', label: 'Download the letter', tip: 'Download', small: true, cls: 'rb-btn--secondary', haspopup: 'menu' });
    dl.addEventListener('click', function () {
      var list = el('div', { role: 'menu', class: 'rb-col', style: 'gap:1px' });
      [
        { label: 'Plain text (.txt)', run: function () {
          U.download(RB.letter.filename(RB.store.get()), RB.letter.compose(RB.letter.get(), RB.store.get()).text, 'text/plain;charset=utf-8');
        } },
        { label: 'Markdown (.md)', run: function () {
          var name = RB.letter.filename(RB.store.get()).replace(/\.txt$/, '.md');
          U.download(name, RB.letter.markdown(RB.store.get()), 'text/markdown;charset=utf-8');
        } }
      ].forEach(function (item) {
        var b = el('button', { type: 'button', class: 'rb-pop__item', role: 'menuitem', text: item.label });
        b.addEventListener('click', function () { item.run(); if (RB.ui && RB.ui.closePopover) RB.ui.closePopover(); });
        list.appendChild(b);
      });
      if (RB.ui && RB.ui.popover) RB.ui.popover(dl, list, { align: 'end' });
    });

    wrap.appendChild(printBtn);
    wrap.appendChild(copy);
    wrap.appendChild(dl);
    return wrap;
  }

  function letterView() {
    var main = el('div', { class: 'rb-ds__main-inner' });
    var hint = el('p', { class: 'rb-hint rb-ds__hint' });
    main.appendChild(hint);
    var wrap = el('div', { class: 'rb-letter-wrap', dataset: { rbLetterPage: '1' } });
    main.appendChild(wrap);
    var foot = el('div', { class: 'rb-ds__foot' });
    main.appendChild(foot);
    return { main: main, hint: hint, wrap: wrap, foot: foot, side: letterSide() };
  }

  function renderLetter(view, r) {
    var draft = RB.letter.get();
    view.wrap.textContent = '';
    var page = letterPage(r);
    view.wrap.appendChild(page);
    if (state.cleanup) { state.cleanup(); state.cleanup = null; }
    state.cleanup = bindLetterPage(page, r, function () { paint(view, r); });

    var out = RB.letter.compose(draft, r);
    var pages = measurePages(page);
    view.hint.textContent = draft.generated
      ? 'Every paragraph below is editable on the page. Nothing in it is a claim you did not already make in your resume.'
      : 'This letter is empty. Fill in who it is for on the left, then choose “Write it for me”.';
    view.foot.textContent = '';
    view.foot.appendChild(wordBadge(r));
    view.foot.appendChild(el('span', {
      class: 'rb-hint',
      text: pages > 1
        ? ' The page is ' + U.pluralize(pages, 'sheet') + ' long — cut a paragraph to bring it back to one.'
        : ' One page at ' + RB.letter.pageSizeOf(r) + ' size.'
    }));
    return out;
  }

  /* Page count from the rendered box, not from a word estimate: the sheet is
   * a real page-height element with the document margin as its padding, so a
   * taller box is literally a second page. */
  function measurePages(page) {
    if (!page || !page.getBoundingClientRect) return 1;
    var sheet = U.qs('.rb-letter__sheet', page);
    var one = page.getBoundingClientRect().height;
    if (!sheet || !one) return 1;
    return Math.max(1, Math.ceil((sheet.getBoundingClientRect().height - 2) / one));
  }

  /* -------------------------------------------------------------------- prep */

  function prepView() {
    var main = el('div', { class: 'rb-ds__main-inner' });
    var hint = el('p', { class: 'rb-hint rb-ds__hint' });
    main.appendChild(hint);
    var wrap = el('div', { class: 'rb-prep', dataset: { rbPrepPage: '1' } });
    main.appendChild(wrap);
    var foot = el('div', { class: 'rb-ds__foot' });
    main.appendChild(foot);
    return { main: main, hint: hint, wrap: wrap, foot: foot, side: prepSide() };
  }

  function prepSide() {
    var prep = RB.prep;
    var side = el('div', { class: 'rb-ds__side-inner' });
    var s = prep.get();

    side.appendChild(sectionTitle('The job', 'Everything on the sheet is built from your resume and this posting. Nothing is sent anywhere.'));

    side.appendChild(labelled('rb-pr-role', 'Role', textInput('rb-pr-role', s.role, 'Senior Product Designer', function (v) {
      prep.set({ role: v });
      refreshMain();
    })));

    side.appendChild(labelled('rb-pr-company', 'Company', textInput('rb-pr-company', s.company, 'Northwind Labs', function (v) {
      prep.set({ company: v });
      refreshMain();
    })));

    side.appendChild(jdField('rb-pr-jd', 6, function () { refreshMain(); }));
    var borrow = borrowButton(function () { refreshMain(); });
    if (borrow) side.appendChild(el('div', { class: 'rb-ds__row' }, [borrow]));

    var clear = el('button', { type: 'button', class: 'rb-btn rb-btn--ghost rb-btn--block' }, [
      el('span', { html: icon('refresh', 'sm') }),
      el('span', { text: 'Clear every tick' })
    ]);
    clear.addEventListener('click', function () {
      confirmThen('Clear every tick?', 'The list stays, the ticks go. Your resume is not touched.', function () {
        prep.clearTicks();
        refreshMain();
      });
    });
    side.appendChild(el('div', { class: 'rb-ds__row' }, [clear]));

    side.appendChild(el('p', {
      class: 'rb-hint rb-ds__note',
      text: 'Ticks are kept in this browser. Reloading the page clears them along with your resume.'
    }));
    return side;
  }

  function prepActions() {
    var wrap = el('div', { class: 'rb-ds__actions' });
    var printBtn = el('button', { type: 'button', class: 'rb-btn rb-btn--primary rb-btn--sm rb-ds__printbtn' }, [
      el('span', { html: icon('printer', 'sm') }),
      el('span', { class: 'rb-btn__label', text: 'Print the checklist' })
    ]);
    printBtn.addEventListener('click', function () {
      var page = U.qs('[data-rb-prep-page]');
      if (!page) { toast('The checklist is not on screen yet.', 'warn'); return; }
      printNode(page, 'Letter');
    });

    var dl = iconButton({ icon: 'download', label: 'Download the checklist', tip: 'Download', small: true, cls: 'rb-btn--secondary', haspopup: 'menu' });
    dl.addEventListener('click', function () {
      var list = el('div', { role: 'menu', class: 'rb-col', style: 'gap:1px' });
      var b = el('button', { type: 'button', class: 'rb-pop__item', role: 'menuitem', text: 'Plain text (.txt)' });
      b.addEventListener('click', function () {
        var name = U.slugify((RB.prep.get().company || 'interview') + '-prep') + '.txt';
        U.download(name, RB.prep.asText(RB.store.get(), RB.prep.get()), 'text/plain;charset=utf-8');
        if (RB.ui && RB.ui.closePopover) RB.ui.closePopover();
      });
      list.appendChild(b);
      if (RB.ui && RB.ui.popover) RB.ui.popover(dl, list, { align: 'end' });
    });
    wrap.appendChild(printBtn);
    wrap.appendChild(dl);
    return wrap;
  }

  function renderPrep(view, r) {
    var prep = RB.prep;
    var s = prep.get();
    var built = prep.build(r, s);

    view.wrap.textContent = '';
    var head = el('header', { class: 'rb-prep__head' });
    head.appendChild(el('h3', { class: 'rb-prep__title', text: 'Interview prep' }));
    var who = [s.role, s.company].map(function (v) { return U.htmlToText(String(v || '')).trim(); })
      .filter(Boolean).join(' at ');
    if (who) head.appendChild(el('p', { class: 'rb-hint', text: who }));
    head.appendChild(el('p', {
      class: 'rb-hint',
      text: 'Prepared ' + U.formatDate(new Date(), 'MMMM YYYY') + '. Ticks are kept in this browser.'
    }));
    view.wrap.appendChild(head);

    built.groups.forEach(function (group) {
      var section = el('section', { class: 'rb-prep__group' });
      section.appendChild(el('h4', { class: 'rb-prep__group-title', text: group.title }));
      if (group.note) section.appendChild(el('p', { class: 'rb-hint rb-prep__group-note', text: group.note }));
      group.items.forEach(function (item) { section.appendChild(prepRow(item, s)); });
      view.wrap.appendChild(section);
    });

    var total = built.groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    view.hint.textContent = total + ' items, built from your resume' +
      (s.jd.trim() ? ' and the posting you pasted.' : '. Paste a job description to sharpen it.');

    paintProgress(view.foot, built);
    return built;
  }

  function paintProgress(foot, built) {
    if (!foot) return;
    var pct = built.total ? Math.round(100 * built.done / built.total) : 0;
    foot.textContent = '';
    foot.appendChild(el('span', {
      class: 'rb-badge ' + (built.total && built.done === built.total ? 'rb-badge--pass' : 'rb-badge--info'),
      role: 'status', 'aria-live': 'polite', text: built.done + ' of ' + built.total + ' done'
    }));
    foot.appendChild(el('div', {
      class: 'rb-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': String(pct), 'aria-label': 'Preparation progress'
    }, [el('span', { class: 'rb-meter__fill', style: 'width:' + pct + '%' })]));
  }

  function prepRow(item, stateIn) {
    var id = 'rb-prep-' + item.id.replace(/[^a-z0-9]+/gi, '-');
    var box = el('input', { type: 'checkbox', id: id });
    box.checked = !!stateIn.done[item.id];
    var text = el('span', { class: 'rb-prep__item-text' });
    text.appendChild(el('span', { class: 'rb-prep__item-label', text: item.text }));
    if (item.hint) text.appendChild(el('span', { class: 'rb-hint rb-prep__item-hint', text: item.hint }));
    var label = el('label', { class: 'rb-prep__item', for: id }, [box, text]);
    if (item.action === 'check') {
      label.appendChild(el('span', { class: 'rb-prep__item-flag', text: 'From Check' }));
    }
    box.addEventListener('change', function () {
      RB.prep.toggle(item.id, box.checked);
      var built = RB.prep.build(RB.store.get(), RB.prep.get());
      if (els.foot) paintProgress(els.foot, built);
    });
    return label;
  }

  function confirmThen(title, message, run) {
    if (RB.ui && typeof RB.ui.confirm === 'function') {
      RB.ui.confirm({ title: title, message: message, confirmLabel: 'Yes', tone: 'danger' }).then(function (yes) {
        if (yes) run();
      });
      return;
    }
    run();
  }

  /* ------------------------------------------------------------------ shell */

  function paint(view, r) {
    if (!view) return;
    if (state.tab === 'letter') renderLetter(view, r);
    else renderPrep(view, r);
  }

  function buildBar() {
    var title = el('h2', { class: 'rb-ds__title', id: 'rb-ds-title', text: '' });
    var seg = el('div', { class: 'rb-seg rb-ds__seg', role: 'tablist', 'aria-label': 'Document' });
    TABS.forEach(function (tab) {
      var b = el('button', {
        type: 'button', class: 'rb-seg__btn', role: 'tab', id: 'rb-ds-tab-' + tab.id,
        'aria-selected': 'false', tabindex: '-1', dataset: { dsTab: tab.id }
      }, [
        el('span', { html: icon(tab.icon, 'sm') }),
        el('span', { text: tab.label })
      ]);
      b.addEventListener('click', function () { selectTab(tab.id); });
      seg.appendChild(b);
    });
    seg.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      var tabs = U.qsa('[data-ds-tab]', seg);
      var at = tabs.indexOf(doc.activeElement);
      if (at === -1) return;
      ev.preventDefault();
      var next = tabs[(at + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next.dataset.dsTab);
    });

    var actions = el('div', { class: 'rb-ds__actions-host' });
    var sideToggle = iconButton({
      icon: 'settings', label: 'Show the details panel', tip: 'Details',
      small: true, cls: 'rb-btn--ghost', expanded: false, controls: 'rb-ds-side'
    });
    sideToggle.classList.add('rb-ds__sidebtn');
    sideToggle.addEventListener('click', function () { setSide(!state.sideOpen); });

    var close = iconButton({ icon: 'x', label: 'Close', tip: 'Close (Esc)', small: true, cls: 'rb-btn--ghost rb-ds__close' });
    close.addEventListener('click', function () { closeWorkspace(); });

    var bar = el('header', { class: 'rb-ds__bar' }, [title, seg, el('span', { class: 'rb-spacer' }), actions, sideToggle, close]);
    return { bar: bar, title: title, seg: seg, actions: actions, sideToggle: sideToggle };
  }

  function setSide(open) {
    state.sideOpen = !!open;
    if (!els.dialog) return;
    els.dialog.setAttribute('data-side', state.sideOpen ? 'open' : 'closed');
    els.sideToggle.setAttribute('aria-expanded', String(state.sideOpen));
    els.sideToggle.setAttribute('aria-label', state.sideOpen ? 'Hide the details panel' : 'Show the details panel');
  }

  function selectTab(id) {
    var next = TABS.filter(function (t) { return t.id === id; })[0];
    if (!next) return;
    var changed = state.tab !== id;
    state.tab = id;
    if (els.seg) {
      U.qsa('[data-ds-tab]', els.seg).forEach(function (b) {
        var on = b.dataset.dsTab === id;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }
    if (els.title) els.title.textContent = next.title;
    if (state.open) {
      render();
      if (changed) U.announce(next.title);
    }
    syncTriggers();
  }

  /* Only the document side is re-derived. Rebuilding the details panel on every
   * keystroke would take the focus out of the field being typed into. */
  function refreshMain() {
    if (!state.open || !els.main) return;
    if (typeof state.cleanup === 'function') { state.cleanup(); state.cleanup = null; }
    els.main.textContent = '';
    var r = RB.store.get();
    var view = state.tab === 'letter' ? letterView() : prepView();
    els.main.appendChild(view.main);
    els.foot = view.foot;
    if (els.actions) {
      els.actions.textContent = '';
      els.actions.appendChild(state.tab === 'letter' ? letterActions() : prepActions());
    }
    paint(view, r);
  }

  function render() {
    if (!els.dialog) return;
    var r = RB.store.get();
    var view = state.tab === 'letter' ? letterView() : prepView();

    els.side.textContent = '';
    els.side.appendChild(view.side);
    els.main.textContent = '';
    els.main.appendChild(view.main);
    els.foot = view.foot;

    els.actions.textContent = '';
    els.actions.appendChild(state.tab === 'letter' ? letterActions() : prepActions());

    paint(view, r);
  }

  function open(id) {
    if (!RB.letter || !RB.prep || !RB.letter.load || !RB.prep.load) {
      toast('Documents are not available right now.', 'warn');
      return;
    }
    var root = U.qs('#rb-overlay-root');
    if (!root) return;

    if (!state.open) state.returnFocus = doc.activeElement;
    selectTab(id || state.tab);
    if (state.open) return;

    var parts = buildBar();
    els.title = parts.title;
    els.seg = parts.seg;
    els.actions = parts.actions;
    els.sideToggle = parts.sideToggle;
    els.side = el('aside', {
      class: 'rb-ds__side rb-scroll', id: 'rb-ds-side', 'aria-label': 'Document details'
    });
    els.main = el('div', { class: 'rb-ds__main rb-scroll' });
    els.body = el('div', { class: 'rb-ds__body' }, [els.side, els.main]);
    els.dialog = el('div', {
      class: 'rb-ds', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rb-ds-title', tabindex: '-1'
    }, [parts.bar, els.body]);

    els.backdrop = el('div', { class: 'rb-ds-backdrop' }, [els.dialog]);
    els.backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === els.backdrop) closeWorkspace();
    });

    root.appendChild(els.backdrop);
    state.open = true;
    state.cleanup = null;
    state.footHost = null;
    setSide(global.matchMedia ? !global.matchMedia('(max-width: ' + MOBILE_MAX + 'px)').matches : true);
    selectTab(state.tab);

    function onKey(ev) {
      if (!state.open || !els.dialog) return;
      /* A dialog opened on top of this one owns Escape, not the workspace. */
      if (ev.key === 'Escape') {
        if (U.qs('.rb-modal-backdrop')) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeWorkspace();
        return;
      }
      if (ev.key !== 'Tab') return;
      U.trapFocus(els.dialog, ev);
    }
    doc.addEventListener('keydown', onKey, true);
    state.disposers.push(function () { doc.removeEventListener('keydown', onKey, true); });

    els.dialog.focus();
    U.announce(TABS.filter(function (t) { return t.id === state.tab; })[0].title + ' opened.');
    syncTriggers();
  }

  function closeWorkspace() {
    if (!state.open) return;
    state.open = false;
    if (state.pending) { state.pending.cancel(); state.pending = null; }
    if (typeof state.cleanup === 'function') { try { state.cleanup(); } catch (err) { /* already gone */ } }
    state.cleanup = null;
    if (els.backdrop && els.backdrop.parentNode) els.backdrop.parentNode.removeChild(els.backdrop);
    state.disposers.forEach(function (off) { off(); });
    state.disposers = [];
    els = {};
    if (state.returnFocus && state.returnFocus.focus) {
      try { state.returnFocus.focus(); } catch (err) { /* the trigger is gone */ }
    }
    state.returnFocus = null;
    syncTriggers();
    U.announce('Closed.');
  }

  /* ---------------------------------------------------------- entry control */

  var triggers = [];

  function syncTriggers() {
    triggers.forEach(function (btn) {
      var on = state.open && btn.dataset.dsTab === state.tab;
      btn.setAttribute('aria-expanded', String(state.open));
      btn.classList.toggle('is-active', on);
    });
  }

  function mountSwitcher() {
    var strip = U.qs('#rb-toolstrip');
    if (!strip) return;
    var existing = U.qs('#rb-documents-switch');
    if (existing) { triggers = U.qsa('[data-ds-open]', existing); return; }

    var group = el('div', {
      id: 'rb-documents-switch', class: 'rb-toolstrip__group rb-docs-switch',
      role: 'group', 'aria-label': 'Documents'
    });
    TABS.forEach(function (tab) {
      var btn = el('button', {
        type: 'button',
        class: 'rb-btn rb-btn--ghost rb-btn--sm rb-docs-switch__btn rb-tip',
        dataset: { dsTab: tab.id, dsOpen: tab.id },
        'aria-label': 'Open the ' + tab.label.toLowerCase(),
        'data-tip': tab.label,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false'
      }, [
        el('span', { html: icon(tab.icon, 'sm') }),
        el('span', { class: 'rb-btn__label', text: tab.label })
      ]);
      btn.addEventListener('click', function () { open(tab.id); });
      group.appendChild(btn);
    });

    group.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      var at = triggers.indexOf(doc.activeElement);
      if (at === -1) return;
      ev.preventDefault();
      var next = triggers[(at + (ev.key === 'ArrowRight' ? 1 : triggers.length - 1)) % triggers.length];
      next.focus();
    });

    strip.insertBefore(group, strip.firstChild);
    strip.insertBefore(el('div', { class: 'rb-toolstrip__sep', 'aria-hidden': 'true' }), group.nextSibling);
    triggers = U.qsa('[data-ds-open]', group);
    syncTriggers();
  }

  /* A store change re-derives the open document: the letter quotes the resume
   * and the prep list is built from it, so neither can drift from the document
   * they describe. Debounced, because typing in the resume fires this on
   * every keystroke. */
  function onStoreChange() {
    if (!state.open) return;
    if (state.pending) state.pending.cancel();
    state.pending = U.debounce(function () { refreshMain(); }, 500);
    state.pending();
  }

  if (RB.bus && typeof RB.bus.on === 'function') RB.bus.on('change', onStoreChange);

  RB.documents = {
    open: open,
    close: closeWorkspace,
    isOpen: function () { return state.open; },
    tab: function () { return state.tab; },
    printNode: printNode,
    mount: mountSwitcher
  };

  function start() {
    RB.letter.load();
    RB.prep.load();
    mountSwitcher();
  }
  if (RB.onBoot) RB.onBoot(start);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window);
