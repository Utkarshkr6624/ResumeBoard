/* Resumeboard — resume renderer
 *
 * Model -> DOM. #rb-doc is both the rendered resume and the editing surface,
 * so every editable node carries a `data-bind` dot path. That path is the only
 * coupling between this file and the binder, the linter and the form panel:
 * nothing outside the renderer should need to know the markup inside a section.
 *
 * The class names below are the contract documented at the top of
 * assets/css/templates.css. Two rules hold the document together:
 *
 *   - Outline: h1 is the name, h2 is a section heading, h3 is an entry title.
 *     Every h2 is the first child of its <section> and nothing else shares its
 *     line, because a heading is the only structure a text extractor keeps.
 *   - Joined text: two model fields that read as one phrase (city and region,
 *     degree and field) are two INLINE fields with a text node between them.
 *     A block-level field between them puts the joiner on a line of its own.
 *
 * Dates are free text in the model ("Mar 2021", "Summer 2019", "Present"). A
 * <time> element is only emitted when the text actually parses as a date, so
 * assistive tech and print both get machine-readable output where it is true
 * and nothing pretends otherwise.
 *
 * The document is a stack of `.rb-page-sheet` elements, one per printed page,
 * each a real page-height box with the page margin as its padding. RB.paginator
 * decides where the breaks fall; this file only re-hangs the sections it
 * located into that many sheets. buildDocument() deliberately returns the flat,
 * unsplit flow: the export and preview paths want the document, not the page
 * furniture around it.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils || {};
  var model = RB.model || {};
  var bus = RB.bus;
  var store = RB.store;
  var doc = global.document;

  /* contenteditable="plaintext-only" is Chromium-only. Engines without it get
   * "true", which is why anything pasted into a field is re-sanitized on write
   * by the binder. */
  var EDITABLE = (function () {
    if (!doc || !doc.createElement) return 'true';
    var probe = doc.createElement('div');
    probe.setAttribute('contenteditable', 'plaintext-only');
    return probe.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
  })();

  var HEADINGS = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
  var IGNORED_CONTENT_KEYS = { id: 1, visible: 1, current: 1, level: 1 };
  var PRESENT_LABEL = 'Present';
  var DATE_SEP = ' \u2013 ';   /* en dash, not a hyphen: a range is not a minus */
  var META_SEP = ' \u00B7 ';   /* middot between facts on one line */
  var CONTACT_SEP = '\u00A0\u00B7\u00A0';  /* nbsp-middot-nbsp: binds the
                                        separator to the fact on either side
                                        of it, so it never splits off alone */
  var PHRASE_SEP = ' in ';     /* degree and field read as one phrase */

  /* The contact separator belongs to the fact it PRECEDES. Glued to the
   * trailing edge of a fact it becomes the last thing on a line the moment
   * the next fact wraps, and a line that ends in a middot reads as a
   * mistake. Leading the next fact it can only ever be followed by that
   * fact — what is left is a line that starts with a separator, and
   * markContactLines() drops the separator on exactly those items. */
  var SHEET_CLASS = 'rb-page-sheet';
  var COLUMNS = ['rb-doc__side', 'rb-doc__main'];
  var NARROW_QUERY = '(max-width: 900px)';
  var FIT_EPS = 1;        /* px of slack before a sheet counts as overfull */
  var FIT_TRIES = 12;
  var FIT_PASSES = 8;
  /* A hair of the page is left unclaimed on purpose. A sheet filled to the
   * last 0.1px measures a hair over the paper once the margin padding is
   * added back, and a page that rounds up prints as two. */
  var FIT_GUARD = 1.5;
  var RESIZE_MS = 180;
  var LINE_EPS = 1.5;     /* px of slack when asking "does this start a line?" */

  /* A two-column page is only two columns while both of them carry something.
   * A rail holding two lines beside a main column holding three pages is the
   * one two-column layout no reader can make sense of: the hairline runs the
   * full height beside nothing and the page reads as an accident. A column
   * this thin — under about four lines, and under a third of its neighbour —
   * hands its sections to the full one and the page is set in one column. */
  var SPARSE_COL_PX = 132;
  var SPARSE_COL_RATIO = 0.34;

  /* The custom property the fitted preview is written to. Screen only: paper
   * takes its geometry from @page, and templates.css hands the minimum back
   * under @media print so a print job is never a fraction of an inch tall. */
  var SHEET_FIT_PROP = '--rb-sheet-min-h';
  var SHEET_FIT_SLACK_PX = 14;   /* air under the last line, not a cut edge */
  var SHEET_FIT_FLOOR_PX = 288;  /* three inches: a short page, not a card */

  var FONT_STACKS = {
    system: 'var(--rb-font-sans)',
    sans: 'var(--rb-font-sans)',
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    mono: 'var(--rb-font-mono)'
  };
  var BULLET_GLYPHS = { disc: '"\u2022"', square: '"\u25AA"', dash: '"\u2013"', none: 'none' };

  /* Used when the chosen design asks for two columns but names no sidebar
   * sections: the compact, list-shaped ones move left, the prose stays right. */
  var DEFAULT_SIDEBAR_TYPES = ['skills', 'languages', 'interests', 'certifications', 'references'];

  var docEl = null;
  var disposers = [];
  var editing = false;
  var dirty = false;
  var scheduled = false;
  var destroyed = false;
  var resizeTimer = null;
  var continuationSeq = 0;

  /* ---------- content predicates ---------- */

  function hasContent(node) {
    if (node == null) return false;
    if (Array.isArray(node)) return node.some(hasContent);
    if (typeof node === 'object') {
      return Object.keys(node).some(function (k) {
        return !IGNORED_CONTENT_KEYS[k] && hasContent(node[k]);
      });
    }
    if (typeof node === 'string') return node.replace(/\s+/g, '').length > 0;
    if (typeof node === 'number') return true;
    return false;
  }

  function text(v) { return v == null ? '' : String(v); }

  function txt(v) { return doc.createTextNode(text(v)); }

  function sepNode() { return doc.createTextNode(META_SEP); }

  function joined(parts, sep) {
    return parts
      .map(function (p) { return text(p).trim(); })
      .filter(Boolean)
      .join(sep == null ? ', ' : sep);
  }

  function listOf(resume, type) {
    if (model.sectionEntries) return model.sectionEntries(resume, type);
    return Array.isArray(resume[type]) ? resume[type] : [];
  }

  /* Two URLs are the same link when they differ only by scheme, www, a query
   * string or a trailing slash. Used to keep the header from printing the same
   * profile twice. */
  function urlKey(v) {
    return text(v).trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }

  /* ---------- dates ---------- */

  function parseDate(value) {
    var s = text(value).trim();
    if (!s || s.length > 40) return null;
    if (!/\d/.test(s)) return null;
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    if (d.getFullYear() < 1900 || d.getFullYear() > 2200) return null;
    return d;
  }

  function isoFor(date, raw) {
    var y = date.getFullYear();
    var hasMonth = /[a-z]{3}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d{2}/i.test(text(raw));
    if (!hasMonth) return String(y);
    var m = String(date.getMonth() + 1);
    return y + '-' + (m.length < 2 ? '0' + m : m);
  }

  function dateField(path, value, label, opts) {
    opts = opts || {};
    var d = parseDate(value);
    var el = fieldEl(path, value, label, Object.assign({}, opts, {
      tag: d ? 'time' : 'span',
      className: 'rb-doc-date' + (opts.className ? ' ' + opts.className : ''),
      spellcheck: false
    }));
    if (d) el.setAttribute('datetime', isoFor(d, value));
    return el;
  }

  /* The whole range is one string: "Mar 2021 – Present". The two <time>
   * elements stay inside a nowrap wrapper, and a free-text end date the user
   * never typed ("Present", "Summer 2019") is a plain span. */
  function dateRange(parent, prefix, entry) {
    var start = text(entry.start).trim();
    var end = text(entry.end).trim();
    if (!start && !end && !entry.current) return null;
    var wrap = U.el('span', { class: 'rb-dates' });
    if (start) wrap.appendChild(dateField(prefix + 'start', start, 'Start date'));
    if (entry.current) {
      if (start) wrap.appendChild(txt(DATE_SEP));
      wrap.appendChild(U.el('span', { class: 'rb-doc-present', text: PRESENT_LABEL }));
    } else if (end) {
      if (start) wrap.appendChild(txt(DATE_SEP));
      wrap.appendChild(dateField(prefix + 'end', end, 'End date'));
    }
    if (parent) parent.appendChild(wrap);
    return wrap;
  }

  function whenRange(prefix, entry) {
    var when = U.el('span', { class: 'rb-entry__when' });
    if (!dateRange(when, prefix, entry)) return null;
    return when;
  }

  function whenDate(prefix, value, label) {
    if (!hasContent(value)) return null;
    var when = U.el('span', { class: 'rb-entry__when' });
    when.appendChild(dateField(prefix + 'date', value, label));
    return when;
  }

  /* ---------- editable nodes ---------- */

  function fieldAttrs(path, value, label, opts) {
    opts = opts || {};
    var tag = opts.tag || 'div';
    var attrs = {
      class: 'rb-field' + (opts.className ? ' ' + opts.className : ''),
      contenteditable: EDITABLE,
      spellcheck: opts.spellcheck === false ? 'false' : 'true'
    };
    if (path) {
      attrs['data-bind'] = path;
      /* role=textbox is not allowed on <a>, and it would flatten the heading
       * outline, so headings and links keep their native role. Both are still
       * labelled — by their visible text, or by aria-label where the text is
       * the value being edited. */
      if (!HEADINGS[tag] && tag !== 'a') {
        attrs.role = 'textbox';
        if (opts.multiline) attrs['aria-multiline'] = 'true';
      }
    }
    if (label) attrs['aria-label'] = label;
    if (opts.readOnly) {
      /* Not editable on the page, but still a real, focusable target for the
       * panel, which selects it when you start typing in the form. */
      attrs.contenteditable = 'false';
      attrs.tabindex = '0';
      attrs['data-readonly'] = 'true';
    }
    if (path && !hasContent(value) && opts.placeholder) attrs['data-placeholder'] = opts.placeholder;
    return attrs;
  }

  function fieldEl(path, value, label, opts) {
    var attrs = fieldAttrs(path, value, label, opts);
    attrs.html = U.textToHtml(text(value));
    return U.el((opts && opts.tag) || 'div', attrs);
  }

  /* The link and the editable must be two elements.
   *
   * Making the <a> itself contenteditable puts the caret inside a hyperlink,
   * and the browser interleaves typed characters with the existing text
   * instead of replacing the selection — "gmail.comtkarsh6624alex.riv…". The
   * printed and exported page still gets a real, clickable <a>; the editable is
   * a span inside it, which behaves like every other field on the page. */
  function linkFrom(path, value, label, href, opts) {
    opts = opts || {};
    /* The contact line is the one place a hyperlink and an editable cannot
     * coexist: the browser refuses to select inside a link, so typing there
     * interleaves with the old value and silently corrupts an email address.
     * It is presented as a link and edited in the side panel, which handles
     * it correctly and validates it. Better a field you edit one place than
     * one you can corrupt in two. */
    var inner = fieldEl(path, value, label, {
      tag: 'span',
      className: 'rb-doc-link__text' + (opts.className ? ' ' + opts.className : ''),
      spellcheck: false,
      readOnly: true
    });
    var attrs = { class: 'rb-doc-link' + (opts.className ? ' ' + opts.className : '') };
    if (href) {
      attrs.href = href;
      if (!/^mailto:|^tel:/i.test(href)) {
        attrs.target = '_blank';
        attrs.rel = 'noopener noreferrer';
      }
    }
    return U.el('a', attrs, [inner]);
  }

  function linkField(path, value, label, kind, opts) {
    opts = opts || {};
    /* `opts.href` lets a label link somewhere other than its own text, which
     * is what a project name needs: the words are the name, the target is the
     * URL stored in a different field. */
    return linkFrom(path, value, label, opts.href || hrefFor(value, kind), opts);
  }

  function hrefFor(value, kind) {
    var v = text(value).trim();
    if (!v) return '';
    if (kind === 'email') return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v) ? 'mailto:' + v : '';
    if (kind === 'tel') return v.replace(/[^\d+]/g, '').length > 3 ? 'tel:' + v.replace(/[^\d+]/g, '') : '';
    return model.safeUrl ? model.safeUrl(v) : (/^https?:\/\//i.test(v) ? v : '');
  }

  /* ---------- shared fragments ---------- */

  /* Entry head: the title (with anything that belongs beside it) on the left,
   * the date range flush right, both on one baseline. `main` is one node or a
   * list of nodes to share the left side of the row. */
  function entryHead(main, when) {
    var head = U.el('div', { class: 'rb-entry__head' });
    head.appendChild(Array.isArray(main)
      ? U.el('div', { class: 'rb-entry__main' }, main)
      : U.el('div', { class: 'rb-entry__main' }, [main]));
    if (when) head.appendChild(when);
    return head;
  }

  function titleEl(tag, className, path, value, label, opts) {
    return U.el(tag, { class: 'rb-entry__org' + (className ? ' ' + className : '') }, [
      fieldEl(path, value, label, Object.assign({ tag: 'span' }, opts || {}))
    ]);
  }

  function subLine(className, children) {
    return U.el('p', { class: 'rb-entry__sub' + (className ? ' ' + className : '') }, children);
  }

  /* One <li> per non-empty bullet, with the glyph and the hanging indent owned
   * by the stylesheet. When the list holds nothing yet a single placeholder
   * bullet is kept so the entry is still typable in place; the stylesheet
   * greys its glyph and hides it from print. */
  function bulletList(prefix, items, label) {
    if (!Array.isArray(items)) return null;
    var filled = items.map(function (v, i) { return { i: i, v: text(v) }; })
      .filter(function (it) { return hasContent(it.v); });
    if (!filled.length) {
      if (!items.length) return null;
      var li = U.el('li', { class: 'rb-bullets__item rb-bullets__item--empty' }, [
        fieldEl(prefix + '.0', '', label, { tag: 'span', className: 'rb-bullets__text', placeholder: label })
      ]);
      return U.el('ul', { class: 'rb-bullets' }, [li]);
    }
    var lis = filled.map(function (it) {
      return U.el('li', { class: 'rb-bullets__item' }, [
        fieldEl(prefix + '.' + it.i, it.v, label, { tag: 'span', className: 'rb-bullets__text' })
      ]);
    });
    return U.el('ul', { class: 'rb-bullets' }, lis);
  }

  /* Comma-separated inline lists (keywords, courses). Same idea: the fields are
   * inline, so the comma sits between them on the same line. */
  function keywordList(prefix, items, label, extraClass) {
    if (!Array.isArray(items)) return null;
    var filled = items.map(function (v, i) { return { i: i, v: text(v) }; })
      .filter(function (it) { return hasContent(it.v); });
    if (!filled.length) {
      if (!items.length) return null;
      return U.el('ul', { class: 'rb-inline-list' + (extraClass ? ' ' + extraClass : '') }, [
        U.el('li', { class: 'rb-inline-list__item rb-inline-list__item--empty' }, [
          fieldEl(prefix + '.0', '', label, { tag: 'span', placeholder: label })
        ])
      ]);
    }
    var lis = filled.map(function (it) {
      return U.el('li', { class: 'rb-inline-list__item' }, [
        fieldEl(prefix + '.' + it.i, it.v, label, { tag: 'span', className: 'rb-inline-list__term' })
      ]);
    });
    return U.el('ul', { class: 'rb-inline-list' + (extraClass ? ' ' + extraClass : '') }, lis);
  }

  function entryEl(type, entry, extraClass) {
    return U.el('div', {
      class: 'rb-entry rb-entry--' + type + (extraClass ? ' ' + extraClass : ''),
      'data-entry-type': type,
      'data-entry-id': entry.id
    });
  }

  /* ---------- section builders, one per SECTION_TYPES entry ---------- */

  var BUILDERS = Object.create(null);

  /* The summary text lives on basics, not on an array, so there is nothing to
   * test for emptiness beyond the paragraph itself. */
  BUILDERS.summary = function (resume) {
    return fieldEl('basics.summary', (resume.basics || {}).summary, 'Professional summary', {
      tag: 'p',
      className: 'rb-prose__text',
      placeholder: 'A short paragraph on what you do and what you are best at.',
      multiline: true
    });
  };

  BUILDERS.experience = function (resume) {
    var out = [];
    listOf(resume, 'experience').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      out.push(experienceEntry(entry, i));
    });
    return out;
  };

  function experienceEntry(entry, i) {
    var p = 'experience.' + i + '.';
    var art = entryEl('experience', entry);

    /* The role is the headline of an experience entry, so the position carries
     * the row and the company sits under it. With more than one role under the
     * same employer the company moves to the top instead, so it is not repeated
     * once per role. */
    var roles = [];
    (Array.isArray(entry.roles) ? entry.roles : []).forEach(function (role, ri) {
      if (role && role.visible !== false) roles.push({ role: role, i: ri });
    });
    if (!roles.length && Array.isArray(entry.roles) && entry.roles[0]) roles.push({ role: entry.roles[0], i: 0 });

    var orgLine = companyLine(p, entry);
    var orgFirst = roles.length > 1;

    roles.forEach(function (r) {
      var block = roleBlock(r.role, p + 'roles.' + r.i + '.', orgLine, orgFirst);
      if (orgFirst && r === roles[0]) {
        block.insertBefore(orgLine, block.firstChild);
      }
      art.appendChild(block);
    });
    if (!roles.length && orgLine) art.appendChild(orgLine);
    return art;
  }

  /* "Northwind Labs Inc. · San Francisco, CA" — one line, one baseline, with
   * the employer emphasised and the rest muted. */
  function companyLine(p, entry) {
    var line = subLine('rb-entry__org-line');
    var added = false;
    if (hasContent(entry.company)) {
      line.appendChild(fieldEl(p + 'company', entry.company, 'Company', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Company' }));
      added = true;
    }
    if (hasContent(entry.companyEntity)) {
      /* "Northwind Labs, Inc." reads as a company; "Northwind Labs Inc" reads
       * as a typo. Only the abbreviations that take a comma get one. */
      if (added) {
        line.appendChild(doc.createTextNode(/^[,.]/.test(text(entry.companyEntity).trim()) || /^(inc|llc|ltd|corp|co|gmbh|plc|s\.?a|b\.?v|pty|n\.v)\b/i.test(text(entry.companyEntity).trim()) ? ', ' : ' '));
      }
      line.appendChild(fieldEl(p + 'companyEntity', entry.companyEntity, 'Company legal suffix', { tag: 'span', className: 'rb-doc-mute' }));
      added = true;
    }
    if (hasContent(entry.location)) {
      if (added) line.appendChild(sepNode());
      line.appendChild(fieldEl(p + 'location', entry.location, 'Location', { tag: 'span', className: 'rb-doc-mute', placeholder: 'City' }));
      added = true;
    }
    if (hasContent(entry.url)) {
      if (added) line.appendChild(sepNode());
      line.appendChild(linkField(p + 'url', entry.url, 'Company website', 'web', { className: 'rb-doc-mute' }));
      added = true;
    }
    return added ? line : null;
  }

  function roleBlock(role, p, orgLine, orgFirst) {
    var block = U.el('div', { class: 'rb-role', 'data-role-id': role.id });
    var when = whenRange(p, role);
    var head = entryHead(
      titleEl('h3', null, p + 'position', role.position, 'Position',
        { className: 'rb-doc-emphasis', placeholder: 'Position' }),
      when
    );
    block.appendChild(head);
    if (orgLine && !orgFirst) block.appendChild(orgLine);
    if (hasContent(role.summary)) {
      block.appendChild(fieldEl(p + 'summary', role.summary, 'Role summary', {
        tag: 'p', className: 'rb-entry__text rb-prose__text', multiline: true
      }));
    }
    var skills = keywordList(p + 'skills', role.skills, 'Skill');
    if (skills) block.appendChild(U.el('div', { class: 'rb-entry__aside' }, [skills]));
    var bullets = bulletList(p + 'highlights', role.highlights, 'Achievement');
    if (bullets) block.appendChild(bullets);
    return block;
  }

  BUILDERS.education = function (resume) {
    var out = [];
    listOf(resume, 'education').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'education.' + i + '.';
      var art = entryEl('education', entry);
      var main = [
        titleEl('h3', null, p + 'institution', entry.institution, 'Institution',
          { className: 'rb-doc-emphasis', placeholder: 'Institution' })
      ];
      /* Degree and field are one phrase, so they share one inline wrapper. */
      if (hasContent(entry.studyType) || hasContent(entry.area)) {
        var degree = U.el('span', { class: 'rb-entry__role' });
        if (hasContent(entry.studyType)) {
          degree.appendChild(fieldEl(p + 'studyType', entry.studyType, 'Qualification', { tag: 'span', className: 'rb-doc-emphasis' }));
        }
        if (hasContent(entry.area)) {
          if (hasContent(entry.studyType)) degree.appendChild(doc.createTextNode(PHRASE_SEP));
          degree.appendChild(fieldEl(p + 'area', entry.area, 'Field of study', { tag: 'span' }));
        }
        main.push(degree);
      }
      art.appendChild(entryHead(main, whenRange(p, entry)));

      var sub = subLine();
      var added = false;
      if (hasContent(entry.score)) {
        sub.appendChild(fieldEl(p + 'score', entry.score, 'Grade or score', { tag: 'span', className: 'rb-doc-mute', placeholder: 'GPA' }));
        added = true;
      }
      if (hasContent(entry.url)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(linkField(p + 'url', entry.url, 'Institution website', 'web', { className: 'rb-doc-mute' }));
        added = true;
      }
      if (added) art.appendChild(sub);

      var courses = keywordList(p + 'courses', entry.courses, 'Course');
      if (courses) art.appendChild(U.el('div', { class: 'rb-entry__aside' }, [courses]));
      out.push(art);
    });
    return out;
  };

  /* Skill groups are the one section that reads as a labelled list rather than
   * as titled entries, so they do not take an .rb-entry wrapper. */
  BUILDERS.skills = function (resume) {
    var out = [];
    listOf(resume, 'skills').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'skills.' + i + '.';
      var group = U.el('div', {
        class: 'rb-skill-group',
        'data-entry-type': 'skills',
        'data-entry-id': entry.id
      });
      group.appendChild(U.el('h3', { class: 'rb-skill-group__label' }, [
        fieldEl(p + 'label', entry.label, 'Skill group', { tag: 'span', placeholder: 'Skill group' })
      ]));
      if (hasContent(entry.level)) {
        group.firstChild.appendChild(sepNode());
        group.firstChild.appendChild(fieldEl(p + 'level', entry.level, 'Skill level', { tag: 'span', className: 'rb-doc-mute' }));
      }
      var words = keywordList(p + 'keywords', entry.keywords, 'Skill', 'rb-tags');
      if (words) group.appendChild(words);
      out.push(group);
    });
    return out;
  };

  BUILDERS.projects = function (resume) {
    var out = [];
    listOf(resume, 'projects').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'projects.' + i + '.';
      var art = entryEl('project', entry);
      var url = hasContent(entry.url) ? (hrefFor(entry.url, 'web') || '') : '';
      var hasName = hasContent(entry.name);
      /* Name links to the project URL when there is one. Printing the raw URL
       * on its own line as well is noise, so only do it when there is no name
       * to hang the link on. */
      var title = url
        ? linkField(p + 'name', entry.name, 'Project name', 'web', { className: 'rb-doc-emphasis', href: url })
        : fieldEl(p + 'name', entry.name, 'Project name', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Project name' });
      art.appendChild(entryHead(U.el('h3', { class: 'rb-entry__org' }, [title]), whenRange(p, entry)));
      if (url && !hasName) {
        art.appendChild(subLine('rb-entry__org-line', [linkField(p + 'url', entry.url, 'Project link', 'web', { className: 'rb-doc-mute' })]));
      }
      if (hasContent(entry.summary)) {
        art.appendChild(fieldEl(p + 'summary', entry.summary, 'Project summary', { tag: 'p', className: 'rb-entry__text rb-prose__text', multiline: true }));
      }
      var bullets = bulletList(p + 'highlights', entry.highlights, 'Detail');
      if (bullets) art.appendChild(bullets);
      var words = keywordList(p + 'keywords', entry.keywords, 'Keyword');
      if (words) art.appendChild(U.el('div', { class: 'rb-entry__aside' }, [words]));
      out.push(art);
    });
    return out;
  };

  BUILDERS.certifications = function (resume) {
    var out = [];
    listOf(resume, 'certifications').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'certifications.' + i + '.';
      var art = entryEl('certification', entry);
      var title = hasContent(entry.url)
        ? linkField(p + 'name', entry.name, 'Certification', 'web', { className: 'rb-doc-emphasis' })
        : fieldEl(p + 'name', entry.name, 'Certification', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Certification' });
      art.appendChild(entryHead(U.el('h3', { class: 'rb-entry__org' }, [title]), whenDate(p, entry.date, 'Date earned')));
      var sub = subLine();
      var added = false;
      if (hasContent(entry.issuer)) {
        sub.appendChild(fieldEl(p + 'issuer', entry.issuer, 'Issuing organization', { tag: 'span', className: 'rb-doc-mute' }));
        added = true;
      }
      if (hasContent(entry.credentialId)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(fieldEl(p + 'credentialId', entry.credentialId, 'Credential ID', { tag: 'span', className: 'rb-doc-mute rb-doc-credential', spellcheck: false }));
        added = true;
      }
      if (added) art.appendChild(sub);
      out.push(art);
    });
    return out;
  };

  BUILDERS.publications = function (resume) {
    var out = [];
    listOf(resume, 'publications').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'publications.' + i + '.';
      var art = entryEl('publication', entry);
      var title = hasContent(entry.url)
        ? linkField(p + 'title', entry.title, 'Publication title', 'web', { className: 'rb-doc-emphasis' })
        : fieldEl(p + 'title', entry.title, 'Publication title', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Title' });
      art.appendChild(entryHead(U.el('h3', { class: 'rb-entry__org' }, [title]), whenDate(p, entry.date, 'Publication date')));
      if (hasContent(entry.authors)) {
        art.appendChild(subLine('rb-entry__org-line', [fieldEl(p + 'authors', entry.authors, 'Authors', { tag: 'span' })]));
      }
      var sub = subLine();
      var added = false;
      if (hasContent(entry.venue)) {
        sub.appendChild(fieldEl(p + 'venue', entry.venue, 'Journal or venue', { tag: 'em', className: 'rb-doc-mute' }));
        added = true;
      }
      if (hasContent(entry.doi)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(fieldEl(p + 'doi', entry.doi, 'DOI', { tag: 'span', className: 'rb-doc-mute rb-doc-credential', spellcheck: false }));
        added = true;
      }
      if (added) art.appendChild(sub);
      out.push(art);
    });
    return out;
  };

  BUILDERS.awards = function (resume) {
    var out = [];
    listOf(resume, 'awards').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'awards.' + i + '.';
      var art = entryEl('award', entry);
      art.appendChild(entryHead(
        titleEl('h3', 'rb-entry__org', p + 'title', entry.title, 'Award', { className: 'rb-doc-emphasis', placeholder: 'Award' }),
        whenDate(p, entry.date, 'Date received')
      ));
      if (hasContent(entry.awarder)) {
        art.appendChild(subLine('rb-entry__org-line', [fieldEl(p + 'awarder', entry.awarder, 'Awarding body', { tag: 'span', className: 'rb-doc-mute' })]));
      }
      out.push(art);
    });
    return out;
  };

  BUILDERS.volunteer = function (resume) {
    var out = [];
    listOf(resume, 'volunteer').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'volunteer.' + i + '.';
      var art = entryEl('volunteer', entry);
      art.appendChild(entryHead(
        titleEl('h3', 'rb-entry__org', p + 'role', entry.role, 'Role', { className: 'rb-doc-emphasis', placeholder: 'Role' }),
        whenRange(p, entry)
      ));
      var sub = subLine('rb-entry__org-line');
      var added = false;
      if (hasContent(entry.organization)) {
        sub.appendChild(fieldEl(p + 'organization', entry.organization, 'Organization', { tag: 'span' }));
        added = true;
      }
      if (hasContent(entry.location)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(fieldEl(p + 'location', entry.location, 'Location', { tag: 'span', className: 'rb-doc-mute' }));
        added = true;
      }
      if (added) art.appendChild(sub);
      var bullets = bulletList(p + 'highlights', entry.highlights, 'Contribution');
      if (bullets) art.appendChild(bullets);
      out.push(art);
    });
    return out;
  };

  /* Languages, interests and coursework read as lists, not titled entries. */
  BUILDERS.languages = function (resume) {
    var items = [];
    listOf(resume, 'languages').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'languages.' + i + '.';
      var li = U.el('li', { class: 'rb-inline-list__item', 'data-entry-id': entry.id, 'data-entry-type': 'languages' }, [
        fieldEl(p + 'language', entry.language, 'Language', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Language' })
      ]);
      if (hasContent(entry.fluency)) {
        li.appendChild(doc.createTextNode(' \u2014 '));
        li.appendChild(fieldEl(p + 'fluency', entry.fluency, 'Fluency', { tag: 'span', className: 'rb-doc-mute' }));
      }
      items.push(li);
    });
    if (!items.length) return [];
    return [U.el('ul', { class: 'rb-inline-list rb-lang-list' }, items)];
  };

  BUILDERS.interests = function (resume) {
    var items = [];
    listOf(resume, 'interests').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      items.push(U.el('li', { class: 'rb-inline-list__item', 'data-entry-id': entry.id, 'data-entry-type': 'interests' }, [
        fieldEl('interests.' + i + '.label', entry.label, 'Interest', { tag: 'span', placeholder: 'Interest' })
      ]));
    });
    if (!items.length) return [];
    return [U.el('ul', { class: 'rb-inline-list' }, items)];
  };

  BUILDERS.references = function (resume) {
    var out = [];
    listOf(resume, 'references').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'references.' + i + '.';
      var art = entryEl('reference', entry);
      art.appendChild(entryHead(
        titleEl('h3', 'rb-entry__org', p + 'name', entry.name, 'Reference name', { className: 'rb-doc-emphasis', placeholder: 'Name' })
      ));
      var sub = subLine('rb-entry__org-line');
      var added = false;
      if (hasContent(entry.label)) {
        sub.appendChild(fieldEl(p + 'label', entry.label, 'Relationship', { tag: 'span' }));
        added = true;
      }
      if (hasContent(entry.contact)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(fieldEl(p + 'contact', entry.contact, 'Contact details', { tag: 'span', className: 'rb-doc-mute', spellcheck: false }));
        added = true;
      }
      if (added) art.appendChild(sub);
      out.push(art);
    });
    return out;
  };

  BUILDERS.coursework = function (resume) {
    var out = [];
    listOf(resume, 'coursework').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'coursework.' + i + '.';
      var art = entryEl('course', entry);
      var title = hasContent(entry.url)
        ? linkField(p + 'name', entry.name, 'Course', 'web', { className: 'rb-doc-emphasis' })
        : fieldEl(p + 'name', entry.name, 'Course', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Course' });
      art.appendChild(entryHead(U.el('h3', { class: 'rb-entry__org' }, [title]), whenDate(p, entry.date, 'Date taken')));
      if (hasContent(entry.institution)) {
        art.appendChild(subLine('rb-entry__org-line', [fieldEl(p + 'institution', entry.institution, 'Institution', { tag: 'span', className: 'rb-doc-mute' })]));
      }
      out.push(art);
    });
    return out;
  };

  BUILDERS.presentations = function (resume) {
    var out = [];
    listOf(resume, 'presentations').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'presentations.' + i + '.';
      var art = entryEl('presentation', entry);
      var title = hasContent(entry.url)
        ? linkField(p + 'title', entry.title, 'Presentation title', 'web', { className: 'rb-doc-emphasis' })
        : fieldEl(p + 'title', entry.title, 'Presentation title', { tag: 'span', className: 'rb-doc-emphasis', placeholder: 'Title' });
      art.appendChild(entryHead(U.el('h3', { class: 'rb-entry__org' }, [title]), whenDate(p, entry.date, 'Date')));
      var sub = subLine('rb-entry__org-line');
      var added = false;
      if (hasContent(entry.event)) {
        sub.appendChild(fieldEl(p + 'event', entry.event, 'Event', { tag: 'span' }));
        added = true;
      }
      if (hasContent(entry.location)) {
        if (added) sub.appendChild(sepNode());
        sub.appendChild(fieldEl(p + 'location', entry.location, 'Location', { tag: 'span', className: 'rb-doc-mute' }));
        added = true;
      }
      if (added) art.appendChild(sub);
      var bullets = bulletList(p + 'highlights', entry.highlights, 'Detail');
      if (bullets) art.appendChild(bullets);
      out.push(art);
    });
    return out;
  };

  /* A user-named section: the entry carries its own title, and a sub-list of
   * free-form rows. */
  BUILDERS.custom = function (resume) {
    var out = [];
    listOf(resume, 'custom').forEach(function (entry, i) {
      if (entry.visible === false || !hasContent(entry)) return;
      var p = 'custom.' + i + '.';
      /* The index has to be the row's own. Filtering first and numbering what
       * is left re-addresses every surviving row at index 0, and a field bound
       * to the wrong row writes the user's text into their neighbour. */
      var rows = (Array.isArray(entry.entries) ? entry.entries : [])
        .map(function (row, ri) { return { row: row, i: ri }; })
        .filter(function (it) {
          return it.row && it.row.visible !== false && hasContent(it.row);
        });
      var art = entryEl('custom', entry);
      if (rows.length) {
        art.appendChild(U.el('header', { class: 'rb-entry__head' }, [
          U.el('div', { class: 'rb-entry__main' }, [
            titleEl('h3', 'rb-entry__org', p + 'label', entry.label, 'Entry title', { className: 'rb-doc-emphasis', placeholder: 'Title' })
          ])
        ]));
      }
      rows.forEach(function (it) {
        var row = it.row;
        var rp = p + 'entries.' + it.i + '.';
        var item = U.el('div', { class: 'rb-custom-row', 'data-entry-id': row.id });
        item.appendChild(entryHead(
          titleEl('h4', 'rb-custom-title', rp + 'title', row.title, 'Item title', { className: 'rb-doc-emphasis', placeholder: 'Title' }),
          whenRange(rp, row)
        ));
        if (hasContent(row.org)) {
          item.appendChild(subLine('rb-entry__org-line', [fieldEl(rp + 'org', row.org, 'Organization', { tag: 'span', className: 'rb-doc-mute' })]));
        }
        if (hasContent(row.text)) {
          item.appendChild(fieldEl(rp + 'text', row.text, 'Detail', { tag: 'p', className: 'rb-entry__text rb-prose__text', multiline: true }));
        }
        art.appendChild(item);
      });
      out.push(art);
    });
    return out;
  };

  /* ---------- document shell ---------- */

  function buildHeader(resume) {
    var b = resume.basics || {};
    var header = U.el('header', { class: 'rb-doc__head' });
    var identity = U.el('div', { class: 'rb-doc__id' });

    identity.appendChild(fieldEl('basics.name', b.name, 'Full name', {
      tag: 'h1',
      className: 'rb-doc__name',
      placeholder: 'Your name'
    }));
    if (hasContent(b.label)) {
      identity.appendChild(fieldEl('basics.label', b.label, 'Professional title', {
        tag: 'p',
        className: 'rb-doc__label',
        placeholder: 'Job title'
      }));
    }
    header.appendChild(identity);

    if (resume.design && resume.design.photoSlot && typeof b.photo === 'string' && /^data:image\//.test(b.photo)) {
      header.appendChild(U.el('div', { class: 'rb-doc__photo' }, [
        U.el('img', {
          src: b.photo,
          alt: hasContent(b.name) ? 'Photo of ' + text(b.name).trim() : ''
        })
      ]));
    }

    var contact = contactList(resume);
    if (contact) header.appendChild(contact);
    return header;
  }

  /* One flowing line: email · phone · city, region · website · profile. Each
   * fact is one inline field, and every fact but the first carries the
   * separator that introduces it. A text extractor still reads separate
   * tokens rather than one run-on string, and because the items are the
   * only break points, a separator can never be the last thing on a line.
   * A profile that resolves to a link the header already prints is dropped
   * rather than repeated. */
  function contactList(resume) {
    var b = resume.basics || {};
    var items = [];
    var seen = {};

    function add(node, key) {
      if (!node) return;
      var k = urlKey(key || node.textContent || '');
      if (k && seen[k]) return;
      if (k) seen[k] = true;
      items.push(U.el('li', { class: 'rb-doc__contact-item' }, [node]));
    }

    if (hasContent(b.email)) add(linkField('basics.email', b.email, 'Email', 'email'), b.email);
    if (hasContent(b.phone)) add(linkField('basics.phone', b.phone, 'Phone', 'tel'), b.phone);

    var loc = b.location || {};
    if (hasContent(loc.city) || hasContent(loc.region)) {
      var place = U.el('span', { class: 'rb-doc__place' });
      if (hasContent(loc.city)) {
        place.appendChild(fieldEl('basics.location.city', loc.city, 'City', { tag: 'span', placeholder: 'City' }));
      }
      if (hasContent(loc.region)) {
        if (hasContent(loc.city)) place.appendChild(txt(', '));
        place.appendChild(fieldEl('basics.location.region', loc.region, 'Region or state', { tag: 'span', placeholder: 'Region' }));
      }
      add(place, joined([loc.city, loc.region]));
    }

    if (hasContent(b.url)) add(linkField('basics.url', b.url, 'Website', 'web'), b.url);

    (Array.isArray(b.profiles) ? b.profiles : []).forEach(function (profile, i) {
      if (!profile || !hasContent(profile)) return;
      var p = 'basics.profiles.' + i + '.';
      /* One profile, one link. A label is the text; a bare URL is its own text.
       * Rendering both is how a profile ends up printed twice. */
      if (hasContent(profile.label)) {
        var href = hasContent(profile.url) ? hrefFor(profile.url, 'web') : '';
        add(linkFrom(p + 'label', profile.label, 'Profile', href || hrefFor(profile.label, 'web')), profile.url || profile.label);
      } else if (hasContent(profile.url)) {
        add(linkField(p + 'url', profile.url, 'Profile link', 'web'), profile.url);
      }
    });

    if (!items.length) return null;
    /* The separator leads the fact it introduces, so a line break falls
     * before it and never after it. markContactLines() removes the ones
     * that end up starting a line. */
    for (var i = 1; i < items.length; i++) {
      items[i].insertBefore(
        U.el('span', { class: 'rb-doc__sep', text: CONTACT_SEP }),
        items[i].firstChild
      );
    }
    return U.el('ul', { class: 'rb-doc__contact', 'aria-label': 'Contact details' }, items);
  }

  function sectionEl(sec, index, body) {
    var meta = model.typeMeta ? model.typeMeta(sec.type) : { defaultLabel: text(sec.type).toUpperCase() };
    var headingId = 'rb-sec-' + index;
    var section = U.el('section', {
      class: 'rb-section',
      'data-section-id': sec.id,
      'data-section-type': sec.type,
      'data-cols': sec.columns === 1 ? '1' : '2',
      'data-collapsed': sec.collapsed ? 'true' : null,
      'aria-labelledby': headingId
    });
    section.appendChild(U.el('h2', { class: 'rb-section__head', id: headingId }, [
      fieldEl('sections.' + index + '.label', sec.label, meta.label + ' section heading', {
        tag: 'span',
        className: 'rb-section__title',
        placeholder: meta.defaultLabel
      })
    ]));
    /* The entries are the section's direct children on purpose. An extra
     * wrapper here costs the paginator one level of its walk, and it spends
     * that level on the two column containers — which is how a section taller
     * than a page used to be measured as a single unbreakable unit. */
    body.forEach(function (node) { section.appendChild(node); });
    return section;
  }

  /* Which sections, if any, move into the sidebar column. The DOM is the same
   * in both modes: .rb-doc__side and .rb-doc__main are display:contents until
   * a two-column design switches the body to a grid. */
  function sidebarTypes(design) {
    var t = RB.templates;
    var preset = t && typeof t.get === 'function' ? t.get(design && design.templateId) : null;
    if (preset && preset.layout && preset.layout.mode === 'sidebar') {
      return (preset.layout.sidebarTypes || []).slice();
    }
    if (design && design.columns === 2) return DEFAULT_SIDEBAR_TYPES.slice();
    return null;
  }

  function buildBody(resume) {
    var body = U.el('div', { class: 'rb-doc__body' });
    var side = U.el('div', { class: 'rb-doc__side' });
    var main = U.el('div', { class: 'rb-doc__main' });
    var inSidebar = sidebarTypes(resume.design);
    var sideTypes = {};
    (inSidebar || []).forEach(function (t) { sideTypes[t] = true; });

    var indexById = {};
    (resume.sections || []).forEach(function (s, i) { indexById[s.id] = i; });
    var ordered = model.orderedSections ? model.orderedSections(resume) : (resume.sections || []);

    ordered.forEach(function (sec) {
      if (!sec || sec.visible === false) return;
      var build = BUILDERS[sec.type];
      if (!build) return;
      var nodes = build(resume, sec, indexById[sec.id]) || [];
      if (!Array.isArray(nodes)) nodes = [nodes];
      if (!nodes.length && sec.type !== 'summary') return;
      var el = sectionEl(sec, indexById[sec.id], nodes);
      (inSidebar && sideTypes[sec.type] ? side : main).appendChild(el);
    });

    body.appendChild(side);
    body.appendChild(main);
    return body;
  }

  function buildDocument(resume) {
    var frag = U.frag([]);
    frag.appendChild(buildHeader(resume));
    frag.appendChild(buildBody(resume));
    return frag;
  }

  /* ---------- pagination: one DOM sheet per printed page ----------
   *
   * The flow is built once, flat, and measured by RB.paginator. The break
   * positions it reports are then turned into real elements: the sections
   * that start a page are moved into a new .rb-page-sheet. Nothing is
   * re-measured and no height is recomputed here — the paginator owns the
   * arithmetic, this only re-hangs the nodes it already located.
   *
   * A sheet is a fixed-height page box with `overflow: visible`, so a sheet
   * that cannot be made to fit grows instead of clipping. Content is never
   * hidden: an overfull sheet is taller than a page, which is visible.
   */

  function sheetList() {
    return U.qsa(':scope > .' + SHEET_CLASS, docEl);
  }

  function columnOf(sheet, cls) {
    var body = U.qs(':scope > .rb-doc__body', sheet);
    if (!body) return null;
    for (var i = 0; i < body.children.length; i++) {
      if (body.children[i].classList.contains(cls)) return body.children[i];
    }
    return null;
  }

  function sheetBody(sheet) {
    var body = U.qs(':scope > .rb-doc__body', sheet);
    if (body) return body;
    body = U.el('div', { class: 'rb-doc__body' });
    COLUMNS.forEach(function (cls) { body.appendChild(U.el('div', { class: cls })); });
    sheet.appendChild(body);
    return body;
  }

  /* The blocks a page break may fall in front of, in document order. A sheet
   * is only ever split between two of these. */
  function sheetBlocks(sheet) {
    var blocks = [];
    var head = U.qs(':scope > .rb-doc__head', sheet);
    if (head) blocks.push(head);
    var body = U.qs(':scope > .rb-doc__body', sheet);
    if (body) {
      COLUMNS.forEach(function (cls) {
        var col = columnOf(sheet, cls);
        if (!col) return;
        for (var i = 0; i < col.children.length; i++) blocks.push(col.children[i]);
      });
    }
    return blocks;
  }

  /* A break can land on a heading or on a role inside a long entry. Lifting it
   * to the section that owns it keeps entries whole and keeps a heading with
   * the content it introduces. */
  function ownerBlock(el) {
    var node = el;
    while (node && node !== docEl) {
      var parent = node.parentNode;
      if (parent && parent.classList &&
        (parent.classList.contains('rb-doc__side') || parent.classList.contains('rb-doc__main'))) {
        return node;
      }
      node = parent;
    }
    return null;
  }

  /* A section's content is the section itself: its entries are direct children,
   * because a wrapper there costs the paginator a level of descent. */
  function sectionContent(section) {
    return U.qs(':scope > .rb-section__content', section) || section;
  }

  /* The block a page break belongs to, and — when the break fell inside that
   * block rather than in front of it — the child it fell on. The paginator
   * only descends into a section that is larger than 60% of a page, so a child
   * here means the section is taller than the page and has to be continued
   * rather than pushed whole onto the next one. */
  function breakSite(el) {
    var block = ownerBlock(el);
    if (!block || block.tagName !== 'SECTION') return { block: block, inner: null };
    var content = sectionContent(block);
    if (!content.contains(el)) return { block: block, inner: null };
    var node = el;
    while (node && node.parentNode && node.parentNode !== content) node = node.parentNode;
    if (!node || node.parentNode !== content) return { block: block, inner: null };
    /* The half that stays has to be worth a page of its own: a section
     * reduced to its heading is the orphan the paginator works to avoid. A
     * break on the last child is fine — it carries that one entry over. */
    var prev = node.previousElementSibling;
    if (!prev || (prev.classList && prev.classList.contains('rb-section__head'))) {
      return { block: block, inner: null };
    }
    return { block: block, inner: node };
  }

  function newSheet() {
    return U.el('div', { class: SHEET_CLASS });
  }

  function wrapSheet(flat) {
    var sheet = newSheet();
    sheet.appendChild(flat);
    return sheet;
  }

  /* The page that carries on from a section which ran out of room. The
   * heading is repeated because a page whose entries have no heading under
   * them is worse on paper than one that repeats itself; it is inert, so the
   * model still has exactly one editable label per section.
   *
   * It is a div, not a section: a second landmark carrying the same name as
   * the one it continues gives a screen reader two identical "Contact" regions
   * to choose between, and nothing on the page is a separate region. */
  function continuationOf(section, n) {
    var head = U.qs(':scope > .rb-section__head', section);
    continuationSeq += 1;
    var id = 'rb-sec-cont-' + continuationSeq + (n == null ? '' : '-' + n);
    var cont = U.el('div', {
      class: 'rb-section rb-section--continued',
      'data-section-id': section.getAttribute('data-section-id'),
      'data-section-type': section.getAttribute('data-section-type'),
      'data-cols': section.getAttribute('data-cols') || '1',
      'data-rb-continued': 'true'
    }, [
      U.el('h2', { class: 'rb-section__head', id: id, contenteditable: 'false' }, [
        U.el('span', { class: 'rb-section__title', text: head ? head.textContent : '' })
      ])
    ]);
    return cont;
  }

  /* Everything in a section that is not its heading, in order. */
  function sectionEntries(section) {
    var head = U.qs(':scope > .rb-section__head', section);
    var content = sectionContent(section);
    var out = [];
    for (var i = 0; i < content.children.length; i++) {
      if (content.children[i] !== head) out.push(content.children[i]);
    }
    return out;
  }

  function columnClassOf(node) {
    var from = node.parentNode;
    return from && from.classList && from.classList.contains('rb-doc__side')
      ? 'rb-doc__side' : 'rb-doc__main';
  }

  /* Distribute the blocks across one sheet per page. The first sheet is
   * reused so the header stays where it already is. A section can be broken
   * more than once — one that runs over three pages has to — so the breaks are
   * grouped by the block they belong to and applied in order. */
  function splitSheets(sites) {
    var first = docEl.firstElementChild;
    if (!first || !first.classList.contains(SHEET_CLASS)) return;
    var blocks = sheetBlocks(first);

    var cuts = [];
    sites.forEach(function (site) {
      if (!site || !site.block) return;
      var i = blocks.indexOf(site.block);
      if (i <= 0) return;
      var list = cuts[i] || (cuts[i] = []);
      /* A break with no inner node moves the whole section, so any later
       * break inside it is already accounted for. */
      if (!site.inner) { if (!list.length) list.push(null); return; }
      if (list.indexOf(site.inner) === -1) list.push(site.inner);
    });
    if (!cuts.length) return;

    var sheets = [first];
    function sheetAt(k) {
      while (sheets.length <= k) {
        var s = newSheet();
        docEl.appendChild(s);
        sheetBody(s);
        sheets.push(s);
      }
      return sheets[k];
    }
    function place(page, node, cls) {
      var col = columnOf(sheetAt(page), cls || columnClassOf(node));
      /* A block already in the right column must not be re-appended:
       * appendChild moves it to the end, which reverses the document order
       * of everything still waiting on this page. */
      if (col && node.parentNode !== col) col.appendChild(node);
    }

    var page = 0;
    blocks.forEach(function (blk, i) {
      /* The header is the first block and belongs to the first sheet alone:
       * it is a sibling of the body, not one of its columns. */
      if (!i) return;
      var list = cuts[i];
      var cls = columnClassOf(blk);
      if (!list || !list.length) { place(page, blk, cls); return; }
      if (list[0] === null || blk.tagName !== 'SECTION') { page += 1; place(page, blk, cls); return; }

      /* The section straddles the boundary. The entry the break fell on, and
       * everything under it, opens the next page as a section of its own; a
       * second break inside the same section does the same again. */
      var host = sectionContent(blk);
      for (var c = 0; c < list.length; c++) {
        var carry = [];
        for (var node = list[c]; node; ) {
          /* The next sibling has to be read before the move: detaching a node
           * takes its siblings' chain with it. */
          var next = node.nextSibling;
          carry.push(node);
          host.removeChild(node);
          node = next;
        }
        if (!carry.length) break;
        page += 1;
        var cont = continuationOf(blk, i + '-' + c);
        carry.forEach(function (n) { cont.appendChild(n); });
        place(page, cont, cls);
        host = cont;
      }
    });
  }

  /* How tall the content actually is.
   *
   * This must not walk the sheet's direct children: `.rb-doc__body` is
   * `display: contents` in a single-column layout, so it has no box and every
   * section inside it is missed. Measuring the real rendered bottom of the
   * sheet's descendants is the only version that is true in every layout. */
  function usedHeight(sheet) {
    var cs = global.getComputedStyle(sheet);
    var top = sheet.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0);
    var bottom = top;
    var nodes = sheet.querySelectorAll('.rb-section, .rb-entry, .rb-doc__id, .rb-doc__contact, .rb-bullets, .rb-inline-list');
    for (var i = 0; i < nodes.length; i++) {
      var rect = nodes[i].getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > bottom) bottom = rect.bottom;
    }
    /* Nothing matched (an empty page): fall back to the sheet's own box. */
    if (bottom <= top) {
      var self = sheet.getBoundingClientRect();
      bottom = self.bottom - (parseFloat(cs.paddingBottom) || 0);
    }
    return Math.max(0, bottom - top);
  }

  /* Which column decides the sheet's height, and the last block in it. */
  function tallerColumn(sheet) {
    var best = null;
    for (var i = 0; i < COLUMNS.length; i++) {
      var col = columnOf(sheet, COLUMNS[i]);
      if (!col || !col.lastElementChild) continue;
      var bottom = col.lastElementChild.getBoundingClientRect().bottom;
      if (!best || bottom > best.bottom) best = { cls: COLUMNS[i], bottom: bottom, node: col.lastElementChild };
    }
    return best;
  }

  /* Take one block off the foot of an overfull page, or — when the block is a
   * section with room to spare in it — the fewest entries that bring the page
   * back inside the margin. Either way the block lands at the head of the next
   * page, so the document order survives. */
  function relieve(sheet, next, available) {
    var col = tallerColumn(sheet);
    if (!col) return false;
    var target = columnOf(next, col.cls);
    if (!target) return false;
    var node = col.node;

    /* The paginator's break inside a section leaves the tail of that section
     * one page too full, because it models the entry it broke on as split
     * across the boundary and this document never splits one. Handing over the
     * trailing entries is the smallest correction that makes the page true. */
    if (node.tagName === 'SECTION') {
      var kids = sectionEntries(node);
      if (kids.length > 1) {
        var cont = continuationOf(node, null);
        /* Prepended, not appended: the loop walks up from the foot, and the
         * continuation is carried to the next page top-down, so appending
         * would print that section's jobs newest first. */
        for (var k = kids.length - 1; k > 0; k--) {
          cont.insertBefore(kids[k], cont.firstChild);
          if (usedHeight(sheet) - available <= FIT_EPS) {
            target.insertBefore(cont, target.firstChild);
            return true;
          }
        }
        /* Nothing shorter than the whole section works here. Put it back. */
        var content = sectionContent(node);
        while (cont.children.length > 1) content.appendChild(cont.firstChild);
      }
    }

    /* A page down to its last block cannot be helped by emptying it: the block
     * is what is taller than the page. Let the sheet grow — the content stays
     * on screen, and the paginator reports the page as oversized. */
    if (sheetBlocks(sheet).length <= 1) return false;
    target.insertBefore(node, target.firstChild);
    return true;
  }

  /* Hand the trailing block of an overfull page to the next page, so a page
   * that cannot be made to fit is never drawn taller than it has to be. */
  function pushOverflow(sheets, available) {
    var moved = false;
    for (var i = 0; i < sheets.length - 1; i++) {
      var tries = 0;
      while (usedHeight(sheets[i]) - available > FIT_EPS && tries++ < FIT_TRIES) {
        if (!relieve(sheets[i], sheets[i + 1], available)) break;
        moved = true;
      }
    }
    return moved;
  }

  /* The other direction: if the whole of the last page still fits on the page
   * before it, the break was early. A break is supposed to fall as late as it
   * can, and a resume that fits on one page must not be shown on two. */
  function pullBack(sheets, available) {    if (sheets.length < 2) return false;
    var last = sheets.length - 1;
    if (usedHeight(sheets[last - 1]) + usedHeight(sheets[last]) > available + FIT_EPS) return false;
    var blocks = sheetBlocks(sheets[last]);
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].getAttribute('data-rb-continued') === 'true') { rejoinContinuation(blocks[i]); continue; }
      var col = columnOf(sheets[last - 1], columnClassOf(blocks[i]));
      if (col) col.appendChild(blocks[i]);
    }
    var dead = sheets.pop();
    if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
    return true;
  }

  function appendSheet(sheets) {
    var s = newSheet();
    docEl.appendChild(s);
    sheetBody(s);
    sheets.push(s);
    return s;
  }

  /* The last page has nowhere to push to, so an overfull one is given a page
   * of its own until what is left fits. Without this the tail of a long
   * section would spill past the foot of the paper. */
  function growTail(sheets, available) {
    var grew = false;
    while (sheets.length && usedHeight(sheets[sheets.length - 1]) - available > FIT_EPS) {
      var last = sheets[sheets.length - 1];
      var next = appendSheet(sheets);
      if (!relieve(last, next, available)) {
        sheets.pop();
        if (next.parentNode) next.parentNode.removeChild(next);
        break;
      }
      grew = true;
    }
    return grew;
  }

  /* Two directions, run to a fixed point: nothing is ever clipped, and the
   * page count the user is shown is the page count they are looking at. */
  function packSheets(sheets, available) {
    var limit = available - FIT_GUARD;
    if (limit <= 0) return;
    for (var pass = 0; pass < FIT_PASSES; pass++) {
      var moved = pushOverflow(sheets, limit);
      if (growTail(sheets, limit)) moved = true;
      if (pullBack(sheets, limit)) moved = true;
      if (!moved) return;
    }
  }

  function numberSheets(sheets) {
    sheets.forEach(function (sheet, i) {
      sheet.setAttribute('data-page', String(i + 1));
    });
    docEl.setAttribute('data-pages', String(sheets.length));
  }

  function narrowViewport() {
    return !!(global.matchMedia && global.matchMedia(NARROW_QUERY).matches);
  }

  /* A two-column sheet runs its columns side by side, so one sequential walk
   * over the whole body describes neither of them. Measuring each column with
   * the other hidden is the only way the paginator's own arithmetic can say
   * where each one breaks; the two lists of breaks are then independent, and
   * each page takes what fits in its own column.
   *
   * One empty column is not two columns: templates.css has already dropped the
   * grid track, so the body is the main column and the flat walk above is the
   * honest one. Measuring it twice would only cost two layouts. */
  function measureColumns(pager, sheet) {
    var side = columnOf(sheet, 'rb-doc__side');
    var main = columnOf(sheet, 'rb-doc__main');
    if (!side || !main || !main.children.length || !side.children.length) return null;
    var sites = [];
    var other = null;
    var result = null;

    other = main;
    other.style.setProperty('display', 'none');
    try { result = pager.measure(docEl); } catch (e) { result = null; }
    other.style.removeProperty('display');
    if (result && result.valid) {
      (result.breaks || []).forEach(function (brk) {
        var site = breakSite(brk.el);
        if (site && site.block && side.contains(site.block)) sites.push(site);
      });
    }

    other = side;
    other.style.setProperty('display', 'none');
    try { result = pager.measure(docEl); } catch (e) { result = null; }
    other.style.removeProperty('display');
    if (result && result.valid) {
      (result.breaks || []).forEach(function (brk) {
        var site = breakSite(brk.el);
        if (site && site.block && main.contains(site.block)) sites.push(site);
      });
    }
    return sites.length ? sites : null;
  }

  /* How much of a column its own content fills. The box is stretched to the
   * grid row, so the box's own height says how much room the page gave the
   * column and not how much the column used. What is on the column is the
   * union of its children's boxes, and taking the last child's bottom only
   * works while the content hangs from the top of the box: a rail anchored to
   * the foot of its column — the whole point of the keel template — then
   * measures as tall as the main column beside it, so a two-line rail beside
   * three jobs reads as perfectly balanced and never gives its sections back. */
  function columnFill(col) {
    if (!col) return 0;
    var top = Infinity;
    var bottom = -Infinity;
    for (var i = 0; i < col.children.length; i++) {
      var rect = col.children[i].getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.top < top) top = rect.top;
      if (rect.bottom > bottom) bottom = rect.bottom;
    }
    if (!isFinite(top)) return 0;
    return Math.max(0, bottom - top);
  }

  /* The column a two-column page cannot afford to keep, or null when it can.
   * Both columns must hold something: an empty one is already handled by
   * templates.css, which drops the grid track entirely. */
  function sparseColumn(sheet) {
    var side = columnOf(sheet, 'rb-doc__side');
    var main = columnOf(sheet, 'rb-doc__main');
    if (!side || !main || !side.lastElementChild || !main.lastElementChild) return null;
    var s = columnFill(side), m = columnFill(main);
    var thin = Math.min(s, m), full = Math.max(s, m);
    if (thin >= SPARSE_COL_PX || thin >= full * SPARSE_COL_RATIO) return null;
    return s < m ? 'rb-doc__side' : 'rb-doc__main';
  }

  function modelRank(resume) {
    var rank = {};
    var ordered = model.orderedSections ? model.orderedSections(resume) : (resume.sections || []);
    ordered.forEach(function (sec, i) { if (sec && sec.id) rank[sec.id] = i; });
    return rank;
  }

  /* The two columns are read side by side, so a section that changes column
   * changes where the reader meets it. Within a column the model's order still
   * rules: appendChild is a detach, so the whole sequence goes back in one
   * pass rather than half-moving. */
  function orderColumn(col, resume) {
    if (!col) return false;
    var rank = modelRank(resume);
    var there = U.qsa(':scope > .rb-section', col);
    if (!there.length) return true;
    var should = there.slice().sort(function (a, b) {
      var ra = rank[a.getAttribute('data-section-id')];
      var rb = rank[b.getAttribute('data-section-id')];
      return (ra == null ? Infinity : ra) - (rb == null ? Infinity : rb);
    });
    if (there.every(function (node, i) { return node === should[i]; })) return true;
    should.forEach(function (node) { col.appendChild(node); });
    return true;
  }

  /* Hand a sparse column's sections to the fuller one and hand the page back
   * its single-column measure. Nothing is written to the model: which column
   * a section sits in was already a rendering decision, and it is re-decided
   * from the same measurement on every render, so adding the skills that make
   * the rail worth having puts the rail back.
   *
   * This has to run before the first measurement, so every page break after it
   * is taken on the layout the reader is actually looking at. */
  function drainSparseColumn(sheet, cls, resume) {
    var other = cls === 'rb-doc__side' ? 'rb-doc__main' : 'rb-doc__side';
    var from = columnOf(sheet, cls);
    var to = columnOf(sheet, other);
    if (!from || !to) return false;
    var moving = U.qsa(':scope > .rb-section', from);
    if (!moving.length) return false;
    moving.forEach(function (node) { to.appendChild(node); });
    orderColumn(to, resume);
    orderColumn(from, resume);
    if (docEl) {
      docEl.setAttribute('data-cols', '1');
      docEl.setAttribute('data-columns', '1');
    }
    return true;
  }

  /* A contact item that opens a line has nothing to be separated from, so its
   * separator goes. Without this the fix for a trailing middot would just
   * move the middot to the head of the next line. */
  function markContactLines() {
    U.qsa('.rb-doc__contact', docEl).forEach(function (list) {
      var items = list.children;
      var prevTop = null;
      for (var i = 0; i < items.length; i++) {
        var top = items[i].getBoundingClientRect().top;
        var sep = items[i].querySelector('.rb-doc__sep');
        if (sep) {
          if (prevTop === null || top - prevTop <= LINE_EPS) sep.removeAttribute('data-lead');
          else sep.setAttribute('data-lead', 'true');
        }
        prevTop = top;
      }
    });
  }

  /* On screen a sheet is a preview, and a preview of a three-bullet resume
   * drawn at eleven inches is a wall of white the user never asked for. So the
   * paper is drawn down to what is on it — the content plus the margin it sits
   * inside plus a little air, floored at three inches so a two-line resume
   * still reads as a page rather than a card. A page that is already full
   * keeps the page height: the number is not clamped down to it, the property
   * is dropped and the page takes the sheet's own minimum back.
   *
   * This is a preview and nothing else. Pagination already measured against
   * --rb-doc-page-h, not against the sheet's box, so a fitted sheet changes no
   * page break; paper takes its height from @page and templates.css hands the
   * minimum back under @media print, so the print job is still a true page. */
  /* A sheet is a page. It is never shorter than a page, at any width.
   *
   * Shrinking it to its content was wrong twice over: on a sparse desktop
   * resume it made the editor show a card, and on a phone — where the sheet
   * reflows to the pane and loses its 11in minimum — it left a small white
   * block floating in a tall dark stage. So the floor is the page's own
   * proportions at whatever width the sheet is actually rendered. */
  function fitSheets(sheets, pageHeight) {
    /* Read the page geometry from the computed style, never from the element:
     * a throw here is swallowed by the caller, and a sheet that silently loses
     * its floor is exactly the bug this function exists to prevent. */
    function pageDim(sheet, prop) {
      try {
        var probe = global.getComputedStyle(sheet);
        if (!probe || typeof probe.getPropertyValue !== 'function') return 0;
        var raw = probe.getPropertyValue(prop) || '';
        var n = parseFloat(raw);
        /* A value in inches parses to 8.5, not 816; the ratio is all that is
         * needed, so scale both sides the same way and the ratio holds. */
        return isFinite(n) && n > 0 ? n : 0;
      } catch (e) { return 0; }
    }

    var pageW = 0, pageH = 0;
    for (var i = 0; i < sheets.length; i++) {
      pageW = pageDim(sheets[i], '--rb-doc-page-w');
      pageH = pageDim(sheets[i], '--rb-doc-page-h');
      if (pageW && pageH) break;
    }
    if (!pageW || !pageH) { for (var j = 0; j < sheets.length; j++) sheets[j].style.removeProperty(SHEET_FIT_PROP); return; }

    var ratio = pageH / pageW;

    sheets.forEach(function (sheet) {
      var cs = global.getComputedStyle(sheet);
      var shownW = sheet.getBoundingClientRect().width || pageW;
      var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      /* At full page width the floor is the page. Below it, the same
       * proportions at the rendered width, so the shape is preserved. */
      var floor = Math.max(pageHeight > 0 && shownW >= pageW - 1 ? pageHeight : 0,
                          Math.round(shownW * ratio)) + pad;
      if (floor > 0) sheet.style.setProperty(SHEET_FIT_PROP, Math.round(floor) + 'px');
    });
  }

  function paginate() {
    var pager = RB.paginator;
    if (!docEl || !docEl.isConnected || !pager || typeof pager.measure !== 'function') return;

    /* Page height is a property of the document, not of the preview, and
     * `zoom` scales every measured box. Measuring at 100% and letting the
     * frame scale the result is the only way the two agree. */
    var frame = U.qs('#rb-page-frame');
    var zoom = frame ? frame.style.getPropertyValue('--rb-doc-zoom') : '';
    if (frame) frame.style.setProperty('--rb-doc-zoom', '1');

    try {
      var flat = docEl.firstElementChild;
      /* Before anything is measured. A rail too thin to read beside a full
       * main column gives its sections back, and every break below is then
       * taken on the single column the reader is going to see. */
      if (docEl.getAttribute('data-cols') === '2' && flat) {
        var resume = store && typeof store.get === 'function' ? store.get() : null;
        var cls = resume ? sparseColumn(flat) : null;
        if (cls) drainSparseColumn(flat, cls, resume);
      }

      var result = pager.measure(docEl);
      if (result && result.valid) {
        var sites = null;
        if (docEl.getAttribute('data-cols') === '2' && flat) sites = measureColumns(pager, flat);
        if (!sites) {
          sites = [];
          (result.breaks || []).forEach(function (brk) {
            var site = breakSite(brk.el);
            if (site && site.block) sites.push(site);
          });
        }
        splitSheets(sites);
        var sheets = sheetList();
        if (!narrowViewport()) {
          packSheets(sheets, result.contentHeight);
          fitSheets(sheets, result.pageHeight);
        }
        numberSheets(sheets);
      } else if (sheetList().length) {
        numberSheets(sheetList());
      }
    } catch (err) {
      /* The flat flow is already on screen, so a layout failure costs the page
       * break, never the document. */
      if (global.console && global.console.error) console.error('[renderer] pagination failed', err);
    } finally {
      markContactLines();
      if (frame) {
        if (zoom) frame.style.setProperty('--rb-doc-zoom', zoom);
        else frame.style.removeProperty('--rb-doc-zoom');
      }
    }
  }

  /* ---------- repaint: a design change without a rebuild ----------
   *
   * A template or design write changes no content, so the nodes already on the
   * page are still the right nodes. Rebuilding them throws away the caret, the
   * selection and focus inside a field, and forces the binder to re-attach to
   * every binding — a cost paid for a change that moved no data.
   *
   * The only structural thing a design can move is which column a section sits
   * in, so a repaint is: put the sheets back into one flat flow, re-home the
   * sections, repaint the design, paginate again. The field nodes are the same
   * objects throughout.
   */

  /* The section a continuation was split out of. A document can hold more than
   * one section with the same id, and a continuation can come *before* the
   * original in document order once a page break has moved it, so every match
   * is checked rather than the first one. */
  function originalSection(cont) {
    var id = cont.getAttribute('data-section-id');
    if (!id) return null;
    var found = null;
    U.qsa('.rb-section[data-section-id="' + id + '"]', docEl).forEach(function (node) {
      if (!found && node.getAttribute('data-rb-continued') !== 'true') found = node;
    });
    return found;
  }

  /* A continuation exists to carry the tail of a section onto the next page.
   * When that page turns out not to be needed, the split has to be undone as
   * well as the break: leaving the continuation in place repeats its heading on
   * the same page, and the resume then says EXPERIENCE twice. The entries it
   * carries were the trailing ones, so they go back at the end of the section.
   * Its repeated heading does not come with them — the section already has one. */
  function rejoinContinuation(cont) {
    var host = originalSection(cont);
    if (host) {
      var content = sectionContent(host);
      sectionEntries(cont).forEach(function (node) { content.appendChild(node); });
    }
    if (cont.parentNode) cont.parentNode.removeChild(cont);
    return !!host;
  }

  /* Undo what pagination did to the flow: every block back into the first
   * sheet's column it belongs to, and every continuation re-joined into the
   * section it was split out of. Returns false when the document is not in the
   * shape this expects, so the caller can fall back to a full render. */
  function flattenSheets() {
    var sheets = sheetList();
    if (!sheets.length) return false;
    var first = sheets[0];
    if (!first.classList.contains(SHEET_CLASS)) return false;
    var side = columnOf(first, 'rb-doc__side');
    var main = columnOf(first, 'rb-doc__main');
    if (!side || !main) return false;

    /* Continuations first, wherever pagination left them — not only on the
     * later sheets, because pullBack moves a continuation back onto the first
     * sheet when the break turns out to be early. Document order, so a section
     * split three ways is re-joined in the order it was split. */
    U.qsa('.rb-section[data-rb-continued="true"]', docEl).forEach(rejoinContinuation);

    for (var s = 1; s < sheets.length; s++) {
      var blocks = sheetBlocks(sheets[s]);
      for (var i = 0; i < blocks.length; i++) {
        (columnClassOf(blocks[i]) === 'rb-doc__side' ? side : main).appendChild(blocks[i]);
      }
    }
    for (var k = sheets.length - 1; k >= 1; k--) {
      if (sheets[k].parentNode) sheets[k].parentNode.removeChild(sheets[k]);
    }
    return true;
  }

  /* Put every section in the column its design calls for, in the order the
   * model holds them. Nothing is touched when the page already reads that way,
   * so a template swap that only changes paint never detaches a node and never
   * costs the caret. When it does not read that way — a section changing
   * column, or a page break that left the order wrong — the whole sequence is
   * re-appended, because appendChild is a detach and a half-move would leave
   * the page in a worse state than doing nothing. */
  function rehomeColumns(resume) {
    var first = sheetList()[0];
    if (!first) return false;
    var side = columnOf(first, 'rb-doc__side');
    var main = columnOf(first, 'rb-doc__main');
    if (!side || !main) return false;

    var byId = {};
    U.qsa('.rb-section', docEl).forEach(function (node) {
      if (node.getAttribute('data-rb-continued') === 'true') return;
      var id = node.getAttribute('data-section-id');
      if (id && !byId[id]) byId[id] = node;
    });
    var inSidebar = {};
    (sidebarTypes(resume.design) || []).forEach(function (t) { inSidebar[t] = true; });

    var order = model.orderedSections(resume);
    var want = { 'rb-doc__side': [], 'rb-doc__main': [] };
    order.forEach(function (sec) {
      var node = sec && byId[sec.id];
      if (!node) return;
      var key = (inSidebar[sec.type] && sec.visible !== false) ? 'rb-doc__side' : 'rb-doc__main';
      want[key].push(node);
    });
    if (!want['rb-doc__side'].length && !want['rb-doc__main'].length) return true;

    /* Compared per column: the two columns are read side by side, so a
     * one-column document and a two-column one never share an order and a
     * global comparison would report a change on every repaint. */
    var settled = COLUMNS.every(function (cls) {
      var col = columnOf(first, cls);
      if (!col) return false;
      var there = [];
      for (var i = 0; i < col.children.length; i++) {
        if (col.children[i].classList.contains('rb-section')) there.push(col.children[i]);
      }
      var should = want[cls] || [];
      if (there.length !== should.length) return false;
      for (var k = 0; k < there.length; k++) if (there[k] !== should[k]) return false;
      return true;
    });
    if (settled) return true;

    COLUMNS.forEach(function (cls) {
      var col = columnOf(first, cls);
      (want[cls] || []).forEach(function (node) { if (col) col.appendChild(node); });
    });
    return true;
  }

  function repaint(resume) {
    if (destroyed || !ensureDoc() || !resume) return false;
    if (!flattenSheets()) return renderNow();
    try {
      applyDesign(docEl, resume.design);
      if (!rehomeColumns(resume)) return false;
      paginate();
    } catch (err) {
      if (global.console) console.error('[renderer] failed to repaint the resume', err);
      return renderNow();
    }
    if (RB.lifecycle && typeof RB.lifecycle.emit === 'function') {
      RB.lifecycle.emit('render', { doc: docEl, resume: resume, repainted: true });
    }
    return true;
  }

  /* ---------- design tokens ---------- */

  function pt(n) {
    var v = Math.round(Number(n) * 100) / 100;
    return (Number.isFinite(v) ? v : 0) + 'pt';
  }

  /* RB.templates owns the token bridge (it knows the font optical scaling and
   * the template presets). These are the values it would write, kept as a
   * fallback for the export and preview paths that render without it. */
  function designVars(design) {
    if (RB.templates && typeof RB.templates.docVars === 'function') {
      return Object.assign({}, RB.templates.docVars(design || {}));
    }
    var d = Object.assign({}, model.DEFAULT_DESIGN || {}, design || {});
    var vars = {
      '--rb-doc-font': FONT_STACKS[d.fontFamily] || FONT_STACKS.system,
      '--rb-doc-size': pt(d.baseSizePt),
      '--rb-doc-leading': String(d.lineHeight),
      '--rb-doc-section-gap': pt(d.sectionGapPt),
      '--rb-doc-entry-gap': pt(d.entryGapPt),
      '--rb-doc-margin': (Math.round(Number(d.marginsIn) * 100) / 100) + 'in',
      '--rb-doc-tracking': (Math.round(Number(d.letterSpacing) * 100) / 100) + 'em',
      '--rb-doc-rule': pt(d.ruleWeight),
      '--rb-doc-bullet': BULLET_GLYPHS[d.bulletGlyph] || BULLET_GLYPHS.disc,
      '--rb-doc-columns': String(d.columns === 2 ? 2 : 1)
    };
    /* accent is the one variable the user owns, so it is validated rather than
     * trusted before it reaches the stylesheet. */
    if (U.isValidHexColor && U.isValidHexColor(d.accent)) vars['--rb-doc-accent'] = d.accent;
    return vars;
  }

  /* Changing a template must never rebuild the document: only these attributes
   * and the custom properties on #rb-doc change. */
  function applyDesign(el, design) {
    var d = Object.assign({}, model.DEFAULT_DESIGN || {}, design || {});

    if (RB.templates && typeof RB.templates.paint === 'function') RB.templates.paint(d);
    else {
      var vars = designVars(d);
      Object.keys(vars).forEach(function (k) { el.style.setProperty(k, vars[k]); });
    }
    if (!el.getAttribute('data-template')) {
      el.setAttribute('data-template', U.slugify ? U.slugify(d.templateId || 'classic') : 'classic');
    }

    el.setAttribute('data-heading', ['uppercase', 'title', 'rule'].indexOf(d.headingStyle) === -1 ? 'uppercase' : d.headingStyle);
    el.setAttribute('data-cols', d.columns === 2 ? '2' : '1');
    el.setAttribute('data-columns', d.columns === 2 ? '2' : '1');
    el.setAttribute('data-bullet', BULLET_GLYPHS[d.bulletGlyph] ? d.bulletGlyph : 'disc');
    el.setAttribute('data-page-size', d.pageSize === 'A4' ? 'A4' : 'Letter');
    el.setAttribute('data-print-safe', d.printSafe ? 'true' : null);
    el.setAttribute('data-photo', d.photoSlot ? 'on' : 'off');
    el.setAttribute('data-layout', sidebarTypes(d) ? 'sidebar' : 'flow');
  }

  /* ---------- render cycle ---------- */

  function ensureDoc(target) {
    if (target) {
      docEl = target;
    } else if (!docEl || !docEl.isConnected) {
      docEl = U.qs('#rb-doc');
    }
    return !!docEl;
  }

  function captureCaret() {
    if (!docEl || !doc.activeElement) return null;
    var active = doc.activeElement;
    if (active === docEl || !docEl.contains(active) || !active.getAttribute) return null;
    var bind = active.getAttribute('data-bind');
    if (!bind) return null;
    var offset = null;
    var sel = global.getSelection ? global.getSelection() : null;
    if (sel && sel.rangeCount && active.contains(sel.anchorNode)) {
      var range = sel.getRangeAt(0).cloneRange();
      range.selectNodeContents(active);
      try {
        range.setEnd(sel.anchorNode, sel.anchorNodeOffset);
        offset = range.toString().length;
      } catch (e) { offset = null; }
    }
    return { bind: bind, offset: offset };
  }

  function restoreCaret(snap) {
    if (!snap || !docEl) return;
    var target = docEl.querySelector('[data-bind="' + snap.bind + '"]');
    if (!target) return;
    var offset = snap.offset;
    var len = target.textContent ? target.textContent.length : 0;
    if (offset == null || offset > len) offset = len;
    try {
      target.focus({ preventScroll: true });
      var sel = global.getSelection ? global.getSelection() : null;
      if (!sel) return;
      var range = doc.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      if (offset > 0) {
        var walker = doc.createTreeWalker(target, global.NodeFilter.SHOW_TEXT, null, false);
        var remaining = offset, node;
        while ((node = walker.nextNode())) {
          if (remaining <= node.nodeValue.length) {
            range.setStart(node, remaining);
            range.collapse(true);
            break;
          }
          remaining -= node.nodeValue.length;
        }
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* focus restoration is best-effort */ }
  }

  function renderNow() {
    if (destroyed || !ensureDoc()) return false;
    var resume = store && typeof store.get === 'function' ? store.get() : null;
    if (!resume) return false;

    var caret = captureCaret();
    try {
      applyDesign(docEl, resume.design);
      var next = wrapSheet(buildDocument(resume));
      if (docEl.replaceChildren) docEl.replaceChildren(next);
      else { docEl.textContent = ''; docEl.appendChild(next); }
      paginate();
    } catch (err) {
      if (global.console) console.error('[renderer] failed to render the resume', err);
      var note = U.el('p', { class: 'rb-doc__error', role: 'alert', text: 'This resume could not be displayed. Your data is still saved — undo or reload the page to try again.' });
      if (docEl.replaceChildren) docEl.replaceChildren(note);
      else { docEl.textContent = ''; docEl.appendChild(note); }
      return false;
    }
    restoreCaret(caret);
    if (RB.lifecycle && typeof RB.lifecycle.emit === 'function') {
      RB.lifecycle.emit('render', { doc: docEl, resume: resume });
    }
    return true;
  }

  /* A rebuild destroys the element the caret is sitting in, so while a bound
   * field has focus the render waits for the blur. Everything else the user
   * does — adding an entry, undoing a change — is not typing, so it renders
   * straight away. */
  function render() {
    if (destroyed || !ensureDoc()) return false;
    if (editing) { dirty = true; return false; }
    return renderNow();
  }

  function flush() {
    dirty = false;
    return renderNow();
  }

  function schedule() {
    if (destroyed || scheduled) return;
    dirty = true;
    scheduled = true;
    U.requestIdle(function () {
      scheduled = false;
      if (dirty) render();
    }, 120);
  }

  var pendingFieldRender = false;

  function isFieldFocused() {
    var a = document.activeElement;
    return !!(a && a.isContentEditable && a.getAttribute('data-bind'));
  }

  /* Called by the binder when a field loses focus. */
  function releaseField() {
    if (!pendingFieldRender || destroyed) return;
    pendingFieldRender = false;
    schedule();
  }

  function onChange(payload) {
    if (destroyed) return;
    ensureDoc();
    var source = (payload && payload.source) || 'update';
    if (source === 'field') {
      /* A field write came from someone typing into a bound node. Re-rendering
       * replaces that node, and a caret in a node that no longer exists
       * interleaves the rest of the word into the text — "gmail.comtkar…".
       * So while a bound field has the focus, nothing is re-rendered; the
       * model is already correct and the page is already showing it. The
       * deferred render happens once, on blur. */
      if (isFieldFocused()) { pendingFieldRender = true; return; }
      schedule();
      return;
    }
    /* A design or template write touches `draft.design` and nothing else, so
     * the content on the page is already correct and only needs repainting. */
    if (source === 'design' || source === 'template') {
      repaint(store && typeof store.get === 'function' ? store.get() : null);
      return;
    }
    flush();
  }

  function isBound(node) {
    return !!(node && node.getAttribute && node.getAttribute('data-bind'));
  }

  /* The sheet is as wide as its pane, so resizing the window rewraps the text
   * and moves every page break. Re-laying out is the only way the sheets stay
   * honest; it is debounced here and idle-scheduled like any other render. */
  function onResize() {
    if (destroyed) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      schedule();
    }, RESIZE_MS);
  }

  function onFocusIn(ev) {
    if (isBound(ev.target)) editing = true;
  }

  function onFocusOut(ev) {
    var next = ev.relatedTarget;
    if (isBound(next) && docEl && docEl.contains(next)) return;
    editing = false;
    if (dirty) schedule();
  }

  /* ---------- public API ---------- */

  function unlisten() {
    disposers.forEach(function (off) {
      try { off(); } catch (e) { /* a detached node throws nothing useful */ }
    });
    disposers = [];
  }

  /* Idempotent: calling mount() again re-points the listeners at the new
   * container instead of stacking a second set on the old one. */
  function mount(target) {
    unlisten();
    destroyed = false;
    editing = false;
    dirty = false;
    if (!ensureDoc(target)) return false;
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    disposers.push(U.on(docEl, 'focusin', null, onFocusIn));
    disposers.push(U.on(docEl, 'focusout', null, onFocusOut));
    disposers.push(U.on(global, 'resize', null, onResize));
    if (bus) disposers.push(bus.on('change', onChange));
    if (store && typeof store.whenReady === 'function') {
      store.whenReady().then(function () { renderNow(); }, function () {});
    }
    return renderNow();
  }

  function destroy() {
    unlisten();
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    docEl = null;
    editing = false;
    dirty = false;
    scheduled = false;
    destroyed = true;
  }

  RB.renderer = {
    mount: mount,
    releaseField: releaseField,
    render: render,
    renderNow: renderNow,
    flush: flush,
    schedule: schedule,
    destroy: destroy,
    doc: function () { return docEl; },
    designVars: designVars,
    /* Exposed for the export and preview paths, which need the same values
     * without touching a live element. */
    buildDocument: function (resume) { return resume ? buildDocument(resume) : null; }
  };

  if (doc && doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { mount(); }, { once: true });
  } else {
    mount();
  }
})(window);
