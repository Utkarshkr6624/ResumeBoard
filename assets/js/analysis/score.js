/* Resumeboard — resume scoring
 *
 * Two independent grades, because a beautiful template over thin content is a
 * different problem from strong content in weak typography. Collapsing them into
 * one number hides which one to fix.
 *
 * Pure: takes a resume, returns a report. Never reads the DOM, never writes the
 * model. Callers debounce into idle time (AGENTS: typing must never lag).
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var MODEL = RB.model || {};

  var BANDS = [
    { id: 'thin',      label: 'Needs work',    min: 0 },
    { id: 'weak',      label: 'Getting there', min: 45 },
    { id: 'fair',      label: 'Solid',         min: 65 },
    { id: 'strong',    label: 'Strong',        min: 80 },
    { id: 'excellent', label: 'Excellent',     min: 92 }
  ];

  /* Only consulted when RB.model is missing (standalone use, tests). The real
   * defaults come from the model so the two can never drift apart. */
  var DESIGN_FALLBACK = {
    fontFamily: 'system', baseSizePt: 10.5, lineHeight: 1.32, accent: '#1f2937',
    headingStyle: 'uppercase', sectionGapPt: 14, entryGapPt: 7, marginsIn: 0.6,
    columns: 1, bulletGlyph: 'disc'
  };

  /* Content carries more weight, but never all of it: a dense, well-evidenced
   * resume in unreadable type is still a weak resume. */
  var OVERALL_WEIGHT = { content: 0.6, design: 0.4 };

  function bands() {
    return BANDS.map(function (b) { return { id: b.id, label: b.label, min: b.min }; });
  }

  /* ---------- primitives ---------- */

  /* Piecewise-linear curve: [[input, output], ...] ascending by input. Keeps
   * every threshold in the file readable as a single literal. */
  function curve(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        var lo = points[i - 1], hi = points[i];
        var span = hi[0] - lo[0];
        if (span <= 0) return hi[1];
        return lo[1] + (hi[1] - lo[1]) * (x - lo[0]) / span;
      }
    }
    return points[points.length - 1][1];
  }

  function n1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function round(x) { return Math.round(x); }
  function nonEmpty(v) { return v != null && safeString(v).trim() !== ''; }

  /* Model fields are user text, but a malformed import can leave something that
   * String() itself refuses to coerce, such as an object with a null toString.
   * Coercion is best-effort: a field that cannot be read is an empty field, not
   * a reason to lose the whole report. */
  function safeString(v) {
    if (typeof v === 'string') return v;
    try { return String(v); }
    catch (e) { return ''; }
  }

  function plain(v) {
    if (v == null) return '';
    var s = safeString(v);
    if (s.indexOf('<') === -1 && s.indexOf('&') === -1) return s;
    return U.htmlToText(s);
  }

  function words(text) {
    var s = plain(text).trim();
    if (!s) return 0;
    return s.split(/\s+/).length;
  }

  /* A role list that a malformed import can leave as a string or an object.
   * Anything that is not an array yields no roles rather than a thrown forEach. */
  function roleList(entry) {
    return entry && Array.isArray(entry.roles) ? entry.roles : [];
  }

  /* The same guard for a custom group's entries, and for anything else read
   * off a model that a hand-edited JSON import or a share link can shape. */
  function rows(value) {
    return Array.isArray(value) ? value : [];
  }

  function lines(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = plain(arr[i]);
      if (!v.trim()) continue;
      /* One array slot can hold a pasted multi-line block. Treat each line as
       * its own bullet, otherwise a single blob wrecks bullet density. */
      v.split(/\n+/).forEach(function (l) { if (l.trim()) out.push(l.trim()); });
    }
    return out;
  }

  function visibleEntries(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (e) { return e && typeof e === 'object' && e.visible !== false; });
  }

  /* isBlankEntry cannot judge a custom section: its `entries` is an array of
   * objects, which it reads as content even when every field is empty. */
  function hasContent(entry, type) {
    if (type === 'custom') {
      return (entry.entries || []).some(function (x) {
        return x && (nonEmpty(x.title) || nonEmpty(x.org) || nonEmpty(x.text));
      });
    }
    return !MODEL.isBlankEntry(entry);
  }

  function filled(list, type) {
    return visibleEntries(list).filter(function (e) { return hasContent(e, type); });
  }

  /* ---------- lexicons ---------- */

  /* Past-tense forms, because a resume bullet starts with what the person did.
   * Deliberately absent: skills[].level ("expert", "advanced"). A self-assessed
   * proficiency bar is not evidence, so it is never read as a score input. */
  var ACTION_VERBS = ('lead led build built drive drove launch launched reduce reduced cut increase ' +
    'increased grow grew improve improved expand expanded rebuild rebuilt create created establish ' +
    'established develop developed deliver delivered own owned manage managed mentor mentored ' +
    'automate automated migrate migrated scale scaled secure secured generate generated analyze ' +
    'analyzed analyse analysed research researched coordinate coordinated streamline streamlined ' +
    'standardize standardized unify unified optimize optimise optimized instrument instrumented ' +
    'prototype prototyped validate validated test tested ship shipped win won earn earned save saved ' +
    'design designed implement implemented engineer architected negotiate negotiated present ' +
    'presented publish published train trained hire hired onboard onboarded accelerate accelerated ' +
    'transform transformed convert converted transition transitioned execute executed perform ' +
    'performed raise raised drop dropped replace replaced simplify simplified strengthen strengthened ' +
    'speed sped visualize visualise conceptualize conceptualise craft crafted shape shaped').split(' ');

  var VERB_SET = {};
  ACTION_VERBS.forEach(function (v) { VERB_SET[v] = true; });

  var OUTCOME_VERBS = /\b(increase|increas\w*|reduce|reduc\w*|cut|improv\w*|grow|grew|sav\w*|boost\w*|expand\w*|accelerat\w*|deliver\w*|launch\w*|ship\w*|built|award\w*|win|won|earn\w*|transform\w*|doubl\w*|tripl\w*|halv\w*|speed\w*|streamlin\w*|automat\w*|migrat\w*|drop\w*|rais\w*|replac\w*|simplif\w*|strengthen\w*|recover\w*|surpass\w*|exceed\w*|topped)\b/i;

  var SCOPE_WORDS = /\b(customers?|users?|patients?|clients?|members?|students?|employees?|team|teams|revenue|market|company|firm|studio|school|hospital|subscribers?|visitors?|tenants?|accounts?|books?|sessions?|transactions?|nurses?|doctors?|families|households|partners?|regions?|markets?|sales|tickets?|orders?|downloads?|installs?)\b/i;

  var METRIC = /(\d|\$|€|£|¥|₹|%|×|percent\b|per cent\b|double[sd]?\b|tripl\w*|halv\w+|quarter\b|thousand\b|million\b|billion\b)/i;

  var STOPWORDS = ('a an the and or of for to in on at by with from as is are be been was were will would can ' +
    'could should may might do does did have has had this that these those it its his her their our your my ' +
    'who whom which what where when how not no nor so than then there here into over under about above below ' +
    'you your we our they their he she them us me i am own using use used new all any both each more most ' +
    'other some such only own same too very s t just don now').split(' ');

  var STOP = {};
  STOPWORDS.forEach(function (w) { STOP[w] = true; });

  /* Seniority and org-structure words. A target role of "Senior Product
   * Designer" should not be scored on whether the word "senior" comes back. */
  var LEVEL_WORDS = ('senior junior lead principal staff head director manager chief vp intern ' +
    'associate assistant specialist advisor coordinator executive general deputy officer president ' +
    'founder owner partner graduate trainee apprentice freelance contractor').split(' ');
  var LEVEL_STOP = {};
  LEVEL_WORDS.forEach(function (w) { LEVEL_STOP[w] = true; });

  /* Fonts that exist on a reader's machine without shipping a webfont. The app
   * is forbidden from loading fonts from a CDN, so anything outside these lists
   * is a gamble on the reader's OS. */
  var WEB_SAFE_FONTS = ('system system-ui sans-serif serif arial helvetica times times new roman georgia ' +
    'courier courier new verdana tahoma trebuchet ms galamond palatino').split(' ').join('|');
  /* The Design panel shows these families as categories. The Check panel has to
   * use the same words, or the two panels describe one setting differently. */
  var FONT_CATEGORIES = { system: 'sans serif', serif: 'serif', mono: 'monospace' };
  var FONT_CATEGORY_LABELS = { system: 'Sans serif', serif: 'Serif', mono: 'Monospace' };

  var WEB_SAFE_RE = new RegExp('^(?:' + WEB_SAFE_FONTS + ')(?:\\s*,.*)?$', 'i');
  var FAMILIAR_RE = new RegExp('^(?:calibri|cambria|candara|constantia|corbel|segoe ui|roboto|lato|open sans|montserrat|source sans pro|noto sans)(?:\\s*,.*)?$', 'i');

  var HEADING_STYLES = { uppercase: true, title: true, rule: true };
  var BULLET_GLYPHS = { disc: 1, square: 1, dash: 1, none: 0.55 };

  /* The page a resume is printed on, not an app theme token: contrast is always
   * measured against paper. */
  var PAPER = '#ffffff';

  var WORD_TARGETS = { entry: 300, junior: 360, mid: 450, senior: 560, lead: 660, executive: 760 };

  /* ---------- collection ---------- */

  function collect(resume) {
    var b = resume.basics || {};
    var body = [];
    var bullets = [];
    var ctx = { body: '', bullets: bullets, words: 0, entries: { sectionCount: 0, emptySections: [] } };

    function add(v) { var t = plain(v).trim(); if (t) body.push(t); }
    function addList(list) { lines(list).forEach(function (l) { body.push(l); bullets.push(l); }); }

    add(b.name); add(b.givenName); add(b.familyName); add(b.label); add(b.summary);
    if (b.location) { add(b.location.city); add(b.location.region); }
    if (Array.isArray(b.profiles)) b.profiles.forEach(function (p) { if (p) add(p.label); });

    visibleEntries(resume.experience).forEach(function (e) {
      add(e.company); add(e.companyEntity); add(e.location);
      roleList(e).forEach(function (r) {
        if (!r || r.visible === false) return;
        add(r.position); add(r.summary);
        lines(r.skills).forEach(add);
        addList(r.highlights);
      });
    });

    visibleEntries(resume.projects).forEach(function (e) { add(e.name); add(e.summary); lines(e.keywords).forEach(add); addList(e.highlights); });

    visibleEntries(resume.volunteer).forEach(function (e) { add(e.role); add(e.organization); add(e.location); addList(e.highlights); });

    visibleEntries(resume.presentations).forEach(function (e) { add(e.title); add(e.event); add(e.location); addList(e.highlights); });

    visibleEntries(resume.skills).forEach(function (e) { add(e.label); lines(e.keywords).forEach(add); });

    visibleEntries(resume.education).forEach(function (e) {
      add(e.institution); add(e.studyType); add(e.area); add(e.score); lines(e.courses).forEach(add);
    });

    visibleEntries(resume.certifications).forEach(function (e) { add(e.name); add(e.issuer); });
    visibleEntries(resume.publications).forEach(function (e) { add(e.title); add(e.authers); add(e.venue); });
    visibleEntries(resume.awards).forEach(function (e) { add(e.title); add(e.awarder); });
    visibleEntries(resume.languages).forEach(function (e) { add(e.language); add(e.fluency); });
    visibleEntries(resume.interests).forEach(function (e) { add(e.label); });
    visibleEntries(resume.references).forEach(function (e) { add(e.name); add(e.label); add(e.contact); });
    visibleEntries(resume.coursework).forEach(function (e) { add(e.name); add(e.institution); });

    visibleEntries(resume.custom).forEach(function (e) {
      add(e.label);
      /* A custom group whose `entries` arrived as a string rather than a list
       * is the one shape this walk had no guard for, and it took the whole
       * report down with it — the same reason roleList() exists above. */
      rows(e.entries).forEach(function (x) { if (x) { add(x.title); add(x.org); addList(plain(x.text).split(/\n+/)); } });
    });

    ctx.body = body.join(' \n ').toLowerCase();
    ctx.bullets = bullets;
    ctx.wordCount = body.reduce(function (sum, t) { return sum + words(t); }, 0);
    return ctx;
  }

  function termsFrom(phrase, extraStop) {
    var out = [], seen = {};
    plain(phrase).toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u).forEach(function (t) {
      t = t.replace(/^[.-]+|[.-]+$/g, '');
      if (!t || /^\d+$/.test(t)) return;
      /* 2-4 letter tokens are treated as acronyms (ai, ux, seo, aws); anything
       * shorter is a fragment, and longer must be a real word. */
      if (t.length < (t.length <= 4 ? 2 : 3)) return;
      if (STOP[t] || (extraStop && extraStop[t])) return;
      if (seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out;
  }

  function bodyHas(body, term) {
    var safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* (?![a-z0-9]) stops "java" from matching "javascript"; the optional plural
     * keeps "design" matching "designs" without a second pass. */
    return new RegExp('(?:^|[^a-z0-9+#.])(?:' + safe + ')(?:e?s)?(?![a-z0-9])', 'i').test(body);
  }

  function skillTerms(resume) {
    var out = [], seen = {};
    visibleEntries(resume.skills).forEach(function (e) {
      var group = [];
      if (nonEmpty(e.label)) group = group.concat(termsFrom(e.label));
      lines(e.keywords).forEach(function (k) { group = group.concat(termsFrom(k)); });
      group.forEach(function (t) { if (!seen[t]) { seen[t] = true; out.push(t); } });
    });
    return out;
  }

  /* ---------- content checks ---------- */

  function checkKeywords(resume, ctx) {
    var meta = resume.meta || {}, b = resume.basics || {};
    var seed = nonEmpty(meta.targetRole) ? meta.targetRole : b.label;
    var terms = nonEmpty(seed) ? termsFrom(seed, LEVEL_STOP) : [];
    var base = {
      id: 'keywords', label: 'Keyword coverage', weight: 14,
      fix: 'Mirror the wording of the job post in your own bullets: the tools, methods and outcomes it names.'
    };

    if (terms.length) {
      var hit = terms.filter(function (t) { return bodyHas(ctx.body, t); });
      var ratio = hit.length / terms.length;
      return {
        base: base,
        score: curve([[0, 0.1], [0.34, 0.45], [0.67, 0.75], [1, 1]], ratio) * 100,
        value: hit.length + ' of ' + terms.length + ' terms used',
        detail: 'Measured against the target role "' + plain(seed).trim() + '": ' +
          (hit.length ? hit.join(', ') : 'none of these words appear anywhere in the resume') + '.' +
          (terms.length < 3 ? ' That target is too generic to be discriminating, so read this as a prompt to copy the job post wording rather than a verdict.' : '')
      };
    }

    var declared = skillTerms(resume);
    if (!declared.length) {
      return { base: base, skip: 'No target role and no skills to compare against, so there is no keyword set to measure.' };
    }
    return {
      base: base,
      score: curve([[0, 0.05], [8, 0.35], [14, 0.7], [20, 0.9], [28, 1]], declared.length) * 100,
      value: declared.length + ' distinct terms',
      detail: 'No target role is set, so this measures declared skill breadth instead of matching against a job post.'
    };
  }

  function checkQuantified(ctx) {
    var base = {
      id: 'quantified', label: 'Quantified achievements', weight: 18,
      fix: 'Give each bullet a number: a percentage, a count, a time saved, a revenue figure.'
    };
    if (!ctx.bullets.length) {
      return { base: base, skip: 'No bullet points written, so there is nothing to measure.' };
    }
    var withNumber = ctx.bullets.filter(function (b) { return METRIC.test(b); });
    var ratio = withNumber.length / ctx.bullets.length;
    return {
      base: base,
      score: curve([[0, 0.05], [0.2, 0.3], [0.4, 0.6], [0.6, 0.85], [0.8, 1], [1, 1]], ratio) * 100,
      value: withNumber.length + ' of ' + ctx.bullets.length,
      detail: ratio >= 0.8
        ? 'Nearly every bullet carries a number.'
        : (function () {
          var bare = ctx.bullets.length - withNumber.length;
          return bare === 1
            ? 'One bullet has no figure, and reads as description rather than result.'
            : U.pluralize(bare, 'bullet') + ' have no figure, and read as description rather than result.';
        })()
    };
  }

  function checkActionVerbs(ctx) {
    var base = {
      id: 'verbs', label: 'Action-verb openers', weight: 12,
      fix: 'Start each bullet with a past-tense action verb, so the eye gets the verb first.'
    };
    if (!ctx.bullets.length) {
      return { base: base, skip: 'No bullet points written, so there is nothing to measure.' };
    }
    var started = ctx.bullets.filter(function (b) {
      var first = (b.replace(/^[•\-–—\s"'“‘(\[*]+/, '').split(/[\s,;:—-]+/)[0] || '').toLowerCase();
      /* Match the form and its stem: "designed" -> "design", "led" -> "led". */
      return VERB_SET[first] || VERB_SET[first.replace(/(ed|es|s|d|ing)$/, '')];
    });
    var ratio = started.length / ctx.bullets.length;
    return {
      base: base,
      score: curve([[0, 0.05], [0.2, 0.25], [0.4, 0.5], [0.6, 0.75], [0.8, 0.95], [1, 1]], ratio) * 100,
      value: started.length + ' of ' + ctx.bullets.length,
      detail: ratio >= 0.85
        ? 'Bullets open on a verb, which is what a six-second skim needs.'
        : 'Some bullets open on a noun phrase, so the result is buried in the line.'
    };
  }

  function checkDensity(ctx) {
    var base = {
      id: 'density', label: 'Bullet density', weight: 10,
      fix: 'Aim for one to two lines per bullet. Cut the setup and keep the result.'
    };
    if (!ctx.bullets.length) {
      return { base: base, skip: 'No bullet points written, so there is nothing to measure.' };
    }
    var lens = ctx.bullets.map(words);
    var avg = lens.reduce(function (a, x) { return a + x; }, 0) / lens.length;
    var over = lens.filter(function (w) { return w > 34; }).length;
    var under = lens.filter(function (w) { return w < 8; }).length;
    return {
      base: base,
      score: curve([[8, 0.4], [12, 0.7], [16, 0.95], [20, 1], [26, 1], [32, 0.8], [40, 0.5], [48, 0.3], [60, 0.12]], avg) * 100,
      value: Math.round(avg) + ' words per bullet',
      detail: (over || under)
        ? U.pluralize(over, 'bullet') + ' ' + (over === 1 ? 'runs' : 'run') + ' past 34 words, and ' +
          U.pluralize(under, 'bullet') + ' ' + (under === 1 ? 'is' : 'are') + ' too short to carry a result.'
        : 'Every bullet sits between 8 and 34 words.'
    };
  }

  function checkSections(resume) {
    var b = resume.basics || {};
    var secs = (resume.sections || []).filter(function (s) { return s && s.visible !== false; });
    var empty = [];
    var filledCount = 0;

    secs.forEach(function (s) {
      if (s.type === 'summary') {
        if (nonEmpty(b.summary)) { filledCount++; return; }
        empty.push(labelOf(s, 'Summary'));
        return;
      }
      var list = filled(resume[s.type], s.type);
      if (list.length) filledCount++;
      else empty.push(labelOf(s, MODEL.typeMeta(s.type).label));
    });

    var hasExp = filled(resume.experience, 'experience').some(function (e) {
      return roleList(e).some(function (r) { return r && (nonEmpty(r.position) || nonEmpty(e.company)); });
    });
    var hasEdU = filled(resume.education, 'education').length > 0;
    var hasSkills = filled(resume.skills, 'skills').length > 0;

    /* Education or skills, not both: plenty of strong resumes have one or the
     * other, and demanding both punishes a legitimate shape. */
    var core = [nonEmpty(b.summary), hasExp, (hasEdU || hasSkills)];
    var coreRatio = core.filter(Boolean).length / core.length;
    var fillRatio = secs.length ? filledCount / secs.length : 0;

    return {
      id: 'sections', label: 'Section completeness', weight: 16,
      fix: empty.length ? 'Fill the empty sections, or hide the ones you are not using.' : 'Review the section order for the role.',
      score: (coreRatio * 0.65 + fillRatio * 0.35) * 100,
      value: filledCount + ' of ' + secs.length + ' sections filled',
      detail: empty.length
        ? 'Still empty: ' + empty.join(', ') + '.'
        : 'Every visible section has content in it.'
    };
  }

  function labelOf(sec, fallback) {
    return nonEmpty(sec.label) ? plain(sec.label).trim() : fallback;
  }

  function checkWordCount(resume, ctx) {
    var level = (resume.meta && resume.meta.experienceLevel) || 'mid';
    var target = WORD_TARGETS[level] || WORD_TARGETS.mid;
    var ratio = ctx.wordCount / target;
    return {
      id: 'words', label: 'Length against target', weight: 14,
      fix: ratio < 1
        ? 'Add substance: another role, a project, or results you left out.'
        : 'Cut the weakest material until the page count is honest.',
      score: curve([[0, 0.05], [0.5, 0.35], [0.75, 0.7], [0.9, 1], [1.2, 1], [1.5, 0.6], [1.9, 0.25], [2.4, 0.05]], ratio) * 100,
      value: ctx.wordCount + ' words',
      detail: 'Target for a ' + level + '-level resume is about ' + target + ' words.'
    };
  }

  function checkContact(resume) {
    var b = resume.basics || {};
    var loc = b.location || {};
    var hasProfile = (Array.isArray(b.profiles) && b.profiles.some(function (p) { return p && nonEmpty(p.url); })) || nonEmpty(b.url);
    /* Email and name are weighted heaviest: an ATS keys on the email and
     * matches the name string, everything else is decoration. */
    var parts = [
      { on: nonEmpty(b.email), w: 2, note: 'email' },
      { on: nonEmpty(b.name), w: 2, note: 'name' },
      { on: hasProfile, w: 1.5, note: 'a portfolio or profile link' },
      { on: nonEmpty(b.phone), w: 1.5, note: 'phone' },
      { on: nonEmpty(loc.city) || nonEmpty(loc.region) || nonEmpty(loc.countryCode), w: 1, note: 'location' }
    ];
    var missing = parts.filter(function (p) { return !p.on; }).map(function (p) { return p.note; });
    var got = parts.reduce(function (s, p) { return s + (p.on ? p.w : 0); }, 0);
    var all = parts.reduce(function (s, p) { return s + p.w; }, 0);
    return {
      id: 'contact', label: 'Contact details', weight: 12,
      fix: missing.length ? 'Add the missing contact details: ' + missing.join(', ') + '.' : 'Double-check the details for typos.',
      score: (got / all) * 100,
      value: (parts.length - missing.length) + ' of ' + parts.length,
      detail: missing.length
        ? 'Missing ' + missing.join(', ') + '. Without an email, a parser has no key to file you under.'
        : 'Name, email, phone, location and a link are all present.'
    };
  }

  function checkSummary(resume) {
    var b = resume.basics || {};
    var summary = plain(b.summary).trim();
    var base = {
      id: 'summary', label: 'Summary states an outcome', weight: 14,
      fix: 'Rewrite the summary to name what you changed and what it produced.'
    };
    if (!summary) {
      return { base: base, skip: 'No summary written, so there is nothing to measure.' };
    }
    var w = words(summary);
    var points = 0;
    if (METRIC.test(summary)) points += 0.5;
    if (OUTCOME_VERBS.test(summary)) points += 0.3;
    if (SCOPE_WORDS.test(summary)) points += 0.2;
    var score = curve([[0, 0.15], [0.5, 0.5], [0.8, 0.85], [1, 1]], points) * 100;
    if (w < 25) score = Math.min(score, 40);

    var parts = [];
    if (!METRIC.test(summary)) parts.push('no measurable result');
    if (!OUTCOME_VERBS.test(summary)) parts.push('no outcome verb');
    if (!SCOPE_WORDS.test(summary)) parts.push('no audience or scope');

    return {
      base: base,
      score: score,
      value: w + ' words',
      detail: parts.length
        ? 'The summary reads as ' + parts.join(', ') + '.'
        : 'The summary names an outcome, with a number and the scope behind it.'
    };
  }

  /* ---------- design checks ---------- */

  function checkTypography(design) {
    var size = Number(design.baseSizePt) || 10.5;
    var family = String(design.fontFamily || 'system');
    var key = family.trim().toLowerCase();
    var category = Object.prototype.hasOwnProperty.call(FONT_CATEGORIES, key) ? FONT_CATEGORIES[key] : null;
    var face = category ? 'the ' + category : family;
    var sizeScore = curve([[7.5, 0.05], [9, 0.3], [9.5, 0.6], [10, 1], [11.5, 1], [12.5, 0.8], [13, 0.55], [14, 0.3]], size);
    var fontScore = WEB_SAFE_RE.test(family.trim()) ? 1 : (FAMILIAR_RE.test(family.trim()) ? 0.7 : 0.35);
    return {
      id: 'type', label: 'Type size and font safety', weight: 16,
      fix: fontScore < 1
        ? 'Switch to a web-safe font. This app ships no webfonts, so an unfamiliar family falls back on the reader machine.'
        : 'Bring the body size up toward 10.5-11.5pt. Small type is the fastest way to lose a human reader.',
      score: (sizeScore * 0.55 + fontScore * 0.45) * 100,
      value: size + 'pt ' + (FONT_CATEGORY_LABELS[key] || family),
      detail: size < 9.5
        ? 'At ' + size + 'pt the body text is below what a recruiter reads comfortably.'
        : 'At ' + size + 'pt the body sits in a readable range, and ' + face + ' is safe on a reader machine with no webfont to load.'
    };
  }

  function checkLineHeight(design) {
    var lh = Number(design.lineHeight) || 1.32;
    return {
      id: 'leading', label: 'Line height', weight: 12,
      fix: 'Set line height to 1.25-1.45. Tighter walls the text together, looser breaks the paragraph apart.',
      score: curve([[1.05, 0.1], [1.15, 0.45], [1.25, 0.9], [1.32, 1], [1.45, 1], [1.6, 0.6], [1.8, 0.3], [2, 0.15]], lh) * 100,
      value: lh + ' line height',
      detail: (lh >= 1.25 && lh <= 1.45)
        ? lh + ' keeps full-width lines readable without breaking them into stripes.'
        : lh + ' is outside the 1.25-1.45 band that suits body text at this measure.'
    };
  }

  function checkRhythm(design) {
    var secGap = Number(design.sectionGapPt) || 14;
    var entryGap = Number(design.entryGapPt) || 7;
    var ratio = entryGap > 0 ? secGap / entryGap : 99;
    var secScore = curve([[0, 0.1], [6, 0.4], [10, 1], [20, 1], [28, 0.6], [40, 0.25]], secGap);
    var entryScore = curve([[0, 0.15], [2, 0.5], [4, 1], [10, 1], [16, 0.6], [30, 0.3]], entryGap);
    var ratioScore = curve([[0.5, 0.2], [1, 0.5], [1.6, 1], [3.2, 1], [5, 0.5], [12, 0.15]], ratio);
    return {
      id: 'rhythm', label: 'Section gap rhythm', weight: 12,
      fix: 'Set section gaps near 14pt and entry gaps near 7pt, so the page has one clear beat per section.',
      score: (secScore * 0.45 + entryScore * 0.35 + ratioScore * 0.2) * 100,
      value: secGap + 'pt / ' + entryGap + 'pt',
      detail: (ratio >= 1.6 && ratio <= 3.2)
        ? 'Sections get ' + n1(ratio) + 'x the space of entries, which is what makes the page scannable.'
        : 'Sections get ' + n1(ratio) + 'x the space of entries, so the hierarchy is flat or too jumpy.'
    };
  }

  function checkHeadings(resume, design) {
    var style = String(design.headingStyle || '');
    var visible = (resume.sections || []).filter(function (s) { return s && s.visible !== false; });
    var unlabelled = [], upper = 0, mixed = 0;
    visible.forEach(function (s) {
      var label = plain(s.label || '').trim();
      if (label.length < 2) { unlabelled.push(MODEL.typeMeta(s.type).label); return; }
      var isUpper = label === label.toUpperCase() && /[A-Z]/.test(label);
      if (isUpper) upper++; else mixed++;
    });

    var styleOK = Object.prototype.hasOwnProperty.call(HEADING_STYLES, style);
    var labelScore = visible.length ? (visible.length - unlabelled.length) / visible.length : 0.5;
    /* The renderer applies the chosen transform, so mixed stored casing only
     * matters for styles that do not transform the text. */
    var caseScore = 1;
    if (style !== 'uppercase' && upper > 0 && mixed > 0) caseScore = 0.4;
    if (style === 'uppercase' && unlabelled.length) caseScore = 0.7;

    return {
      id: 'headings', label: 'Heading consistency', weight: 12,
      fix: !styleOK
        ? 'Pick a supported heading style: uppercase, title or rule.'
        : unlabelled.length
          ? 'Give every section a real heading, or hide the section.'
          : 'Pick one heading style and use it on every section.',
      score: styleOK ? (1 * 0.5 + labelScore * 0.3 + caseScore * 0.2) * 100 : 15,
      value: style || 'unset',
      detail: !styleOK
        ? '"' + style + '" is not a supported heading style, so sections fall back to the template default and headings stop matching each other.'
        : unlabelled.length
          ? 'These sections have no heading: ' + unlabelled.join(', ') + '.'
          : 'All ' + visible.length + ' sections use the ' + style + ' style.'
    };
  }

  function checkContrast(design) {
    var accent = String(design.accent || '');
    var base = {
      id: 'contrast', label: 'Accent contrast on white', weight: 16,
      fix: 'Darken the accent. Anything lighter than 4.5:1 on white stops being readable for body-adjacent text.'
    };
    var c = U.contrast(accent);
    if (!c) {
      return { base: base, skip: 'The accent colour is not a parseable hex value, so contrast cannot be computed.' };
    }
    var ratio = c.ratio(PAPER);
    if (ratio == null) {
      return { base: base, skip: 'Contrast against white could not be computed for this accent.' };
    }
    return {
      base: base,
      score: curve([[1, 0], [2, 0.2], [3, 0.45], [4.5, 0.85], [7, 1], [21, 1]], ratio) * 100,
      value: n1(ratio) + ':1 on white',
      detail: ratio >= 4.5
        ? 'Accent ' + accent + ' clears AA for normal text.'
        : 'Accent ' + accent + ' sits at ' + n1(ratio) + ':1. AA needs 4.5:1 for body text, 3:1 for large headings.'
    };
  }

  function checkColumns(design) {
    return {
      id: 'columns', label: 'ATS column safety', weight: 14,
      fix: 'Set the layout to a single column. Parsers read across before down, so two columns scramble the dates.',
      score: Number(design.columns) === 1 ? 100 : 30,
      value: Number(design.columns) === 1 ? 'single column' : 'two columns',
      detail: Number(design.columns) === 1
        ? 'Single column: everything reads top to bottom, which every parser handles.'
        : 'Two columns. Many applicant tracking systems read across then down, so your end dates land in the wrong row.'
    };
  }

  function checkMargins(design) {
    var m = Number(design.marginsIn) || 0.6;
    var page = design.pageSize === 'A4' ? 'A4' : 'Letter';
    return {
      id: 'margins', label: 'Margins', weight: 10,
      fix: m < 0.4
        ? 'Widen the margins to at least 0.5in. Thin margins get clipped by most printers.'
        : 'Bring the margins back toward 0.5-0.8in; wider margins buy whitespace you do not need.',
      score: curve([[0.2, 0.15], [0.35, 0.45], [0.5, 1], [0.8, 1], [1, 0.6], [1.2, 0.35], [1.5, 0.15]], m) * 100,
      value: m + 'in on ' + page,
      detail: (m >= 0.5 && m <= 0.8)
        ? m + 'in is the standard range: safe at the printer edge, no wasted page.'
        : m + 'in sits outside the 0.5-0.8in band that printers and reviewers both expect.'
    };
  }

  function checkBullets(design, ctx) {
    var glyph = String(design.bulletGlyph || '');
    /* Read through the own-property test rather than straight off the object: a
     * design value of "constructor" answered from Object.prototype, and the
     * weighted design grade came out NaN, which is not a score anyone can act
     * on. A hand-edited JSON import or a share link can put any string in
     * design, so the same shape of lookup guards FONT_CATEGORIES in
     * checkTypography and HEADING_STYLES in checkHeadings. */
    var known = Object.prototype.hasOwnProperty.call(BULLET_GLYPHS, glyph);
    var base = known ? BULLET_GLYPHS[glyph] : 0;
    var hasBullets = ctx.bullets.length > 0;
    if (known && glyph === 'none' && hasBullets) base = 0.55;

    return {
      id: 'glyph', label: 'Bullet glyph uniformity', weight: 8,
      fix: !known
        ? 'Use one of the supported glyphs: disc, square or dash.'
        : glyph === 'none' && hasBullets
          ? 'Turn bullets back on. Unmarked lines run together when a reviewer skims.'
          : 'Keep one glyph across the whole document.',
      score: base * 100,
      value: known ? glyph + ' bullets' : glyph + ' (unsupported)',
      detail: !known
        ? '"' + glyph + '" is not one of the supported marks, so each section falls back to the template default and the glyphs can differ.'
        : glyph === 'none' && hasBullets
          ? 'Bullets are turned off while you have ' + ctx.bullets.length + ' bullet lines, so the list reads as a block of text.'
          : 'One glyph throughout, which is what keeps a two-page resume readable.'
    };
  }

  /* ---------- assembly ---------- */

  /* Skipped items are removed from the denominator, not scored zero and not
   * counted as full marks. A check that cannot be measured is neither a pass
   * nor a failure, so it leaves the weighted total and the list instead.
   *
   * `status`, `points` and `max` are the same numbers under the names the Check
   * panel reads; it normalises a richer shape than it documents. */
  function gather(results, skipped) {
    var items = [];
    results.forEach(function (r) {
      var base = r.base || r;
      if (r.skip) { skipped.push({ scope: r.scope, label: base.label, why: r.skip }); return; }
      var score = round(Math.max(0, Math.min(100, r.score)));
      items.push({
        id: base.id,
        label: base.label,
        value: r.value,
        detail: r.detail,
        score: score,
        status: score >= 80 ? 'pass' : (score >= 55 ? 'warn' : 'fail'),
        points: score,
        max: 100,
        weight: base.weight,
        fix: base.fix
      });
    });
    return items;
  }

  function total(items) {
    var sum = 0, weight = 0;
    items.forEach(function (i) { sum += i.score * i.weight; weight += i.weight; });
    if (!weight) return 0;
    return Math.round(sum / weight);
  }

  function bandFor(score) {
    var found = BANDS[0];
    for (var i = 0; i < BANDS.length; i++) if (score >= BANDS[i].min) found = BANDS[i];
    return found;
  }

  function run(resume) {
    if (!resume || typeof resume !== 'object') return null;

    var skipped = [];
    var design = Object.assign({}, MODEL.DEFAULT_DESIGN || DESIGN_FALLBACK, resume.design || {});
    var ctx = collect(resume);

    var contentChecks = [
      checkKeywords(resume, ctx),
      checkQuantified(ctx),
      checkActionVerbs(ctx),
      checkDensity(ctx),
      checkSections(resume),
      checkWordCount(resume, ctx),
      checkContact(resume),
      checkSummary(resume)
    ];
    var designChecks = [
      checkTypography(design),
      checkLineHeight(design),
      checkRhythm(design),
      checkHeadings(resume, design),
      checkContrast(design),
      checkColumns(design),
      checkMargins(design),
      checkBullets(design, ctx)
    ];
    contentChecks.forEach(function (c) { c.scope = 'content'; });
    designChecks.forEach(function (c) { c.scope = 'design'; });

    /* An empty document still "has" perfect default design settings, so scoring
     * the design grade there would hand 40 points for doing nothing. With no page
     * to look at, every design check is unmeasurable rather than excellent. */
    /* isBlankResume assumes basics fields are strings, so a resume carrying a
     * non-string name (a malformed import) would throw here and lose the whole
     * report. An unreadable field is not a reason to skip scoring. */
    var isBlank = false;
    try { isBlank = MODEL.isBlankResume(resume); } catch (e) { isBlank = false; }
    if (isBlank) {
      designChecks.forEach(function (c) {
        skipped.push({ scope: 'design', label: (c.base || c).label, why: 'The document has no content yet, so there is no page to assess.' });
      });
      designChecks = [];
    }

    var contentItems = gather(contentChecks, skipped);
    var designItems = gather(designChecks, skipped);

    var contentScore = total(contentItems);
    var designScore = total(designItems);
    var overall = Math.round(contentScore * OVERALL_WEIGHT.content + designScore * OVERALL_WEIGHT.design);

    /* Tips are ranked by points actually recoverable, not by raw score, so a
     * heavy item sitting at 60 outranks a light item sitting at 40. */
    var tips = contentItems.concat(designItems)
      .filter(function (i) { return i.fix && i.score < 95; })
      .map(function (i) { return { label: i.label, note: i.fix, gain: i.weight * (100 - i.score) / 100 }; })
      .sort(function (a, b) { return b.gain - a.gain; })
      .slice(0, 5)
      .map(function (t) { return { label: t.label, note: t.note }; });

    return {
      content: grade('Content', contentScore, contentItems, skipped, 'content'),
      design: grade('Design', designScore, designItems, skipped, 'design'),
      overall: overall,
      tips: tips,
      skipped: skipped
    };
  }

  /* One grade, shaped for the Check panel: it reads `label`, `score`, `items`
   * and a per-grade `skipped` list, while the report above uses `band` and a
   * single top-level `skipped`. Both spellings carry the same text. */
  function grade(name, score, items, skipped, scope) {
    return {
      label: name + ' — ' + bandFor(score).label,
      score: score,
      band: bandFor(score).label,
      items: items,
      skipped: skipped
        .filter(function (s) { return s.scope === scope; })
        .map(function (s) { return { label: s.label, reason: s.why, why: s.why }; })
    };
  }

  /* Utilities and model are loaded before this file. If either is missing there
   * is nothing to fall back on, so callers get a null report rather than a
   * crash mid-render. */
  if (!U || !U.contrast || !U.htmlToText || !MODEL.typeMeta) {
    RB.score = { run: function () { return null; }, bands: bands };
    return;
  }

  RB.score = { run: run, bands: bands };

  /* The Check panel probes RB.analysis.<name> as a plain function
   * (assets/js/ui/analysis-panel.js). Both names are registered so the module
   * works whichever entry point a caller uses. */
  RB.analysis = RB.analysis || {};
  RB.analysis.score = run;
})(window);
