/* Resumeboard — resume data model
 * The one source of truth. Pure functions only: they take a draft, return a
 * new draft. Nothing here touches the DOM, storage, or the network.
 *
 * NOTE ON DATES: start/end are free-text strings on purpose. Typed dates
 * force the user into one format and silently mangle "Summer 2019" or
 * "Present". Formatting happens at render time, never on write.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;

  var SECTION_TYPES = [
    { type: 'summary',     label: 'Summary',          defaultLabel: 'PROFESSIONAL SUMMARY', single: true,  icon: 'user' },
    { type: 'experience',  label: 'Experience',       defaultLabel: 'EXPERIENCE',            hasMany: true,  icon: 'briefcase' },
    { type: 'education',   label: 'Education',        defaultLabel: 'EDUCATION',             hasMany: true,  icon: 'cap' },
    { type: 'skills',      label: 'Skills',           defaultLabel: 'SKILLS',                hasMany: true,  icon: 'spark' },
    { type: 'projects',    label: 'Projects',         defaultLabel: 'PROJECTS',              hasMany: true,  icon: 'cube' },
    { type: 'certifications', label: 'Certifications', defaultLabel: 'CERTIFICATIONS',       hasMany: true,  icon: 'badge' },
    { type: 'publications',label: 'Publications',     defaultLabel: 'PUBLICATIONS',          hasMany: true,  icon: 'book' },
    { type: 'awards',      label: 'Awards',           defaultLabel: 'AWARDS & HONORS',       hasMany: true,  icon: 'trophy' },
    { type: 'volunteer',   label: 'Volunteering',     defaultLabel: 'VOLUNTEER EXPERIENCE',  hasMany: true,  icon: 'heart' },
    { type: 'languages',   label: 'Languages',        defaultLabel: 'LANGUAGES',             hasMany: true,  icon: 'globe' },
    { type: 'interests',   label: 'Interests',        defaultLabel: 'INTERESTS',             hasMany: true,  icon: 'star' },
    { type: 'references',  label: 'References',       defaultLabel: 'REFERENCES',            hasMany: true,  icon: 'quote' },
    { type: 'coursework',  label: 'Coursework',       defaultLabel: 'COURSEWORK',            hasMany: true,  icon: 'list' },
    { type: 'presentations', label: 'Presentations',  defaultLabel: 'PRESENTATIONS',         hasMany: true,  icon: 'mic' },
    { type: 'custom',      label: 'Custom section',   defaultLabel: 'CUSTOM',                hasMany: true,  icon: 'plus' }
  ];

  /* Null-prototype on purpose: an imported resume carries whatever section
   * type its author typed, and a plain {} answers 'constructor' or 'toString'
   * from the prototype chain — validate would then let the section through and
   * the renderer would call Object() as a builder. */
  var TYPE_BY_NAME = Object.create(null);
  SECTION_TYPES.forEach(function (s) { TYPE_BY_NAME[s.type] = s; });

  function meta(type) {
    return TYPE_BY_NAME[type] || { type: type, label: type, defaultLabel: type.toUpperCase(), hasMany: true, icon: 'plus' };
  }

  function blankSection(type, order) {
    var m = meta(type);
    return {
      id: U.uid('sec'),
      type: type,
      label: m.defaultLabel,
      visible: true,
      pinned: false,
      collapsed: false,
      columns: m.single ? 1 : 2,
      order: typeof order === 'number' ? order : 0
    };
  }

  var ENTRY_FACTORIES = {
    experience: function () {
      return {
        id: U.uid('exp'), company: '', companyEntity: '', location: '', url: '',
        roles: [{
          id: U.uid('role'), position: '', start: '', end: '', current: false,
          summary: '', highlights: [''], skills: [], visible: true
        }],
        visible: true
      };
    },
    education: function () {
      return {
        id: U.uid('edu'), institution: '', url: '', studyType: '', area: '', score: '',
        courses: [], start: '', end: '', visible: true
      };
    },
    skills: function () {
      return { id: U.uid('skl'), label: '', keywords: [''], level: null, visible: true };
    },
    projects: function () {
      return {
        id: U.uid('prj'), name: '', url: '', start: '', end: '', current: false,
        summary: '', highlights: [''], keywords: [], visible: true
      };
    },
    certifications: function () {
      return { id: U.uid('crt'), name: '', issuer: '', date: '', url: '', credentialId: '', visible: true };
    },
    publications: function () {
      return { id: U.uid('pub'), title: '', authors: '', venue: '', date: '', url: '', doi: '', visible: true };
    },
    awards: function () {
      return { id: U.uid('awd'), title: '', awarder: '', date: '', visible: true };
    },
    volunteer: function () {
      return { id: U.uid('vol'), role: '', organization: '', location: '', start: '', end: '', current: false, highlights: [''], visible: true };
    },
    languages: function () {
      return { id: U.uid('lng'), language: '', fluency: '' };
    },
    interests: function () {
      return { id: U.uid('int'), label: '' };
    },
    references: function () {
      return { id: U.uid('ref'), name: '', label: '', contact: '', visible: true };
    },
    coursework: function () {
      return { id: U.uid('crs'), name: '', institution: '', date: '', url: '' };
    },
    presentations: function () {
      return { id: U.uid('prs'), title: '', event: '', date: '', location: '', url: '', highlights: [''] };
    },
    custom: function () {
      return { id: U.uid('cus'), label: '', entries: [{ id: U.uid('ent'), title: '', org: '', start: '', end: '', text: '' }] };
    },
    summary: function () { return null; }
  };

  function blankEntry(type) {
    var f = ENTRY_FACTORIES[type];
    return f ? f() : { id: U.uid('ent'), title: '', visible: true };
  }

  var DEFAULT_DESIGN = {
    templateId: 'classic',
    fontFamily: 'system',
    baseSizePt: 11.5,
    lineHeight: 1.32,
    accent: '#1f2937',
    headingStyle: 'uppercase',
    ruleWeight: 1,
    sectionGapPt: 14,
    entryGapPt: 7,
    marginsIn: 0.6,
    columns: 1,
    photoSlot: false,
    bulletGlyph: 'disc',
    printSafe: false,
    pageSize: 'Letter',
    letterSpacing: 0
  };

  function emptyResume() {
    var now = new Date().toISOString();
    return {
      $schema: 'https://resumeboard.app/schema/resume.v1.json',
      schemaVersion: 1,
      id: U.uid('res'),
      meta: {
        createdAt: now,
        updatedAt: now,
        title: 'Untitled resume',
        templateId: 'classic',
        renderVersion: RENDER_VERSION,
        locale: U.LOCALE.lang,
        dateFormat: 'MMM YYYY',
        experienceLevel: 'mid',
        targetRole: '',
        targetCompany: ''
      },
      basics: {
        name: '', givenName: '', familyName: '', label: '',
        email: '', phone: '', url: '', location: { city: '', region: '', countryCode: U.LOCALE.region },
        summary: '', photo: null,
        profiles: [{ id: U.uid('prf'), network: 'linkedin', label: '', url: '' }]
      },
      sections: [
        Object.assign(blankSection('summary', 0), { id: 'sec_summary' }),
        Object.assign(blankSection('experience', 1), { id: 'sec_experience' }),
        Object.assign(blankSection('education', 2), { id: 'sec_education' }),
        Object.assign(blankSection('skills', 3), { id: 'sec_skills' })
      ],
      experience: [], education: [], skills: [], projects: [], certifications: [],
      publications: [], awards: [], volunteer: [], languages: [], interests: [],
      references: [], coursework: [], presentations: [], custom: [],
      design: Object.assign({}, DEFAULT_DESIGN),
      versions: { masterId: null, disabled: {} }
    };
  }

  var RENDER_VERSION = 3;

  /* A worked example. Deliberately imperfect-but-strong: metric-bearing bullets,
   * consistent date format, no pronouns. It is the fastest possible "aha". */
  function sampleResume() {
    var r = emptyResume();
    r.meta.title = 'Product Designer';
    r.meta.experienceLevel = 'senior';
    r.meta.targetRole = 'Senior Product Designer';
    Object.assign(r.basics, {
      name: 'Alex Rivera', givenName: 'Alex', familyName: 'Rivera',
      label: 'Senior Product Designer',
      email: 'alex.rivera@example.com',
      phone: '+1 415 555 0142',
      url: 'alexrivera.design',
      location: { city: 'San Francisco', region: 'CA', countryCode: 'US' }
    });
    r.basics.summary = 'Product designer with 8 years turning ambiguous problems into shipped software. Led the redesign of a checkout flow used by 2M+ customers and cut cart abandonment by 18%. Comfortable owning a problem end to end, from research through post-launch metrics.';
    r.basics.profiles[0] = { id: U.uid('prf'), network: 'linkedin', label: 'linkedin.com/in/alexrivera', url: 'https://linkedin.com/in/alexrivera' };

    r.sections.push(Object.assign(blankSection('projects', 4), { id: 'sec_projects' }));
    r.sections.push(Object.assign(blankSection('certifications', 5), { id: 'sec_certs' }));

    r.experience = [
      {
        id: U.uid('exp'), company: 'Northwind Labs', companyEntity: 'Inc.', location: 'San Francisco, CA', url: '', visible: true,
        roles: [{
          id: U.uid('role'), position: 'Senior Product Designer', start: 'Mar 2021', end: '', current: true, visible: true,
          summary: '',
          highlights: [
            'Led the end-to-end redesign of checkout, lifting conversion from 61% to 72% and reducing support tickets by 3,400/month.',
            'Built the design system adopted by 6 product teams, cutting new-feature design time from 3 weeks to 4 days.',
            'Ran 40+ customer interviews to validate a payments rebuild before engineering committed a single sprint.',
            'Mentored 3 junior designers; two were promoted within 18 months.'
          ],
          skills: []
        }]
      },
      {
        id: U.uid('exp'), company: 'Cobalt Health', companyEntity: '', location: 'Remote', url: '', visible: true,
        roles: [{
          id: U.uid('role'), position: 'Product Designer', start: 'Jun 2018', end: 'Feb 2021', current: false, visible: true,
          summary: '',
          highlights: [
            'Designed the patient onboarding flow used by 400,000 patients, reducing drop-off at the insurance step by 31%.',
            'Shipped a clinician scheduling tool that saved an average of 4.5 hours per provider per week.',
            'Established the first usability testing program at the company; 12 studies in the first year.'
          ],
          skills: []
        }]
      },
      {
        id: U.uid('exp'), company: 'Studio Mesa', companyEntity: '', location: 'Austin, TX', url: '', visible: true,
        roles: [{
          id: U.uid('role'), position: 'UX Designer', start: 'Aug 2016', end: 'May 2018', current: false, visible: true,
          summary: '',
          highlights: [
            'Delivered 14 client projects across fintech, health, and e-commerce.',
            'Rebuilt a regional e-commerce site\'s product page, increasing average order value by 22%.'
          ],
          skills: []
        }]
      }
    ];

    r.education = [
      { id: U.uid('edu'), institution: 'Rhode Island School of Design', url: '', studyType: 'Bachelor of Fine Arts', area: 'Graphic Design', score: '', courses: [], start: '2012', end: '2016', visible: true }
    ];

    r.skills = [
      { id: U.uid('skl'), label: 'Design', keywords: ['Product design', 'Design systems', 'Prototyping', 'Figma', 'Interaction design'], level: null, visible: true },
      { id: U.uid('skl'), label: 'Research', keywords: ['User interviews', 'Usability testing', 'Journey mapping', 'A/B testing'], level: null, visible: true },
      { id: U.uid('skl'), label: 'Tools', keywords: ['Figma', 'FigJam', 'Adobe CC', 'Maze', 'Amplitude', 'HTML/CSS'], level: null, visible: true }
    ];

    r.projects = [
      {
        id: U.uid('prj'), name: 'Open Checkout Kit', url: 'https://example.com/checkout-kit', start: '2023', end: '', current: true, visible: true,
        summary: 'An open-source React checkout flow. 3.2k GitHub stars and used in production by 11 companies.',
        highlights: ['Designed and documented the flow; contributed the accessibility layer (WCAG 2.2 AA).'],
        keywords: []
      }
    ];

    r.certifications = [
      { id: U.uid('crt'), name: 'Certified Usability Analyst', issuer: 'Human Factors International', date: 'Mar 2023', url: '', credentialId: '', visible: true }
    ];

    r.languages = [
      { id: U.uid('lng'), language: 'English', fluency: 'Native' },
      { id: U.uid('lng'), language: 'Spanish', fluency: 'Professional working proficiency' }
    ];

    return r;
  }

  function isBlankEntry(entry) {
    if (!entry) return true;
    var keys = Object.keys(entry);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'id' || k === 'visible' || k === 'level' || k === 'current') continue;
      var v = entry[k];
      if (Array.isArray(v)) { if (v.some(function (x) { return U.htmlToText(x || '').trim().length; })) return false; }
      else if (v && typeof v === 'object') { if (Object.keys(v).length) return false; }
      else if (v !== null && v !== undefined && String(v).trim() !== '') return false;
    }
    return true;
  }

  function isBlankResume(r) {
    if (!r) return true;
    var b = r.basics || {};
    if ((b.name || '').trim() || (b.email || '').trim()) return false;
    var lists = ['experience','education','skills','projects','certifications','publications','awards','volunteer','languages','interests','references','coursework','presentations','custom'];
    for (var i = 0; i < lists.length; i++) {
      if (Array.isArray(r[lists[i]]) && r[lists[i]].some(function (e) { return !isBlankEntry(e); })) return false;
    }
    return !(b.summary || '').trim();
  }

  function orderedSections(r) {
    return (r.sections || []).slice().sort(function (a, b) {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (a.order || 0) - (b.order || 0);
    });
  }

  function sectionEntries(r, type) {
    return Array.isArray(r[type]) ? r[type] : [];
  }

  function findEntry(r, type, id) {
    var list = sectionEntries(r, type);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function addSection(r, type, atOrder) {
    if (!TYPE_BY_NAME[type]) return null;
    var existing = (r.sections || []).filter(function (s) { return s.type === type; })[0];
    if (existing) { existing.visible = true; existing.order = atOrder != null ? atOrder : existing.order; return existing; }
    var max = (r.sections || []).reduce(function (m, s) { return Math.max(m, s.order || 0); }, 0);
    var sec = blankSection(type, atOrder != null ? atOrder : max + 1);
    r.sections.push(sec);
    if (Array.isArray(r[type])) r[type].push(blankEntry(type));
    return sec;
  }

  function removeSection(r, sectionId) {
    var sec = (r.sections || []).filter(function (s) { return s.id === sectionId; })[0];
    if (!sec) return false;
    var i = r.sections.indexOf(sec);
    r.sections.splice(i, 1);
    if (Array.isArray(r[sec.type]) && r[sec.type].length) {
      r[sec.type] = [];
    }
    return true;
  }

  function addEntry(r, type, index) {
    if (!Array.isArray(r[type])) r[type] = [];
    var entry = blankEntry(type);
    if (type === 'experience' && r.experience.length) {
      /* A second role is usually a promotion at the same company, not a new
       * employer. Seed it from the last entry so the user edits, not types. */
      var last = r.experience[r.experience.length - 1];
      entry.company = last.company;
      entry.companyEntity = last.companyEntity;
      entry.location = last.location;
      if (last.roles && last.roles.length) {
        var lr = last.roles[last.roles.length - 1];
        entry.roles[0].position = lr.position;
        entry.roles[0].start = lr.end;
        entry.roles[0].highlights = [''];
      }
    }
    if (typeof index === 'number' && index >= 0 && index <= r[type].length) r[type].splice(index, 0, entry);
    else r[type].push(entry);
    return entry;
  }

  function duplicateEntry(r, type, id) {
    var list = sectionEntries(r, type);
    var i = list.map(function (e) { return e.id; }).indexOf(id);
    if (i === -1) return null;
    var copy = deepClone(list[i]);
    copy.id = U.uid('copy');
    (function reid(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(reid); return; }
      if (node.id) node.id = U.uid('copy');
      Object.keys(node).forEach(function (k) { reid(node[k]); });
    })(copy);
    list.splice(i + 1, 0, copy);
    return copy;
  }

  function removeEntry(r, type, id) {
    var list = sectionEntries(r, type);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list.splice(i, 1); return true; }
    }
    return false;
  }

  function moveEntry(r, type, id, delta) {
    var list = sectionEntries(r, type);
    var i = list.map(function (e) { return e.id; }).indexOf(id);
    if (i === -1) return false;
    var j = i + delta;
    if (j < 0 || j >= list.length) return false;
    var tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    return true;
  }

  function moveSection(r, sectionId, delta) {
    var ordered = orderedSections(r);
    var i = ordered.map(function (s) { return s.id; }).indexOf(sectionId);
    if (i === -1) return false;
    var j = i + delta;
    if (j < 0 || j >= ordered.length) return false;
    var a = ordered[i], b = ordered[j];
    /* orderedSections sorts pinned first, so swapping order alone cannot carry
     * a section across that boundary: the order changes, the sort puts both
     * back where they were, and the caller is told the move happened when the
     * document is identical. Honouring it would mean silently unpinning
     * somebody's pinned section, so the move is refused instead. */
    if (!!a.pinned !== !!b.pinned) return false;
    var tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    if (a.order === b.order) { normalizeOrders(r); }
    return true;
  }

  function normalizeOrders(r) {
    orderedSections(r).forEach(function (s, i) { s.order = i; });
  }

  function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  /* Path-based read/write, so the binder, linter, importer and share-link all
   * address model fields the same way. Path is a dot/bracket string:
   *   "basics.name", "experience.0.roles.1.position", "design.accent"
   */
  function pathParts(path) {
    return String(path).replace(/\[\s*(\d+)\s*\]/g, '.$1').split('.');
  }

  function getPath(obj, path) {
    var parts = pathParts(path);
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      var p = parts[i];
      if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
      else cur = cur[p];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    var parts = pathParts(path);
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      /* Descending through a value rather than a container means the path is
       * stale. Writing anyway would clobber the value in sloppy mode and throw
       * in this one; writing nothing is the only safe answer. */
      if (cur == null || typeof cur !== 'object') return obj;
      var p = parts[i];
      var nextIsIndex = /^\d+$/.test(parts[i + 1]);
      var k = (Array.isArray(cur) && /^\d+$/.test(p)) ? Number(p) : p;
      var child = cur[k];
      if (child == null) {
        var fresh = nextIsIndex ? [] : {};
        /* An index at or past the end appends. Assigning cur[9] on a two
         * element array leaves holes, and forEach/map skip holes, so every
         * index derived from the array afterwards — duplicateEntry's splice
         * point, the renderer's data-bind paths — stops matching it. */
        if (Array.isArray(cur) && typeof k === 'number' && k >= cur.length) cur.push(fresh);
        else cur[k] = fresh;
        child = fresh;
      } else if (typeof child !== 'object') {
        return obj;
      }
      cur = child;
    }
    if (cur == null || typeof cur !== 'object') return obj;
    var last = parts[parts.length - 1];
    /* An index at or past the end pads with empty slots rather than being
     * assigned. Assigning cur[3] on a two element array leaves holes, and
     * every array reader downstream — arr()'s map, the renderer's bulletList,
     * JSON.stringify — skips a hole, so the value the user just typed is the
     * only survivor and the slots around it become null. Padding keeps both
     * halves of the contract: the path still resolves to what was written,
     * and nothing in the array is a hole. */
    if (Array.isArray(cur) && /^\d+$/.test(last)) {
      var li = Number(last);
      while (cur.length < li) cur.push('');
    }
    cur[last] = value;
    return obj;
  }

  /* Guard every write. A single invalid field must not be able to persist. */
  function validate(resume) {
    var errors = [];
    if (!resume || typeof resume !== 'object') { errors.push({ path: '', message: 'Resume must be an object.' }); return { ok: false, errors: errors, resume: emptyResume() }; }

    var out = emptyResume();

    /* Never report a version this build does not know, and never drop back to
     * 1: Math.min alone rewrote every v3 resume to v1 on the first write, so
     * the field could never describe anything but the oldest schema. */
    if (typeof resume.schemaVersion === 'number' && isFinite(resume.schemaVersion)) {
      out.schemaVersion = Math.max(1, Math.min(Math.round(resume.schemaVersion), out.schemaVersion));
    }
    if (typeof resume.id === 'string') out.id = resume.id;

    ['createdAt'].forEach(function (k) { if (typeof resume.meta?.[k] === 'string') out.meta[k] = resume.meta[k]; });
    if (typeof resume.meta?.updatedAt === 'string') out.meta.updatedAt = resume.meta.updatedAt;
    ['title','targetRole','targetCompany','locale','dateFormat','experienceLevel'].forEach(function (k) {
      if (typeof resume.meta?.[k] === 'string') out.meta[k] = resume.meta[k].slice(0, 300);
    });
    if (typeof resume.meta?.renderVersion === 'number' && isFinite(resume.meta.renderVersion)) {
      out.meta.renderVersion = Math.max(1, Math.min(Math.round(resume.meta.renderVersion), RENDER_VERSION));
    }

    var b = resume.basics || {};
    ['name','givenName','familyName','label','email','phone','url'].forEach(function (k) {
      if (typeof b[k] === 'string') out.basics[k] = b[k].slice(0, 400);
    });
    if (typeof b.summary === 'string') out.basics.summary = b.summary.slice(0, 6000);
    if (b.location && typeof b.location === 'object') {
      ['city','region','countryCode'].forEach(function (k) {
        if (typeof b.location[k] === 'string') out.basics.location[k] = b.location[k].slice(0, 120);
      });
    }
    if (typeof b.photo === 'string' && b.photo.indexOf('data:image/') === 0 && b.photo.length < 3_000_000) out.basics.photo = b.photo;
    if (Array.isArray(b.profiles)) {
      out.basics.profiles = b.profiles.filter(function (p) { return p && typeof p === 'object'; }).slice(0, 20).map(function (p) {
        return {
          id: typeof p.id === 'string' ? p.id : U.uid('prf'),
          network: typeof p.network === 'string' ? p.network.slice(0, 40) : 'other',
          label: typeof p.label === 'string' ? p.label.slice(0, 200) : '',
          url: typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url.slice(0, 500) : ''
        };
      });
    }

    if (Array.isArray(resume.sections)) {
      /* One section per type, one id per document — both are load-bearing.
       * Two sections of a type render the same entry list twice; two sections
       * sharing an id both answer to data-section-id, so the renderer's
       * section index and its re-homing map cannot tell them apart. */
      var seenType = Object.create(null);
      var seenId = Object.create(null);
      out.sections = resume.sections.filter(function (s) {
        if (!s || typeof s !== 'object' || !TYPE_BY_NAME[s.type]) return false;
        if (seenType[s.type]) return false;
        seenType[s.type] = true;
        return true;
      })
        .slice(0, 40)
        .map(function (s, i) {
          var id = (typeof s.id === 'string' && s.id && !seenId[s.id]) ? s.id : U.uid('sec');
          seenId[id] = true;
          return {
            id: id,
            type: s.type,
            label: typeof s.label === 'string' && s.label.trim() ? s.label.slice(0, 80) : meta(s.type).defaultLabel,
            visible: s.visible !== false,
            pinned: !!s.pinned,
            collapsed: !!s.collapsed,
            columns: s.columns === 1 || s.columns === 2 ? s.columns : (meta(s.type).single ? 1 : 2),
            order: Number.isFinite(s.order) ? s.order : i
          };
        });
      if (!out.sections.some(function (s) { return s.type === 'experience'; })) out.sections.unshift(blankSection('experience', -1));
      if (!out.sections.some(function (s) { return s.type === 'education'; })) out.sections.push(blankSection('education', 99));
    }

    SECTION_TYPES.forEach(function (def) {
      if (!def.hasMany) return;
      var incoming = resume[def.type];
      if (!Array.isArray(incoming)) return;
      out[def.type] = incoming.filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); })
        .slice(0, 200)
        .map(sanitizeEntry.bind(null, def.type));
    });

    if (resume.design && typeof resume.design === 'object') {
      var d = resume.design, out_d = out.design;
      if (typeof d.templateId === 'string') out_d.templateId = d.templateId;
      if (typeof d.fontFamily === 'string') out_d.fontFamily = d.fontFamily;
      out_d.baseSizePt = U.clamp(Number(d.baseSizePt) || out_d.baseSizePt, 9, 16);
      out_d.lineHeight = U.clamp(Number(d.lineHeight) || out_d.lineHeight, 1.05, 2);
      if (U.isValidHexColor(d.accent)) out_d.accent = d.accent;
      if (['uppercase','title','rule'].indexOf(d.headingStyle) !== -1) out_d.headingStyle = d.headingStyle;
      out_d.ruleWeight = U.clamp(Number(d.ruleWeight) || 1, 0.5, 4);
      out_d.sectionGapPt = U.clamp(Number(d.sectionGapPt) || out_d.sectionGapPt, 0, 40);
      out_d.entryGapPt = U.clamp(Number(d.entryGapPt) || out_d.entryGapPt, 0, 30);
      out_d.marginsIn = U.clamp(Number(d.marginsIn) || out_d.marginsIn, 0.2, 1.5);
      out_d.columns = d.columns === 2 ? 2 : 1;
      out_d.photoSlot = !!d.photoSlot;
      if (['disc','square','dash','none'].indexOf(d.bulletGlyph) !== -1) out_d.bulletGlyph = d.bulletGlyph;
      out_d.printSafe = !!d.printSafe;
      if (['Letter','A4'].indexOf(d.pageSize) !== -1) out_d.pageSize = d.pageSize;
      out_d.letterSpacing = U.clamp(Number(d.letterSpacing) || 0, -0.5, 1.5);
    }

    if (resume.versions && typeof resume.versions === 'object') {
      if (typeof resume.versions.masterId === 'string') out.versions.masterId = resume.versions.masterId;
      if (resume.versions.disabled && typeof resume.versions.disabled === 'object') {
        Object.keys(resume.versions.disabled).slice(0, 5000).forEach(function (k) {
          if (resume.versions.disabled[k] === true) out.versions.disabled[k] = true;
        });
      }
    }

    out.meta.templateId = out.design.templateId;
    normalizeOrders(out);
    return { ok: errors.length === 0, errors: errors, resume: out };
  }

  var SANITIZERS = {
    experience: function (e) {
      var roles = Array.isArray(e.roles) ? e.roles.slice(0, 20).map(function (role) {
        return {
          id: typeof role.id === 'string' ? role.id : U.uid('role'),
          position: str(role.position, 200),
          start: str(role.start, 60),
          end: str(role.end, 60),
          current: !!role.current,
          summary: str(role.summary, 2000),
          highlights: arr(role.highlights, 40, 3000),
          skills: arr(role.skills, 40, 120),
          visible: role.visible !== false
        };
      }) : [];
      if (!roles.length) roles = [{ id: U.uid('role'), position: '', start: '', end: '', current: false, summary: '', highlights: [''], skills: [], visible: true }];
      return {
        id: typeof e.id === 'string' ? e.id : U.uid('exp'),
        company: str(e.company, 200), companyEntity: str(e.companyEntity, 40),
        location: str(e.location, 200), url: safeUrl(e.url),
        roles: roles, visible: e.visible !== false
      };
    },
    education: function (e) {
      return {
        id: typeof e.id === 'string' ? e.id : U.uid('edu'),
        institution: str(e.institution, 200), url: safeUrl(e.url),
        studyType: str(e.studyType, 150), area: str(e.area, 150),
        score: str(e.score, 60), courses: arr(e.courses, 30, 200),
        start: str(e.start, 60), end: str(e.end, 60), visible: e.visible !== false
      };
    },
    skills: function (e) {
      return {
        id: typeof e.id === 'string' ? e.id : U.uid('skl'),
        label: str(e.label, 80), keywords: arr(e.keywords, 60, 120),
        level: (e.level === 'beginner' || e.level === 'intermediate' || e.level === 'advanced' || e.level === 'expert') ? e.level : null,
        visible: e.visible !== false
      };
    },
    projects: function (e) {
      return {
        id: typeof e.id === 'string' ? e.id : U.uid('prj'),
        name: str(e.name, 200), url: safeUrl(e.url),
        start: str(e.start, 60), end: str(e.end, 60), current: !!e.current,
        summary: str(e.summary, 2000), highlights: arr(e.highlights, 30, 3000),
        keywords: arr(e.keywords, 40, 120), visible: e.visible !== false
      };
    },
    certifications: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('crt'), name: str(e.name, 200), issuer: str(e.issuer, 200), date: str(e.date, 60), url: safeUrl(e.url), credentialId: str(e.credentialId, 120), visible: e.visible !== false };
    },
    publications: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('pub'), title: str(e.title, 400), authors: str(e.authors, 400), venue: str(e.venue, 300), date: str(e.date, 60), url: safeUrl(e.url), doi: str(e.doi, 120), visible: e.visible !== false };
    },
    awards: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('awd'), title: str(e.title, 300), awarder: str(e.awarder, 200), date: str(e.date, 60), visible: e.visible !== false };
    },
    volunteer: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('vol'), role: str(e.role, 200), organization: str(e.organization, 200), location: str(e.location, 200), start: str(e.start, 60), end: str(e.end, 60), current: !!e.current, highlights: arr(e.highlights, 30, 3000), visible: e.visible !== false };
    },
    languages: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('lng'), language: str(e.language, 120), fluency: str(e.fluency, 120) };
    },
    interests: function (e) { return { id: typeof e.id === 'string' ? e.id : U.uid('int'), label: str(e.label, 200) }; },
    references: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('ref'), name: str(e.name, 200), label: str(e.label, 200), contact: str(e.contact, 300), visible: e.visible !== false };
    },
    coursework: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('crs'), name: str(e.name, 300), institution: str(e.institution, 200), date: str(e.date, 60), url: safeUrl(e.url) };
    },
    presentations: function (e) {
      return { id: typeof e.id === 'string' ? e.id : U.uid('prs'), title: str(e.title, 300), event: str(e.event, 300), date: str(e.date, 60), location: str(e.location, 200), url: safeUrl(e.url), highlights: arr(e.highlights, 30, 3000) };
    },
    custom: function (e) {
      return {
        id: typeof e.id === 'string' ? e.id : U.uid('cus'),
        label: str(e.label, 200),
        entries: (Array.isArray(e.entries) ? e.entries : []).slice(0, 100).map(function (x) {
          return { id: typeof x.id === 'string' ? x.id : U.uid('ent'), title: str(x.title, 300), org: str(x.org, 200), start: str(x.start, 60), end: str(x.end, 60), text: str(x.text, 2000) };
        })
      };
    }
  };

  function sanitizeEntry(type, e) {
    var f = SANITIZERS[type];
    return f ? f(e) : { id: typeof e.id === 'string' ? e.id : U.uid('ent'), title: str(e.title, 300), visible: e.visible !== false };
  }

  function str(v, max) {
    if (v == null) return '';
    if (typeof v === 'string') return v.slice(0, max);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  function arr(v, maxItems, maxLen) {
    if (!Array.isArray(v)) return [];
    /* Empty entries are kept, never dropped. The renderer binds bullet N to
     * `highlights.N` and the binder writes back through that same path, so an
     * emptied bullet that shifts its neighbours renumbers every one of them:
     * the next keystroke aimed at the second bullet is written into what used
     * to be the third, and the bullet the user did not touch is the one that
     * disappears. Keeping the slot is what keeps the index honest. Every
     * reader of these arrays — the renderer, the linter, the score, all four
     * exporters — already skips an empty string, so holding one costs
     * nothing. */
    return v.slice(0, maxItems)
      .map(function (x) { return typeof x === 'string' ? x.slice(0, maxLen) : (x == null ? '' : String(x).slice(0, maxLen)); });
  }

  function safeUrl(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s.slice(0, 500);
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return 'https://' + s.slice(0, 500);
    return '';
  }

  function migrate(resume) {
    if (!resume || typeof resume !== 'object') return resume;
    var out = deepClone(resume);
    var v = Number(out.schemaVersion) || 1;
    if (v < 2 && Array.isArray(out.experience)) {
      /* v1 stored a flat role; v2 groups roles under a company. */
      out.experience = out.experience.map(function (e) {
        if (!e.roles && e.position !== undefined) {
          return {
            id: e.id || U.uid('exp'), company: e.company || '', companyEntity: e.companyEntity || '',
            location: e.location || '', url: e.url || '', visible: e.visible !== false,
            roles: [{ id: U.uid('role'), position: e.position || '', start: e.start || '', end: e.end || '', current: !!e.current, summary: e.summary || '', highlights: e.highlights || [''], skills: [], visible: true }]
          };
        }
        return e;
      });
      v = 2;
    }
    if (v < 3 && Array.isArray(out.design)) {
      out.design = Object.assign({}, DEFAULT_DESIGN, out.design);
      v = 3;
    }
    out.schemaVersion = 3;
    return out;
  }

  global.RB = global.RB || {};
  global.RB.model = {
    RENDER_VERSION: RENDER_VERSION,
    SECTION_TYPES: SECTION_TYPES,
    DEFAULT_DESIGN: DEFAULT_DESIGN,
    typeMeta: meta,
    emptyResume: emptyResume,
    sampleResume: sampleResume,
    blankEntry: blankEntry,
    blankSection: blankSection,
    isBlankEntry: isBlankEntry,
    isBlankResume: isBlankResume,
    orderedSections: orderedSections,
    sectionEntries: sectionEntries,
    findEntry: findEntry,
    addSection: addSection,
    removeSection: removeSection,
    addEntry: addEntry,
    duplicateEntry: duplicateEntry,
    removeEntry: removeEntry,
    moveEntry: moveEntry,
    moveSection: moveSection,
    normalizeOrders: normalizeOrders,
    getPath: getPath,
    setPath: setPath,
    validate: validate,
    migrate: migrate,
    deepClone: deepClone,
    safeUrl: safeUrl
  };
})(window);
