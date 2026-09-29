/* Resumeboard — import diff and merge
 *
 * An import that lands on a resume someone has already worked on is the one
 * place in this app where real work can be lost without a warning, so this
 * file exists to make that outcome a choice instead of a surprise.
 *
 * Pure functions only: they take two resume objects and return a third plus a
 * list of rows describing what differs. Nothing here touches the DOM, the
 * store, or storage — the caller decides what to do with the result, and the
 * store stays the single write path.
 *
 *   RB.merge.preview(current, incoming, mode)
 *       -> { mode, next, rows, counts }
 *   RB.merge.apply(current, incoming, mode) -> next resume
 *   RB.merge.needsStep(current)             -> bool
 *
 * A row is { kind, section, sectionLabel, entry, field, before, after } where
 * kind is 'added' | 'changed' | 'removed' | 'kept'.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var M = RB.model;
  if (!U || !M) return;

  var MODES = {
    keep: {
      id: 'keep',
      label: 'Keep what I have',
      blurb: 'Adds whatever the import has that this resume does not. Nothing you have written is overwritten.'
    },
    favour: {
      id: 'favour',
      label: 'Let the import win',
      blurb: 'Same entries, matched by name. Where both have a value for the same field, the import\'s is used.'
    },
    replace: {
      id: 'replace',
      label: 'Replace the whole resume',
      blurb: 'Discards everything on the page now and uses the import as the resume. One undo brings it all back.'
    }
  };

  var MODE_ORDER = ['keep', 'favour', 'replace'];

  /* Every list section, in the order the model declares them, so the diff reads
   * top to bottom the way the page does. */
  var ENTRY_SECTIONS = (M.SECTION_TYPES || []).filter(function (s) { return s.hasMany; })
    .map(function (s) { return s.type; });

  /* name: the field that identifies an entry well enough to match it.
   * fields: scalars compared and merged one by one.
   * lists:  arrays of free text, merged as a set.
   * roles:  nested sub-entries that need matching too. */
  var SPEC = {
    experience: {
      name: 'company', alt: 'companyEntity',
      fields: [
        { key: 'company', label: 'Company' },
        { key: 'companyEntity', label: 'Legal name' },
        { key: 'location', label: 'Location' },
        { key: 'url', label: 'Company site' }
      ],
      roles: [
        { key: 'position', label: 'Position' },
        { key: 'start', label: 'Start' },
        { key: 'end', label: 'End' },
        { key: 'summary', label: 'Role summary' }
      ],
      roleLists: [{ key: 'highlights', label: 'Highlights' }, { key: 'skills', label: 'Role skills' }]
    },
    education: {
      name: 'institution',
      fields: [
        { key: 'institution', label: 'Institution' },
        { key: 'studyType', label: 'Degree' },
        { key: 'area', label: 'Field of study' },
        { key: 'score', label: 'Grade' },
        { key: 'url', label: 'Link' },
        { key: 'start', label: 'Start' },
        { key: 'end', label: 'End' }
      ],
      lists: [{ key: 'courses', label: 'Courses' }]
    },
    skills: {
      name: 'label',
      fields: [{ key: 'label', label: 'Group' }, { key: 'level', label: 'Level' }],
      lists: [{ key: 'keywords', label: 'Skills' }]
    },
    projects: {
      name: 'name',
      fields: [
        { key: 'name', label: 'Name' }, { key: 'url', label: 'Link' },
        { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
        { key: 'summary', label: 'Summary' }
      ],
      lists: [{ key: 'highlights', label: 'Highlights' }, { key: 'keywords', label: 'Keywords' }]
    },
    certifications: {
      name: 'name',
      fields: [
        { key: 'name', label: 'Name' }, { key: 'issuer', label: 'Issuer' },
        { key: 'date', label: 'Date' }, { key: 'credentialId', label: 'Credential ID' },
        { key: 'url', label: 'Link' }
      ]
    },
    publications: {
      name: 'title',
      fields: [
        { key: 'title', label: 'Title' }, { key: 'authors', label: 'Authors' },
        { key: 'venue', label: 'Venue' }, { key: 'date', label: 'Date' },
        { key: 'doi', label: 'DOI' }, { key: 'url', label: 'Link' }
      ]
    },
    awards: {
      name: 'title',
      fields: [
        { key: 'title', label: 'Title' }, { key: 'awarder', label: 'Awarder' },
        { key: 'date', label: 'Date' }
      ]
    },
    volunteer: {
      name: 'organization', alt: 'role',
      fields: [
        { key: 'role', label: 'Role' }, { key: 'organization', label: 'Organization' },
        { key: 'location', label: 'Location' }, { key: 'start', label: 'Start' },
        { key: 'end', label: 'End' }
      ],
      lists: [{ key: 'highlights', label: 'Highlights' }]
    },
    languages: { name: 'language', fields: [{ key: 'language', label: 'Language' }, { key: 'fluency', label: 'Fluency' }] },
    interests: { name: 'label', fields: [{ key: 'label', label: 'Interest' }] },
    references: { name: 'name', fields: [{ key: 'name', label: 'Name' }, { key: 'label', label: 'Relationship' }, { key: 'contact', label: 'Contact' }] },
    coursework: {
      name: 'name',
      fields: [{ key: 'name', label: 'Course' }, { key: 'institution', label: 'Institution' }, { key: 'date', label: 'Date' }, { key: 'url', label: 'Link' }]
    },
    presentations: {
      name: 'title',
      fields: [
        { key: 'title', label: 'Title' }, { key: 'event', label: 'Event' },
        { key: 'date', label: 'Date' }, { key: 'location', label: 'Location' },
        { key: 'url', label: 'Link' }
      ],
      lists: [{ key: 'highlights', label: 'Highlights' }]
    },
    custom: {
      name: 'label',
      fields: [{ key: 'label', label: 'Section title' }],
      /* A custom section owns a second list of its own. It is matched inside
       * the section by title and organisation. */
      inner: {
        name: 'title', alt: 'org',
        fields: [
          { key: 'title', label: 'Title' }, { key: 'org', label: 'Organisation' },
          { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
          { key: 'text', label: 'Text' }
        ]
      }
    }
  };

  var BASICS_FIELDS = [
    { key: 'name', label: 'Name' },
    { key: 'label', label: 'Headline' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'url', label: 'Website' },
    { key: 'summary', label: 'Summary' }
  ];
  var LOCATION_FIELDS = [
    { key: 'city', label: 'City' },
    { key: 'region', label: 'Region' },
    { key: 'countryCode', label: 'Country' }
  ];

  /* ------------------------------------------------------------------ *
   * Value helpers
   * ------------------------------------------------------------------ */

  function txt(v) { return v == null ? '' : String(v); }

  function isBlank(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.every(isBlank);
    if (typeof v === 'object') return Object.keys(v).every(function (k) { return isBlank(v[k]); });
    if (typeof v === 'boolean') return v === false;
    return txt(v).trim() === '';
  }

  /* A readable one-line rendering of any field, for the diff. */
  function display(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.filter(function (x) { return !isBlank(x); }).map(txt).join(' · ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'object') {
      if (v.city || v.region || v.countryCode) return [v.city, v.region, v.countryCode].filter(Boolean).join(', ');
      return '';
    }
    return txt(v).replace(/\s+/g, ' ').trim();
  }

  /* "Acme, Inc." and "ACME" are the same employer as far as a reader is
   * concerned. Legal suffixes and articles go; everything else stays, so
   * "Kestrel Financial" and "Kestrel Labs" stay apart. */
  var LEGAL = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|gmbh|plc|sa|sas|ag|bv|nv|ab|oy|pte|pvt|pty|kk|kg|srl|spa|sl|holdings|group)\b/g;

  function foldKey(s) {
    var t = txt(s).toLowerCase();
    if (t.normalize) { try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep the raw form */ } }
    t = t.replace(/&/g, ' and ');
    t = t.replace(/[^a-z0-9]+/g, ' ').trim();
    t = t.replace(LEGAL, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    if (/^the /.test(t)) t = t.slice(4);
    return t;
  }

  function entryName(type, e) {
    var spec = SPEC[type];
    var raw = spec && spec.name ? txt(e && e[spec.name]) : '';
    if (!raw && spec && spec.alt) raw = txt(e && e[spec.alt]);
    return display(raw) || (M.typeMeta(type).label + ' entry');
  }

  /* Ids are the one thing a merge can genuinely break: the incoming resume was
   * written by a different session and its entry ids can collide with the ones
   * already in the store. Re-mint them on everything the merge adds. */
  function reid(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { node.forEach(reid); return node; }
    Object.keys(node).forEach(function (k) {
      if (k === 'id' && typeof node[k] === 'string') node[k] = U.uid('mrg');
      else reid(node[k]);
    });
    return node;
  }

  function pushSection(resume, type) {
    var sections = Array.isArray(resume.sections) ? resume.sections : [];
    if (sections.some(function (s) { return s && s.type === type; })) return;
    var max = sections.reduce(function (m, s) { return Math.max(m, (s && s.order) || 0); }, 0);
    sections.push(M.blankSection(type, max + 1));
    resume.sections = sections;
  }

  /* ------------------------------------------------------------------ *
   * Merge
   * ------------------------------------------------------------------ */

  /* The folded name, prefixed by the type so two sections can hold the same
   * name without matching each other. Null when the entry has no name to
   * match on, which makes it always-new. */
  function keyFor(type, entry) {
    var spec = SPEC[type];
    if (!spec) return null;
    var raw = spec.name ? txt(entry && entry[spec.name]) : '';
    if (!raw && spec.alt) raw = txt(entry && entry[spec.alt]);
    var folded = foldKey(raw);
    return folded ? type + '::' + folded : null;
  }

  /* One scalar field. `overwrite` is the difference between the two merge
   * modes: keep only fills a blank, favour takes a non-blank incoming value. */
  function mergeScalar(target, incoming, spec, overwrite) {
    var from = incoming[spec.key];
    if (isBlank(from)) return;
    if (typeof from === 'boolean') {
      /* `current: true` is a fact worth taking; `current: false` would clear a
       * flag the current resume set for itself. */
      if (from === true) target[spec.key] = true;
      return;
    }
    if (typeof target[spec.key] === 'boolean' || typeof from === 'number') {
      target[spec.key] = from;
      return;
    }
    if (overwrite || isBlank(target[spec.key])) target[spec.key] = from;
  }

  function mergeList(target, incoming, spec) {
    var from = Array.isArray(incoming[spec.key]) ? incoming[spec.key] : [];
    if (!from.length) return;
    if (!Array.isArray(target[spec.key])) target[spec.key] = [];
    var have = target[spec.key];
    from.forEach(function (item) {
      if (isBlank(item)) return;
      var text = txt(item).replace(/\s+/g, ' ').trim();
      var already = have.some(function (x) { return foldKey(txt(x)) === foldKey(text); });
      if (already) return;
      /* Both modes append rather than reorder: a list the user wrote is a
       * record of their own ordering, and reordering it to match a parser's
       * output would show up as a change with nothing gained. `overwrite`
       * governs scalars only. */
      have.push(text);
    });
  }

  function mergeEntry(target, incoming, type, mode) {
    var spec = SPEC[type];
    var overwrite = mode === 'favour';
    if (!spec) return;
    spec.fields.forEach(function (f) { mergeScalar(target, incoming, f, overwrite); });
    (spec.lists || []).forEach(function (f) { mergeList(target, incoming, f); });
    (spec.roleLists || []).forEach(function (f) { mergeList(target, incoming, f); });
    if (spec.roles) mergeRoles(target, incoming, mode);
    if (spec.inner) mergeCustomEntries(target, incoming, mode);
  }

  function mergeRoles(target, incoming, mode) {
    var spec = SPEC.experience;
    var from = Array.isArray(incoming.roles) ? incoming.roles : [];
    if (!from.length) return;
    if (!Array.isArray(target.roles) || !target.roles.length) {
      target.roles = reid(from.map(function (r) { return M.deepClone(r); }));
      return;
    }
    var overwrite = mode === 'favour';
    from.forEach(function (role) {
      if (!role || typeof role !== 'object') return;
      var key = foldKey(role.position) || foldKey(role.start);
      var at = -1;
      target.roles.forEach(function (r, i) {
        if (at !== -1 || !r) return;
        var folded = foldKey(r.position) || foldKey(r.start);
        if (folded && key && folded === key) at = i;
      });
      if (at === -1) { target.roles.push(reid(M.deepClone(role))); return; }
      spec.roles.forEach(function (f) { mergeScalar(target.roles[at], role, f, overwrite); });
      (spec.roleLists || []).forEach(function (f) { mergeList(target.roles[at], role, f); });
    });
  }

  function mergeCustomEntries(target, incoming, mode) {
    var inner = SPEC.custom.inner;
    var from = Array.isArray(incoming.entries) ? incoming.entries : [];
    if (!from.length) return;
    if (!Array.isArray(target.entries)) target.entries = [];
    var overwrite = mode === 'favour';
    from.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var key = foldKey(item.title) || foldKey(item.org);
      var at = -1;
      target.entries.forEach(function (e, i) {
        if (at !== -1 || !e) return;
        var folded = foldKey(e.title) || foldKey(e.org);
        if (folded && key && folded === key) at = i;
      });
      if (at === -1) { target.entries.push(reid(M.deepClone(item))); return; }
      inner.fields.forEach(function (f) { mergeScalar(target.entries[at], item, f, overwrite); });
    });
  }

  function mergeBasics(target, incoming, mode) {
    var overwrite = mode === 'favour';
    BASICS_FIELDS.forEach(function (f) { mergeScalar(target, incoming, f, overwrite); });
    if (incoming.location && typeof incoming.location === 'object') {
      if (!target.location || typeof target.location !== 'object') target.location = { city: '', region: '', countryCode: '' };
      LOCATION_FIELDS.forEach(function (f) { mergeScalar(target.location, incoming.location, f, overwrite); });
    }
    var from = Array.isArray(incoming.profiles) ? incoming.profiles : [];
    if (!from.length) return;
    if (!Array.isArray(target.profiles)) target.profiles = [];
    from.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var at = -1;
      target.profiles.forEach(function (t, i) {
        if (at !== -1) return;
        if (t && p.network && t.network === p.network) at = i;
      });
      if (at === -1) { target.profiles.push(reid(M.deepClone(p))); return; }
      mergeScalar(target.profiles[at], p, { key: 'url', label: 'Link' }, overwrite);
      mergeScalar(target.profiles[at], p, { key: 'label', label: 'Label' }, overwrite);
    });
  }

  function merge(current, incoming, mode) {
    var next = M.deepClone(current) || M.emptyResume();
    if (mode === 'replace') {
      /* A replace keeps the incoming document but never the incoming design:
       * the font, margins and template the reader chose are settings, not
       * content, and silently reverting them reads as the app breaking. */
      var out = M.deepClone(incoming) || M.emptyResume();
      if (current && current.design) out.design = M.deepClone(current.design);
      if (current && current.meta) {
        out.meta = M.deepClone(out.meta || {});
        out.meta.createdAt = current.meta.createdAt || out.meta.createdAt;
      }
      return reid(out);
    }

    if (!Array.isArray(next.sections)) next.sections = [];
    mergeBasics(next.basics || (next.basics = {}), (incoming && incoming.basics) || {}, mode);

    ENTRY_SECTIONS.forEach(function (type) {
      var list = Array.isArray(next[type]) ? next[type] : [];
      next[type] = list;
      var from = Array.isArray(incoming && incoming[type]) ? incoming[type] : [];
      if (!from.length) return;
      pushSection(next, type);
      from.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return;
        if (M.isBlankEntry && M.isBlankEntry(entry)) return;
        var key = keyFor(type, entry);
        var at = -1;
        if (key) {
          list.forEach(function (e, i) {
            if (at !== -1) return;
            if (keyFor(type, e) === key) at = i;
          });
        }
        if (at === -1) { list.push(reid(M.deepClone(entry))); return; }
        mergeEntry(list[at], entry, type, mode);
      });
    });

    M.normalizeOrders(next);
    return next;
  }

  /* ------------------------------------------------------------------ *
   * Diff
   *
   * Both sides are flattened into a map keyed by type and folded name, so a
   * diff survives the index renumbering a replace does to the whole document.
   * ------------------------------------------------------------------ */

  function flatten(resume) {
    var map = Object.create(null);
    var order = [];

    function put(key, node) {
      if (map[key]) { key += '#' + order.length; }
      map[key] = node;
      order.push(key);
      return node;
    }

    var b = (resume && resume.basics) || {};
    var header = put('header', { section: 'header', sectionLabel: 'Header', name: display(b.name) || 'Header', fields: Object.create(null), order: -1 });
    BASICS_FIELDS.forEach(function (f) {
      header.fields[f.key] = { label: f.label, value: display(b[f.key]) };
    });
    var loc = b.location && typeof b.location === 'object' ? b.location : {};
    LOCATION_FIELDS.forEach(function (f) {
      var v = display(loc[f.key]);
      if (v) header.fields['location.' + f.key] = { label: f.label, value: v };
    });
    (Array.isArray(b.profiles) ? b.profiles : []).forEach(function (p, i) {
      var v = display(p && (p.url || p.label));
      if (v) header.fields['profiles.' + i] = { label: 'Link ' + (i + 1), value: v };
    });

    ENTRY_SECTIONS.forEach(function (type) {
      var list = Array.isArray(resume && resume[type]) ? resume[type] : [];
      list.forEach(function (entry, i) {
        if (!entry || typeof entry !== 'object') return;
        if (M.isBlankEntry && M.isBlankEntry(entry)) return;
        var base = keyFor(type, entry) || (type + '::#' + i);
        var node = put(base, {
          section: type,
          sectionLabel: M.typeMeta(type).label,
          name: entryName(type, entry),
          fields: Object.create(null),
          order: i,
          type: type
        });
        var spec = SPEC[type] || {};
        (spec.fields || []).forEach(function (f) {
          var v = display(entry[f.key]);
          if (v) node.fields[f.key] = { label: f.label, value: v };
        });
        (spec.lists || []).concat(spec.roleLists || []).forEach(function (f) {
          var v = display(entry[f.key]);
          if (v) node.fields[f.key] = { label: f.label, value: v };
        });
        if (spec.inner && Array.isArray(entry.entries)) {
          entry.entries.forEach(function (x, j) {
            if (!x || typeof x !== 'object') return;
            var v = display(x.text) || entryName('custom', x);
            if (v) node.fields['entries.' + j + '.text'] = { label: entryName('custom', x), value: v };
          });
        }
        if (spec.roles && Array.isArray(entry.roles)) {
          entry.roles.forEach(function (role, j) {
            if (!role || typeof role !== 'object') return;
            var who = display(role.position) || ('Role ' + (j + 1));
            SPEC.experience.roles.forEach(function (f) {
              var v = display(role[f.key]);
              if (v) node.fields['roles.' + j + '.' + f.key] = { label: who + ' · ' + f.label, value: v };
            });
            SPEC.experience.roleLists.forEach(function (f) {
              var v = display(role[f.key]);
              if (v) node.fields['roles.' + j + '.' + f.key] = { label: who + ' · ' + f.label, value: v };
            });
          });
        }
      });
    });

    return { map: map, order: order };
  }

  function classify(before, after) {
    if (before == null) return 'added';
    if (after == null) return 'removed';
    return before === after ? 'kept' : 'changed';
  }

  function diff(before, after) {
    var a = flatten(before);
    var b = flatten(after);
    var rows = [];
    var counts = { added: 0, changed: 0, removed: 0, kept: 0 };

    function pushRow(kind, sectionLabel, entry, field, beforeText, afterText) {
      rows.push({
        kind: kind, section: sectionLabel, entry: entry,
        field: field, before: beforeText, after: afterText
      });
      counts[kind] += 1;
    }

    /* Walk the union of both key sets: b's keys for anything added or
     * changed, then a's leftovers for anything the merge dropped. */
    b.order.forEach(function (key) {
      var nb = a.map[key];
      var na = b.map[key];
      if (!na) return;
      if (!nb) {
        Object.keys(na.fields).forEach(function (fk) {
          pushRow('added', na.sectionLabel, na.name, na.fields[fk].label, '', na.fields[fk].value);
        });
        if (!Object.keys(na.fields).length) pushRow('added', na.sectionLabel, na.name, 'Entry', '', '');
        return;
      }
      var fieldKeys = Object.create(null);
      Object.keys(nb.fields).forEach(function (k) { fieldKeys[k] = true; });
      Object.keys(na.fields).forEach(function (k) { fieldKeys[k] = true; });
      Object.keys(fieldKeys).forEach(function (fk) {
        var fb = nb.fields[fk];
        var fa = na.fields[fk];
        var beforeText = fb ? fb.value : '';
        var afterText = fa ? fa.value : '';
        var kind = classify(beforeText, afterText);
        /* Unchanged fields are counted, not listed: the list is what changes,
         * and "41 fields stay as they are" is the sentence that tells someone
         * their work is safe. */
        if (kind === 'kept') { counts.kept += 1; return; }
        pushRow(kind, na.sectionLabel, na.name, (fa || fb).label, beforeText, afterText);
      });
    });

    a.order.forEach(function (key) {
      if (b.map[key]) return;
      var nb = a.map[key];
      Object.keys(nb.fields).forEach(function (fk) {
        pushRow('removed', nb.sectionLabel, nb.name, nb.fields[fk].label, nb.fields[fk].value, '');
      });
      if (!Object.keys(nb.fields).length) pushRow('removed', nb.sectionLabel, nb.name, 'Entry', '', '');
    });

    /* Group by section, keeping the document's own order. */
    var rank = {};
    rank.header = -1;
    ENTRY_SECTIONS.forEach(function (t, i) { rank[t] = i; });
    rows.sort(function (x, y) {
      var rx = rank[x.section] == null ? 99 : rank[x.section];
      var ry = rank[y.section] == null ? 99 : rank[y.section];
      if (rx !== ry) return rx - ry;
      if (x.entry !== y.entry) return x.entry < y.entry ? -1 : 1;
      return 0;
    });

    return { rows: rows, counts: counts };
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  function needsStep(current) {
    try { return !!current && !M.isBlankResume(current); } catch (e) { return false; }
  }

  function preview(current, incoming, mode) {
    var id = MODES[mode] ? mode : 'keep';
    var next = merge(current, incoming, id);
    var result = diff(current, next);
    return {
      mode: id,
      next: next,
      rows: result.rows,
      counts: result.counts,
      changed: result.counts.added + result.counts.changed + result.counts.removed
    };
  }

  /* Three previews is three merges and three diffs over a document that is a
   * few hundred fields at most. Cheap enough to show the real number for each
   * option rather than a guess. */
  function previews(current, incoming) {
    var out = {};
    MODE_ORDER.forEach(function (mode) { out[mode] = preview(current, incoming, mode); });
    return out;
  }

  RB.merge = {
    MODES: MODES,
    MODE_ORDER: MODE_ORDER,
    preview: preview,
    previews: previews,
    apply: function (current, incoming, mode) { return merge(current, incoming, mode); },
    diff: diff,
    needsStep: needsStep,
    foldKey: foldKey
  };
})(window);
