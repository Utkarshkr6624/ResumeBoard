/* Resumeboard — import hub
 *
 * Four ways in: .docx, .json, pasted text, PDF. Three of them never touch the
 * network. The fourth downloads pdf.js from a CDN, and the UI says so in
 * those words, shows the exact URLs, and offers a cancel before it starts.
 *
 * Nothing lands in the resume until the user has seen every extracted field
 * with its confidence and ticked the ones they want. The commit is a single
 * store.replace, so one undo takes the whole import back out.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var model = global.RB.model;
  var store = global.RB.store;
  var ui = global.RB.ui;
  var icons = global.RB.icons;
  var doc = global.document;
  var el = U.el;

  /* pdf.js 3.x is the last release published as a classic script. 4.x is
   * ESM-only, which this project cannot load. */
  var PDF_VERSION = '3.11.174';
  var PDF_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDF_VERSION + '/';
  var PDF_LIB_URL = PDF_CDN_BASE + 'pdf.min.js';
  var PDF_WORKER_URL = PDF_CDN_BASE + 'pdf.worker.min.js';
  var PDF_LOAD_TIMEOUT = 25000;
  /* No vendor publishes a PDF parse failure rate, and this site does not quote
   * figures it cannot source. Name the cases that fail instead. */
  var PDF_FAILURE_CASES = 'Some PDFs cannot be read at all';

  var MAX_FIELDS = 400;
  var MAX_FILE_BYTES = 25 * 1024 * 1024;
  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  var ENTRY_TYPES = {};
  (model.SECTION_TYPES || []).forEach(function (s) { if (s.hasMany) ENTRY_TYPES[s.type] = true; });

  var CONFIDENCE = {
    high: { label: 'High', cls: 'rb-badge--pass' },
    medium: { label: 'Medium', cls: 'rb-badge--warn' },
    low: { label: 'Low', cls: 'rb-badge--fail' }
  };

  /* A structured source states its fields; free text only ever implies them. */
  var SOURCE = {
    json: { label: 'JSON file', basics: 'high', entries: 'high' },
    docx: { label: 'Word document', basics: 'medium', entries: 'medium' },
    text: { label: 'Pasted text', basics: 'medium', entries: 'low' },
    pdf: { label: 'PDF', basics: 'medium', entries: 'low' }
  };

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  var PHONE_RE = /^\+?[\d\s().-]{7,24}$/;
  var URL_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/;

  var SECTION_ORDER = ['experience', 'education', 'skills', 'projects', 'certifications',
    'publications', 'awards', 'volunteer', 'languages', 'interests', 'references',
    'coursework', 'presentations', 'custom'];

  var TYPE_FIELDS = {
    experience: [{ key: 'company', label: 'Company' }, { key: 'location', label: 'Location' }, { key: 'url', label: 'Company site' }],
    education: [{ key: 'institution', label: 'Institution' }, { key: 'studyType', label: 'Study type' },
      { key: 'area', label: 'Field of study' }, { key: 'score', label: 'Grade' }, { key: 'start', label: 'Start' }, { key: 'end', label: 'End' }],
    skills: [{ key: 'label', label: 'Group' }, { key: 'keywords', label: 'Skills', list: true }],
    projects: [{ key: 'name', label: 'Name' }, { key: 'url', label: 'Link' },
      { key: 'summary', label: 'Summary' }, { key: 'highlights', label: 'Highlights', list: true }],
    certifications: [{ key: 'name', label: 'Name' }, { key: 'issuer', label: 'Issuer' },
      { key: 'date', label: 'Date' }, { key: 'credentialId', label: 'Credential ID' }],
    publications: [{ key: 'title', label: 'Title' }, { key: 'authors', label: 'Authors' },
      { key: 'venue', label: 'Venue' }, { key: 'date', label: 'Date' }, { key: 'doi', label: 'DOI' }],
    awards: [{ key: 'title', label: 'Title' }, { key: 'awarder', label: 'Awarder' }, { key: 'date', label: 'Date' }],
    volunteer: [{ key: 'role', label: 'Role' }, { key: 'organization', label: 'Organization' },
      { key: 'location', label: 'Location' }, { key: 'start', label: 'Start' },
      { key: 'end', label: 'End' }, { key: 'highlights', label: 'Highlights', list: true }],
    languages: [{ key: 'language', label: 'Language' }, { key: 'fluency', label: 'Fluency' }],
    interests: [{ key: 'label', label: 'Interest' }],
    references: [{ key: 'name', label: 'Name' }, { key: 'label', label: 'Relationship' }, { key: 'contact', label: 'Contact' }],
    coursework: [{ key: 'name', label: 'Course' }, { key: 'institution', label: 'Institution' }, { key: 'date', label: 'Date' }],
    presentations: [{ key: 'title', label: 'Title' }, { key: 'event', label: 'Event' },
      { key: 'date', label: 'Date' }, { key: 'location', label: 'Location' }],
    custom: [{ key: 'label', label: 'Section title' }]
  };

  var ROLE_FIELDS = [{ key: 'position', label: 'Position' }, { key: 'start', label: 'Start' }, { key: 'end', label: 'End' }];

  var CANCELLED = { cancelled: true };

  /* ------------------------------------------------------------------ *
   * Value helpers
   * ------------------------------------------------------------------ */

  function isBlank(value) {
    if (value == null) return true;
    if (Array.isArray(value)) return value.every(isBlank);
    if (typeof value === 'object') return Object.keys(value).every(function (k) { return isBlank(value[k]); });
    return String(value).trim() === '';
  }

  function preview(value) {
    if (Array.isArray(value)) return value.filter(function (v) { return !isBlank(v); }).join('  ·  ');
    if (value && typeof value === 'object') {
      return [value.city, value.region, value.countryCode].filter(Boolean).join(', ');
    }
    return String(value == null ? '' : value);
  }

  /* Strict shapes are the only place we claim high confidence on our own. */
  function sharpen(value, fallback) {
    var text = preview(value).trim();
    if (EMAIL_RE.test(text) || PHONE_RE.test(text) || URL_RE.test(text)) return 'high';
    return fallback;
  }

  function clampConfidence(value) {
    var v = String(value == null ? '' : value).toLowerCase();
    if (v === 'high' || v === 'medium' || v === 'low') return v;
    if (v === 'certain' || v === 'sure' || v === 'exact') return 'high';
    if (v === 'guess' || v === 'unsure' || v === 'weak') return 'low';
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Parse result -> review fields
   * ------------------------------------------------------------------ */

  function makeField(path, label, value, group, type, source, explicit) {
    var conf = clampConfidence(explicit) || sharpen(value, source.entries);
    return {
      path: path,
      label: label,
      group: group,
      type: type,
      value: value,
      display: preview(value),
      confidence: conf,
      checked: conf !== 'low'
    };
  }

  function entryName(type, entry, index) {
    var hint = entry.company || entry.institution || entry.name || entry.title ||
      entry.organization || entry.language || entry.label || entry.role || entry.course || entry.event || '';
    return model.typeMeta(type).label + (hint ? ' · ' + hint : ' · Entry ' + (index + 1));
  }

  function flattenExperience(out, list, source) {
    list.forEach(function (entry, i) {
      if (!entry || typeof entry !== 'object') return;
      var group = entryName('experience', entry, i);
      TYPE_FIELDS.experience.forEach(function (f) {
        if (isBlank(entry[f.key])) return;
        out.push(makeField('experience.' + i + '.' + f.key, f.label, entry[f.key], group, 'experience', source));
      });
      var roles = Array.isArray(entry.roles) && entry.roles.length ? entry.roles : [entry];
      roles.forEach(function (role, r) {
        if (!role || typeof role !== 'object') return;
        var label = group + (roles.length > 1 ? ' · Role ' + (r + 1) : '');
        ROLE_FIELDS.forEach(function (f) {
          if (isBlank(role[f.key])) return;
          out.push(makeField('experience.' + i + '.roles.' + r + '.' + f.key, f.label, role[f.key], label, 'experience', source));
        });
        if (!isBlank(role.summary)) {
          out.push(makeField('experience.' + i + '.roles.' + r + '.summary', 'Role summary', role.summary, label, 'experience', source));
        }
        if (!isBlank(role.highlights)) {
          out.push(makeField('experience.' + i + '.roles.' + r + '.highlights', 'Highlights', role.highlights, label, 'experience', source));
        }
        if (!isBlank(role.skills)) {
          out.push(makeField('experience.' + i + '.roles.' + r + '.skills', 'Role skills', role.skills, label, 'experience', source));
        }
      });
    });
  }

  function flattenSimple(out, type, list, source) {
    list.forEach(function (entry, i) {
      if (!entry || typeof entry !== 'object') return;
      var group = entryName(type, entry, i);
      TYPE_FIELDS[type].forEach(function (f) {
        if (isBlank(entry[f.key])) return;
        var value = f.list && !Array.isArray(entry[f.key]) ? [entry[f.key]] : entry[f.key];
        out.push(makeField(type + '.' + i + '.' + f.key, f.label, value, group, type, source));
      });
    });
  }

  function flattenResume(resume, source) {
    var out = [];
    if (!resume || typeof resume !== 'object') return out;

    var b = resume.basics && typeof resume.basics === 'object' ? resume.basics : {};
    var identity = source.basics;
    var group = 'Header';

    if (!isBlank(b.name)) out.push(makeField('basics.name', 'Name', b.name, group, 'basics', identity));
    if (!isBlank(b.label)) out.push(makeField('basics.label', 'Headline', b.label, group, 'basics', identity));
    if (!isBlank(b.email)) out.push(makeField('basics.email', 'Email', b.email, group, 'basics', identity));
    if (!isBlank(b.phone)) out.push(makeField('basics.phone', 'Phone', b.phone, group, 'basics', identity));
    if (!isBlank(b.url)) out.push(makeField('basics.url', 'Website', b.url, group, 'basics', identity));
    if (b.location && typeof b.location === 'object' && !isBlank(b.location)) {
      out.push(makeField('basics.location', 'Location', b.location, group, 'basics', identity));
    }
    if (Array.isArray(b.profiles)) {
      b.profiles.forEach(function (p, i) {
        if (!p || (isBlank(p.url) && isBlank(p.label))) return;
        out.push(makeField('basics.profiles.' + i + '.url', 'Profile ' + (i + 1) + ' link', p.url || p.label, group, 'basics', identity));
      });
    }
    if (!isBlank(b.summary)) {
      out.push(makeField('basics.summary', 'Summary', b.summary, group, 'basics', source.entries));
    }

    flattenExperience(out, Array.isArray(resume.experience) ? resume.experience : [], source);
    SECTION_ORDER.forEach(function (type) {
      if (type === 'experience') return;
      var list = resume[type];
      if (!Array.isArray(list) || !TYPE_FIELDS[type]) return;
      flattenSimple(out, type, list, source);
    });

    return out;
  }

  function fromFieldLike(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var path = raw.path || raw.key || raw.bind;
    if (typeof path !== 'string' || !path) return null;
    var value = raw.value !== undefined ? raw.value : raw.text;
    if (value === undefined || value === null) return null;
    var type = String(path.split('.')[0]);
    var conf = clampConfidence(raw.confidence || raw.conf);
    return {
      path: path,
      label: String(raw.label || raw.name || type),
      group: String(raw.group || raw.section || model.typeMeta(type).label),
      type: type,
      value: value,
      display: preview(value),
      confidence: conf || sharpen(value, 'medium'),
      checked: raw.checked !== false && conf !== 'low'
    };
  }

  /* The parsers are another module's code and this one has to survive whatever
   * shape they hand back. Anything unrecognized yields no fields, and the user
   * gets the empty state instead of a broken review list. */
  function normalizeResult(raw, source) {
    var warnings = [];
    if (!raw) return { items: [], warnings: warnings };

    if (typeof raw === 'string') {
      return { items: [], warnings: ['The reader returned text instead of fields, so there is nothing to review.'] };
    }
    if (Array.isArray(raw.warnings)) {
      /* The text reader reports {code, message}; the JSON reader reports
       * {level, path, message}. String(record) would print [object Object]
       * on the review screen, which is worse than showing nothing. */
      raw.warnings.forEach(function (w) {
        if (!w) return;
        if (typeof w === 'object') {
          var where = w.path ? ' (' + w.path + ')' : '';
          warnings.push(String(w.message || w.code || '') + where);
          return;
        }
        warnings.push(String(w));
      });
    }
    if (Array.isArray(raw)) {
      return { items: raw.map(fromFieldLike).filter(Boolean), warnings: warnings };
    }
    if (Array.isArray(raw.fields)) {
      return { items: raw.fields.map(fromFieldLike).filter(Boolean), warnings: warnings };
    }

    var resume = (raw.resume && typeof raw.resume === 'object') ? raw.resume
      : (raw.draft && typeof raw.draft === 'object') ? raw.draft
        : (raw.data && typeof raw.data === 'object') ? raw.data
          : raw;
    return { items: flattenResume(resume, source), warnings: warnings };
  }

  /* ------------------------------------------------------------------ *
   * Commit
   * ------------------------------------------------------------------ */

  function blankLike(sample) {
    var out = {};
    if (!sample || typeof sample !== 'object') return out;
    Object.keys(sample).forEach(function (k) {
      var v = sample[k];
      if (k === 'id') out[k] = U.uid('gen');
      else if (Array.isArray(v)) out[k] = [];
      else if (v && typeof v === 'object') out[k] = blankLike(v);
      else if (typeof v === 'boolean') out[k] = false;
      else out[k] = '';
    });
    return out;
  }

  function entrySeed(type) {
    return ENTRY_TYPES[type] ? model.blankEntry(type) : {};
  }

  /* Walks a bind path, growing any array it runs short of. Imported entries
   * arrive positionally, so index 4 has to exist before it can be written. */
  function containerFor(draft, parts) {
    var cur = draft;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      var nextKey = parts[i + 1];
      var wantsIndex = /^\d+$/.test(nextKey);
      if (cur[key] == null) cur[key] = wantsIndex ? [] : entrySeed(key);
      if (wantsIndex && Array.isArray(cur[key])) {
        var idx = Number(nextKey);
        while (cur[key].length <= idx) {
          cur[key].push(cur[key].length ? blankLike(cur[key][0]) : entrySeed(key));
        }
        cur = cur[key][idx];
      } else {
        cur = cur[key];
      }
      if (cur == null) return null;
    }
    return cur;
  }

  function writeField(draft, path, value) {
    var parts = String(path).split('.');
    var parent = containerFor(draft, parts);
    if (!parent) return false;
    parent[parts[parts.length - 1]] = value;
    return true;
  }

  function sectionTypeOf(path) {
    var head = String(path).split('.')[0];
    return head === 'basics' || head === 'design' || head === 'meta' ? null : head;
  }

  /* One store.replace, so the whole import is one undo step. */
  function commit(items) {
    var current = store.get();
    if (!current) return 0;

    var next = model.deepClone(current);
    var touched = {};
    var applied = 0;

    items.forEach(function (item) {
      if (!item.checked || isBlank(item.value)) return;
      if (!writeField(next, item.path, item.value)) return;
      applied++;
      var type = sectionTypeOf(item.path);
      if (type) touched[type] = true;
    });

    if (!applied) return 0;

    var sections = Array.isArray(next.sections) ? next.sections : [];
    Object.keys(touched).forEach(function (type) {
      if (!sections.some(function (s) { return s.type === type; })) {
        sections.push(model.blankSection(type, sections.length));
      }
    });
    model.normalizeOrders(next);

    store.replace(next, { source: 'import' });
    return applied;
  }

  /* ------------------------------------------------------------------ *
   * View primitives
   * ------------------------------------------------------------------ */

  function iconSpan(name, size) {
    return el('span', { style: 'display:inline-flex;flex:none', html: icons.svg(name, { size: size }) });
  }

  function iconButton(name, label, tip, onClick) {
    var btn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-btn--sm rb-tip rb-tip--below',
      'aria-label': label,
      'data-tip': tip,
      html: icons.svg(name, { size: 'sm' })
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function primary(label, onClick, opts) {
    opts = opts || {};
    var btn = el('button', {
      type: 'button',
      class: 'rb-btn ' + (opts.secondary ? 'rb-btn--secondary' : 'rb-btn--primary'),
      text: label
    });
    if (opts.disabled) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function quiet(label, onClick) {
    var btn = el('button', { type: 'button', class: 'rb-btn rb-btn--ghost', text: label });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function card(style) {
    return el('div', { class: 'rb-card', style: 'padding:var(--rb-space-4);display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0' + (style ? ';' + style : '') });
  }

  function noticeCard(icon, title, bodyNode) {
    var wrap = card();
    wrap.appendChild(el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2);align-items:flex-start' }, [
      iconSpan(icon, 'sm'),
      el('span', { text: title, style: 'font-weight:600;font-size:var(--rb-text-base)' })
    ]));
    if (bodyNode) wrap.appendChild(bodyNode);
    return wrap;
  }

  function body(text) {
    return el('p', { class: 'rb-hint', text: text, style: 'font-size:var(--rb-text-base)' });
  }

  function emptyState(title, message, actionLabel, onAction) {
    var wrap = el('div', { class: 'rb-empty' });
    wrap.appendChild(el('div', { class: 'rb-empty__icon', html: icons.svg('file-text', { size: 'xl' }) }));
    wrap.appendChild(el('p', { class: 'rb-empty__title', text: title }));
    wrap.appendChild(el('p', { class: 'rb-empty__text', text: message }));
    if (actionLabel) wrap.appendChild(primary(actionLabel, onAction, { secondary: true }));
    return wrap;
  }

  function progressBar(fraction) {
    var fill = el('div', { class: 'rb-progress__bar' });
    fill.style.width = U.clamp(Math.round(fraction * 100), 0, 100) + '%';
    return el('div', { class: 'rb-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(U.clamp(Math.round(fraction * 100), 0, 100)) }, [fill]);
  }

  function codeLine(text) {
    return el('p', { class: 'rb-text-mono', text: text, style: 'word-break:break-all;color:var(--rb-text-secondary)' });
  }

  function engine() { return global.RB.importer || null; }
  function hasDocx() { var e = engine(); return !!(e && typeof e.docxText === 'function' && typeof e.text === 'function'); }
  function hasText() { var e = engine(); return !!(e && typeof e.text === 'function'); }
  function hasJson() { var x = global.RB.exporters; return !!(x && typeof x.parseJSON === 'function'); }

  /* ------------------------------------------------------------------ *
   * The hub
   * ------------------------------------------------------------------ */

  function createHub(opts) {
    opts = opts || {};
    var node = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4);min-width:0' });
    var state = { view: 'choose', pdfLoad: null, disposed: false };
    var seq = 0;
    function nextId() { return 'rb-imp-' + (++seq); }

    function setBusy(busy) { node.setAttribute('aria-busy', busy ? 'true' : 'false'); }

    function show(view) {
      if (state.disposed) return;
      state.view = view;
      U.qsa('*', node).forEach(function (child) { child.remove(); });
      node.appendChild(view);
      node.scrollTop = 0;
    }

    function fail(message, nextLabel, nextFn) {
      show(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
        noticeCard('alert-triangle', 'That did not work', body(message)),
        el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' }, [
          nextLabel ? primary(nextLabel, nextFn) : null,
          quiet('Back', function () { show(chooseView()); })
        ].filter(Boolean))
      ]));
      ui.toast(message, { tone: 'error' });
    }

    /* ---------------- .docx ---------------- */

    function runDocx() {
      if (!hasDocx()) {
        fail('Word files cannot be opened from here.', 'Paste the text instead', function () { show(pasteView()); });
        return;
      }
      U.readFile('.docx,' + DOCX_MIME)
        .then(function (file) {
          if (file.size > MAX_FILE_BYTES) throw new Error('too-large');
          setBusy(true);
          show(workView('Reading ' + file.name, 'Unpacking the document in this browser. Nothing leaves your machine.'));
          return engine().docxText(file).catch(function (err) {
            if (err && /too-large/.test(err.message)) throw err;
            /* Some builds want the bytes rather than the File. Try once. */
            return U.readAsArrayBuffer(file).then(function (buf) { return engine().docxText(buf); });
          });
        })
        .then(function (read) {
          if (state.disposed) return null;
          setBusy(false);
          /* docxText resolves {text, paragraphs}; the review step needs a
           * parsed resume. Handing it the reader's own result is what made
           * every .docx come back as "nothing to review". */
          var text = read && typeof read === 'object' ? read.text : read;
          if (typeof text !== 'string' || !text.trim()) throw new Error('no-text');
          return engine().text(text, { filename: 'document.docx' });
        })
        .then(function (parsed) {
          if (state.disposed || parsed == null) return;
          toReview(parsed, 'docx');
        })
        .catch(function (err) {
          if (state.disposed) return;
          setBusy(false);
          fail(/too-large/.test(err && err.message)
            ? 'That file is larger than 25 MB. Paste the text instead.'
            : 'That .docx could not be read. Old .doc files and scans have no readable text in them, so paste the text instead.',
            'Paste the text instead', function () { show(pasteView()); });
        });
    }

    /* ---------------- .json ---------------- */

    function runJson() {
      if (!hasJson()) {
        fail('JSON files cannot be opened from here.', null, null);
        return;
      }
      U.readFile('.json,application/json,text/plain')
        .then(function (file) {
          if (file.size > MAX_FILE_BYTES) throw new Error('too-large');
          setBusy(true);
          show(workView('Reading ' + file.name, 'Checking it against the Resumeboard and JSON Resume schemas.'));
          return U.readAsText(file).then(function (text) { return global.RB.exporters.parseJSON(text); });
        })
        .then(function (parsed) {
          if (state.disposed) return;
          setBusy(false);
          toReview(parsed, 'json');
        })
        .catch(function (err) {
          if (state.disposed) return;
          setBusy(false);
          fail(/too-large/.test(err && err.message)
            ? 'That file is larger than 25 MB.'
            : (err && err.message ? String(err.message).slice(0, 200) : 'That file is not a resume we recognise.'),
            'Paste the text instead', function () { show(pasteView()); });
        });
    }

    /* ---------------- Paste ---------------- */

    function pasteView() {
      var fieldId = nextId();
      var area = el('textarea', {
        class: 'rb-textarea',
        id: fieldId,
        rows: '14',
        spellcheck: 'true',
        placeholder: 'Paste the plain text of your resume here.',
        style: 'min-height:220px;font-family:var(--rb-font-mono);font-size:var(--rb-text-sm)'
      });
      return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
        el('div', { class: 'rb-col', style: 'gap:var(--rb-space-1)' }, [
          el('label', { class: 'rb-label', for: fieldId, text: 'Resume text' }),
          el('span', { class: 'rb-hint', text: 'Open the file in any text editor, select all, and paste. Headings, dates and bullets are read as they are written.' })
        ]),
        area,
        el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' }, [
          primary('Read this text', function () { parsePasted(area.value); }),
          quiet('Back', function () { show(chooseView()); })
        ])
      ]);
    }

    function parsePasted(text) {
      if (!hasText()) {
        fail('Pasted text cannot be read here.', null, null);
        return;
      }
      if (!text || !text.trim()) {
        ui.toast('Paste some text first.', { tone: 'warn' });
        return;
      }
      setBusy(true);
      show(workView('Reading your text', 'Working out where the header, the roles and the dates begin.'));
      Promise.resolve()
        .then(function () { return engine().text(text); })
        .then(function (parsed) {
          if (state.disposed) return;
          setBusy(false);
          toReview(parsed, 'text');
        })
        .catch(function () {
          if (state.disposed) return;
          setBusy(false);
          fail('That text could not be read. Check that it is resume text rather than a table or an image.', null, null);
        });
    }

    /* ---------------- PDF ---------------- */

    function pdfView() {
      var alreadyLoaded = !!global.pdfjsLib;
      var kids = [];

      if (alreadyLoaded) {
        kids.push(body('The reader is already loaded in this tab, so choosing a file now makes no network request at all.'));
      }

      kids.push(body('Reading a PDF needs a real PDF engine, and Resumeboard does not ship one. This is the only action in the whole app that makes a network request. It downloads the reader from cdnjs.cloudflare.com, then reads your file in this browser. Your file is never uploaded and nothing about it is sent anywhere.'));
      var urls = card();
      urls.appendChild(el('p', { class: 'rb-label', text: 'Exactly what is requested' }));
      urls.appendChild(el('div', { class: 'rb-col', style: 'gap:2px' }, [
        el('span', { class: 'rb-hint', text: 'Reader library' }),
        codeLine(PDF_LIB_URL)
      ]));
      urls.appendChild(el('div', { class: 'rb-col', style: 'gap:2px' }, [
        el('span', { class: 'rb-hint', text: 'Reader worker' }),
        codeLine(PDF_WORKER_URL)
      ]));
      kids.push(urls);

      kids.push(noticeCard('alert-triangle', PDF_FAILURE_CASES,
        body('Scans, photographs of a page, and PDFs whose text was converted to outlines have no text layer. A file locked with a password, or one owned by a company profile, will refuse to open as well. Any of those gives you an error instead of a resume. Paste the text and it works every time.')));

      kids.push(el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' }, [
        primary(alreadyLoaded ? 'Choose a PDF' : 'Download the reader and continue', pickPdf),
        quiet('Cancel', function () { show(chooseView()); })
      ]));

      return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, kids);
    }

    function pickPdf() {
      U.readFile('.pdf,application/pdf')
        .then(runPdf)
        .catch(function (err) {
          if (state.disposed) return;
          if (err && err.cancelled) { show(pdfView()); return; }
          fail(/too-large/.test(err && err.message)
            ? 'That PDF is larger than 25 MB. Paste the text instead.'
            : 'That PDF could not be opened. Paste the text instead.',
            'Paste the text instead', function () { show(pasteView()); });
        });
    }

    function runPdf(file) {
      setBusy(true);
      var bar = progressBar(0.05);
      var status = el('p', { class: 'rb-hint', text: 'Fetching the PDF reader from cdnjs.cloudflare.com.', style: 'font-size:var(--rb-text-base)' });
      show(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
        el('p', { text: 'Importing ' + file.name, style: 'font-size:var(--rb-text-md);font-weight:600;color:var(--rb-text);word-break:break-word' }),
        bar,
        status,
        el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2)' }, [
          primary('Cancel', function () { cancel(); }, { secondary: true })
        ])
      ]));

      function move(fraction, message) {
        var pct = U.clamp(Math.round(fraction * 100), 0, 100);
        var fill = bar.querySelector('.rb-progress__bar');
        if (fill) fill.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', String(pct));
        if (message) status.textContent = message;
      }

      function cancel() {
        if (state.pdfLoad) state.pdfLoad.abort();
        setBusy(false);
        if (state.disposed) return;
        show(pdfView());
        ui.toast('Download cancelled. Nothing was fetched.', { tone: 'info' });
      }

      state.pdfLoad = loadPdfJs();
      state.pdfLoad.promise
        .then(function () {
          if (state.disposed) return null;
          move(0.2, 'Reader ready. Opening the file.');
          return U.readAsArrayBuffer(file);
        })
        .then(function (bytes) {
          if (state.disposed || !bytes) return null;
          return pdfToText(bytes, function (page, total) {
            move(0.2 + 0.8 * (page / Math.max(total, 1)), 'Reading page ' + page + ' of ' + total + '.');
          });
        })
        .then(function (text) {
          state.pdfLoad = null;
          setBusy(false);
          if (state.disposed || text == null) return;
          if (!hasText()) throw new Error('no-text-parser');
          if (text.replace(/\s/g, '').length < 40) {
            fail('No text came out of that PDF, which nearly always means it is a scan. Paste the text and it will read fine.',
              'Paste the text instead', function () { show(pasteView()); });
            return;
          }
          return engine().text(text).then(function (parsed) {
            if (!state.disposed) toReview(parsed, 'pdf');
          });
        })
        .catch(function (err) {
          state.pdfLoad = null;
          setBusy(false);
          if (state.disposed || (err && err.cancelled)) return;
          fail('That PDF could not be opened. It may be a scan, password protected, or too unusual for any reader.',
            'Paste the text instead', function () { show(pasteView()); });
        });
    }

    /* The single network call in the app. Injected on click, removable, and
     * cancellable for as long as it is still in flight. */
    function loadPdfJs() {
      if (global.pdfjsLib) return { promise: Promise.resolve(global.pdfjsLib), abort: function () {} };

      var holder = { aborted: false, script: null, timer: null, abort: function () {} };
      holder.promise = new Promise(function (resolve, reject) {
        var script = doc.createElement('script');
        script.src = PDF_LIB_URL;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        holder.script = script;

        function settle(fn, value) {
          if (holder.timer) { clearTimeout(holder.timer); holder.timer = null; }
          if (script.parentNode) script.parentNode.removeChild(script);
          fn(value);
        }
        holder.abort = function () {
          if (holder.aborted) return;
          holder.aborted = true;
          settle(reject, CANCELLED);
        };
        script.onload = function () {
          if (global.pdfjsLib) settle(resolve, global.pdfjsLib);
          else settle(reject, new Error('The reader loaded but did not start.'));
        };
        script.onerror = function () {
          if (holder.aborted) return;
          settle(reject, new Error('The reader could not be downloaded.'));
        };
        holder.timer = setTimeout(function () {
          if (holder.aborted) return;
          holder.aborted = true;
          settle(reject, new Error('The reader download timed out.'));
        }, PDF_LOAD_TIMEOUT);

        doc.head.appendChild(script);
      });
      return holder;
    }

    function pdfToText(bytes, onProgress) {
      var lib = global.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return lib.getDocument({ data: bytes }).promise.then(function (doc_) {
        var pages = [];
        var chain = Promise.resolve();
        for (var n = 1; n <= doc_.numPages; n++) {
          (function (pageNo) {
            chain = chain.then(function () {
              return doc_.getPage(pageNo)
                .then(function (page) { return page.getTextContent(); })
                .then(function (content) {
                  pages[pageNo - 1] = itemsToText(content.items);
                  if (onProgress) onProgress(pageNo, doc_.numPages);
                });
            });
          })(n);
        }
        return chain.then(function () { return pages.join('\n\n'); });
      });
    }

    /* pdf.js emits positioned fragments, not lines. A change in baseline means
     * a new line; horizontal distance inside a line means a space. */
    function itemsToText(items) {
      var text = '';
      var lastY = null;
      var lastEndX = null;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || typeof item.str !== 'string') continue;
        var transform = item.transform;
        var y = transform ? transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          text += '\n';
        } else if (text && item.str && !/\s$/.test(text) && !/^\s/.test(item.str) &&
          lastEndX !== null && transform && transform[4] > lastEndX + 1) {
          text += ' ';
        }
        text += item.str;
        lastY = y;
        lastEndX = transform ? transform[4] + (item.width || 0) : null;
      }
      return text;
    }

    /* ---------------- Review ---------------- */

    function toReview(raw, sourceKey) {
      var source = SOURCE[sourceKey] || SOURCE.text;
      var result = normalizeResult(raw, source);
      var items = result.items.slice(0, MAX_FIELDS);
      if (result.items.length > MAX_FIELDS) {
        result.warnings.push('Only the first ' + MAX_FIELDS + ' of ' + result.items.length + ' fields are listed. The rest were not read.');
      }
      if (!items.length) {
        show(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
          emptyState('Nothing to review',
            'No fields were found in that ' + (source.label || 'file').toLowerCase() + '. Scans and table-heavy layouts give the reader nothing to work with, so pasting the text is the reliable path.',
            'Paste the text instead', function () { show(pasteView()); }),
          el('div', { class: 'rb-row', style: 'justify-content:center' }, [quiet('Back', function () { show(chooseView()); })])
        ]));
        return;
      }
      show(reviewView(items, result.warnings, source));
    }

    function reviewView(items, warnings, source) {
      var selected = items.filter(function (i) { return i.checked; }).length;
      var counter = el('span', { class: 'rb-hint rb-numeric', text: selected + ' of ' + items.length + ' selected', role: 'status' });
      var importBtn = primary('Import ' + selected + ' fields', function () { doImport(items); });
      if (!selected) importBtn.disabled = true;

      function refresh() {
        var n = items.filter(function (i) { return i.checked; }).length;
        counter.textContent = n + ' of ' + items.length + ' selected';
        importBtn.textContent = 'Import ' + n + ' fields';
        importBtn.disabled = n === 0;
      }

      var groups = [];
      var byGroup = Object.create(null);
      items.forEach(function (item) {
        if (!byGroup[item.group]) {
          byGroup[item.group] = { name: item.group, items: [], sync: function () {} };
          groups.push(byGroup[item.group]);
        }
        byGroup[item.group].items.push(item);
      });

      var listWrap = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-3);min-width:0' });
      groups.forEach(function (group) {
        var section = groupView(group);
        listWrap.appendChild(section);
      });

      var allBtn = el('button', { type: 'button', class: 'rb-btn rb-btn--secondary rb-btn--sm', text: 'Select all' });
      var noneBtn = el('button', { type: 'button', class: 'rb-btn rb-btn--secondary rb-btn--sm', text: 'Clear all' });
      allBtn.addEventListener('click', function () { setAll(true); });
      noneBtn.addEventListener('click', function () { setAll(false); });

      function setAll(on) {
        items.forEach(function (item) { item.checked = on; });
        U.qsa('.rb-imp-row-box', node).forEach(function (box) { box.checked = on; });
        groups.forEach(function (group) { group.sync(); });
        refresh();
      }

      var head = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-2)' }, [
        el('p', {
          text: 'Found ' + items.length + ' field' + (items.length === 1 ? '' : 's') + ' in the ' + (source.label || 'file').toLowerCase() + '. Tick what should land in your resume.',
          style: 'font-size:var(--rb-text-base);color:var(--rb-text-secondary)'
        }),
        el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-3);font-size:var(--rb-text-xs);color:var(--rb-text-muted)' }, [
          legendPill('high', 'read straight from a labelled field'),
          legendPill('medium', 'inferred from surrounding text'),
          legendPill('low', 'guessed from position and shape')
        ]),
        el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' }, [
          allBtn, noneBtn, el('span', { class: 'rb-spacer' }), counter
        ])
      ]);

      var kids = [head];
      (warnings || []).forEach(function (w) {
        kids.push(noticeCard('info', 'From the reader', body(w)));
      });
      if (hasExistingData()) {
        kids.push(noticeCard('info', 'This adds to what you already have', body(
          'A ticked field replaces the current value in the same spot. Everything you have written yourself stays. The whole import is one step, so a single undo takes all of it back out.')));
      }
      kids.push(listWrap);
      kids.push(el('hr', { class: 'rb-divider' }));
      kids.push(el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' }, [
        importBtn,
        el('span', { class: 'rb-spacer' }),
        quiet('Start over', function () { show(chooseView()); })
      ]));

      return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4);min-width:0' }, kids);

      function groupView(group) {
        var boxId = nextId();
        var box = el('input', { type: 'checkbox', id: boxId, class: 'rb-imp-group-box' });
        var count = el('span', { class: 'rb-hint rb-numeric' });
        var header = el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2)' }, [
          el('label', { class: 'rb-label', for: boxId, style: 'cursor:pointer;align-items:center;gap:var(--rb-space-2);min-width:0;flex:1 1 auto' }, [
            box,
            el('span', { class: 'rb-truncate', text: group.name })
          ]),
          count
        ]);

        var rows = el('div', { class: 'rb-col', style: 'gap:2px;min-width:0' });
        var section = el('div', {
          class: 'rb-card',
          style: 'padding:var(--rb-space-3);display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0'
        }, [header, rows]);

        function sync() {
          var on = group.items.filter(function (i) { return i.checked; }).length;
          count.textContent = on + '/' + group.items.length;
          box.checked = on === group.items.length;
          box.indeterminate = on > 0 && on < group.items.length;
        }

        box.addEventListener('change', function () {
          group.items.forEach(function (item) { item.checked = box.checked; });
          group.items.forEach(function (item) { syncRow(item); });
          sync();
          refresh();
        });

        /* A row tick has to reach refresh() as well as the group tally. The
         * count in "Import N fields" and the counter above the list are
         * written there, so syncing the group alone left the button
         * advertising fields that were no longer ticked, and left it enabled
         * with none — clicking it did nothing but say so. */
        group.items.forEach(function (item) {
          rows.appendChild(rowView(item, function () { sync(); refresh(); }));
        });
        group.sync = sync;
        sync();
        return section;
      }
    }

    function syncRow(item) {
      var boxes = U.qsa('.rb-imp-row-box', node);
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].dataset.path === item.path) { boxes[i].checked = item.checked; return; }
      }
    }

    function legendPill(level, meaning) {
      var conf = CONFIDENCE[level];
      return el('span', { class: 'rb-row-tight', style: 'gap:var(--rb-space-1)' }, [
        el('span', { class: 'rb-badge ' + conf.cls, text: conf.label }),
        el('span', { text: meaning })
      ]);
    }

    function rowView(item, onChange) {
      var boxId = nextId();
      var box = el('input', {
        type: 'checkbox', id: boxId, class: 'rb-imp-row-box',
        dataset: { path: item.path }
      });
      box.checked = item.checked;
      box.addEventListener('change', function () {
        item.checked = box.checked;
        if (onChange) onChange();
      });

      var conf = CONFIDENCE[item.confidence] || CONFIDENCE.medium;
      var valueNode = el('p', {
        class: item.display.length > 160 ? 'rb-clamp-3' : '',
        text: item.display,
        style: 'font-size:var(--rb-text-sm);color:var(--rb-text);white-space:pre-wrap;word-break:break-word;min-width:0'
      });

      var aside = el('div', { class: 'rb-col', style: 'gap:var(--rb-space-1);align-items:flex-end;flex:none' }, [
        el('span', { class: 'rb-badge ' + conf.cls }, [
          el('span', { text: conf.label }),
          el('span', { class: 'sr-only', text: ' confidence' })
        ])
      ]);

      if (item.display.length > 160) {
        var expanded = false;
        var toggle = iconButton('chevron-down', 'Show the full text of ' + item.label, 'Show full text', function () {
          expanded = !expanded;
          valueNode.classList.toggle('rb-clamp-3', !expanded);
          toggle.innerHTML = icons.svg(expanded ? 'chevron-up' : 'chevron-down', { size: 'sm' });
          toggle.setAttribute('aria-label', (expanded ? 'Hide' : 'Show') + ' the full text of ' + item.label);
        });
        aside.appendChild(toggle);
      }

      var current = currentValueAt(item.path);
      var textCol = el('div', { class: 'rb-col', style: 'gap:2px;min-width:0;flex:1 1 auto' }, [
        el('span', { text: item.label, style: 'font-size:var(--rb-text-xs);color:var(--rb-text-secondary);font-weight:600' }),
        valueNode,
        (current && current !== item.display)
          ? el('span', { class: 'rb-hint', text: 'Replaces: ' + current, style: 'font-size:var(--rb-text-xs)' })
          : null
      ].filter(Boolean));

      var label = el('label', { class: 'rb-checkbox', for: boxId, style: 'align-items:flex-start;width:100%' }, [
        box, textCol, aside
      ]);

      return el('div', {
        class: 'rb-row',
        style: 'gap:var(--rb-space-2);padding:var(--rb-space-2) 0;border-top:1px solid var(--rb-border-subtle);min-width:0;align-items:flex-start'
      }, [label]);
    }

    function currentValueAt(path) {
      var current = store.get();
      if (!current) return '';
      var value = model.getPath(current, path);
      if (isBlank(value)) return '';
      var text = preview(value).replace(/\s+/g, ' ').trim();
      return text.length > 80 ? text.slice(0, 80) + '…' : text;
    }

    function hasExistingData() {
      var current = store.get();
      return !!current && !model.isBlankResume(current);
    }

    function doImport(items) {
      var applied = commit(items);
      if (!applied) {
        ui.toast('Nothing was ticked, so nothing changed.', { tone: 'warn' });
        return;
      }
      /* Read at click time: the toast sits for four seconds, and a keystroke
         on the resume in that window would otherwise be what this Undo button
         takes back. */
      var after = JSON.stringify(store.get());
      show(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4)' }, [
        emptyState('Imported ' + applied + ' field' + (applied === 1 ? '' : 's'),
          'Everything is on the page now. Edit it there, or take the whole import back out in one step.',
          'Undo the import', function () { store.undo(); show(chooseView()); }),
        el('div', { class: 'rb-row', style: 'justify-content:center' }, [
          primary('Import something else', function () { show(chooseView()); })
        ])
      ]));
      U.announce('Imported ' + applied + ' fields');
      ui.undoableToast('Imported ' + applied + ' field' + (applied === 1 ? '' : 's') + '.', {
        tone: 'success',
        isUnchanged: function () { return JSON.stringify(store.get()) === after; },
        onUndo: function () { store.undo(); }
      });
    }

    function workView(title, message) {
      return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-3);min-width:0' }, [
        progressBar(0.35),
        el('p', { text: title, style: 'font-size:var(--rb-text-md);font-weight:600;color:var(--rb-text);word-break:break-word' }),
        el('p', { class: 'rb-hint', text: message, style: 'font-size:var(--rb-text-base)' })
      ]);
    }

    /* ---------------- Choose ---------------- */

    function pathCard(icon, title, text, buttonLabel, onClick, enabled) {
      return el('div', { class: 'rb-card', style: 'padding:var(--rb-space-4);display:flex;flex-direction:column;gap:var(--rb-space-2);min-width:0' }, [
        el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2);align-items:center' }, [
          iconSpan(icon, 'sm'),
          el('span', { text: title, style: 'font-weight:600;font-size:var(--rb-text-base)' })
        ]),
        body(text),
        el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2)' }, [
          primary(buttonLabel, onClick, { secondary: !enabled })
        ])
      ]);
    }

    function chooseView() {
      var cards = [
        pathCard('file-text', 'Word document (.docx)',
          'Read on this machine. The file is unpacked in your browser and never sent anywhere. Old .doc files and scans hold no readable text, so paste the text if this fails.',
          hasDocx() ? 'Choose a .docx' : 'Unavailable',
          hasDocx() ? runDocx : function () { unavailable('Word files cannot be opened from here.'); },
          hasDocx()),
        pathCard('file', 'Resume file (.json)',
          'Either a Resumeboard export or a JSON Resume file. Structured data is the most accurate import there is, because every field in it was written on purpose.',
          hasJson() ? 'Choose a .json' : 'Unavailable',
          hasJson() ? runJson : function () { unavailable('JSON files cannot be opened from here.'); },
          hasJson()),
        pathCard('list', 'Paste text',
          'Paste the plain text of any resume. Paste wins whenever a file will not open: copy it out of Word, Google Docs or a PDF reader and paste it straight in.',
          'Paste text', function () { show(pasteView()); }, hasText()),
        pathCard('file-down', 'PDF',
          'Needs a one-off download of a PDF reader from a CDN. This is the only thing in the app that touches the network, and you will be shown the exact address first. ' + PDF_FAILURE_CASES + ', and the cases are listed before you start.',
          'Import a PDF', function () { show(pdfView()); })
      ];

      if (!hasDocx() && !hasJson() && !hasText()) {
        cards.unshift(noticeCard('alert-triangle', 'File import is unavailable',
          body('The file readers did not load, so no file can be read. Typing or pasting into the editor is the way through.')));
      }

      return el('div', { class: 'rb-col', style: 'gap:var(--rb-space-4);min-width:0' }, [
        el('p', {
          text: 'Four ways in. Three of them never touch the network, and you will see every field before anything is written.',
          style: 'font-size:var(--rb-text-base);color:var(--rb-text-secondary)'
        })
      ].concat(cards));
    }

    function unavailable(message) {
      ui.toast(message, { tone: 'warn' });
    }

    show(chooseView());

    return {
      node: node,
      view: function () { return state.view; },
      destroy: function () {
        state.disposed = true;
        if (state.pdfLoad) state.pdfLoad.abort();
        state.pdfLoad = null;
        U.qsa('*', node).forEach(function (child) { child.remove(); });
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  var current = null;

  /* Opens the hub in a modal. The panel mount is the same node, so a topbar
   * button and the Import tab behave identically. */
  function open(opts) {
    opts = opts || {};
    if (current) current.destroy();
    var hub = createHub(opts);
    current = hub;
    if (!ui || typeof ui.modal !== 'function') {
      doc.body.appendChild(hub.node);
      return hub;
    }
    var handle = ui.modal({
      title: opts.title || 'Import',
      body: hub.node,
      wide: true,
      onClose: function () {
        hub.destroy();
        if (current === hub) current = null;
      }
    });
    hub.handle = handle;
    return hub;
  }

  function mount(container) {
    if (!container) return null;
    var hub = createHub({});
    container.appendChild(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-3);min-width:0' }, [
      el('div', { class: 'rb-row', style: 'gap:var(--rb-space-2)' }, [
        el('p', { class: 'rb-hint', text: 'Bring an existing resume in, then edit it on the page.', style: 'flex:1 1 auto;min-width:0;font-size:var(--rb-text-sm)' }),
        iconButton('maximize', 'Open the import hub in a larger window', 'Open larger', function () { open({ title: 'Import' }); })
      ]),
      hub.node
    ]));
    return hub;
  }

  if (global.RB.panels && typeof global.RB.panels.register === 'function') {
    global.RB.panels.register({
      id: 'import',
      title: 'Import',
      icon: 'upload',
      mount: function (container) {
        var hub = mount(container);
        /* The shell calls the returned fn when this tab closes. Registering a
           lifecycle hook here instead would leak one listener per mount. */
        return function () { if (hub) hub.destroy(); };
      }
    });
  }

  global.RB.importerHub = {
    open: open,
    mount: mount,
    create: createHub,
    commit: commit,
    PDF_LIB_URL: PDF_LIB_URL,
    PDF_WORKER_URL: PDF_WORKER_URL,
    sources: function () { return Object.keys(SOURCE); }
  };
})(window);
