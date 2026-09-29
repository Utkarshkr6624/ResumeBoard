/* Resumeboard — cover letter builder
 *
 * A second document that shares the resume's design: same page size, same
 * margins, same type size, same accent, same font. The renderer owns the
 * resume; this owns the letter, and the two never touch the same DOM.
 *
 * The draft is NOT part of the resume model. RB.store is the single write path
 * for the resume, and a letter is not a resume, so the draft lives in its own
 * IndexedDB record and is written through the one helper below. A reload wipes
 * it along with everything else, which is the product rule the whole app keeps.
 *
 * The generator is deterministic. It rearranges what the user already wrote —
 * the strongest line from each recent role, the terms the posting asks for —
 * into a first draft. It never invents a claim, and every sentence it emits is
 * a sentence the user can find in their own resume.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  if (!U) return;

  var KEY = 'letter:current';

  /* A letter that runs past one page is a letter nobody finishes. The warn
   * line is advisory: the counter is honest about overflow rather than
   * pretending the number is a rule. */
  var SOFT_MAX_WORDS = 420;
  var HARD_MAX_WORDS = 560;

  var SOURCES = [
    { id: 'posting',    label: 'A job posting',    blurb: 'you saw the role advertised' },
    { id: 'referral',   label: 'A referral',       blurb: 'someone put your name forward' },
    { id: 'recruiter',  label: 'A recruiter',      blurb: 'a recruiter reached out' },
    { id: 'site',       label: 'Your careers page', blurb: 'the careers page brought you here' }
  ];

  var LENGTHS = [
    { id: 'short', label: 'Short', bullets: 2 },
    { id: 'standard', label: 'Standard', bullets: 3 }
  ];

  /* The same four stacks the renderer paints onto #rb-doc, so a serif resume
   * gets a serif letter. Kept as a literal rather than a require: the renderer
   * does not export its table and a private copy of four lines is cheaper than
   * a new public surface on a file this one does not own. */
  var FONT_STACKS = {
    system: 'var(--rb-font-sans)',
    sans: 'var(--rb-font-sans)',
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    mono: 'var(--rb-font-mono)'
  };

  /* ------------------------------------------------------------------ text */

  function plain(v) {
    if (v == null) return '';
    var s = String(v);
    if (!/[<&]/.test(s)) return s;
    return U.htmlToText(s);
  }

  function one(v) {
    return plain(v).replace(/\s+/g, ' ').trim();
  }

  function sentence(v) {
    var s = one(v);
    if (!s) return '';
    if (!/[.!?]$/.test(s)) s += '.';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function clip(s, max) {
    s = one(s);
    if (s.length <= max) return s;
    var cut = s.slice(0, max);
    var at = cut.lastIndexOf(' ');
    if (at > max * 0.6) cut = cut.slice(0, at);
    return cut.replace(/[,;:\-–—]$/, '') + '…';
  }

  function cap(s) {
    s = one(s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function joinWith(parts, sep) {
    return parts.filter(Boolean).join(sep || ' ');
  }

  /* ----------------------------------------------------------------- draft */

  function blank() {
    return {
      date: '',
      toName: '',
      toCompany: '',
      toAddress: '',
      role: '',
      referrer: '',
      source: 'posting',
      tone: 'direct',
      length: 'standard',
      greeting: '',
      opening: '',
      evidence: '',
      fit: '',
      close: '',
      signoff: 'Sincerely,',
      generated: false
    };
  }

  function normalize(raw) {
    var base = blank();
    if (!raw || typeof raw !== 'object') return base;
    Object.keys(base).forEach(function (k) {
      if (k === 'source' || k === 'tone' || k === 'length' || k === 'generated') return;
      if (typeof raw[k] === 'string') base[k] = raw[k].slice(0, 4000);
    });
    if (SOURCES.some(function (s) { return s.id === raw.source; })) base.source = raw.source;
    if (raw.tone === 'direct' || raw.tone === 'warm') base.tone = raw.tone;
    if (LENGTHS.some(function (l) { return l.id === raw.length; })) base.length = raw.length;
    base.generated = !!raw.generated;
    return base;
  }

  var current = null;
  var loaded = null;

  function load() {
    if (loaded) return loaded;
    if (!RB.idb) { loaded = Promise.resolve(blank()); return loaded; }
    loaded = RB.idb.get(KEY).then(function (stored) {
      current = normalize(stored);
      return current;
    }).catch(function () {
      current = blank();
      return current;
    });
    return loaded;
  }

  function get() { return current || blank(); }

  var persist = U.debounce(function () {
    if (!RB.idb) return;
    RB.idb.set(KEY, get()).catch(function () {});
  }, 350);

  /* The only write into the draft. Everything else in the app funnels here so
   * there is one persistence path to reason about. */
  function set(patch) {
    var next = normalize(Object.assign({}, get(), patch));
    current = next;
    persist();
    return next;
  }

  function reset() {
    current = blank();
    if (RB.idb) RB.idb.del(KEY).catch(function () {});
    return current;
  }

  /* ------------------------------------------------------ resume harvesting */

  function resumeOrEmpty(r) {
    if (r && typeof r === 'object' && r.basics) return r;
    if (RB.store && RB.store.get) {
      var s = RB.store.get();
      if (s) return s;
    }
    return RB.model ? RB.model.emptyResume() : { basics: {}, design: {} };
  }

  function visibleEntries(r, type) {
    var list = Array.isArray(r[type]) ? r[type] : [];
    return list.filter(function (e) {
      if (!e || typeof e !== 'object' || e.visible === false) return false;
      return !(RB.model && RB.model.isBlankEntry && RB.model.isBlankEntry(e));
    });
  }

  function rolesOf(entry) {
    var out = (Array.isArray(entry.roles) ? entry.roles : []).filter(function (role) {
      return role && typeof role === 'object' && role.visible !== false;
    });
    return out.length ? out : [null];
  }

  function hasNumber(text) {
    return /[0-9]/.test(text);
  }

  /* A bullet that opens on a past-tense verb can be folded into a sentence
   * with a subject. Anything else — a noun phrase, a clause that has already
   * got one — is left exactly as the user wrote it, because inventing a frame
   * for it would mean inventing the grammar too. */
  var VERB_OPENER = /^(led|built|designed|shipped|created|launched|ran|owned|drove|grew|reduced|increased|cut|saved|established|managed|coordinated|delivered|rewrote|migrated|automated|mentored|trained|analy[sz]ed|defined|introduced|eliminated|negotiated|wrote|researched|prototyped|orchestrated|standardized|streamlined|scaled|secured|earned|generated|improved|rebuilt|revamped|outsourced|held|kept|brought|taught|sold|spent|felt|found|met|began|broke|chose|concluded|took|got|put|set|made|gave|spoke|drew|won|left|lost|paid|read|said|understood|started|reported|headed|led)\b/i;

  function firstWordOf(text) {
    /* The leading run is optional: a resume bullet may or may not have been
     * typed with a glyph in front of it. */
    var m = /^[^A-Za-z0-9]*([A-Za-z0-9'’-]+)/.exec(one(text));
    return m ? m[1] : '';
  }

  function openerIsVerb(text) {
    return VERB_OPENER.test(firstWordOf(text));
  }

  /* The strongest line from a role: it carries a figure, it is a complete
   * sentence, and it is not one of the linter's "helped with" openers. A
   * letter is the one place a bullet has to survive as prose, so the filter
   * is doing real work here. */
  function bestLine(role) {
    var bullets = (Array.isArray(role.highlights) ? role.highlights : [])
      .map(one)
      .filter(function (t) { return t.length > 40 && t.length < 240; });
    var scored = bullets.map(function (t) {
      var score = 0;
      if (hasNumber(t)) score += 3;
      if (VERB_OPENER.test(t)) score += 2;
      if (/^(helped|assisted|worked on|participated|involved|responsible)/i.test(t)) score -= 4;
      /* No length bonus: it was picking the tidiest line over the most
       * important one, and the sort below is stable, so equal scores keep
       * the order the user wrote them in. */
      return { text: t, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.length ? scored[0].text : '';
  }

  /* Ordered oldest-last, the way a letter reads: most recent first. */
  function careerRows(r) {
    var rows = [];
    visibleEntries(r, 'experience').forEach(function (entry) {
      rolesOf(entry).forEach(function (role) {
        var position = one(role && role.position);
        var company = one(entry.company);
        if (!position && !company) return;
        rows.push({
          position: position,
          company: company,
          start: one(role && role.start),
          end: role && role.current ? 'Present' : one(role && role.end),
          line: role ? bestLine(role) : '',
          all: (Array.isArray(role && role.highlights) ? role.highlights : []).map(one).filter(Boolean)
        });
      });
    });
    return rows;
  }

  function firstName(full) {
    var name = one(full);
    if (!name) return '';
    var given = one(full.split(/\s+/)[0]);
    return given;
  }

  function contactLine(r) {
    var b = (resumeOrEmpty(r).basics) || {};
    var bits = [one(b.email), one(b.phone), one(b.url)].filter(Boolean);
    if (!bits.length) {
      var city = one((b.location || {}).city);
      if (city) bits.push(city);
    }
    return bits.join(' · ');
  }

  function senderName(r) {
    var b = (resumeOrEmpty(r).basics) || {};
    return one(b.name) || joinWith([one(b.givenName), one(b.familyName)], ' ');
  }

  function roleLabel(r, draft) {
    var resume = resumeOrEmpty(r);
    return one(draft.role) || one(resume.meta && resume.meta.targetRole) || one((resume.basics || {}).label) || '';
  }

  function companyLabel(r, draft) {
    var resume = resumeOrEmpty(r);
    return one(draft.toCompany) || one(resume.meta && resume.meta.targetCompany) || '';
  }

  /* "the Senior Product Designer role" reads as English; pasting a label into
   * a sentence template does not, so every slot in the generated prose goes
   * through a phrase that carries its own article. */
  function rolePhrase(r, draft) {
    var role = roleLabel(r, draft);
    return role ? 'the ' + role + ' role' : 'this role';
  }

  function atCompany(r, draft) {
    var company = companyLabel(r, draft);
    return company ? ' at ' + company : ' at your company';
  }

  /* Terms the posting asks for that the resume already answers. The prep
   * module owns the salience rule — the matcher's raw ranking leads with
   * frequency, so a posting that repeats a word puts that word first — and
   * both documents read the same list, so they cannot disagree about what
   * the job is. Falls back to the matcher's own answer if prep.js is absent. */
  function agreedTerms(r, jdText) {
    if (!jdText || !String(jdText).trim()) return [];
    if (RB.prep && typeof RB.prep.salient === 'function') {
      try { return RB.prep.salient(resumeOrEmpty(r), jdText).present.map(function (t) { return t.term; }); }
      catch (err) { /* fall through to the matcher's own ranking */ }
    }
    if (!RB.jdmatch || typeof RB.jdmatch.match !== 'function') return [];
    var out = [];
    try {
      var result = RB.jdmatch.match(resumeOrEmpty(r), jdText);
      (result.present || []).slice(0, 6).forEach(function (c) {
        var t = one(c.term);
        if (t && t.length > 2) out.push(t);
      });
    } catch (err) { /* an empty list is a valid answer */ }
    return out;
  }

  function listAnd(terms) {
    if (!terms.length) return '';
    if (terms.length === 1) return terms[0];
    return terms.slice(0, -1).join(', ') + ' and ' + terms[terms.length - 1];
  }

  /* ------------------------------------------------------------- generation */

  function greetingFor(draft) {
    var who = firstName(draft.toName);
    return who ? 'Dear ' + who + ',' : 'Dear Hiring Team,';
  }

  function openingFor(draft, r, rows) {
    var role = rolePhrase(r, draft);
    var company = companyLabel(r, draft);
    var at = atCompany(r, draft);
    var current0 = rows[0] || null;
    var lead = '';
    var referrer = one(draft.referrer);

    if (draft.source === 'referral') {
      lead = (referrer ? referrer + ' suggested' : 'Someone suggested') + ' I write to you about ' + role + at + '.';
    } else if (draft.source === 'recruiter') {
      lead = 'A recruiter passed me ' + role + at + ', and it is the work I want to be doing.';
    } else if (draft.source === 'site') {
      lead = 'Your careers page brought me to ' + role + at + '.';
    } else {
      lead = 'I am writing to apply for ' + role + at + '.';
    }

    var where = '';
    if (current0 && (current0.position || current0.company)) {
      /* No article before the job title: "I am a Senior Product Designer" is
       * right and "I am an UX Designer" is not, and there is no way to know
       * which without guessing at the sound of the word. "Since … I have
       * worked as …" needs no article and reads the same either way. The
       * company is left out when the lead sentence already named it. */
      where = ' Since ' + (current0.start || 'recently') + ' I have worked as ' +
        (current0.position || 'a member of the team') +
        (current0.company && current0.company !== company ? ' at ' + current0.company : '') + '.';
    } else {
      var summary = one((resumeOrEmpty(r).basics || {}).summary);
      if (summary) where = ' ' + clip(summary, 180);
    }
    return cap(clip(lead + where, 520));
  }

  /* One sentence per employer, and the employer named in the sentence.
   * Lining a claim up against a company the reader cannot see is how a
   * cover letter starts making claims the resume never made. */
  function evidenceFor(draft, r, rows) {
    if (!rows.length) return '';
    var want = (LENGTHS.filter(function (l) { return l.id === draft.length; })[0] || LENGTHS[1]).bullets;
    var picked = [];
    rows.forEach(function (row) {
      if (picked.length >= want) return;
      if (!row.line) return;
      var already = picked.some(function (p) { return p.company && row.company && p.company === row.company; });
      if (already) return;
      picked.push(row);
    });

    if (!picked.length) {
      var fallback = rows[0].line;
      return fallback ? cap(clip(sentence(fallback), 300)) : '';
    }

    var parts = picked.map(function (row) {
      if (!row.company || !openerIsVerb(row.line)) return sentence(row.line);
      var line = one(row.line);
      var head = firstWordOf(line);
      return 'At ' + row.company + ', I ' + head.toLowerCase() + line.slice(head.length);
    });
    return cap(clip(joinWith(parts), 760));
  }

  function fitFor(draft, r, terms) {
    var role = rolePhrase(r, draft);
    var at = atCompany(r, draft);
    var out = '';
    if (terms.length) {
      out = 'Your posting asks for ' + listAnd(terms.slice(0, 3)) + '. Those are areas I have worked in directly, and they are the part of ' + role + ' I would most want to own.';
    } else if (draft.tone === 'warm') {
      out = 'What interests me' + at + ' is how close ' + role + ' sits to the work I have been doing, and the chance to go further with it.';
    } else {
      out = role + at + ' is the closest match to the work I have done so far, and it is the work I want to keep doing.';
    }
    return cap(clip(out, 420));
  }

  function closeFor(draft, r) {
    var loc = one(((resumeOrEmpty(r).basics || {}).location || {}).city);
    var where = loc ? ' I am based in ' + loc + '.' : '';
    var ask = draft.tone === 'warm'
      ? ' I would genuinely like to talk about where I could be useful.'
      : ' If this looks like a fit, I would welcome the chance to talk.';
    return cap(clip('I am available for an interview at short notice.' + where + ask, 320));
  }

  /* Fill the empty prose only. A letter the user has started editing keeps
   * their sentences; the button is explicit about that. */
  function generate(r, jdText, opts) {
    var resume = resumeOrEmpty(r);
    var base = normalize(Object.assign({}, get(), (opts && opts.patch) || {}));
    var rows = careerRows(resume);
    var terms = agreedTerms(resume, jdText);
    var keep = (opts && opts.keep) || {};

    var next = {
      date: base.date || U.formatDate(new Date(), (resume.meta && resume.meta.dateFormat) || 'MMM YYYY'),
      toName: base.toName,
      toCompany: base.toCompany,
      toAddress: base.toAddress,
      role: base.role || (resume.meta && resume.meta.targetRole) || '',
      referrer: base.referrer,
      source: base.source,
      tone: base.tone,
      length: base.length,
      greeting: keep.greeting ? base.greeting : greetingFor(base),
      opening: keep.opening ? base.opening : openingFor(base, resume, rows),
      evidence: keep.evidence ? base.evidence : evidenceFor(base, resume, rows),
      fit: keep.fit ? base.fit : fitFor(base, resume, terms),
      close: keep.close ? base.close : closeFor(base, resume),
      signoff: base.signoff || 'Sincerely,',
      generated: true
    };
    return normalize(next);
  }

  /* ---------------------------------------------------------------- compose */

  function body(draft) {
    return [draft.opening, draft.evidence, draft.fit, draft.close].filter(function (p) { return one(p); });
  }

  function compose(draft, r) {
    var d = normalize(draft);
    var resume = resumeOrEmpty(r);
    var to = [d.toName, d.toCompany, d.toAddress].map(one).filter(Boolean);
    var lines = [];

    lines.push(one(d.date));
    to.forEach(function (t) { lines.push(t); });
    lines.push('');
    lines.push(one(d.greeting));
    lines.push('');
    body(d).forEach(function (p) { lines.push(one(p)); lines.push(''); });
    lines.push(one(d.signoff));
    lines.push(senderName(resume));
    var contact = contactLine(resume);
    if (contact) lines.push(contact);

    var text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    return {
      text: text,
      words: countWords(text),
      paragraphs: body(d).length,
      to: to,
      sender: senderName(resume),
      contact: contact
    };
  }

  function countWords(text) {
    var m = String(text).trim().match(/[^\s]+/g);
    return m ? m.length : 0;
  }

  function lengthState(words) {
    if (words > HARD_MAX_WORDS) return 'over';
    if (words > SOFT_MAX_WORDS) return 'long';
    return 'ok';
  }

  function filename(r) {
    var name = senderName(r) || 'cover-letter';
    return U.slugify(name + '-cover-letter') + '.txt';
  }

  function markdown(r) {
    var out = compose(get(), r);
    return '# Cover letter\n\n' + out.text;
  }

  /* ------------------------------------------------------------------ print
   * The resume's print path hard-codes #rb-doc, so the letter cannot borrow
   * it. The workspace owns the shared print host; this only picks the sheet
   * and hands it over. Resolved per call because workspace.js loads after
   * this file. */
  function print(r, pageEl) {
    if (!pageEl) {
      toast('Open the cover letter before printing it.', 'warn');
      return Promise.resolve(false);
    }
    var host = RB.documents && RB.documents.printNode;
    if (typeof host !== 'function') {
      toast('Printing the cover letter is not available right now.', 'warn');
      return Promise.resolve(false);
    }
    return host(pageEl, pageSizeOf(r));
  }

  function pageSizeOf(r) {
    var d = (resumeOrEmpty(r).design) || {};
    return d.pageSize === 'A4' ? 'A4' : 'Letter';
  }

  function toast(message, tone) {
    if (RB.ui && typeof RB.ui.toast === 'function') RB.ui.toast(message, { tone: tone || 'info' });
  }

  RB.letter = {
    KEY: KEY,
    SOURCES: SOURCES,
    LENGTHS: LENGTHS,
    SOFT_MAX_WORDS: SOFT_MAX_WORDS,
    blank: blank,
    normalize: normalize,
    load: load,
    get: get,
    set: set,
    reset: reset,
    generate: generate,
    compose: compose,
    countWords: countWords,
    lengthState: lengthState,
    body: body,
    senderName: senderName,
    contactLine: contactLine,
    roleLabel: roleLabel,
    companyLabel: companyLabel,
    rolePhrase: rolePhrase,
    careerRows: careerRows,
    agreedTerms: agreedTerms,
    greetingFor: greetingFor,
    filename: filename,
    markdown: markdown,
    print: print,
    pageSizeOf: pageSizeOf,
    FONT_STACKS: FONT_STACKS
  };
})(window);
