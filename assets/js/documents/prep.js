/* Resumeboard — interview prep
 *
 * A checklist built from two things the user already has: the resume, and the
 * posting they are preparing for. Every item is derived, not invented — a
 * story prompt is seeded with a line from their own bullet, a gap is a term
 * their own matcher could not find, a question is anchored to a requirement in
 * the posting they pasted.
 *
 * The tick state is the only thing stored, and it is stored per id, so editing
 * the resume re-derives the list without losing the ticks for items that
 * survived. Nothing here writes to the resume model.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  if (!U) return;

  var KEY = 'prep:state';
  var MAX_STORIES = 5;
  var MAX_GAPS = 6;
  var MAX_QUESTIONS = 5;

  function blank() {
    return { jd: '', company: '', role: '', done: {} };
  }

  function normalize(raw) {
    var base = blank();
    if (!raw || typeof raw !== 'object') return base;
    if (typeof raw.jd === 'string') base.jd = raw.jd.slice(0, 24000);
    if (typeof raw.company === 'string') base.company = raw.company.slice(0, 200);
    if (typeof raw.role === 'string') base.role = raw.role.slice(0, 200);
    if (raw.done && typeof raw.done === 'object' && !Array.isArray(raw.done)) {
      Object.keys(raw.done).slice(0, 400).forEach(function (k) {
        if (raw.done[k] === true) base.done[k] = true;
      });
    }
    return base;
  }

  var current = null;
  var loaded = null;

  function load() {
    if (loaded) return loaded;
    if (!RB.idb) { loaded = Promise.resolve(blank()); current = blank(); return loaded; }
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
  }, 300);

  function set(patch) {
    current = normalize(Object.assign({}, get(), patch));
    persist();
    return current;
  }

  function toggle(id, on) {
    var done = Object.assign({}, get().done);
    if (on) done[id] = true;
    else delete done[id];
    current = normalize(Object.assign({}, get(), { done: done }));
    persist();
    return current;
  }

  function clearTicks() {
    current = normalize(Object.assign({}, get(), { done: {} }));
    persist();
    return current;
  }

  /* ------------------------------------------------------------------ text */

  function one(v) { return v == null ? '' : U.htmlToText(String(v)).replace(/\s+/g, ' ').trim(); }

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

  function strongest(role) {
    var lines = (Array.isArray(role.highlights) ? role.highlights : []).map(one)
      .filter(function (t) { return t.length > 40; });
    if (!lines.length) return '';
    var withNumber = lines.filter(function (t) { return /[0-9]/.test(t); });
    var pool = withNumber.length ? withNumber : lines;
    return pool.slice().sort(function (a, b) { return b.length - a.length; })[0];
  }

  /* ----------------------------------------------------------------- build */

  function beforeGroup(state) {
    var company = one(state.company);
    var role = one(state.role);
    return {
      id: 'before',
      title: 'Before the interview',
      note: 'The things that are cheap to do and expensive to skip.',
      items: [
        { id: 'before:company', text: 'Read the last year of news, the product changelog and the pricing page, and note one thing that surprised you.', hint: company ? 'About ' + company + ' in particular. Interviewers can tell the difference in the first two minutes.' : 'Interviewers can tell the difference in the first two minutes.' },
        { id: 'before:role', text: 'Re-read the posting and mark the three requirements you can answer with a specific example.', hint: role ? 'Out of the ' + role + ' description. One example per requirement beats one example that covers all three.' : 'One example per requirement beats one example that covers all three.' },
        { id: 'before:pitch', text: 'Write a 60-second version of your background out loud, twice, with a timer.', hint: 'The second attempt is the one that sounds natural.' },
        { id: 'before:why', text: 'Prepare one honest sentence for why you are leaving, and one for why you want this.', hint: 'Both are asked in almost every first round.' },
        { id: 'before:questions', text: 'Pick four questions to ask them from the list below.', hint: 'Asking nothing is read as not being interested.' },
        { id: 'before:logistics', text: 'Confirm the format, the panel, the length, and how the interview is scheduled.', hint: 'Get the name of every person you will meet.' },
        { id: 'before:print', text: 'Save a PDF of the resume and the cover letter to the device you will be interviewed on.', hint: 'Share the screen from a file, not from a link that may not load.' }
      ]
    };
  }

  function storyGroup(r) {
    var rows = [];
    visibleEntries(r, 'experience').forEach(function (entry) {
      var roles = (Array.isArray(entry.roles) ? entry.roles : []).filter(function (role) {
        return role && typeof role === 'object' && role.visible !== false;
      });
      roles.forEach(function (role) {
        var position = one(role.position);
        var company = one(entry.company);
        if (!position && !company) return;
        var seed = strongest(role);
        rows.push({
          id: 'story:' + (entry.id || rows.length),
          position: position,
          company: company,
          seed: seed
        });
      });
    });
    if (!rows.length) return null;

    /* The role and the employer are kept in the user's own capitalisation.
     * Lowercasing them turns "Northwind Labs" into a lowercase phrase, which is
     * the first thing that makes a generated list look machine-made. */
    var items = rows.slice(0, MAX_STORIES).map(function (row) {
      var who = row.position && row.company
        ? 'your time as ' + row.position + ' at ' + row.company
        : (row.position ? 'your time as ' + row.position : 'your time at ' + row.company);
      return {
        id: row.id,
        text: 'Tell me about ' + who + '.',
        hint: row.seed
          ? 'Start from this line in your resume: “' + row.seed + '”'
          : 'Write one sentence about what changed because you were there.',
        long: true
      };
    });
    return {
      id: 'stories',
      title: 'Stories to prepare',
      note: 'One per role, newest first. Have the situation, the number and the outcome ready for each.',
      items: items
    };
  }

  function gapGroup(r, jdText, terms, lintFindings) {
    var items = [];
    var seen = Object.create(null);

    (terms && terms.missing ? terms.missing : []).slice(0, MAX_GAPS).forEach(function (c) {
      var term = one(c.term);
      if (!term) return;
      var key = 'gap:' + term.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      items.push({
        id: key,
        text: 'Be ready for: “What is your experience with ' + term + '?”',
        hint: c.cued
          ? 'The posting lists it as a requirement and your resume does not say it. Decide before the interview whether you can claim it.'
          : 'The posting asks for it and your resume does not say it. Only answer it if it is true.',
        action: 'check'
      });
    });

    (lintFindings || []).filter(function (f) { return f.severity === 'error'; }).slice(0, 3).forEach(function (f) {
      var key = 'lint:' + f.id + ':' + f.path;
      if (seen[key]) return;
      seen[key] = true;
      items.push({
        id: key,
        text: 'Fix before you interview: ' + one(f.title).toLowerCase() + '.',
        hint: f.message,
        action: 'check'
      });
    });

    if (!items.length) return null;
    return {
      id: 'gaps',
      title: 'Close these before you sit down',
      note: 'Drawn from your own resume and the posting. Each one is a question you cannot answer well yet.',
      items: items
    };
  }

  function likelyGroup(r, state, terms) {
    var role = one(state.role) || one((resumeOrEmpty(r).meta || {}).targetRole) || one((resumeOrEmpty(r).basics || {}).label) || 'this role';
    var items = [];

    items.push({
      id: 'likely:story',
      text: 'Tell me about a time you had to ship something incomplete.',
      hint: 'They are asking how you behave under a deadline, not about the project.'
    });
    items.push({
      id: 'likely:weakest',
      text: 'What is the weakest part of your experience so far?',
      hint: 'Naming it yourself turns a question into a choice.'
    });
    if (terms.length) {
      items.push({
        id: 'likely:term',
        text: 'How deep is your ' + one(terms[0]) + ' experience, really?',
        hint: 'They have read the keyword on your resume. They want the boundary of it.'
      });
    }
    items.push({
      id: 'likely:leave',
      text: 'Why are you looking?',
      hint: 'Say what you are moving towards, not what you are moving away from.'
    });
    items.push({
      id: 'likely:first90',
      text: 'What would you do in your first 90 days here?',
      hint: 'It tests whether you read the posting, and whether you ask before you act.'
    });
    if (one(state.role)) {
      items.push({
        id: 'likely:whyyou',
        text: 'Why you, for the ' + role + ' role, rather than the next person in the queue?',
        hint: 'One sentence, said plainly. The rest of the interview is the proof.'
      });
    }
    return {
      id: 'likely',
      title: 'Questions they are likely to ask',
      note: 'Six is the usual number. Prepare an answer for each in one sentence, then expand.',
      items: items.slice(0, 6)
    };
  }

  function askGroup(r, state, terms) {
    var company = one(state.company) || 'the company';
    var role = one(state.role) || 'the role';
    var items = [];

    items.push({
      id: 'ask:first90',
      text: 'What does success look like in this role after the first 90 days?',
      hint: 'It gets you the real job description in their words.'
    });
    items.push({
      id: 'ask:open',
      text: 'Why is the ' + role + ' role open, and what happened to the person who held it?',
      hint: 'Asking it plainly is usually welcome and almost always informative.'
    });
    if (terms.length) {
      items.push({
        id: 'ask:metric',
        text: 'How does the team measure ' + one(terms[0]) + ' today?',
        hint: 'It shows you have read the posting closely, and you learn what they actually care about.'
      });
    }
    items.push({
      id: 'ask:constraint',
      text: 'What is the hardest constraint on the team right now — people, budget, or legacy?',
      hint: 'The answer tells you what your first year would actually be like.'
    });
    items.push({
      id: 'ask:process',
      text: 'How does a piece of work get from an idea to shipped at ' + company + '?',
      hint: 'Useful even when you do not take the job.'
    });
    items.push({
      id: 'ask:followup',
      text: 'What happens after this interview, and who will I hear from?',
      hint: 'It gets you a name and a date, and it stops the silence afterwards.'
    });
    return {
      id: 'ask',
      title: 'Questions to ask them',
      note: 'Take five. Asking none is the most common way to lose a role you were going to be offered.',
      items: items.slice(0, MAX_QUESTIONS + 1)
    };
  }

  /* Terms the posting asks for and the resume already answers. The cover
   * letter reads the same list, so the two documents never contradict each
   * other about what the job is. */
  function agreedTerms(r, jdText) {
    return termNames(salient(resumeOrEmpty(r), jdText).present, 4);
  }

  /* Terms the posting asks for, split by whether the resume already answers.
   *
   * The matcher's own ranking leads with frequency, so a posting that says
   * "product" forty times puts "product" first. Every question this file
   * builds from a term has to survive being read aloud to a stranger, so a
   * term only counts if the matcher recognises it as a skill, a credential, a
   * degree or a named concept — the categories its own dictionary is built
   * from. Unrecognised words stay out of both documents. */
  function salient(r, jdText) {
    var out = { present: [], missing: [] };
    if (!jdText || !String(jdText).trim()) return out;
    var jm = RB.jdmatch;
    if (!jm || typeof jm.match !== 'function' || typeof jm.keywords !== 'function') return out;

    var result = null;
    var kws = null;
    try { result = jm.match(resumeOrEmpty(r), jdText); } catch (err) { result = null; }
    try { kws = jm.keywords(jdText); } catch (err) { kws = null; }
    if (!result || !kws) return out;

    var index = Object.create(null);
    (result.present || []).forEach(function (c) { index[one(c.term).toLowerCase()] = 'present'; });
    (result.missing || []).forEach(function (c) {
      var k = one(c.term).toLowerCase();
      if (!index[k]) index[k] = 'missing';
    });

    kws.forEach(function (k) {
      var term = one(k.term);
      if (!k.category || term.length < 4) return;
      var where = index[term.toLowerCase()];
      if (!where) return;
      var entry = { term: term, words: term.split(/\s+/), cued: !!k.cued, category: k.category };
      if (where === 'present') {
        if (out.present.length < 8) out.present.push(entry);
      } else if (out.missing.length < 10) {
        out.missing.push(entry);
      }
    });

    /* A word already inside a phrase is not a separate requirement. The
     * matcher's own ranking drops these only when the phrase outscores the
     * word, and in a posting that says "product" forty times it does not —
     * so "your posting asks for product, product design and design systems"
     * is what a naive read produces. */
    function dropContained(list) {
      var phrases = list.filter(function (t) { return t.words.length > 1; })
        .map(function (t) { return ' ' + t.words.map(function (w) { return w.toLowerCase(); }).join(' ') + ' '; });
      return list.filter(function (t) {
        if (t.words.length > 1) return true;
        var w = t.words[0].toLowerCase();
        return !phrases.some(function (p) { return p.indexOf(' ' + w + ' ') !== -1; });
      });
    }
    out.present = dropContained(out.present);
    out.missing = dropContained(out.missing);
    return out;
  }

  function termNames(list, n) {
    return (list || []).slice(0, n || 4).map(function (t) { return t.term; });
  }

  function build(r, state) {
    var resume = resumeOrEmpty(r);
    var s = normalize(state);
    var terms = salient(resume, s.jd);

    var lint = [];
    if (RB.linter && typeof RB.linter.run === 'function') {
      try { lint = RB.linter.run(resume); } catch (err) { lint = []; }
    }

    var groups = [beforeGroup(s)];
    var stories = storyGroup(resume);
    if (stories) groups.push(stories);
    groups.push(likelyGroup(resume, s, termNames(terms.present, 1)));
    groups.push(askGroup(resume, s, termNames(terms.present, 1)));
    var gaps = gapGroup(resume, s.jd, terms, lint);
    if (gaps) groups.push(gaps);

    var total = 0;
    var done = 0;
    groups.forEach(function (g) {
      g.items.forEach(function (it) {
        total++;
        if (s.done[it.id]) done++;
      });
    });

    return {
      groups: groups,
      terms: termNames(terms.present, 4),
      present: terms.present,
      missing: terms.missing,
      total: total,
      done: done
    };
  }

  function progress(built, state) {
    var s = normalize(state);
    var done = built.groups.reduce(function (n, g) {
      return n + g.items.filter(function (it) { return s.done[it.id]; }).length;
    }, 0);
    return { done: done, total: built.total };
  }

  /* ----------------------------------------------------------------- print */

  function asText(r, state) {
    var built = build(r, state);
    var s = normalize(state);
    var name = one((resumeOrEmpty(r).basics || {}).name);
    var lines = [];
    lines.push('INTERVIEW PREP');
    var who = [s.role, s.company].map(one).filter(Boolean).join(' at ');
    lines.push(who ? name + ' — ' + who : name);
    lines.push('Prepared ' + U.formatDate(new Date(), 'MMM YYYY'));
    lines.push('');
    built.groups.forEach(function (g) {
      lines.push(g.title.toUpperCase());
      lines.push('');
      g.items.forEach(function (it) {
        lines.push('□  ' + it.text);
        if (it.hint) lines.push('    ' + it.hint);
        lines.push('');
      });
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  RB.prep = {
    KEY: KEY,
    blank: blank,
    normalize: normalize,
    load: load,
    get: get,
    set: set,
    toggle: toggle,
    clearTicks: clearTicks,
    build: build,
    progress: progress,
    salient: salient,
    agreedTerms: agreedTerms,
    asText: asText
  };
})(window);
