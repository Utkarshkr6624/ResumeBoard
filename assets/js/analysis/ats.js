/* Resumeboard — ATS pre-flight checker and named vendor simulators.
 *
 * Pure analysis. run() and simulate() never write to the store, never inject
 * DOM, and never touch the network. Checks that need geometry or rendered
 * output read #rb-doc when it is present and degrade to a documented 'skip'
 * when it is not, so the same call works inside the app and headless.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  /* utils.js is a hard dependency loaded first by index.html. Bailing keeps
   * the page alive rather than throwing during a load-order mistake. */
  if (!U) return;

  var doc = global.document;

  /* ============================ tuning ============================ */

  var WORD_FLOOR = 2000;
  var WORD_FLOOR_LABEL = '2,000';
  var PDF_MAX_BYTES = 2.5 * 1024 * 1024;
  var ENTRY_GAP_RATIO = 1.4;
  var ENTITY_MIN_RATIO = 0.5;
  var TRACKING_LIMIT_EM = 0.02;
  /* Rough size of a text-only PDF from this renderer, used to estimate a size
   * before the exporter has produced a real file. */
  var BASE_PDF_BYTES = 90 * 1024;
  /* Photo data-URL overhead when converting to the bytes it costs in the PDF. */
  var DATA_URL_RATIO = 0.75;

  var CHECK_META = {
    'contact-body':     { label: 'Contact details sit in the document body', category: 'Parseability', weight: 12, source: 'ATS text extraction reads the body flow; running headers and footers are read after, or not at all.' },
    'single-column':    { label: 'One text column', category: 'Layout', weight: 8, source: 'Column layouts interleave lines on extraction, producing garbled reading order.' },
    'no-tables':        { label: 'No tables or text boxes', category: 'Parseability', weight: 10, source: 'Table and text-box content is read cell by cell or not at all, so content order is lost.' },
    'web-safe-fonts':   { label: 'Web-safe fonts only', category: 'Parseability', weight: 6, source: 'Unembedded fonts can substitute at extraction time and break the text layer.' },
    'bullet-glyphs':    { label: 'No icon glyphs as bullets', category: 'Layout', weight: 6, source: 'Symbol-font bullets extract as mojibake, not as list markers.' },
    'letter-spacing':   { label: 'No letter-spacing on body text', category: 'Layout', weight: 4, source: 'Tracking splits words into separate glyph runs, which many extractors space out.' },
    'legal-entity':     { label: 'Employers carry a legal entity suffix', category: 'Matching', weight: 6, source: 'Company-name matching against employer records keys on the legal entity suffix.' },
    'no-abbrev-titles': { label: 'Job titles are not abbreviated', category: 'Matching', weight: 8, source: 'Recruiter keyword search matches the spelled-out title, not the abbreviation.' },
    'role-titles':      { label: 'Role titles name a role, not a department', category: 'Matching', weight: 4, source: 'Functional titles such as "Head of Design" match no job-title taxonomy entry.' },
    'apostrophe-year':  { label: 'No ambiguous apostrophe years', category: 'Parseability', weight: 6, source: 'Two-digit years such as Jan \'21 have no agreed century and break date parsing.' },
    'file-size':        { label: 'PDF under 2.5 MB', category: 'Delivery', weight: 8, source: 'Greenhouse rejects attachments above 2.5 MB; most tenants sit at or below that ceiling.' },
    'section-headings': { label: 'Headings are bold, uppercase, and alone on their line', category: 'Parseability', weight: 8, source: 'Recruiters read the resume as a flat string; headings are the only structure the parser keeps.' },
    'entry-spacing':    { label: 'Entry gaps are wider than bullet gaps', category: 'Parseability', weight: 6, source: 'OpenResume section-detection heuristic: an entry must be separated from the next by more than 1.4x the inter-bullet line gap.' },
    'no-emoji':         { label: 'No emoji', category: 'Parseability', weight: 6, source: 'Emoji extract as multi-byte noise or as the replacement character.' },
    'no-images':        { label: 'No images other than a photo', category: 'Parseability', weight: 8, source: 'Graphics carry no extractable text and push a PDF past upload limits.' },
    'consistent-dates': { label: 'One date format throughout', category: 'Parseability', weight: 8, source: 'Inconsistent date formats split one timeline into unmergeable fragments.' },
    'file-name':        { label: 'File name follows the convention', category: 'Delivery', weight: 5, source: 'Recruiting platforms surface the attachment name; Firstname_Lastname_Resume.pdf keeps candidates distinguishable.' },
    'word-count':       { label: 'At least 2,000 words of content', category: 'Content', weight: 7, source: 'Below roughly 2,000 words a resume is too thin to keyword-match a senior or lead role.' }
  };

  var CHECK_ORDER = [
    'contact-body', 'single-column', 'no-tables', 'web-safe-fonts', 'bullet-glyphs',
    'letter-spacing', 'no-emoji', 'no-images', 'section-headings', 'entry-spacing',
    'consistent-dates', 'apostrophe-year', 'legal-entity', 'no-abbrev-titles',
    'role-titles', 'word-count', 'file-size', 'file-name'
  ];

  var CREDIT = { pass: 1, warn: 0.5, fail: 0, skip: 0 };

  /* ============================ text helpers ============================ */

  /* Model values can carry the inline HTML the editor produces, so they go
   * through the sanitiser. DOM text is already decoded and skips that cost. */
  /* Every model field passes through here, so this is where an unreadable
   * value is absorbed: a malformed import can leave something String() refuses
   * to coerce, and one such field must not take a whole check down with it. */
  function coerce(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return String(value); }
    catch (e) { return ''; }
  }

  function txt(value) {
    if (value == null) return '';
    return U.htmlToText(coerce(value)).replace(/\s+/g, ' ').trim();
  }

  function plain(value) {
    if (value == null) return '';
    return coerce(value).replace(/\s+/g, ' ').trim();
  }

  function words(str) {
    var s = String(str || '').trim();
    if (!s) return 0;
    return s.split(/\s+/).length;
  }

  function cap(list, max) {
    var n = max || 6;
    if (list.length <= n) return list.slice();
    return list.slice(0, n).concat(['+' + (list.length - n) + ' more']);
  }

  function pct(n) { return Math.round(n * 100) + '%'; }

  function bytesLabel(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  /* Keys that never reach the page, so they never count as content. */
  var NON_CONTENT_KEYS = {
    id: 1, visible: 1, order: 1, collapsed: 1, pinned: 1, columns: 1, level: 1,
    current: 1, type: 1, network: 1, photo: 1, $schema: 1, schemaVersion: 1,
    renderVersion: 1, createdAt: 1, updatedAt: 1, templateId: 1, dateFormat: 1,
    locale: 1, masterId: 1, disabled: 1
  };

  var DATE_KEYS = { start: 1, end: 1, date: 1 };

  /* Walks the model once and returns every user-visible string and every
   * date-shaped field, with its data-bind path. The result is memoised on the
   * resume object: harvest() is a pure function of that object, and the store
   * replaces the object on every write rather than mutating it, so identity is
   * a sound key. It matters because simulate() builds a context per vendor, and
   * six vendors were walking a maximum-size resume twelve times — the
   * difference between a vendor simulation that answers and one that locks the
   * tab. */
  var harvestCache = typeof global.WeakMap === 'function' ? new global.WeakMap() : null;

  function harvest(resume) {
    if (harvestCache) {
      var hit = harvestCache.get(resume);
      if (hit) return hit;
    }
    var out = buildHarvest(resume);
    if (harvestCache) harvestCache.set(resume, out);
    return out;
  }

  function buildHarvest(resume) {
    var out = { text: [], dates: [], seen: 0 };
    /* A resume object can reach this function with a back-reference in it (a
     * hand-edited import or a plugin-built model), and an unguarded walk over a
     * cycle overflows the stack and takes the whole report down. */
    var visited = typeof global.WeakSet === 'function' ? new global.WeakSet() : null;
    var plain = [];
    (function walk(node, path, key, depth) {
      if (node == null) return;
      if (typeof node === 'string') {
        var value = txt(node);
        if (value) {
          out.seen++;
          if (DATE_KEYS[key]) out.dates.push({ path: path, value: value });
          else out.text.push({ path: path, value: value });
        }
        return;
      }
      if (typeof node !== 'object') return;
      if (depth > 40) return;
      if (visited) {
        if (visited.has(node)) return;
        visited.add(node);
      } else {
        if (plain.indexOf(node) !== -1) return;
        plain.push(node);
      }
      if (Array.isArray(node)) {
        node.forEach(function (item, i) { walk(item, path + '.' + i, key, depth + 1); });
        return;
      }
      if (path.indexOf('versions') === 0 || path === 'meta' || path.indexOf('design') === 0) return;
      Object.keys(node).forEach(function (k) {
        if (NON_CONTENT_KEYS[k]) return;
        walk(node[k], path ? path + '.' + k : k, k, depth + 1);
      });
    })(resume, '', '', 0);
    return out;
  }

  function visibleList(r, type) {
    if (!Array.isArray(r[type])) return [];
    return r[type].filter(function (e) { return e && e.visible !== false; });
  }

  function visibleSections(r) {
    if (!r || !Array.isArray(r.sections)) return [];
    /* Drop the holes before ordering: model.orderedSections reads s.pinned and
     * s.order, so a single null section (easy to produce from a malformed
     * import) would throw out of every check that calls this. */
    var list = r.sections.filter(function (s) { return s && s.visible !== false; });
    if (RB.model && typeof RB.model.orderedSections === 'function') {
      try { return RB.model.orderedSections({ sections: list }); }
      catch (e) { /* fall through to the unordered list */ }
    }
    return list;
  }

  function design(r) { return (r && r.design) || {}; }

  function roles(exp) {
    if (!exp || !Array.isArray(exp.roles)) return [];
    return exp.roles.filter(function (role) { return role && role.visible !== false; });
  }

  /* ============================ date formats ============================ */

  var MONTH_ABBR = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  var MONTH_FULL = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

  var DATE_PATTERNS = [
    { family: 'monthYear', label: 'Mon YYYY', re: new RegExp('^\\s*' + MONTH_ABBR + '[a-z]*\\.?\\s+(19|20)\\d{2}\\s*$', 'i') },
    { family: 'monthYear', label: 'Month YYYY', re: new RegExp('^\\s*' + MONTH_FULL + '\\s+(19|20)\\d{2}\\s*$', 'i') },
    { family: 'monthYear', label: 'Mon YYYY', re: new RegExp('^\\s*[0-3]?\\d\\s+' + MONTH_ABBR + '[a-z]*\\s+(19|20)\\d{2}\\s*$', 'i') },
    { family: 'numericDay', label: 'MM/DD/YYYY', re: /^\s*\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\s*$/ },
    { family: 'numericMonthYear', label: 'MM/YYYY', re: /^\s*\d{1,2}[\/.](19|20)\d{2}\s*$/ },
    { family: 'isoMonth', label: 'YYYY-MM', re: /^\s*(19|20)\d{2}-\d{1,2}\s*$/ },
    { family: 'isoDay', label: 'YYYY-MM-DD', re: /^\s*(19|20)\d{2}-\d{1,2}-\d{1,2}\s*$/ },
    { family: 'yearOnly', label: 'YYYY', re: /^\s*(19|20)\d{2}\s*$/ },
    { family: 'present', label: 'Present', re: /^\s*(present|current|now|today|ongoing)\s*$/i }
  ];

  var FREE_TEXT = { family: 'freeText', label: 'free text' };

  function dateFormat(value) {
    var s = String(value || '').trim();
    if (!s) return FREE_TEXT;
    for (var i = 0; i < DATE_PATTERNS.length; i++) {
      if (DATE_PATTERNS[i].re.test(s)) return DATE_PATTERNS[i];
    }
    return FREE_TEXT;
  }

  var APOSTROPHE_YEAR = /(?:^|[\s(\[])(?:\d{1,2}[\s.])?(?:'|\u2018|\u2019|\u02bc)\s?\d{2}\b/;

  /* ============================ glyph detection ============================ */

  var EMOJI_ALLOWED = /[\u00a9\u00ae\u00b0\u00b1\u00d7\u20ac\u00a3\u00a5\u00a7\u00b6\u2116\u2122\u2020\u2021]/g;

  var EMOJI_RE = null;
  try { EMOJI_RE = new RegExp('\\p{Extended_Pictographic}', 'u'); }
  catch (e) { EMOJI_RE = /[\u2600-\u27bf\u2b00-\u2bff\ud83c-\udbff\ud83e-\ud83f\ud800-\udbff\ufe0f\U0001f1e6-\U0001f1ff]/; }

  /* Private Use Area is where Wingdings and Webdings bullets live. */
  var SYMBOL_FONT_RE = /[\ue000-\uf8ff]|[\u2776-\u277f]|\u00b7|\u2022|\u25aa|\u25ab|\u25cf|\u2043|\u2044/;

  var ICON_BULLET_RE = /^[\s\u2022\u25cf\u25aa\u25ab\u2043\u2044\u2192\u27a2\u276f\u25b6\u25c0\u00b7\uf0a7\uf0b7\uf0d8\uf0fc\uf0fe\ue000-\uf8ff\d]+[\s.)-]/;

  var EMOJI_TONE = '\ufe0f|\u20e3';

  /* Built once: a fresh global regex per field would re-scan for every match. */
  var EMOJI_FIND_RE = new RegExp(EMOJI_RE.source, 'gu');

  function findEmoji(str) {
    var probe = String(str || '').replace(EMOJI_ALLOWED, '');
    if (!EMOJI_RE.test(probe)) return null;
    EMOJI_FIND_RE.lastIndex = 0;
    var m = EMOJI_FIND_RE.exec(probe);
    if (!m) return null;
    var next = probe.slice(m.index + m[0].length, m.index + m[0].length + 2);
    return m[0] + (new RegExp('^[' + EMOJI_TONE + ']').test(next) ? next[0] : '');
  }

  /* ============================ fonts ============================ */

  var WEB_SAFE = [
    'arial', 'helvetica', 'times', 'times new roman', 'georgia', 'courier',
    'courier new', 'verdana', 'tahoma', 'trebuchet ms', 'palatino',
    'palatino linotype', 'garamond', 'impact', 'century gothic', 'book antiqua'
  ];
  /* Widely shipped but not on the classic web-safe list. Not wrong, just not
   * guaranteed to survive a PDF round trip on a machine that lacks them. */
  var NEAR_SAFE = [
    'inter', 'roboto', 'segoe ui', 'segoe ui variable', 'calibri', 'cambria',
    'aptos', 'gill sans', 'gill sans mt', 'futura', 'optima', 'rockwell',
    'bookman old style', 'perpetua', 'baskerville', 'franklin gothic book',
    'lato', 'montserrat', 'open sans', 'source sans pro', 'ibm plex sans',
    'nunito sans', 'work sans', 'barlow'
  ];
  var GENERIC_FONTS = [
    'serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif',
    'ui-serif', 'ui-monospace', 'ui-rounded', 'cursive', 'fantasy',
    '-apple-system', 'blinkmacsystemfont',
    /* The Design panel stores stack keywords, not families, for these. */
    'system', 'sans', 'serif', 'mono', 'systemfont', 'inherit', 'initial', 'unset', 'revert'
  ];

  /* The same families ship under a style or weight qualifier, and neither
   * "Helvetica Neue" nor "Inter var" is a different font for ATS purposes. */
  var FONT_ALIASES = {
    'helvetica neue': 'helvetica', 'inter var': 'inter', 'arial unicode ms': 'arial',
    'times new roman ps': 'times new roman', 'segoe ui variable': 'segoe ui',
    'cambria math': 'cambria'
  };

  function familyStatus(family) {
    var name = String(family || '').replace(/^['"]|['"]$/g, '').trim().toLowerCase();
    if (!name) return { state: 'skip', name: name };
    if (WEB_SAFE.indexOf(name) !== -1) return { state: 'pass', name: name };
    if (GENERIC_FONTS.indexOf(name) !== -1) return { state: 'pass', name: name };
    if (NEAR_SAFE.indexOf(name) !== -1) return { state: 'warn', name: name };
    var alias = FONT_ALIASES[name];
    if (alias) return familyStatus(alias);
    return { state: 'fail', name: name };
  }

  function stackFamilies(stack) {
    return String(stack || '').split(',').map(function (part) {
      return part.replace(/['"]/g, '').trim();
    }).filter(Boolean);
  }

  /* ============================ title dictionaries ============================ */

  var TITLE_ABBREV = {
    'sr': 'Senior', 'snr': 'Senior', 'jr': 'Junior', 'jnr': 'Junior',
    'mgr': 'Manager', 'mgmt': 'Management', 'mngr': 'Manager',
    'eng': 'Engineer', 'engr': 'Engineer', 'dev': 'Developer',
    'devlpr': 'Developer', 'admin': 'Administrator', 'admn': 'Administrator',
    'asst': 'Assistant', 'assoc': 'Associate', 'dept': 'Department',
    'intl': 'International', 'biz': 'Business', 'ops': 'Operations',
    'spec': 'Specialist', 'spc': 'Specialist', 'coord': 'Coordinator',
    'supv': 'Supervisor', 'repr': 'Representative', 'consult': 'Consultant',
    'acct': 'Accountant', 'fin': 'Finance', 'tech': 'Technician',
    'mktg': 'Marketing', 'comm': 'Communications', 'pr': 'Public Relations',
    'hr': 'Human Resources', 'svcs': 'Services', 'sys': 'Systems',
    'netw': 'Network', 'anal': 'Analyst', 'arch': 'Architect',
    'dir': 'Director', 'vc': 'Vice President', 'vp': 'Vice President',
    'gm': 'General Manager', 'cmo': 'Chief Marketing Officer',
    'ceo': 'Chief Executive Officer', 'cto': 'Chief Technology Officer',
    'pm': 'Project Manager'
  };

  var ACRONYM_TOKENS = {
    MBA: 'Master of Business Administration', BBA: 'Bachelor of Business Administration',
    MPA: 'Master of Public Administration', MS: 'Master of Science',
    MA: 'Master of Arts', BS: 'Bachelor of Science', BA: 'Bachelor of Arts',
    BFA: 'Bachelor of Fine Arts', MFA: 'Master of Fine Arts', BSCS: 'Bachelor of Science in Computer Science',
    PHD: 'Doctor of Philosophy', PMP: 'Project Management Professional',
    CPA: 'Certified Public Accountant', SQL: 'Structured Query Language',
    KPI: 'Key Performance Indicator', Kpis: 'Key Performance Indicators',
    B2B: 'Business to Business', B2C: 'Business to Consumer',
    SAAS: 'Software as a Service', API: 'Application Programming Interface',
    UX: 'User Experience', UI: 'User Interface', HR: 'Human Resources',
    PR: 'Public Relations', SEO: 'Search Engine Optimization',
    SEM: 'Search Engine Marketing', AWS: 'Amazon Web Services',
    GDPR: 'General Data Protection Regulation', CRM: 'Customer Relationship Management',
    ERP: 'Enterprise Resource Planning', CAD: 'Computer-Aided Design',
    QA: 'Quality Assurance', RN: 'Registered Nurse', EMT: 'Emergency Medical Technician',
    OKR: 'Objectives and Key Results', EOS: 'Entrepreneurial Operating System',
    SLA: 'Service Level Agreement', AB: 'A/B Testing'
  };

  var LEAD_REGEX = /^(global|regional|country|group)\s+/i;

  function isFunctionalTitle(title) {
    var s = txt(title);
    if (!s) return false;
    var rest = s.replace(LEAD_REGEX, '');
    if (/^(head|chief|lead|principal|vp|vice\s+president|director|manager|general\s+manager)\s+of\b/i.test(rest)) return true;
    if (/^(head|chief|lead|principal)\s*,\s*\S/i.test(rest)) return true;
    return false;
  }

  /* ============================ vendor table ============================ */

  var VENDORS = [
    { id: 'greenhouse', label: 'Greenhouse', blurb: 'Strictest of the group on abbreviations and file size.' },
    { id: 'taleo', label: 'Oracle Taleo', blurb: 'Boolean keyword search that is blind to acronyms.' },
    { id: 'workday', label: 'Workday', blurb: 'Section-mapped parsing; unnamed sections are dropped.' },
    { id: 'icims', label: 'iCIMS', blurb: 'Exact-phrase keyword search over a structured profile.' },
    { id: 'lever', label: 'Lever', blurb: 'Aggressive layout flattening; order is preserved, spacing is not.' },
    { id: 'generic', label: 'Generic ATS', blurb: 'The shared baseline every parser agrees on.' }
  ];

  function vendorById(id) {
    for (var i = 0; i < VENDORS.length; i++) if (VENDORS[i].id === id) return VENDORS[i];
    return null;
  }

  var DISCLAIMER = 'Simulations apply publicly documented recruiter guidance as rules of thumb. They are not vendor-certified parsers, so a clean result is a floor and not a guarantee.';

  /* ============================ DOM access ============================ */

  function resolveDoc(opts) {
    if (opts && opts.doc) return opts.doc;
    return U.qs('#rb-doc');
  }

  function docReady(node) {
    return !!(node && node.childElementCount && doc && doc.contains(node));
  }

  /* A node the document renderer adds for editing affordances, not for print. */
  function isEditorChrome(node) {
    return !!(node.closest && node.closest('[data-editor-only],[data-chrome],[aria-hidden="true"],[contenteditable="false"]'));
  }

  /* getComputedStyle hands back a live object, so memoising it per element is
   * both safe across re-renders and the difference between one layout flush
   * per check and one per element per check. */
  var styleCache = typeof global.WeakMap === 'function' ? new global.WeakMap() : null;

  function styleOf(node) {
    if (!global.getComputedStyle) return null;
    if (styleCache) {
      var hit = styleCache.get(node);
      if (hit) return hit;
    }
    var cs = global.getComputedStyle(node);
    if (styleCache) styleCache.set(node, cs);
    return cs;
  }

  function visible(node) {
    if (isEditorChrome(node)) return false;
    if (node.getClientRects && node.getClientRects().length === 0) return false;
    var style = styleOf(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    return true;
  }

  function textOf(node) { return plain(node.textContent); }

  /* ============================ context ============================ */

  function buildContext(resume, opts) {
    var r = resume && typeof resume === 'object' ? resume : null;
    var d = r ? design(r) : {};
    return {
      r: r,
      opts: opts || {},
      d: d,
      doc: resolveDoc(opts),
      artifact: resolveArtifact(opts),
      fields: r ? harvest(r) : { text: [], dates: [], seen: 0 }
    };
  }

  function resolveArtifact(opts) {
    if (opts && opts.artifact && typeof opts.artifact === 'object') return opts.artifact;
    var last = lastArtifact;
    if (last) return last;
    /* The exporter, if it publishes one, is the only module that knows the
     * final file size. Read it if it is there; never require it. */
    var exp = RB.export;
    if (exp && exp.lastArtifact && typeof exp.lastArtifact === 'object') return exp.lastArtifact;
    return null;
  }

  var lastArtifact = null;

  function artifactBytes(a) {
    if (!a) return null;
    if (typeof a.bytes === 'number' && isFinite(a.bytes)) return a.bytes;
    if (typeof a.size === 'number' && isFinite(a.size)) return a.size;
    if (typeof a.blob === 'object' && a.blob && typeof a.blob.size === 'number') return a.blob.size;
    if (typeof a.dataUrl === 'string') return Math.round(a.dataUrl.length * DATA_URL_RATIO);
    return null;
  }

  /* ============================ checks ============================ */

  function cContactBody(ctx) {
    var b = (ctx.r && ctx.r.basics) || {};
    var email = txt(b.email);
    var phone = txt(b.phone);
    var url = txt(b.url);
    var profiles = Array.isArray(b.profiles) ? b.profiles : [];

    if (!email) {
      return { status: 'fail', detail: 'No email address is set. Every parser reads contact details from the body flow first.', evidence: ['basics.email is empty'], fix: 'Add an email address in the contact block at the top of your resume.' };
    }
    if (!phone && !url && !profiles.length) {
      return { status: 'warn', detail: 'An email is set, but there is no phone number or web address to fall back on.', evidence: ['basics.email set', 'basics.phone, basics.url and basics.profiles are empty'], fix: 'Add a phone number or a portfolio link so a recruiter has a second way to reach you.' };
    }

    if (!docReady(ctx.doc)) {
      return { status: 'skip', detail: 'Contact details are set in the model, but the rendered document was not available to confirm where they land.', evidence: ['email: ' + email, 'phone: ' + (phone || 'not set')], fix: null };
    }

    var tokens = [email, phone, url].concat(profiles.map(function (p) { return txt(p.label) || txt(p.url); }))
      .filter(Boolean).map(stripUrl);
    var found = 0;
    var stranded = [];
    U.qsa('*', ctx.doc).forEach(function (node) {
      var body = textOf(node);
      if (!body) return;
      tokens.forEach(function (token) {
        if (body.indexOf(token) === -1) return;
        found++;
        /* A running header is a per-page band, and this app never emits one —
         * the document header is an in-flow block at the top of the body, which
         * is exactly where contact details belong. Matching the bare <header>
         * tag therefore failed every resume the renderer has ever produced. An
         * imported or hand-authored document marks a real running band with
         * data-doc-region or a landmark role instead. */
        if (node.closest('[role="banner"],[role="contentinfo"],[data-doc-region="header"],[data-doc-region="footer"]')) {
          if (stranded.indexOf(token) === -1) stranded.push(token);
        }
      });
    });

    if (!found) {
      return { status: 'fail', detail: 'The contact details are in the model but were not found in the rendered document.', evidence: cap(tokens), fix: 'Make sure the contact line renders in the document body, not only in the editor panel.' };
    }
    if (stranded.length) {
      return { status: 'fail', detail: 'Contact details sit in a running header or footer. Those are extracted after the body, or not at all, so recruiters can see the name with no way to contact you.', evidence: cap(stranded.map(function (t) { return 'in header/footer: ' + t; })), fix: 'Move the contact line into the first block of the document body.' };
    }
    return { status: 'pass', detail: 'Contact details sit in the document body, which is where every parser reads them first.', evidence: cap(tokens), fix: null };
  }

  function stripUrl(u) {
    var s = txt(u);
    return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  }

  function cSingleColumn(ctx) {
    var offenders = [];
    if (ctx.d.columns === 2) offenders.push('design.columns = 2');
    /* A section's column hint only bites inside a two-column document.
     * blankSection() defaults every multi-entry section to 2, so reading the
     * hint on its own flagged every resume the model has ever produced, single
     * column or not. */
    if (ctx.d.columns === 2 && Array.isArray(ctx.r && ctx.r.sections)) {
      ctx.r.sections.forEach(function (s) {
        if (s && s.visible !== false && s.columns === 2) offenders.push('section "' + txt(s.label) + '" is set to 2 columns');
      });
    }
    if (docReady(ctx.doc)) {
      U.qsa('*', ctx.doc).forEach(function (node) {
        if (!visible(node)) return;
        var cs = styleOf(node);
        if (!cs) return;
        var cols = cs.columnCount && cs.columnCount !== 'auto' ? cs.columnCount : (cs.columns && cs.columns.indexOf(' ') > -1 ? cs.columns.split(' ')[0] : 'auto');
        if (cols !== 'auto' && parseInt(cols, 10) > 1) {
          var label = node.className && typeof node.className === 'string' ? node.className.split(' ')[0] : node.tagName.toLowerCase();
          if (offenders.indexOf('rendered ' + label + ' uses ' + cols + ' columns') === -1) offenders.push('rendered ' + label + ' uses ' + cols + ' columns');
        }
      });
    }
    if (!offenders.length) {
      return { status: 'pass', detail: 'The document is a single column, so text extracts in reading order.', evidence: [], fix: null };
    }
    return { status: 'warn', detail: 'Two-column layouts survive PDF export but interleave lines on extraction, so two adjacent lines can end up on the same line of plain text.', evidence: cap(offenders), fix: 'Set the document to one column in the Design panel.' };
  }

  function cNoTables(ctx) {
    if (!docReady(ctx.doc)) {
      return { status: 'skip', detail: 'Tables and text boxes can only be confirmed against the rendered document, which was not available.', evidence: [], fix: null };
    }
    var offenders = [];
    /* role="textbox" is not matched here on purpose: the document renderer
     * puts it on every inline-editable field, which is the primary editing
     * surface, so matching it failed every resume with ~70 phantom offenders
     * and advice the user could not act on. A real floating text box is caught
     * by the positioned-block sweep below whatever its role. */
    U.qsa('table,[role="table"],textarea', ctx.doc).forEach(function (node) {
      if (!visible(node)) return;
      offenders.push('<' + node.tagName.toLowerCase() + '> in the document');
    });
    U.qsa('*', ctx.doc).forEach(function (node) {
      if (!visible(node) || !textOf(node)) return;
      var cs = styleOf(node);
      if (!cs) return;
      if (cs.position === 'absolute' || cs.position === 'fixed') {
        offenders.push('positioned text block: "' + textOf(node).slice(0, 40) + '"');
      }
      if (cs.listStyleImage && cs.listStyleImage !== 'none') {
        offenders.push('list item with an image bullet: "' + textOf(node).slice(0, 40) + '"');
      }
    });
    if (!offenders.length) {
      return { status: 'pass', detail: 'No tables, text boxes, positioned text, or image bullets in the document.', evidence: [], fix: null };
    }
    return { status: 'fail', detail: 'Tables and text boxes are read cell by cell, so your experience and education end up interleaved in the extracted text.', evidence: cap(offenders), fix: 'Replace tables and positioned text boxes with normal paragraphs in a single column.' };
  }

  function cWebSafeFonts(ctx) {
    var offenders = [];
    var soft = [];
    var sources = [];
    if (ctx.d.fontFamily) sources.push(String(ctx.d.fontFamily));
    if (docReady(ctx.doc)) {
      var seen = {};
      U.qsa('*', ctx.doc).forEach(function (node) {
        if (!visible(node) || !textOf(node)) return;
        var cs = styleOf(node);
        if (!cs || !cs.fontFamily || seen[cs.fontFamily]) return;
        seen[cs.fontFamily] = true;
        sources.push(cs.fontFamily);
      });
    }
    if (!sources.length) {
      return { status: 'skip', detail: 'No font stack was available to check.', evidence: [], fix: null };
    }
    sources.forEach(function (stack) {
      var families = stackFamilies(stack);
      var states = families.map(familyStatus);
      /* A CSS font stack is a fallback chain, so it is only as unsafe as its
       * worst *usable* option. Testing each family in isolation failed the app's
       * own system stack on "Inter var" and "Helvetica Neue" even though it ends
       * in Arial and sans-serif. A stack is only a problem when nothing in it
       * is safe. */
      if (states.some(function (st) { return st.state === 'pass'; })) return;
      states.forEach(function (st, i) {
        if (st.state === 'fail' && offenders.indexOf(families[i]) === -1) offenders.push(families[i]);
        else if (st.state === 'warn' && soft.indexOf(families[i]) === -1) soft.push(families[i]);
      });
    });
    if (offenders.length) {
      return { status: 'fail', detail: 'The document uses fonts that are not web-safe. If the PDF does not embed them, the recruiter sees substituted text or a broken text layer.', evidence: cap(offenders), fix: 'Pick a web-safe stack such as Arial, Helvetica, Georgia, or Times New Roman in the Design panel.' };
    }
    if (soft.length) {
      return { status: 'warn', detail: 'The stack is built from fonts that are not on the web-safe list. That is usually fine, but only if the exported PDF embeds them.', evidence: cap(soft), fix: 'Export a PDF and reopen it on another machine to confirm the fonts survived.' };
    }
    return { status: 'pass', detail: 'Every font in the document stack is web-safe or a generic system font.', evidence: [], fix: null };
  }

  function cBulletGlyphs(ctx) {
    var glyph = ctx.d.bulletGlyph;
    var offenders = [];
    if (glyph && ['disc', 'square', 'dash', 'none'].indexOf(glyph) === -1) {
      offenders.push('design.bulletGlyph = "' + glyph + '"');
    }
    if (glyph === 'none') {
      return { status: 'warn', detail: 'Bullets are turned off. Unmarked paragraphs lose their list structure on extraction.', evidence: ['design.bulletGlyph = none'], fix: 'Use a standard disc, square, or dash bullet so list structure survives extraction.' };
    }
    ctx.fields.text.forEach(function (f) {
      if (SYMBOL_FONT_RE.test(f.value) && ICON_BULLET_RE.test(f.value)) offenders.push(f.path + ': "' + f.value.slice(0, 40) + '"');
    });
    if (!offenders.length) {
      return { status: 'pass', detail: 'Bullets are plain typographic characters, not icons from a symbol font.', evidence: [], fix: null };
    }
    return { status: 'fail', detail: 'Icon glyphs used as bullets come out of the PDF as private-use characters and extract as mojibake.', evidence: cap(offenders), fix: 'Switch the bullet style to a standard disc, square, or dash.' };
  }

  function cLetterSpacing(ctx) {
    var tracking = Number(ctx.d.letterSpacing);
    if (isFinite(tracking) && tracking > TRACKING_LIMIT_EM) {
      return { status: 'fail', detail: 'Letter-spacing of ' + tracking + 'em is applied to the document. Tracking widens every glyph run, and extractors treat the gaps as word breaks.', evidence: ['design.letterSpacing = ' + tracking], fix: 'Set tracking to 0 in the Design panel.' };
    }
    if (docReady(ctx.doc)) {
      var offenders = [];
      var checked = 0;
      U.qsa('*', ctx.doc).forEach(function (node) {
        if (offenders.length >= 4 || checked >= 60) return;
        if (!visible(node) || !textOf(node)) return;
        if (node.children.length) return;
        var cs = styleOf(node);
        if (!cs) return;
        checked++;
        var px = parseFloat(cs.letterSpacing);
        if (isFinite(px) && px > 0.5) offenders.push('"' + textOf(node).slice(0, 36) + '" at ' + px.toFixed(2) + 'px');
      });
      if (offenders.length) {
        return { status: 'fail', detail: 'Body text renders with letter-spacing. Extractors split tracked text into separate runs and insert spaces between letters.', evidence: cap(offenders), fix: 'Remove tracking from body text. Tracking on section headings only is fine.' };
      }
    }
    return { status: 'pass', detail: 'No letter-spacing is applied to body text.', evidence: isFinite(tracking) ? ['design.letterSpacing = ' + tracking] : [], fix: null };
  }

  function cEmoji(ctx) {
    var offenders = [];
    ctx.fields.text.forEach(function (f) {
      if (offenders.length >= 8) return;
      var found = findEmoji(f.value);
      if (found) offenders.push(f.path + ': "' + found + '" in "' + f.value.slice(0, 40) + '"');
    });
    if (!offenders.length) {
      return { status: 'pass', detail: 'No emoji anywhere in the resume content.', evidence: [], fix: null };
    }
    return { status: 'fail', detail: 'Emoji extract as multi-byte noise or as the replacement character, which shows up in the recruiter\'s search as a garbled term.', evidence: cap(offenders, 5), fix: 'Remove the emoji. If a line needs emphasis, use a word.' };
  }

  function cImages(ctx) {
    var modelPhoto = !!(ctx.r && ctx.r.basics && ctx.r.basics.photo);
    var renderedPhoto = 0;
    var extras = [];

    if (docReady(ctx.doc)) {
      U.qsa('img,svg,canvas,picture,object,embed,iframe,video', ctx.doc).forEach(function (node) {
        if (!visible(node)) return;
        var name = (node.className && typeof node.className === 'string') ? node.className.split(' ').slice(0, 2).join('.') : '';
        if (node.tagName.toLowerCase() === 'img' && (name.indexOf('photo') !== -1 || name.indexOf('avatar') !== -1 || node.getAttribute('role') === 'presentation')) {
          renderedPhoto++;
          return;
        }
        extras.push(node.tagName.toLowerCase() + (name ? ' .' + name : ''));
      });
      U.qsa('*', ctx.doc).forEach(function (node) {
        if (!visible(node)) return;
        var cs = styleOf(node);
        if (cs && cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.indexOf('url(') !== -1) {
          var cls = (node.className && typeof node.className === 'string') ? node.className.split(' ')[0] : node.tagName.toLowerCase();
          extras.push('background image on ' + cls);
        }
      });
    }

    if (extras.length) {
      return { status: 'fail', detail: 'The document carries graphics beyond an optional photo. Graphics hold no extractable text and inflate the PDF.', evidence: cap(extras, 5), fix: 'Remove icons, logos, rating stars, and skill bars. Use text.' };
    }
    if (modelPhoto || renderedPhoto) {
      return { status: 'pass', detail: 'The only image is the optional photo, which carries no text a parser needs.', evidence: modelPhoto ? ['basics.photo'] : ['photo slot in the document'], fix: null };
    }
    return { status: 'pass', detail: 'No images in the document.', evidence: [], fix: null };
  }

  /* A heading that explicitly announces itself as a section heading, used so a
   * hand-authored document is still checked without the bare tag soup. */
  function markedAsSectionHeading(node) {
    if (node.getAttribute && node.getAttribute('data-role') === 'section-heading') return true;
    if (!node.classList) return false;
    return node.classList.contains('rb-section-heading') ||
      node.classList.contains('rb-sec__heading') ||
      node.classList.contains('rb-section-title');
  }

  function cSectionHeadings(ctx) {
    var d = ctx.d;
    var evidence = [];
    var style = d.headingStyle || 'uppercase';
    if (style !== 'uppercase') {
      evidence.push('design.headingStyle = ' + style);
    }
    visibleSections(ctx.r).forEach(function (s) {
      var label = txt(s.label);
      if (label && label !== label.toUpperCase()) evidence.push('"' + label + '" is not uppercase');
    });

    if (docReady(ctx.doc)) {
      U.qsa('[data-role="section-heading"],.rb-section-heading,.rb-sec__heading,.rb-section-title,h1,h2,h3,h4', ctx.doc).forEach(function (node) {
        if (!visible(node)) return;
        /* Only a heading that heads a section is a section heading. The document
         * title, every entry's employer and role, and each skill group label are
         * h1..h4 as well, and requiring a company name to be uppercase is advice
         * no document can follow. */
        var host = node.closest ? node.closest('section, [data-section-type]') : null;
        if (!markedAsSectionHeading(node) && !(host && host.firstElementChild === node)) return;
        var cs = styleOf(node);
        var label = textOf(node);
        if (!label) return;
        if (cs) {
          var weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
          var isUpper = cs.textTransform === 'uppercase' || label === label.toUpperCase();
          if (weight < 600) evidence.push('"' + label + '" is not bold (weight ' + weight + ')');
          else if (!isUpper) evidence.push('"' + label + '" is not uppercase');
        }
        var inlineNoise = U.qsa('span,em,small,time,a', node).filter(function (child) {
          return txt(child.textContent) && txt(child.textContent) !== label;
        });
        if (inlineNoise.length) {
          evidence.push('"' + label + '" shares its line with ' + U.pluralize(inlineNoise.length, 'other element'));
        }
      });
    }

    if (evidence.length) {
      return { status: 'fail', detail: 'Section headings are not consistently bold, uppercase, and alone on their line. Headings are the only structure a parser keeps, so a heading that shares a line with a date or a page number is lost.', evidence: cap(evidence, 5), fix: 'Give every section a bold uppercase heading on its own line.' };
    }
    if (!visibleSections(ctx.r).length) {
      return { status: 'skip', detail: 'No visible sections to inspect.', evidence: [], fix: null };
    }
    return { status: 'pass', detail: 'Every section has a bold, uppercase heading standing alone on its line.', evidence: visibleSections(ctx.r).map(function (s) { return txt(s.label); }), fix: null };
  }

  /* Entry and bullet geometry.
   *
   * The rule is that an entry boundary has to be more whitespace than the
   * whitespace inside an entry, so both sides of the ratio have to be the same
   * quantity. The left side used to be the median top-to-top pitch *between
   * bullet boxes*, which is one line for a one-line bullet and two for a
   * two-line one — a number that moves with how long the writing is, not with
   * the leading. A resume written in long bullets was reported as failing an
   * entry-spacing rule it passes. The leading is what the browser already
   * computed, so read it off the bullet instead of inferring it.
   *
   * The DOM pass measures pixels and the model fallback is in points, so the
   * px-per-pt scale is recovered from the rendered body size before anything is
   * returned. Preview zoom scales every measured box by the same factor, so it
   * cancels out of the ratio; dividing by the scale keeps the printed numbers
   * in points as well.
   */
  function measureGeometry(ctx) {
    var size = Number(ctx.d.baseSizePt) || 10.5;
    var leading = Number(ctx.d.lineHeight) || 1.32;
    var entryGap = Number(ctx.d.entryGapPt);
    var lineGap = size * leading;
    var source = 'model';
    var perPt = 1;

    if (docReady(ctx.doc)) {
      var bound = U.qsa('[data-bind]', ctx.doc).filter(visible);
      if (bound.length > 4) {
        var bullets = [];
        var entryTops = {};
        bound.forEach(function (node) {
          var path = node.getAttribute('data-bind') || '';
          var r = node.getBoundingClientRect();
          if (!r.height) return;
          var m = /^([a-z]+)\.(\d+)\./.exec(path);
          if (!m) return;
          var key = m[1] + '.' + m[2];
          if (entryTops[key] == null || r.top < entryTops[key]) entryTops[key] = r.top;
          if (/\.highlights\.\d+$/.test(path)) bullets.push({ path: path, key: key, node: node, top: r.top });
        });
        var tops = Object.keys(entryTops).map(function (k) { return entryTops[k]; }).sort(function (a, b) { return a - b; });
        var entryDeltas = deltas(tops);
        var leadings = bullets.map(function (b) { return leadingOf(b.node); }).filter(function (v) { return v > 0; });
        if (entryDeltas.length && leadings.length) {
          lineGap = median(leadings);
          /* Inter-entry top delta includes one line of the previous entry, so
           * the ratio is (lineGap + entryGap) / lineGap. */
          var topDelta = median(entryDeltas);
          entryGap = Math.max(0, topDelta - lineGap);
          perPt = pxPerPoint(bullets[0].node, size) || 1;
          source = 'rendered document';
        }
      }
    }

    if (!isFinite(entryGap)) entryGap = 0;
    if (!(lineGap > 0)) lineGap = size * leading;
    if (!(perPt > 0)) perPt = 1;
    return {
      entryGap: entryGap / perPt,
      lineGap: lineGap / perPt,
      ratio: 1 + entryGap / lineGap,
      source: source
    };
  }

  /* The browser's own answer to "how far apart are two lines here", in px. */
  function leadingOf(node) {
    if (!node || !global.getComputedStyle) return 0;
    var v = parseFloat(global.getComputedStyle(node).lineHeight);
    if (isFinite(v) && v > 0) return v;
    /* `normal` computes to the used value in every engine that matters, but a
     * unitless fallback keeps a keyword line-height from reading as zero. */
    var fs = parseFloat(global.getComputedStyle(node).fontSize);
    return isFinite(fs) && fs > 0 ? fs * 1.2 : 0;
  }

  /* Rendered px per typographic point, taken from the body size so a template
   * with an optical font scale still converts correctly. */
  function pxPerPoint(node, baseSizePt) {
    if (!node || !global.getComputedStyle || !(baseSizePt > 0)) return 0;
    var fs = parseFloat(global.getComputedStyle(node).fontSize);
    if (!isFinite(fs) || fs <= 0) return 0;
    return fs / baseSizePt;
  }

  function deltas(sorted) {
    var out = [];
    for (var i = 1; i < sorted.length; i++) {
      var d = sorted[i] - sorted[i - 1];
      if (d > 0.5) out.push(d);
    }
    return out;
  }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function cEntrySpacing(ctx) {
    var geo = measureGeometry(ctx);
    var needed = geo.lineGap * ENTRY_GAP_RATIO;
    var evidence = [
      'measured from the ' + geo.source,
      'inter-bullet line gap: ' + geo.lineGap.toFixed(1) + 'pt',
      'inter-entry gap: ' + geo.entryGap.toFixed(1) + 'pt',
      'ratio: ' + geo.ratio.toFixed(2) + 'x (needs > ' + ENTRY_GAP_RATIO + 'x)'
    ];
    if (geo.ratio > ENTRY_GAP_RATIO) {
      return { status: 'pass', detail: 'Entries are separated by ' + geo.ratio.toFixed(2) + 'x the inter-bullet line gap, so section detection can tell an entry boundary from a new bullet.', evidence: evidence, fix: null };
    }
    return { status: 'fail', detail: 'Entries are only ' + geo.ratio.toFixed(2) + 'x the inter-bullet line gap apart. At ' + ENTRY_GAP_RATIO + 'x or less, section detection reads the whole block as one entry and the following company disappears into the previous one.', evidence: evidence, fix: 'Increase the gap between entries, or reduce the body line height.' };
  }

  function cConsistentDates(ctx) {
    var families = {};
    var evidence = [];
    ctx.fields.dates.forEach(function (f) {
      var fmt = dateFormat(f.value);
      if (fmt.family === 'freeText') {
        if (evidence.indexOf(f.path + ': "' + f.value + '" is not a date') === -1) evidence.push(f.path + ': "' + f.value + '" is not a date');
        return;
      }
      if (fmt.family === 'present') return;
      if (!families[fmt.family]) families[fmt.family] = { label: fmt.label, samples: [] };
      if (families[fmt.family].samples.length < 4) families[fmt.family].samples.push(f.path + ': ' + f.value);
    });
    var names = Object.keys(families);
    if (!names.length) {
      return { status: 'skip', detail: 'No recognisable dates on the resume, so there is nothing to compare.', evidence: cap(evidence, 3), fix: null };
    }
    var main = names.filter(function (n) { return n !== 'yearOnly'; });
    if (main.length > 1) {
      var mixed = names.map(function (n) { return families[n].label; });
      return { status: 'fail', detail: 'Dates use ' + mixed.length + ' different formats (' + mixed.join(', ') + '). One timeline, one format, or a parser reads them as unrelated periods.', evidence: cap(evidence.concat(names.map(function (n) { return families[n].label + ' e.g. ' + families[n].samples[0]; })), 5), fix: 'Pick one date format and apply it to every start and end date.' };
    }
    if (main.length === 1 && names.indexOf('yearOnly') !== -1) {
      return { status: 'warn', detail: 'Most dates use ' + families[main[0]].label + ', but some use a bare year. A parser cannot tell whether a year-only entry lasted one year or five.', evidence: cap(evidence.concat(families.yearOnly.samples), 5), fix: 'Use the same month and year format everywhere, even for education dates.' };
    }
    return { status: 'pass', detail: 'Every date uses the ' + families[names[0]].label + ' format.', evidence: cap(evidence.concat(families[names[0]].samples), 4), fix: null };
  }

  function cApostropheYear(ctx) {
    var offenders = [];
    ctx.fields.text.concat(ctx.fields.dates).forEach(function (f) {
      var m = APOSTROPHE_YEAR.exec(f.value);
      if (m) offenders.push(f.path + ': "' + f.value.slice(0, 48) + '"');
    });
    if (!offenders.length) {
      return { status: 'pass', detail: 'No two-digit apostrophe years such as Jan \'21.', evidence: [], fix: null };
    }
    return { status: 'fail', detail: 'Apostrophe years such as Jan \'21 carry no century. A parser cannot place them, and some read them as 1921.', evidence: cap(offenders, 5), fix: 'Write the full year: Jan 2021.' };
  }

  var ENTITY_RE = /\b(inc|incorporated|llc|l\.l\.c\.|ltd|ltd\.|limited|corp|corp\.|corporation|co|company|plc|gmbh|ag|sa|bv|nv|pty|pty\.?ltd|pte|llp|pllc|sarl|srl|oy|ab|as|kk|s\.a\.|kg|oyj|doo|dba|holdings|group)\b\.?/i;

  function hasEntity(str) {
    var s = txt(str);
    if (!s) return false;
    return ENTITY_RE.test(s);
  }

  function cLegalEntity(ctx) {
    var employers = visibleList(ctx.r, 'experience').filter(function (e) { return txt(e.company); });
    if (employers.length < 2) {
      return { status: 'skip', detail: 'Fewer than two named employers, so there is nothing to compare against.', evidence: [], fix: null };
    }
    var withEntity = [];
    var without = [];
    employers.forEach(function (e) {
      var suffix = txt(e.companyEntity);
      var label = txt(e.company) + (suffix ? ' (' + suffix + ')' : '');
      if (hasEntity(suffix) || hasEntity(e.company)) withEntity.push(label);
      else without.push(label);
    });
    var ratio = withEntity.length / employers.length;
    var evidence = cap(without.map(function (w) { return 'no entity: ' + w; }), 4);
    if (ratio >= ENTITY_MIN_RATIO) {
      return { status: 'pass', detail: withEntity.length + ' of ' + employers.length + ' employers (' + pct(ratio) + ') carry a legal entity suffix.', evidence: evidence, fix: null };
    }
    return { status: 'fail', detail: 'Only ' + withEntity.length + ' of ' + employers.length + ' employers (' + pct(ratio) + ') carry a legal entity suffix. Employer-record matching keys on that suffix, so "Northwind Labs" does not join "Northwind Labs, Inc."', evidence: evidence, fix: 'Add the legal entity to at least ' + Math.ceil(employers.length * ENTITY_MIN_RATIO) + ' of ' + employers.length + ' employers.' };
  }

  function collectTitles(r) {
    var titles = [];
    visibleList(r, 'experience').forEach(function (e) {
      roles(e).forEach(function (role) {
        var p = txt(role.position);
        if (p) titles.push({ path: 'experience position', value: p });
      });
    });
    visibleList(r, 'volunteer').forEach(function (v) {
      var p = txt(v.role);
      if (p) titles.push({ path: 'volunteer role', value: p });
    });
    var label = txt(r.basics && r.basics.label);
    if (label) titles.push({ path: 'basics.label', value: label });
    return titles;
  }

  function cAbbrevTitles(ctx) {
    var titles = collectTitles(ctx.r);
    if (!titles.length) {
      return { status: 'skip', detail: 'No job titles are set, so there is nothing to spell out.', evidence: [], fix: null };
    }
    var knownAcronyms = Object.keys(ACRONYM_TOKENS);
    var hard = [];
    var bare = [];
    titles.forEach(function (t) {
      t.value.split(/[\s/&,\-]+/).forEach(function (rawToken) {
        var token = rawToken.replace(/[.,]/g, '');
        if (!token) return;
        var key = token.toLowerCase();
        if (token.length <= 5 && Object.prototype.hasOwnProperty.call(TITLE_ABBREV, key)) {
          var full = TITLE_ABBREV[key];
          var line = '"' + t.value + '" -> ' + full;
          if (hard.indexOf(line) === -1) hard.push(line);
        } else if (/^[A-Z]{2,5}$/.test(token) && knownAcronyms.indexOf(token) === -1) {
          if (bare.indexOf('"' + t.value + '"') === -1) bare.push('"' + t.value + '"');
        }
      });
    });
    if (hard.length) {
      return { status: 'fail', detail: 'Abbreviated job titles do not match a recruiter search. Someone searching "Senior Software Engineer" will not find "Sr. SW Eng".', evidence: cap(hard, 5), fix: 'Spell out every title: Senior, Manager, Engineer, Specialist.' };
    }
    if (bare.length) {
      return { status: 'warn', detail: 'Some titles are written as bare acronyms. A keyword search for the spelled-out term will not find them.', evidence: cap(bare, 4), fix: 'Write the title out, for example Site Reliability Engineer instead of SRE.' };
    }
    return { status: 'pass', detail: 'All ' + titles.length + ' job titles are spelled out in full.', evidence: titles.slice(0, 4).map(function (t) { return t.value; }), fix: null };
  }

  function cRoleTitles(ctx) {
    var titles = collectTitles(ctx.r);
    var offenders = titles.filter(function (t) { return isFunctionalTitle(t.value); });
    if (!offenders.length) {
      return { status: 'pass', detail: 'Titles name a role rather than a department or a function.', evidence: titles.slice(0, 3).map(function (t) { return t.value; }), fix: null };
    }
    return { status: 'fail', detail: 'Functional titles like "' + offenders[0].value + '" name a department, not a job. They match nothing in a job-title taxonomy, so the role reads as blank.', evidence: cap(offenders.map(function (o) { return o.value; }), 4), fix: 'Use the role you held, for example Director of Product Design instead of Head of Design.' };
  }

  function cWordCount(ctx) {
    var total = ctx.fields.text.reduce(function (n, f) { return n + words(f.value); }, 0);
    var bullets = 0;
    ctx.fields.text.forEach(function (f) {
      if (/\.highlights\.\d+$/.test(f.path)) bullets += words(f.value);
    });
    var evidence = [total + ' words of extracted content', bullets + ' words inside bullet points'];
    if (total >= WORD_FLOOR) {
      return { status: 'pass', detail: total + ' words, at or above the ' + WORD_FLOOR_LABEL + '-word floor.', evidence: evidence, fix: null };
    }
    return { status: 'fail', detail: total + ' words, ' + (WORD_FLOOR - total) + ' short of the ' + WORD_FLOOR_LABEL + '-word floor. A resume this thin keyword-matches almost nothing for a senior or lead role.', evidence: evidence, fix: 'Expand the weakest roles: add scope, scale, and the outcome for each bullet.' };
  }

  var FILENAME_OK = /^([a-z]+)[-_\s]([a-z]+)[-_\s](resume|cv)([-_ ]?v?\d+)?\.(pdf|docx?|rtf|txt)$/i;

  function suggestedFileName(r) {
    var b = (r && r.basics) || {};
    var given = txt(b.givenName);
    var family = txt(b.familyName);
    if (!given || !family) {
      var parts = txt(b.name).split(/\s+/).filter(Boolean);
      given = given || parts[0] || '';
      family = family || parts[parts.length - 1] || '';
    }
    var clean = function (s) { return U.slugify(s).replace(/-/g, ''); };
    return [clean(given), clean(family)].filter(Boolean).join('_') + '_Resume.pdf';
  }

  function cFileSize(ctx) {
    var bytes = artifactBytes(ctx.artifact);
    var photo = (ctx.r && ctx.r.basics && ctx.r.basics.photo) || '';
    var estimated = bytes == null;
    /* A photo is the one thing big enough to blow the limit on its own, so a
     * data-URL length is a usable stand-in until a real export exists. */
    if (bytes == null && photo) {
      bytes = Math.round(BASE_PDF_BYTES + photo.length * DATA_URL_RATIO);
      estimated = true;
    }
    if (bytes == null) {
      return { status: 'skip', detail: 'The exported PDF size is not known yet, and there is no photo to estimate from. Export the file and this check becomes exact.', evidence: [], fix: null };
    }
    var evidence = [bytesLabel(bytes) + (estimated ? ' (estimated from the embedded photo)' : ' (measured from the last export)')];
    if (bytes <= PDF_MAX_BYTES) {
      return { status: 'pass', detail: 'The file is ' + bytesLabel(bytes) + ', under the 2.5 MB ceiling.' + (estimated ? ' This is an estimate; the exact size appears after an export.' : ''), evidence: evidence, fix: null };
    }
    return { status: 'fail', detail: 'The file is about ' + bytesLabel(bytes) + '. Upload limits sit at 2.5 MB, and a file over the limit is rejected outright rather than truncated.', evidence: evidence, fix: 'Remove the photo or compress it, then export again.' };
  }

  function cFileName(ctx) {
    var expected = suggestedFileName(ctx.r);
    var name = ctx.artifact && txt(ctx.artifact.fileName);
    if (!name) {
      return { status: 'skip', detail: 'No exported file to name-check yet. The convention is ' + expected + '.', evidence: ['expected: ' + expected], fix: null };
    }
    if (FILENAME_OK.test(name)) {
      return { status: 'pass', detail: 'The file name "' + name + '" follows the convention.', evidence: ['expected shape: ' + expected], fix: null };
    }
    return { status: 'fail', detail: 'The file name "' + name + '" does not follow the convention. Recruiters scan attachment names in a list, and "final_final2.pdf" tells them nothing.', evidence: ['expected: ' + expected], fix: 'Export as ' + expected + '.' };
  }

  var CHECKS = {
    'contact-body': cContactBody,
    'single-column': cSingleColumn,
    'no-tables': cNoTables,
    'web-safe-fonts': cWebSafeFonts,
    'bullet-glyphs': cBulletGlyphs,
    'letter-spacing': cLetterSpacing,
    'legal-entity': cLegalEntity,
    'no-abbrev-titles': cAbbrevTitles,
    'role-titles': cRoleTitles,
    'apostrophe-year': cApostropheYear,
    'file-size': cFileSize,
    'section-headings': cSectionHeadings,
    'entry-spacing': cEntrySpacing,
    'no-emoji': cEmoji,
    'no-images': cImages,
    'consistent-dates': cConsistentDates,
    'file-name': cFileName,
    'word-count': cWordCount
  };

  function makeCheck(id, res) {
    var meta = CHECK_META[id];
    return {
      id: id,
      label: meta.label,
      category: meta.category,
      weight: meta.weight,
      rule: meta.source,
      status: res.status,
      detail: res.detail,
      evidence: res.evidence || [],
      fix: res.fix || null
    };
  }

  function grade(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 60) return 'fair';
    return 'poor';
  }

  function summarise(checks) {
    var counts = { pass: 0, fail: 0, warn: 0, skip: 0, total: checks.length, blocking: 0 };
    checks.forEach(function (c) { counts[c.status]++; });
    return counts;
  }

  function scoreChecks(checks) {
    var earned = 0, weight = 0;
    checks.forEach(function (c) {
      if (c.status === 'skip') return;
      weight += c.weight;
      earned += c.weight * CREDIT[c.status];
    });
    if (!weight) return 0;
    return Math.round((earned / weight) * 100);
  }

  /* ============================ public: run ============================ */

  function run(resume, opts) {
    if (!resume || typeof resume !== 'object') {
      return {
        score: 0,
        grade: grade(0),
        summary: summarise([{
          id: 'resume', label: 'Resume loaded', category: 'Parseability', weight: 1, rule: '',
          status: 'fail', detail: 'No resume was passed to the checker.', evidence: [], fix: 'Open or create a resume first.'
        }]),
        checks: [{
          id: 'resume', label: 'Resume loaded', category: 'Parseability', weight: 1, rule: '',
          status: 'fail', detail: 'No resume was passed to the checker.', evidence: [], fix: 'Open or create a resume first.'
        }]
      };
    }
    var ctx = buildContext(resume, opts);
    var checks = [];
    CHECK_ORDER.forEach(function (id) {
      var res;
      try {
        res = CHECKS[id](ctx) || { status: 'skip', detail: 'No result.', evidence: [] };
      } catch (e) {
        /* One broken check must not take the whole pre-flight down. */
        res = { status: 'skip', detail: 'This check could not run: ' + (e && e.message ? e.message : 'unknown error'), evidence: [], fix: null };
      }
      if (CREDIT[res.status] == null) res.status = 'skip';
      checks.push(makeCheck(id, res));
    });
    var score = scoreChecks(checks);
    return { score: score, grade: grade(score), summary: summarise(checks), checks: checks };
  }

  /* ============================ public: simulate ============================ */

  function byId(report, id) {
    for (var i = 0; i < report.checks.length; i++) if (report.checks[i].id === id) return report.checks[i];
    return null;
  }

  /* A vendor finding keeps the base check shape so one renderer can list both,
   * and adds the rule citation and how firmly it is known. */
  function finding(id, label, status, detail, evidence, fix, rule, source, confidence) {
    return {
      id: id,
      label: label,
      status: status,
      detail: detail,
      evidence: evidence || [],
      fix: fix || null,
      rule: rule,
      source: source,
      confidence: confidence || 'community'
    };
  }

  function reframe(check, rule, source, confidence) {
    return finding(check.id, check.label, check.status, check.detail, check.evidence, check.fix, rule, source, confidence);
  }

  /* Section labels a parser can map. Anything else is a section it drops. */
  var STANDARD_HEADINGS = {
    summary: 1, profile: 1, 'professional summary': 1, objective: 1, 'career objective': 1, about: 1,
    experience: 1, 'work experience': 1, 'professional experience': 1, 'employment history': 1, 'employment': 1, career: 1,
    education: 1, 'academic background': 1, 'education and training': 1, qualifications: 1,
    skills: 1, 'technical skills': 1, 'core skills': 1, 'core competencies': 1, competencies: 1, expertise: 1,
    certifications: 1, 'certifications and licenses': 1, licences: 1, licenses: 1, credentials: 1,
    projects: 1, 'selected projects': 1, 'personal projects': 1,
    awards: 1, 'awards and honors': 1, 'awards and honours': 1, honors: 1, achievements: 1,
    publications: 1, 'presentations and publications': 1, papers: 1,
    volunteer: 1, volunteering: 1, 'volunteer experience': 1, 'community involvement': 1,
    languages: 1, 'language skills': 1,
    interests: 1, hobbies: 1, 'interests and hobbies': 1,
    references: 1, 'references available upon request': 1,
    coursework: 1, coursework: 1, 'relevant coursework': 1,
    contact: 1, 'contact details': 1
  };

  var HEADING_RULE = 'Section label must map to a known heading';
  var HEADING_SOURCE = 'Vendor parsing rules';

  function headingCheck(ctx) {
    var sections = visibleSections(ctx.r);
    var unknown = sections.filter(function (s) {
      var label = txt(s.label).toLowerCase().replace(/[:\s]+$/, '');
      return label && !STANDARD_HEADINGS[label];
    });
    if (!sections.length) {
      return finding('standard-headings', 'Section labels map to a known heading', 'skip',
        'No visible sections to match against the standard heading set.', [], null, HEADING_RULE, HEADING_SOURCE, 'community');
    }
    if (unknown.length) {
      var names = unknown.map(function (s) { return txt(s.label); });
      return finding('standard-headings', 'Section labels map to a known heading', 'warn',
        'Section label' + (names.length > 1 ? 's ' : ' ') + '"' + names.join('", "') + '" do' + (names.length > 1 ? '' : 'es') + ' not match a standard section name. A mapper that does not recognise a heading leaves that block out of the structured profile.',
        cap(names), 'Rename the section to its standard name, or move the content into Skills or Experience.', HEADING_RULE, HEADING_SOURCE, 'community');
    }
    return finding('standard-headings', 'Section labels map to a known heading', 'pass',
      'All ' + sections.length + ' section labels map to a standard heading.',
      sections.map(function (s) { return txt(s.label); }), null, HEADING_RULE, HEADING_SOURCE, 'community');
  }

  var ACRONYM_RULE = 'Boolean search matches full words only; acronyms are not expanded';
  var ACRONYM_SOURCE = 'Oracle Taleo recruiting user guidance';

  function acronymFinding(ctx) {
    var corpus = ctx.fields.text.map(function (f) { return f.value; }).join(' \n ');
    var lower = corpus.toLowerCase();
    var missing = [];
    Object.keys(ACRONYM_TOKENS).forEach(function (acr) {
      if (!new RegExp('(^|[^A-Za-z0-9])' + acr + '([^A-Za-z0-9]|$)').test(corpus)) return;
      if (lower.indexOf(ACRONYM_TOKENS[acr].toLowerCase()) !== -1) return;
      if (missing.indexOf(acr) === -1) missing.push(acr);
    });
    if (!missing.length) {
      return finding('acronyms', 'Acronyms are written out in full as well', 'pass',
        'Every acronym that appears is also written out in full somewhere in the resume, so a boolean search on either form hits.',
        [], null, ACRONYM_RULE, ACRONYM_SOURCE, 'documented');
    }
    return finding('acronyms', 'Acronyms are written out in full as well', 'warn',
      missing.length + ' acronym' + (missing.length > 1 ? 's appear' : ' appears') + ' with no spelled-out form. An acronym-blind boolean search for "' + ACRONYM_TOKENS[missing[0]] + '" will not match "' + missing[0] + '", and the reverse is equally true.',
      cap(missing, 6).map(function (a) { return a + ' = ' + ACRONYM_TOKENS[a]; }),
      'Write both forms in the entry: ' + ACRONYM_TOKENS[missing[0]] + ' (' + missing[0] + ').',
      ACRONYM_RULE, ACRONYM_SOURCE, 'documented');
  }

  var TITLE_RULE = 'Titles must be written out; abbreviated senior titles are not matched';
  var TITLE_SOURCE = 'Greenhouse job board help centre, resume formatting guidance';

  function seniorTitleFinding(report) {
    var check = byId(report, 'no-abbrev-titles');
    if (check.status === 'fail') {
      var senior = (check.evidence || []).filter(function (e) { return /Senior|Chief|Lead|Director|Manager|Engineer|Developer|Designer/.test(e); });
      return finding('no-abbrev-titles', check.label, 'fail',
        'Job titles are abbreviated. Greenhouse stores the title as typed and recruiters search it as written, so "Sr. Product Designer" never matches a search for "Senior Product Designer" and the resume is filtered out of that req.',
        cap(senior.length ? senior : check.evidence, 5), 'Write the title out in full.', TITLE_RULE, TITLE_SOURCE, 'documented');
    }
    if (check.status === 'warn') {
      return finding('no-abbrev-titles', check.label, 'warn',
        'Some titles are bare acronyms. Greenhouse matches titles as written, so a search for the spelled-out role will not find them.',
        cap(check.evidence, 4), 'Write each title out in full.', TITLE_RULE, TITLE_SOURCE, 'documented');
    }
    return reframe(check, TITLE_RULE, TITLE_SOURCE, 'documented');
  }

  function sizeFinding(report, sourceLabel, documented) {
    var check = byId(report, 'file-size');
    if (documented) {
      var rule = 'Attachment must be 2.5 MB or smaller';
      var source = 'Greenhouse job board help centre, supported resume formats';
      if (check.status === 'fail') {
        return finding('file-size', check.label, 'fail',
          check.detail + ' Greenhouse rejects the upload outright, so the resume is never stored and the application has to be made again from the original.',
          check.evidence, check.fix, rule, source, 'documented');
      }
      return reframe(check, rule, source, 'documented');
    }
    var tenantRule = 'Attachment size is limited per tenant';
    var tenantSource = sourceLabel + ' configuration and candidate portal help';
    if (check.status === 'fail') {
      return finding('file-size', check.label, 'fail',
        check.detail + ' ' + sourceLabel + ' enforces its own, tenant-configured ceiling, which is often tighter than 2.5 MB.',
        check.evidence, check.fix, tenantRule, tenantSource, 'community');
    }
    return reframe(check, tenantRule, tenantSource, 'community');
  }

  function flatFinding(report, vendorLabel, emphasis) {
    var keys = ['no-tables', 'single-column', 'no-images', 'contact-body', 'section-headings', 'entry-spacing'];
    var out = [];
    keys.forEach(function (id) {
      var check = byId(report, id);
      if (!check || check.status === 'pass') return;
      out.push(reframe(check, emphasis + ' ' + check.rule, vendorLabel + ' resume ingestion guidance', 'community'));
    });
    return out;
  }

  function simulate(resume, vendorId, opts) {
    var vendor = vendorById(vendorId);
    if (!vendor) {
      return { vendor: null, score: 0, verdict: 'unknown', findings: [], disclaimer: DISCLAIMER, error: 'Unknown ATS: ' + String(vendorId) + '. Expected one of ' + VENDORS.map(function (v) { return v.id; }).join(', ') + '.' };
    }
    var report = run(resume, opts);
    var ctx = buildContext(resume, opts);
    var findings = [];
    var head = headingCheck(ctx);

    if (vendor.id === 'greenhouse') {
      findings.push(seniorTitleFinding(report));
      findings.push(sizeFinding(report, 'Greenhouse', true));
      findings.push(head);
      findings = findings.concat(flatFinding(report, 'Greenhouse', 'Greenhouse flattens the document before it stores it, so'));
      var nameCheck = byId(report, 'file-name');
      findings.push(reframe(nameCheck, 'Attachment name is shown in the candidate pipeline and should be plain', 'Greenhouse job board help centre, supported resume formats', 'documented'));
    } else if (vendor.id === 'taleo') {
      findings.push(acronymFinding(ctx));
      findings.push(head);
      findings = findings.concat(flatFinding(report, 'Oracle Taleo', 'Taleo reads the document as a flat text stream, so'));
      var dates = byId(report, 'consistent-dates');
      findings.push(reframe(dates, 'The search index dates come from parsed values, so one date format yields one searchable timeline', 'Oracle Taleo recruiting user guidance', 'community'));
    } else if (vendor.id === 'workday') {
      findings.push(head);
      findings = findings.concat(flatFinding(report, 'Workday', 'Workday maps the document onto its section model, so'));
      findings.push(sizeFinding(report, 'Workday', false));
    } else if (vendor.id === 'icims') {
      findings.push(acronymFinding(ctx));
      findings.push(head);
      findings = findings.concat(flatFinding(report, 'iCIMS', 'iCIMS matches exact phrases from a structured profile, so'));
      var abbrev = byId(report, 'no-abbrev-titles');
      findings.push(reframe(abbrev, 'Profile search is exact-phrase, so a spelled-out title must appear in the resume verbatim', 'iCIMS candidate portal and recruiting user documentation', 'community'));
      findings.push(sizeFinding(report, 'iCIMS', false));
    } else if (vendor.id === 'lever') {
      findings.push(head);
      findings = findings.concat(flatFinding(report, 'Lever', 'Lever flattens layout aggressively, so'));
      var dates2 = byId(report, 'consistent-dates');
      findings.push(reframe(dates2, 'Lever builds a single normalised timeline, which breaks when the source dates use mixed formats', 'Lever recruiter product documentation', 'community'));
    } else {
      CHECK_ORDER.forEach(function (id) {
        var check = byId(report, id);
        if (check) findings.push(reframe(check, check.rule, 'Shared ATS parsing behaviour', 'community'));
      });
    }

    var blocking = findings.filter(function (f) { return f.status === 'fail'; }).length;
    var warned = findings.filter(function (f) { return f.status === 'warn'; }).length;
    var scored = findings.filter(function (f) { return f.status !== 'skip'; });
    var earned = scored.reduce(function (n, f) { return n + CREDIT[f.status]; }, 0);
    var score = scored.length ? Math.round((earned / scored.length) * 100) : 0;

    return {
      vendor: vendor,
      score: score,
      verdict: blocking ? 'will-fail' : (warned ? 'risky' : 'clean'),
      findings: findings,
      disclaimer: DISCLAIMER
    };
  }

  /* ============================ public: artifact ============================ */

  function setArtifact(artifact) {
    lastArtifact = artifact && typeof artifact === 'object' ? artifact : null;
    return lastArtifact;
  }

  function getArtifact() { return lastArtifact; }

  /* The pre-flight is a full-document walk. Callers run it off the typing
   * path, not inside an input handler. This wrapper enforces that by
   * deferring to an idle callback and dropping superseded runs. */
  var scheduleToken = 0;

  function schedule(resumeFn, done, opts) {
    var token = ++scheduleToken;
    U.requestIdle(function () {
      if (token !== scheduleToken) return;
      var resume = typeof resumeFn === 'function' ? resumeFn() : resumeFn;
      var out = run(resume, opts);
      if (typeof done === 'function') done(out);
    }, 300);
    return function cancel() { if (token === scheduleToken) scheduleToken++; };
  }

  /* ============================ export ============================ */

  RB.ats = {
    run: run,
    simulate: simulate,
    schedule: schedule,
    setArtifact: setArtifact,
    getArtifact: getArtifact,
    suggestedFileName: suggestedFileName,
    dateFormat: function (value) { return dateFormat(value).label; },
    VENDORS: VENDORS,
    CHECKS: CHECK_ORDER.map(function (id) {
      return { id: id, label: CHECK_META[id].label, category: CHECK_META[id].category, weight: CHECK_META[id].weight, rule: CHECK_META[id].source };
    }),
    thresholds: {
      wordFloor: WORD_FLOOR,
      pdfMaxBytes: PDF_MAX_BYTES,
      entryGapRatio: ENTRY_GAP_RATIO,
      entityMinRatio: ENTITY_MIN_RATIO
    },
    disclaimer: DISCLAIMER
  };

  /* The Check panel resolves every analysis module through RB.analysis
   * (assets/js/ui/analysis-panel.js). Without this the ATS tab reports the
   * module as missing and shows nothing. */
  RB.analysis = RB.analysis || {};
  RB.analysis.ats = run;
})(window);
