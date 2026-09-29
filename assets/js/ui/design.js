/* Resumeboard — design panel
 *
 * Every control writes through RB.store with source 'design'. That gives the
 * renderer one code path to restyle the document, and it collapses a whole
 * slider drag into a single undo step. The panel never touches #rb-doc itself:
 * RB.templates.paint owns data-template and the --rb-doc-* properties.
 *
 * Control options come from RB.templates.tokenPresets(), which is the shared
 * catalogue, so the panel cannot offer a value model.validate would reject.
 * The local lists below are only the fallback for a page where that module did
 * not load.
 */
(function (global) {
  'use strict';

  if (!global.RB || !global.RB.utils) return;

  var U = global.RB.utils;
  var doc = global.document;
  var el = U.el;
  var bus = global.RB.bus;
  var store = global.RB.store;
  var model = global.RB.model;

  if (!store || !model || !bus || !global.RB.panels || !global.RB.panels.register) return;

  var AA_NORMAL = 4.5;
  var PAPER = '#ffffff'; // the page is white in print whatever the app theme is

  var FALLBACK = {
    fonts: [
      { id: 'system', label: 'System UI', category: 'sans' },
      { id: 'helvetica', label: 'Helvetica', category: 'sans' },
      { id: 'georgia', label: 'Georgia', category: 'serif' },
      { id: 'times', label: 'Times New Roman', category: 'serif' },
      { id: 'mono', label: 'Monospace', category: 'mono' }
    ],
    accents: [
      { id: '#151a23', label: 'Ink' },
      { id: '#232936', label: 'Graphite' },
      { id: '#4d5666', label: 'Slate' },
      { id: '#3a35bd', label: 'Indigo' },
      { id: '#0550ae', label: 'Blue' },
      { id: '#065f46', label: 'Pine' },
      { id: '#93370d', label: 'Bronze' }
    ],
    headingStyles: [
      { id: 'uppercase', label: 'Uppercase', note: 'Section titles in capitals. The most conventional choice.' },
      { id: 'title', label: 'Title case', note: 'Section titles in title case. Softer, more editorial.' },
      { id: 'rule', label: 'Rule under the heading', note: 'Section titles in title case with a rule beneath them.' }
    ],
    bulletGlyphs: [
      { id: 'disc', label: 'Disc bullet', glyph: '\u2022' },
      { id: 'square', label: 'Square bullet', glyph: '\u25AA' },
      { id: 'dash', label: 'Dash bullet', glyph: '\u2013' },
      { id: 'none', label: 'No bullet marker', glyph: '\u2014' }
    ],
    columns: [
      { id: 1, label: 'One column' },
      { id: 2, label: 'Two columns' }
    ],
    pageSizes: [
      { id: 'Letter', label: 'US Letter' },
      { id: 'A4', label: 'A4' }
    ],
    /* The full list, so a page where render/templates.js did not load still
       offers every template rather than a short list the user has to guess at.
       The notes are the same one-liners the cards show. */
    templates: [
      { id: 'classic', name: 'Classic', note: 'One column, system UI, uppercase rules. The safest page to send.' },
      { id: 'modern', name: 'Modern', note: 'Airy, larger section headings, a colour accent you can change.' },
      { id: 'compact', name: 'Compact', note: 'Smaller type, tighter gaps. A long career on one page.' },
      { id: 'executive', name: 'Executive', note: 'Georgia, wide margins, a photo slot. Built for senior roles.' },
      { id: 'academic', name: 'Academic', note: 'Times, wide margins, square bullets. A curriculum vitae.' },
      { id: 'minimal', name: 'Minimal', note: 'No bullets, no rules, no colour. Whitespace does the work.' },
      { id: 'sidebar', name: 'Two column with sidebar', note: 'Narrow left column for contact and skills, roles on the right.', columns: 2 },
      { id: 'print-bw', name: 'Print black and white', note: 'Black and white for a laser printer. Rules carry the structure.' },
      { id: 'technical', name: 'Technical', note: 'A rule under every heading, dash bullets, engineering density.' }
    ]
  };

  var CATEGORY_LABELS = { sans: 'Sans serif', serif: 'Serif', mono: 'Monospace' };
  var CATEGORY_ORDER = ['sans', 'serif', 'mono'];

  var teardown = null;
  var cancels = [];

  /* ---------------- catalogue ---------------- */

  function presets() {
    var T = global.RB.templates;
    if (T && typeof T.tokenPresets === 'function') {
      try {
        var p = T.tokenPresets();
        if (p && typeof p === 'object') return p;
      } catch (e) { /* fall through to the local lists */ }
    }
    return {};
  }

  /* The catalogue speaks {value,label}, templates {templateId,name} and fonts
     {key,label}; the controls speak {id,label}. */
  function options(list, fallback) {
    var src = Array.isArray(list) && list.length ? list : (fallback || []);
    return src.map(function (o) {
      if (o == null) return null;
      if (typeof o === 'string') return { id: o, label: U.titleCase(o) };
      var id = o.id;
      if (id === undefined) id = o.value;
      if (id === undefined) id = o.templateId;
      if (id === undefined) id = o.key;
      if (id === undefined || id === null) return null;
      return {
        id: id,
        label: o.label || o.name || String(id),
        note: o.summary || o.note || o.description || '',
        glyph: o.glyph,
        token: o.token,
        category: o.category,
        columns: o.columns
      };
    }).filter(Boolean);
  }

  function templates() {
    var out = options(presets().templates, FALLBACK.templates).map(function (t) {
      return { id: t.id, label: t.label, note: t.note };
    });
    var current = design().templateId;
    if (!out.some(function (t) { return t.id === current; })) {
      out.unshift({ id: current, label: U.titleCase(current), note: 'Current template' });
    }
    return out;
  }

  /* A bullet catalogue that stores the marker "none" as a word, not a glyph. */
  function bullets() {
    return options(presets().bulletGlyphs, FALLBACK.bulletGlyphs).map(function (o) {
      var glyph = o.glyph;
      if (!glyph || /[a-z]{2,}/i.test(glyph)) {
        glyph = { disc: '\u2022', square: '\u25AA', dash: '\u2013', none: '\u2014' }[o.id] || '\u2014';
      }
      return { id: o.id, label: o.label, glyph: glyph };
    });
  }

  /* ---------------- model plumbing ---------------- */

  function design() {
    var r = store.get();
    return (r && r.design) || model.DEFAULT_DESIGN;
  }

  function write(key, value) {
    store.update(function (draft) {
      draft.design[key] = value;
    }, { source: 'design', coalesceKey: 'design.' + key });
  }

  /* The model seeds every section label with the upper-case SECTION_TYPE
   * default, and the template CSS asks the browser to undo that with
   * `text-transform: capitalize`. Blink does not lowercase the tail of a word
   * under `capitalize`, so the two "title case" options painted the same caps
   * as "Uppercase" — the control changed the size and the rule but never the
   * case it is named for. Recase the label in the model instead, and only when
   * it is still the untouched default, so a heading the user renamed by hand
   * is never rewritten underneath them. */
  function applyHeadingCase(style) {
    if (style === 'uppercase') return;
    var titleCase = model.SECTION_TYPES.reduce(function (acc, t) {
      acc[String(t.defaultLabel || '').toLowerCase()] = U.titleCase(t.defaultLabel || t.label || '');
      return acc;
    }, {});
    /* `update`, not `design`: a design write takes the renderer's no-rebuild
     * repaint path on the grounds that it cannot have changed any content.
     * This one has, and repaint deliberately leaves field text alone. */
    store.update(function (draft) {
      (draft.sections || []).forEach(function (sec) {
        if (!sec || typeof sec.label !== 'string') return;
        var next = titleCase[sec.label.trim().toLowerCase()];
        if (next) sec.label = next;
      });
    }, { source: 'update' });
  }

  function normalizeHex(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    /* contrast() only reads #rrggbb, so expand shorthand before comparing. */
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return s;
  }

  /* Defaults for the template that is selected, so "reset" means the template's
     own starting point rather than the built-in constant. */
  function templateDefaults(templateId) {
    var out = Object.assign({}, model.DEFAULT_DESIGN);
    var T = global.RB.templates;
    var preset = T && typeof T.get === 'function' ? T.get(templateId) : null;
    if (preset && typeof preset === 'object') {
      Object.keys(out).forEach(function (k) {
        if (preset[k] !== undefined) out[k] = preset[k];
      });
    }
    return out;
  }

  function applyTemplate(id) {
    var T = global.RB.templates;
    /* Applying a preset is the template module's write, not ours: it knows the
       full token set for that template. An id it does not know is a plain
       templateId change, written here. */
    if (T && typeof T.apply === 'function' && typeof T.get === 'function' && T.get(id)) {
      T.apply(id);
      /* Presets carry their own headingStyle, so a title-case template needs
         the same recasing the Design tab does. */
      applyHeadingCase(design().headingStyle);
      return;
    }
    write('templateId', id);
  }

  function pageCount() {
    var P = global.RB.paginator;
    if (!P || typeof P.last !== 'function') return null;
    var last = null;
    try { last = P.last(); } catch (e) { return null; }
    var n = last && (last.pages != null ? last.pages : last.count);
    return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  /* ---------------- small builders ---------------- */

  function icon(name) {
    var icons = global.RB.icons;
    return icons && typeof icons.el === 'function' ? icons.el(name) : null;
  }

  function debounced(fn, ms) {
    var d = U.debounce(fn, ms);
    cancels.push(function () { d.cancel(); });
    return d;
  }

  function field(labelNode, control, hintNode) {
    return el('div', { class: 'rb-field' }, [labelNode, control, hintNode]);
  }

  function label(id, text) {
    return el('span', { class: 'rb-label', id: id, text: text });
  }

  function hint(text) {
    return el('span', { class: 'rb-hint', text: text });
  }

  function section(title, children) {
    return el('section', { class: 'rb-col', style: 'gap:var(--rb-space-3)' }, [
      el('h3', { class: 'rb-label', text: title })
    ].concat(children));
  }

  /* Single-select groups render as toggle buttons: aria-pressed is valid on a
     button and base.css already styles the pressed state, so no new CSS. */
  function segment(cfg) {
    var group = el('div', {
      class: 'rb-btn-group',
      role: 'group',
      'aria-labelledby': cfg.labelId,
      style: 'flex-wrap:wrap'
    });
    var buttons = cfg.options.map(function (opt) {
      var b = el('button', {
        type: 'button',
        class: 'rb-btn rb-btn--ghost rb-btn--sm',
        'aria-pressed': 'false',
        dataset: { value: String(opt.id) }
      });
      if (opt.glyph) {
        b.setAttribute('aria-label', opt.label);
        b.setAttribute('data-tip', opt.label);
        b.classList.add('rb-tip');
        b.appendChild(el('span', { text: opt.glyph, 'aria-hidden': 'true' }));
      } else {
        b.appendChild(el('span', { text: opt.label }));
        if (opt.note) { b.setAttribute('data-tip', opt.note); b.classList.add('rb-tip'); }
      }
      b.addEventListener('click', function () { cfg.onPick ? cfg.onPick(opt.id) : write(cfg.key, opt.id); });
      group.appendChild(b);
      return b;
    });
    return {
      node: group,
      sync: function () {
        var cur = String(cfg.value());
        buttons.forEach(function (b) {
          b.setAttribute('aria-pressed', b.dataset.value === cur ? 'true' : 'false');
        });
      }
    };
  }

  function select(cfg) {
    var node = el('select', { class: 'rb-select', 'aria-labelledby': cfg.labelId });
    var grouped = cfg.options.some(function (o) { return !!o.category; });
    var buckets = {};
    cfg.options.forEach(function (o) {
      var key = o.category || '';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(o);
    });
    function fillOption(o) { return el('option', { value: o.id, text: o.label }); }
    if (grouped) {
      CATEGORY_ORDER.filter(function (c) { return buckets[c]; }).forEach(function (c) {
        var group = el('optgroup', { label: CATEGORY_LABELS[c] || c });
        buckets[c].forEach(function (o) { group.appendChild(fillOption(o)); });
        node.appendChild(group);
      });
    } else {
      cfg.options.forEach(function (o) { node.appendChild(fillOption(o)); });
    }
    node.addEventListener('change', function () { write(cfg.key, node.value); });
    return {
      node: node,
      sync: function () { node.value = String(cfg.value()); }
    };
  }

  function switchControl(cfg) {
    var id = U.uid('rbd');
    var input = el('input', { type: 'checkbox', id: id });
    input.checked = !!cfg.value();
    input.addEventListener('change', function () { write(cfg.key, input.checked); });
    var node = el('label', { class: 'rb-switch', for: id }, [
      input,
      el('span', { class: 'rb-switch-track', 'aria-hidden': 'true' }),
      el('span', { text: cfg.text })
    ]);
    return { node: node, sync: function () { input.checked = !!cfg.value(); } };
  }

  /* Range plus a typed value. The visible label names the slider; the number
     box names itself, so neither control has an unnamed twin. */
  function numberRange(cfg) {
    var rangeId = U.uid('rbd');
    var range = el('input', {
      type: 'range', class: 'rb-range', id: rangeId,
      min: cfg.min, max: cfg.max, step: cfg.step
    });
    var num = el('input', {
      type: 'number', class: 'rb-input rb-input--sm rb-numeric',
      min: cfg.min, max: cfg.max, step: cfg.step,
      'aria-label': cfg.label + ' value'
    });
    num.style.cssText = 'width:76px;flex:none;text-align:right';

    var fmt = cfg.format || function (v) { return String(Math.round(v * 100) / 100); };

    function snap(v) {
      if (!cfg.step) return U.clamp(v, cfg.min, cfg.max);
      return U.clamp(Math.round(v / cfg.step) * cfg.step, cfg.min, cfg.max);
    }
    function commit(v) {
      if (!isFinite(v)) return;
      write(cfg.key, Math.round(snap(v) * 1000) / 1000);
    }
    var push = U.throttle(function (v) { commit(v); }, 80);

    function paint() { num.value = fmt(Number(range.value)); }

    range.addEventListener('input', function () { push(Number(range.value)); paint(); });
    range.addEventListener('change', function () { commit(Number(range.value)); paint(); });

    num.addEventListener('input', function () {
      var v = parseFloat(num.value);
      if (!isFinite(v)) return;
      range.value = String(snap(v));
      push(v);
    });
    num.addEventListener('change', function () {
      var v = parseFloat(num.value);
      if (isFinite(v)) commit(v);
      range.value = String(snap(isFinite(v) ? v : Number(cfg.value())));
      paint();
    });

    var head = el('div', { class: 'rb-row' }, [
      el('label', { class: 'rb-label', for: rangeId, text: cfg.label }),
      el('span', { class: 'rb-spacer' }),
      num,
      cfg.unit ? el('span', { class: 'rb-hint', text: cfg.unit }) : null
    ]);

    return {
      node: el('div', { class: 'rb-field', style: 'gap:var(--rb-space-1)' }, [head, range]),
      sync: function () {
        var v = Number(cfg.value());
        range.value = String(v);
        if (doc.activeElement !== num) num.value = fmt(v);
      }
    };
  }

  /* ---------------- template gallery ---------------- */

  /* A card is a true reduction, not a drawing: the sheet inside it is laid out
     at the real page size in real points and then scaled to the card, with the
     template's own --rb-doc-* properties. A wireframe cannot tell the user that
     Garamond is looser than Verdana, or that the compact template fits six
     roles on a page. This one does. */
  var PAGE_PX = {
    Letter: { w: 816, h: 1056 },
    A4: { w: 793.7, h: 1122.5 }
  };
  var SHEET_W = 126;   /* px of paper in the panel; the scale follows from it */

  /* Enough of a resume to show density and rhythm. A card is 126px wide, so
     anything past this is below the threshold of seeing, and the node count
     across nine cards is what keeps the panel cheap to open. */
  var LIMITS = { sections: 5, entries: 3, roles: 2, bullets: 4 };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (v == null) return '';
    return String(v).trim();
  }

  function join() {
    return Array.prototype.filter.call(arguments, function (v) { return !!str(v); })
      .map(str).join(' ');
  }

  function monthYear(value, style) {
    var s = str(value);
    var m = /^(\d{4})(?:-(\d{1,2}))?/.exec(s);
    if (!m) return s;
    if (style === 'YYYY' || !m[2]) return m[1];
    return MONTHS[U.clamp(parseInt(m[2], 10) - 1, 0, 11)] + ' ' + m[1];
  }

  function dateRange(start, end, current, style) {
    var a = monthYear(start, style);
    var b = monthYear(end, style);
    if (a && (current || b)) return a + ' – ' + (current ? 'Present' : b);
    return a || b;
  }

  function list(v) {
    return (Array.isArray(v) ? v : []).map(str).filter(Boolean);
  }

  /* One flat read of an entry, whatever its type: the four things a resume
     page shows for anything — a title, a date, a line of context, and the
     bullet list. */
  function readEntry(type, e, style) {
    var out = { title: '', sub: '', when: '', roles: [] };
    /* A dated entry with its own bullet list: the date belongs to the entry,
       the way the document puts it, not to a phantom job title. */
    function dated(s, en, cur, bullets) {
      out.when = dateRange(s, en, cur, style);
      var b = list(bullets).slice(0, LIMITS.bullets);
      if (b.length) out.roles = [{ title: '', when: '', bullets: b }];
    }
    switch (type) {
      case 'experience':
        out.title = join(e.company, e.companyEntity);
        out.sub = str(e.location);
        out.roles = (Array.isArray(e.roles) ? e.roles : []).filter(Boolean)
          .slice(0, LIMITS.roles).map(function (r) {
            return {
              title: str(r.position),
              when: dateRange(r.start, r.end, r.current, style),
              bullets: list(r.highlights).slice(0, LIMITS.bullets)
            };
          });
        break;
      case 'volunteer':
        out.title = join(e.organization, e.location);
        dated(e.start, e.end, e.current, e.highlights);
        break;
      case 'education':
        out.title = str(e.institution);
        out.sub = [str(e.studyType), str(e.area)].filter(Boolean).join(', ');
        out.when = dateRange(e.start, e.end, false, style);
        break;
      case 'skills':
        out.title = str(e.label);
        out.sub = list(e.keywords).join(', ');
        break;
      case 'projects':
        out.title = str(e.name);
        out.sub = str(e.url);
        dated(e.start, e.end, e.current, e.highlights);
        break;
      case 'presentations':
        out.title = str(e.title);
        out.sub = join(e.event, e.location);
        dated('', '', false, e.highlights);
        break;
      case 'certifications':
        out.title = str(e.name);
        out.sub = str(e.issuer);
        out.when = monthYear(e.date, style);
        break;
      case 'publications':
        out.title = str(e.title);
        out.sub = join(e.authors, e.venue);
        out.when = monthYear(e.date, style);
        break;
      case 'awards':
        out.title = str(e.title);
        out.sub = str(e.awarder);
        out.when = monthYear(e.date, style);
        break;
      case 'coursework':
        out.title = str(e.name);
        out.sub = str(e.institution);
        out.when = monthYear(e.date, style);
        break;
      case 'languages':
        out.title = str(e.language);
        out.sub = str(e.fluency);
        break;
      case 'interests':
        out.title = str(e.label);
        break;
      case 'references':
        out.title = str(e.name);
        out.sub = join(e.label, e.contact);
        break;
      case 'custom':
        out.title = str(e.label);
        out.sub = (Array.isArray(e.entries) ? e.entries : []).map(function (x) {
          return join(x.title, x.org, x.start);
        }).join(' · ');
        break;
      default:
        out.title = join(e.title, e.name);
    }
    return out;
  }

  function row(left, right) {
    var kids = [];
    if (str(left)) kids.push(el('span', { class: 'rb-t__lead', text: left }));
    if (str(right)) kids.push(el('span', { class: 'rb-t__when', text: right }));
    if (!kids.length) return null;
    return el('span', { class: 'rb-t__row' }, kids);
  }

  function bulletList(items) {
    if (!items.length) return null;
    return el('span', { class: 'rb-t__list' }, items.map(function (t) {
      return el('span', { class: 'rb-t__li', text: t });
    }));
  }

  /* The miniature body, built from the user's own resume. */
  function sheetContent(resume, preset) {
    var style = (resume.meta && resume.meta.dateFormat) || 'MMM YYYY';
    var b = resume.basics || {};
    var parts = [];

    var identity = [];
    if (str(b.name)) identity.push(el('span', { class: 'rb-t__name', text: b.name }));
    if (str(b.label)) identity.push(el('span', { class: 'rb-t__label', text: b.label }));
    if (identity.length) {
      parts.push(el('span', { class: 'rb-t__head' }, [el('span', { class: 'rb-t__id' }, identity)]));
    }

    /* The profile objects have to be read before they are stringified. list()
       ran str() over them first, so the map then read .label off the string
       "[object Object]", got nothing, and every profile link the person had
       added was dropped from all fifty-nine cards. */
    var contact = list([b.email, b.phone, join(b.location && b.location.city, b.location && b.location.region), b.url])
      .concat((Array.isArray(b.profiles) ? b.profiles : []).map(function (p) {
        return str(p && p.label) || str(p && p.url);
      }))
      .filter(Boolean);
    if (contact.length) {
      parts.push(el('span', { class: 'rb-t__contact' }, contact.map(function (t) {
        return el('span', { class: 'rb-t__contact-item', text: t });
      })));
    }

    var sections = [];
    try { sections = model.orderedSections(resume) || []; } catch (e) { sections = []; }
    var side = [];
    var main = [];
    /* The sidebar template's own layout decides which sections go left, so the
       card shows the split that template really produces. */
    var sideTypes = (preset && preset.layout && preset.layout.mode === 'sidebar')
      ? (preset.layout.sidebarTypes || []) : null;

    sections.slice(0, LIMITS.sections).forEach(function (sec) {
      if (!sec || sec.visible === false) return;
      var entries;
      try {
        entries = (model.sectionEntries(resume, sec.type) || []).filter(function (e) {
          if (!e) return false;
          if (e.visible === false) return false;
          return !model.isBlankEntry || !model.isBlankEntry(e);
        });
      } catch (e2) { entries = []; }
      if (!entries.length && sec.type !== 'summary') return;

      var body = [];
      if (sec.type === 'summary') {
        if (str(b.summary)) body.push(el('span', { class: 'rb-t__prose', text: b.summary }));
      }
      entries.slice(0, LIMITS.entries).forEach(function (e) {
        var r = readEntry(sec.type, e, style);
        var node = el('span', { class: 'rb-t__entry' });
        var head = row(r.title, r.when);
        if (head) node.appendChild(head);
        if (r.sub) node.appendChild(el('span', { class: 'rb-t__sub', text: r.sub }));
        r.roles.forEach(function (role) {
          var roleNode = el('span', { class: 'rb-t__role' });
          var roleHead = row(role.title, role.when);
          if (roleHead) roleNode.appendChild(roleHead);
          var list_ = bulletList(role.bullets);
          if (list_) roleNode.appendChild(list_);
          if (roleNode.childNodes.length) node.appendChild(roleNode);
        });
        if (node.childNodes.length) body.push(node);
      });
      if (!body.length) return;
      var section = el('span', { class: 'rb-t__sec' }, [
        el('span', { class: 'rb-t__sec-title', text: str(sec.label) || str(model.typeMeta(sec.type).defaultLabel) }),
        el('span', { class: 'rb-t__sec-body' }, body)
      ]);
      if (sideTypes && sideTypes.indexOf(sec.type) !== -1) side.push(section);
      else main.push(section);
    });

    if (sideTypes) {
      parts.push(el('span', { class: 'rb-t__body' }, [
        side.length ? el('span', { class: 'rb-t__col rb-t__col--side' }, side) : null,
        main.length ? el('span', { class: 'rb-t__col rb-t__col--main' }, main) : null
      ]));
    } else {
      parts = parts.concat(main, side);
    }

    return parts;
  }

  function previewSignature(resume) {
    if (!resume) return '';
    return JSON.stringify([
      resume.basics, resume.sections, resume.experience, resume.education, resume.skills,
      resume.projects, resume.certifications, resume.publications, resume.awards,
      resume.volunteer, resume.languages, resume.interests, resume.references,
      resume.coursework, resume.presentations, resume.custom
    ]);
  }

  /* The paper: a page-sized box carrying the template's own tokens, scaled
     down to the card. Nothing here is editable and nothing is announced — the
     document itself is both of those. */
  function previewNode(preset) {
    var page = PAGE_PX[preset.pageSize] || PAGE_PX.Letter;
    var scale = SHEET_W / page.w;
    var vars = (global.RB.templates && typeof global.RB.templates.docVars === 'function')
      ? global.RB.templates.docVars(preset, preset)
      : {};

    var sheet = el('span', { class: 'rb-t__sheet' });
    Object.keys(vars).forEach(function (k) { sheet.style.setProperty(k, vars[k]); });
    sheet.setAttribute('data-template', preset.templateId || '');
    sheet.setAttribute('data-heading', preset.headingStyle || 'uppercase');
    sheet.setAttribute('data-bullet', preset.bulletGlyph || 'disc');
    sheet.setAttribute('data-columns', String(preset.columns === 2 ? 2 : 1));
    if (preset.layout && preset.layout.mode) sheet.setAttribute('data-layout', preset.layout.mode);
    sheet.style.width = page.w + 'px';
    sheet.style.minHeight = page.h + 'px';
    sheet.style.transform = 'scale(' + scale + ')';

    var paper = el('span', { class: 'rb-t__paper' }, [
      el('span', { class: 'rb-t__page2', 'aria-hidden': 'true' }),
      sheet
    ]);
    paper.style.setProperty('--rb-t-page-h', Math.round(page.h * scale) + 'px');

    return {
      node: paper,
      fill: function (resume) {
        sheet.textContent = '';
        sheet.appendChild(el('span', { class: 'rb-t__flow' }, sheetContent(resume, preset)));
      }
    };
  }

  function templatePicker() {
    var labelId = U.uid('rbt');
    var list_ = templates();
    var grid = el('div', {
      class: 'rb-t__grid',
      role: 'group',
      'aria-labelledby': labelId
    });
    var rows = list_.map(function (t) {
      var preset = (global.RB.templates && typeof global.RB.templates.get === 'function')
        ? global.RB.templates.get(t.id) : null;
      var art = previewNode(preset || { templateId: t.id, pageSize: 'Letter' });
      var blurb = t.note || '';
      var b = el('button', {
        type: 'button',
        class: 'rb-t__card rb-tip',
        'aria-pressed': 'false',
        'aria-label': t.label + ' template. ' + blurb,
        dataset: { value: String(t.id) }
      });
      if (blurb) b.setAttribute('data-tip', t.label + ': ' + blurb);
      b.appendChild(art.node);
      b.appendChild(el('span', { class: 'rb-t__card__name', text: t.label }));
      if (blurb) b.appendChild(el('span', { class: 'rb-t__card__desc', text: blurb }));
      b.addEventListener('click', function () { applyTemplate(t.id); });
      grid.appendChild(b);
      return { button: b, art: art, id: t.id, filled: null };
    });

    var signature = null;
    var pages = null;

    function fill() {
      var resume = store.get();
      var sig = previewSignature(resume);
      rows.forEach(function (row) {
        if (row.filled !== sig) { row.art.fill(resume); row.filled = sig; }
      });
      signature = sig;
    }

    /* The page count belongs to the document on screen, which is the selected
       template. Putting it on every card would be a claim about a template
       nobody has applied, so only the selected card shows the spill. */
    function markPages() {
      var n = pageCount();
      if (n === pages) return;
      pages = n;
      var cur = String(design().templateId);
      rows.forEach(function (row) {
        row.art.node.dataset.pages = (row.id === cur && n && n > 1) ? 'many' : 'one';
      });
    }

    return {
      node: grid,
      labelNode: el('span', { class: 'rb-label', id: labelId, text: 'Template' }),
      /* Only the sheet contents are rebuilt, and only when the resume they
         were drawn from has actually changed, so a slider drag does not churn
         nine cards. */
      refresh: function (force) {
        var sig = previewSignature(store.get());
        try {
          if (force || sig !== signature) fill();
          markPages();
        } catch (e) { console.error('[design] template preview', e); }
      },
      sync: function () {
        var cur = String(design().templateId);
        rows.forEach(function (row) {
          row.button.setAttribute('aria-pressed', row.id === cur ? 'true' : 'false');
        });
        pages = null;
        markPages();
      }
    };
  }

  /* ---------------- accent color ---------------- */

  function accentField() {
    var hexId = U.uid('rbd');
    var errId = U.uid('rbd');
    var noteId = U.uid('rbd');

    var swatches = el('div', { class: 'rb-row rb-wrap', style: 'gap:var(--rb-space-2)' });
    var hex = el('input', {
      type: 'text', class: 'rb-input rb-input--sm rb-mono', id: hexId,
      maxlength: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      'aria-describedby': errId + ' ' + noteId
    });
    var picker = el('input', {
      type: 'color', class: 'rb-input rb-input--sm', 'aria-label': 'Choose an accent color'
    });
    picker.style.cssText = 'width:38px;flex:none;padding:2px';
    var err = el('span', { class: 'rb-error-text', id: errId, hidden: true });
    var note = el('span', { class: 'rb-badge', id: noteId, hidden: true });

    function currentAccent() {
      var raw = hex.value.trim();
      return U.isValidHexColor(raw) ? normalizeHex(raw) : design().accent;
    }

    function refreshNote() {
      var c = U.contrast(currentAccent());
      var ratio = c ? c.ratio(PAPER) : null;
      if (ratio == null) { note.hidden = true; return; }
      var pass = ratio >= AA_NORMAL;
      note.hidden = false;
      note.className = 'rb-badge ' + (pass ? 'rb-badge--pass' : 'rb-badge--warn');
      note.textContent = (pass ? 'AA pass' : 'Low contrast') + ' \u00b7 ' + ratio.toFixed(1) + ':1 on white';
    }

    function commitHex(value) {
      var v = normalizeHex(value);
      if (!U.isValidHexColor(v)) return;
      if (v !== design().accent) write('accent', v);
      refreshNote();
    }

    var pushHex = debounced(function (value) { commitHex(value); }, 200);

    var swatchButtons = options(presets().accents, FALLBACK.accents).map(function (c) {
      var b = el('button', {
        type: 'button',
        class: 'rb-btn rb-btn--ghost rb-tip',
        'aria-label': c.label + ' accent',
        'aria-pressed': 'false',
        'data-tip': c.label,
        dataset: { value: String(c.id).toLowerCase() },
        /* Catalogue entries carry the token they came from, so the swatch can
           repaint with the theme instead of carrying a fixed hex. */
        style: 'width:26px;height:26px;min-width:26px;padding:0;border-radius:var(--rb-radius-full);' +
          'border:1px solid var(--rb-border-strong);background:' + (c.token ? 'var(' + c.token + ')' : c.id)
      });
      b.addEventListener('click', function () { commitHex(c.id); });
      swatches.appendChild(b);
      return b;
    });

    hex.addEventListener('input', function () {
      var ok = U.isValidHexColor(hex.value.trim());
      hex.setAttribute('aria-invalid', ok ? 'false' : 'true');
      err.hidden = ok;
      err.textContent = ok ? '' : 'Enter a hex color like #1f2937.';
      if (ok) pushHex(hex.value); else pushHex.cancel();
      refreshNote();
    });
    hex.addEventListener('change', function () {
      if (U.isValidHexColor(hex.value.trim())) { commitHex(hex.value); return; }
      /* Revert rather than leave an unparseable value in a labeled field. */
      hex.value = design().accent;
      hex.setAttribute('aria-invalid', 'false');
      err.hidden = true;
      err.textContent = '';
      refreshNote();
      if (global.RB.ui && typeof global.RB.ui.toast === 'function') {
        global.RB.ui.toast('Hex colors look like #1f2937.', { tone: 'error' });
      }
    });

    picker.addEventListener('input', function () { commitHex(picker.value); });
    picker.addEventListener('change', function () { commitHex(picker.value); });

    var node = el('div', { class: 'rb-field' }, [
      el('div', { class: 'rb-row' }, [
        el('label', { class: 'rb-label', for: hexId, text: 'Accent' }),
        el('span', { class: 'rb-spacer' }),
        note
      ]),
      swatches,
      el('div', { class: 'rb-row' }, [hex, picker]),
      err
    ]);

    return {
      node: node,
      sync: function () {
        var cur = normalizeHex(design().accent);
        if (doc.activeElement !== hex) hex.value = cur;
        if (U.isValidHexColor(cur)) picker.value = cur;
        swatchButtons.forEach(function (b) {
          var on = b.dataset.value === cur;
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          /* The focus ring doubles as the selected ring. */
          b.style.boxShadow = on ? 'var(--rb-focus-ring)' : '';
        });
        refreshNote();
      }
    };
  }

  /* ---------------- mount ---------------- */

  function paperHint() {
    return U.LOCALE.isMetric
      ? 'A4 is the common paper size in ' + U.LOCALE.region + '.'
      : 'Letter is the common paper size in ' + U.LOCALE.region + '.';
  }

  function photoHint() {
    return U.LOCALE.prefersPhoto
      ? 'A photo is expected in ' + U.LOCALE.region + '. Check the role before you add one.'
      : 'Most applications in ' + U.LOCALE.region + ' expect no photo. Leave this off.';
  }

  function mount(root) {
    if (!root) return;
    if (teardown) { teardown(); teardown = null; }
    cancels = [];
    root.textContent = '';

    var p = presets();
    var syncFns = [];
    function track(part) { syncFns.push(part.sync); return part.node; }

    var fontLabel = U.uid('rbd');
    var headingLabel = U.uid('rbd');
    var bulletLabel = U.uid('rbd');
    var columnLabel = U.uid('rbd');
    var paperLabel = U.uid('rbd');

    var pagesRow = el('span', { class: 'rb-hint rb-numeric', hidden: true });
    var headingNote = hint('');

    var picker = templatePicker();
    var font = select({
      key: 'fontFamily', labelId: fontLabel,
      options: options(p.fonts, FALLBACK.fonts),
      value: function () { return design().fontFamily; }
    });
    /* Steps are sized so every value in the template registry is reachable
     * from its own slider. A coarser grid silently rewrites the value: the
     * registry ships 1.44, 0.75 and 0.01, none of which sit on a 0.05 or 0.5
     * grid, so the thumb and the number box disagreed and typing the number
     * either did nothing or wrote a different number. The base size stops at
     * 9pt for the same reason from the other end: model.validate clamps it
     * there, so a slider that offered 7.5 snapped back to 9 and the number box
     * reverted under the user's finger. */
    var size = numberRange({
      key: 'baseSizePt', label: 'Base size', unit: 'pt', min: 9, max: 14, step: 0.5,
      value: function () { return design().baseSizePt; }
    });
    var leading = numberRange({
      key: 'lineHeight', label: 'Line height', min: 1.05, max: 2, step: 0.01,
      format: function (v) { return v.toFixed(2); },
      value: function () { return design().lineHeight; }
    });
    var tracking = numberRange({
      key: 'letterSpacing', label: 'Letter spacing', unit: 'em', min: -0.5, max: 1.5, step: 0.01,
      format: function (v) { return v.toFixed(2); },
      value: function () { return design().letterSpacing; }
    });
    var heading = segment({
      key: 'headingStyle', labelId: headingLabel,
      options: options(p.headingStyles, FALLBACK.headingStyles),
      value: function () { return design().headingStyle; },
      onPick: function (id) { write('headingStyle', id); applyHeadingCase(id); }
    });
    var rule = numberRange({
      key: 'ruleWeight', label: 'Rule weight', unit: 'pt', min: 0.5, max: 4, step: 0.05,
      value: function () { return design().ruleWeight; }
    });
    var bulletControl = segment({
      key: 'bulletGlyph', labelId: bulletLabel,
      options: bullets(),
      value: function () { return design().bulletGlyph; }
    });
    var accent = accentField();
    var columns = segment({
      key: 'columns', labelId: columnLabel,
      options: options(p.columns, FALLBACK.columns),
      value: function () { return design().columns; }
    });
    var sectionGap = numberRange({
      key: 'sectionGapPt', label: 'Space between sections', unit: 'pt', min: 0, max: 40, step: 1,
      format: function (v) { return String(Math.round(v)); },
      value: function () { return design().sectionGapPt; }
    });
    var entryGap = numberRange({
      key: 'entryGapPt', label: 'Space between entries', unit: 'pt', min: 0, max: 30, step: 1,
      format: function (v) { return String(Math.round(v)); },
      value: function () { return design().entryGapPt; }
    });
    var margins = numberRange({
      key: 'marginsIn', label: 'Page margins', unit: 'in', min: 0.2, max: 1.5, step: 0.05,
      format: function (v) { return v.toFixed(2); },
      value: function () { return design().marginsIn; }
    });
    var photo = switchControl({ key: 'photoSlot', text: 'Photo slot', value: function () { return design().photoSlot; } });
    var paper = segment({
      key: 'pageSize', labelId: paperLabel,
      options: options(p.pageSizes, FALLBACK.pageSizes),
      value: function () { return design().pageSize; }
    });
    var printSafe = switchControl({ key: 'printSafe', text: 'Print-safe mode', value: function () { return design().printSafe; } });

    [picker, font, size, leading, tracking, heading, rule, bulletControl, accent,
      columns, sectionGap, entryGap, margins, photo, paper, printSafe].forEach(track);

    var resetBtn = el('button', {
      type: 'button',
      class: 'rb-btn rb-btn--ghost rb-btn--icon rb-tip',
      'aria-label': 'Reset design to template defaults',
      'data-tip': 'Reset design to defaults'
    });
    var resetIcon = icon('refresh');
    if (resetIcon) resetBtn.appendChild(resetIcon);
    resetBtn.addEventListener('click', function () {
      var defaults = templateDefaults(design().templateId);
      function apply() {
        /* One write, so one undo step returns the whole design. */
        store.update(function (draft) { draft.design = defaults; }, { source: 'design', coalesceKey: 'design.reset' });
        if (global.RB.ui && typeof global.RB.ui.toast === 'function') {
          global.RB.ui.toast('Design reset to template defaults.', { tone: 'info' });
        }
      }
      if (global.RB.ui && typeof global.RB.ui.confirm === 'function') {
        global.RB.ui.confirm({
          title: 'Reset the design?',
          message: 'Typography, color and spacing go back to the defaults for this template. Your content is untouched.',
          confirmLabel: 'Reset design'
        }).then(function (yes) { if (yes) apply(); });
        return;
      }
      apply();
    });

    root.appendChild(el('div', { class: 'rb-col', style: 'gap:var(--rb-space-5);padding:var(--rb-space-4)' }, [
      el('div', { class: 'rb-row' }, [pagesRow, el('span', { class: 'rb-spacer' }), resetBtn]),

      el('section', { class: 'rb-col', style: 'gap:var(--rb-space-2)' }, [
        el('h3', {}, [picker.labelNode]),
        picker.node
      ]),

      el('hr', { class: 'rb-divider' }),

      section('Type', [
        field(label(fontLabel, 'Font family'), font.node),
        size.node,
        leading.node,
        tracking.node,
        field(label(headingLabel, 'Heading style'), heading.node),
        headingNote,
        rule.node,
        field(label(bulletLabel, 'Bullets'), bulletControl.node, hint('Not every template uses a bullet marker.'))
      ]),

      el('hr', { class: 'rb-divider' }),

      section('Color', [accent.node]),

      el('hr', { class: 'rb-divider' }),

      section('Layout', [
        field(label(columnLabel, 'Columns'), columns.node),
        sectionGap.node,
        entryGap.node,
        margins.node,
        photo.node,
        hint(photoHint())
      ]),

      el('hr', { class: 'rb-divider' }),

      section('Page', [
        field(label(paperLabel, 'Paper'), paper.node, hint(paperHint())),
        printSafe.node,
        hint('Print-safe mode drops decorative color and background fills so the page stays legible in black and white.')
      ])
    ]));

    function refreshPages() {
      var n = pageCount();
      pagesRow.hidden = n == null;
      if (n != null) pagesRow.textContent = U.pluralize(n, 'page', 'pages');
    }

    /* Nine scaled sheets is a lot of DOM to build while the user is typing, so
       the redraw waits for the keystrokes to settle, then for an idle moment,
       and skips itself when the text it drew is unchanged. */
    var repaintPreviews = U.debounce(function () {
      U.requestIdle(function () { picker.refresh(false); }, 500);
    }, 320);
    cancels.push(function () { repaintPreviews.cancel(); });

    function syncAll() {
      syncFns.forEach(function (fn) {
        try { fn(); } catch (e) { console.error('[design]', e); }
      });
      var h = options(presets().headingStyles, FALLBACK.headingStyles)
        .filter(function (o) { return o.id === design().headingStyle; })[0];
      headingNote.textContent = h ? h.note : '';
    }

    var offs = [
      bus.on('change', function () {
        syncAll();
        U.requestIdle(refreshPages, 300);
        repaintPreviews();
      }),      bus.on('paginator:update', function (payload) {
        var n = payload && payload.pages;
        pagesRow.hidden = typeof n !== 'number' || !isFinite(n) || n <= 0;
        if (!pagesRow.hidden) pagesRow.textContent = U.pluralize(Math.round(n), 'page', 'pages');
        picker.refresh(false);
      })
    ];

    var disposed = false;
    teardown = function () {
      if (disposed) return;
      disposed = true;
      offs.forEach(function (off) { off(); });
      cancels.forEach(function (fn) { fn(); });
      cancels = [];
    };

    if (store.isReady()) { syncAll(); refreshPages(); picker.refresh(true); }
    else if (typeof store.whenReady === 'function') {
      store.whenReady().then(function () { syncAll(); refreshPages(); picker.refresh(true); });
    }

    /* The panel shell calls this when the tab is hidden or replaced. */
    return teardown;
  }

  /* RB.lifecycle 'unmount' fires for whichever panel is closing, so only stand
     down when the payload is ours. */
  RB.lifecycle.on('unmount', function (payload) {
    if (!teardown) return;
    if (payload && payload.scope === 'panel' && payload.panelId !== 'design') return;
    teardown();
    teardown = null;
  });

  RB.panels.register({ id: 'design', title: 'Design', icon: 'palette', mount: mount });
})(window);
