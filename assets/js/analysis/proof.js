/* Resumeboard — proof pass
 *
 * Consistency rules that span the whole document: every date in one format,
 * every open-ended role saying the same word, one entry per employer, no role
 * running backwards. Each rule is deterministic and offline, and every fix is
 * expressed as a mutation of a draft so the store stays the single write path.
 *
 * This overlaps the linter on purpose in one place only — date formats — and
 * differs in what it can do about it. The linter names the problem one field
 * at a time; a proof pass is allowed to look at the whole resume, decide what
 * the document is actually doing, and then change all of it in one step.
 *
 *   RB.proof.run(resume)          -> { issues, fixable, byId }
 *   RB.proof.fixAll(resume)       -> resume   (a copy, with every safe fix)
 *   RB.proof.DATE_FORMATS
 *
 * An issue is { id, severity, path, section, title, message, evidence, fix? }
 * where fix is { label, bulk, apply(draft) }. `bulk` marks the fixes that are
 * safe to apply without a human reading each one; Fix all uses only those.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var M = RB.model;
  if (!U || !M) return;

  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
  var SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var DATE_FORMATS = [
    { id: 'MMM YYYY', label: 'Mar 2021' },
    { id: 'MMMM YYYY', label: 'March 2021' },
    { id: 'MM/YYYY', label: '03/2021' },
    { id: 'YYYY', label: '2021' },
    { id: 'YYYY-MM', label: '2021-03' }
  ];

  var FORMAT_LABEL = {};
  DATE_FORMATS.forEach(function (f) { FORMAT_LABEL[f.id] = f.label; });

  var OPEN_WORDS = { present: 'Present', current: 'Present', now: 'Present', ongoing: 'Present', today: 'Present' };

  var TITLES = {
    'date.format': 'Mixed date formats',
    'date.present': 'Two words for an open end date',
    'date.reversed': 'A date range that runs backwards',
    'date.future': 'A start date in the future',
    'overlap.role': 'Two roles at the same employer overlap',
    'employer.duplicate': 'The same employer listed twice',
    'employer.spelling': 'The same employer, two spellings'
  };

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */

  function tidy(v) {
    if (v == null) return '';
    var s;
    if (typeof v === 'string') s = v;
    else { try { s = String(v); } catch (e) { s = ''; } }
    return s.replace(/\s+/g, ' ').trim();
  }

  function openWord(v) {
    var s = tidy(v).toLowerCase();
    if (!s || /\d/.test(s)) return null;
    return OPEN_WORDS[s] || null;
  }

  function monthIndex(word) {
    var w = String(word).toLowerCase().replace(/\.$/, '');
    var i = MONTHS.indexOf(w);
    if (i !== -1) return i;
    for (var j = 0; j < MONTHS.length; j++) {
      if (MONTHS[j].indexOf(w) === 0 && w.length >= 3) return j;
    }
    return -1;
  }

  /* { y, m, d, exact } or null. `exact` is false for a bare year or a phrase
   * like "Summer 2019", which is a real date a reader understands but which
   * cannot be re-rendered without changing the words. */
  function parseDate(value) {
    var s = tidy(value);
    if (!s) return null;
    if (openWord(s)) return null;
    var m;

    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) {
      return { y: +m[1], m: +m[2] - 1, d: +m[3], exact: true };
    }
    if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) {
      return { y: +m[1], m: +m[2] - 1, d: 0, exact: true };
    }
    if ((m = /^(\d{4})$/.exec(s))) {
      return { y: +m[1], m: 0, d: 0, exact: true, yearOnly: true };
    }
    if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) {
      return { y: +m[2], m: +m[1] - 1, d: 0, exact: true };
    }
    if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/.exec(s))) {
      var mi = monthIndex(m[2]);
      if (mi !== -1) return { y: +m[3], m: mi, d: +m[1], exact: true };
    }
    if ((m = /^([A-Za-z]{3,9})[\s.\-/]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
      var mi2 = monthIndex(m[1]);
      if (mi2 !== -1) return { y: +m[3], m: mi2, d: +m[2], exact: true };
    }
    if ((m = /^([A-Za-z]{3,9})[\s.\-/]+(\d{4})$/.exec(s))) {
      var mi3 = monthIndex(m[1]);
      if (mi3 !== -1) return { y: +m[2], m: mi3, d: 0, exact: true };
    }
    if ((m = /(\d{4})/.exec(s))) return { y: +m[1], m: 0, d: 0, exact: false };
    return null;
  }

  /* Which of DATE_FORMATS a value already reads as, or null when it does not
   * read as any of them. A free-text date is left alone on purpose: rewriting
   * "Summer 2019" as "Jun 2019" invents a month. */
  function formatOf(value) {
    var s = tidy(value);
    if (!s || openWord(s)) return null;
    if (/^\d{4}$/.test(s)) return 'YYYY';
    if (/^\d{4}[-/.]\d{1,2}$/.test(s)) return 'YYYY-MM';
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return null;
    if (/^\d{1,2}\/\d{4}$/.test(s)) return 'MM/YYYY';
    var m = /^([A-Za-z]{3,9})[\s.\-/]+\d{4}$/.exec(s);
    if (m) return m[1].length <= 3 ? 'MMM YYYY' : 'MMMM YYYY';
    return null;
  }

  function renderDate(parsed, formatId) {
    if (!parsed || !parsed.exact) return null;
    switch (formatId) {
      case 'YYYY': return String(parsed.y);
      case 'YYYY-MM': return parsed.y + '-' + String(parsed.m + 1).padStart(2, '0');
      case 'MM/YYYY': return String(parsed.m + 1).padStart(2, '0') + '/' + parsed.y;
      case 'MMMM YYYY': return LONG[parsed.m] + ' ' + parsed.y;
      default: return SHORT[parsed.m] + ' ' + parsed.y;
    }
  }

  /* A comparable month index. A year on its own is read as the start of the
   * year for a start date and the end of it for an end date, so "2019" and
   * "Jun 2019" in the same range is not reported as running backwards. */
  function monthIndexOf(value, biasEnd) {
    var p = parseDate(value);
    if (!p) return null;
    if (p.yearOnly) return p.y * 12 + (biasEnd ? 11 : 0);
    return p.y * 12 + p.m;
  }

  /* ------------------------------------------------------------------ *
   * Identity
   * ------------------------------------------------------------------ */

  var LEGAL = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|gmbh|plc|sa|sas|ag|bv|nv|ab|oy|pte|pvt|pty|kk|kg|srl|spa|sl|holdings|group)\b/g;

  function foldKey(s) {
    var t = tidy(s).toLowerCase();
    if (t.normalize) { try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep it */ } }
    t = t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    t = t.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
    if (/^the /.test(t)) t = t.slice(4);
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Collection
   * ------------------------------------------------------------------ */

  /* Everything with a start and an end, in one shape, so a rule never has to
   * know which section it came from. */
  function ranges(resume) {
    var out = [];
    function add(type, index, roleIndex, start, end, current, name) {
      out.push({
        type: type, index: index, roleIndex: roleIndex,
        startPath: roleIndex == null ? type + '.' + index + '.start' : type + '.' + index + '.roles.' + roleIndex + '.start',
        endPath: roleIndex == null ? type + '.' + index + '.end' : type + '.' + index + '.roles.' + roleIndex + '.end',
        start: tidy(start), end: tidy(end), current: !!current, name: name
      });
    }

    (Array.isArray(resume.experience) ? resume.experience : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      var company = tidy(e.company) || M.typeMeta('experience').label;
      (Array.isArray(e.roles) ? e.roles : []).forEach(function (r, j) {
        if (!r || typeof r !== 'object' || r.visible === false) return;
        var who = tidy(r.position) ? company + ' · ' + tidy(r.position) : company;
        add('experience', i, j, r.start, r.end, r.current, who);
      });
    });
    (Array.isArray(resume.education) ? resume.education : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('education', i, null, e.start, e.end, false, tidy(e.institution) || 'Education');
    });
    (Array.isArray(resume.projects) ? resume.projects : []).forEach(function (p, i) {
      if (!p || typeof p !== 'object' || p.visible === false) return;
      add('projects', i, null, p.start, p.end, p.current, tidy(p.name) || 'Project');
    });
    (Array.isArray(resume.volunteer) ? resume.volunteer : []).forEach(function (v, i) {
      if (!v || typeof v !== 'object' || v.visible === false) return;
      add('volunteer', i, null, v.start, v.end, v.current, tidy(v.organization) || 'Volunteering');
    });
    (Array.isArray(resume.custom) ? resume.custom : []).forEach(function (c, ci) {
      if (!c || typeof c !== 'object' || c.visible === false) return;
      (Array.isArray(c.entries) ? c.entries : []).forEach(function (x, xi) {
        if (!x || typeof x !== 'object') return;
        var i = ci + ':' + xi;
        out.push({
          type: 'custom', index: ci, roleIndex: xi,
          startPath: 'custom.' + ci + '.entries.' + xi + '.start',
          endPath: 'custom.' + ci + '.entries.' + xi + '.end',
          start: tidy(x.start), end: tidy(x.end), current: false,
          name: tidy(c.label) || 'Custom'
        });
      });
    });
    return out;
  }

  /* Every date-bearing field on the resume as a flat {path, value} list.
   * ranges() pairs a start with an end for the range rules; this is the same
   * data unpaired, which is what the format and spelling rules need. */
  function allDates(resume) {
    var out = [];
    ranges(resume).forEach(function (r) {
      if (r.start) out.push({ path: r.startPath, value: r.start, name: r.name, type: r.type });
      if (r.end) out.push({ path: r.endPath, value: r.end, name: r.name, type: r.type });
    });
    singles(resume).forEach(function (s) { out.push(s); });
    return out;
  }

  function singles(resume) {
    var out = [];
    function add(type, index, field, value, name) {
      var v = tidy(value);
      if (!v) return;
      out.push({ path: type + '.' + index + '.' + field, value: v, name: name, type: type });
    }
    (Array.isArray(resume.certifications) ? resume.certifications : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('certifications', i, 'date', e.date, tidy(e.name) || 'Certification');
    });
    (Array.isArray(resume.awards) ? resume.awards : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('awards', i, 'date', e.date, tidy(e.title) || 'Award');
    });
    (Array.isArray(resume.publications) ? resume.publications : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('publications', i, 'date', e.date, tidy(e.title) || 'Publication');
    });
    (Array.isArray(resume.presentations) ? resume.presentations : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('presentations', i, 'date', e.date, tidy(e.title) || 'Presentation');
    });
    (Array.isArray(resume.coursework) ? resume.coursework : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      add('coursework', i, 'date', e.date, tidy(e.name) || 'Course');
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Rules
   * ------------------------------------------------------------------ */

  function issue(id, severity, path, section, message, evidence, fix) {
    return {
      id: id, severity: severity, path: path || '', section: section || 'Document',
      title: TITLES[id] || id, message: message, evidence: evidence || '',
      fix: fix || null
    };
  }

  function sectionName(resume, type) {
    var sections = Array.isArray(resume.sections) ? resume.sections : [];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i] && sections[i].type === type) return tidy(sections[i].label) || M.typeMeta(type).label;
    }
    return M.typeMeta(type).label;
  }

  function run(resume) {
    var out = [];
    if (!resume || typeof resume !== 'object') return { issues: [], fixable: 0, byId: {} };
    try {
      if (M.isBlankResume(resume)) return { issues: [], fixable: 0, byId: {} };
    } catch (e) { /* a malformed import: run the rules anyway */ }

    var dates = allDates(resume);
    dateFormatRule(dates, resume, out);
    presentRule(dates, out);
    reversedRule(ranges(resume), out);
    futureRule(ranges(resume).concat(singles(resume)), out);
    overlapRule(resume, out);
    employerRule(resume, out);

    var rank = { error: 0, warn: 1, tip: 2 };
    out.sort(function (a, b) {
      var d = (rank[a.severity] || 9) - (rank[b.severity] || 9);
      if (d) return d;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
    });

    var byId = {};
    var fixable = 0;
    out.forEach(function (f) {
      byId[f.id] = (byId[f.id] || 0) + 1;
      if (f.fix && f.fix.bulk) fixable += 1;
    });
    return { issues: out, fixable: fixable, byId: byId };
  }

  var META_MAP = {
    'YYYY': 'YYYY', 'YY': 'YYYY', 'YYYY-MM': 'YYYY-MM', 'MM/YYYY': 'MM/YYYY',
    'MM.YYYY': 'MM/YYYY', 'MMM YYYY': 'MMM YYYY', 'MMMM YYYY': 'MMMM YYYY',
    'MMM YY': 'MMM YYYY', 'D MMM YYYY': 'MMM YYYY', 'YYYY-MM-DD': 'YYYY-MM'
  };

  /* --- dates: one format everywhere --- */
  function dateFormatRule(dates, resume, out) {
    var counts = Object.create(null);
    dates.forEach(function (d) {
      var f = formatOf(d.value);
      if (f) counts[f] = (counts[f] || 0) + 1;
    });
    var formats = Object.keys(counts);
    if (formats.length < 2) return;

    var target = null;
    var wanted = resume.meta ? META_MAP[tidy(resume.meta.dateFormat)] : null;
    if (wanted && counts[wanted]) target = wanted;
    if (!target) {
      target = formats.slice().sort(function (a, b) {
        return counts[b] - counts[a] || (a < b ? -1 : 1);
      })[0];
    }

    dates.forEach(function (d) {
      var f = formatOf(d.value);
      if (!f || f === target) return;
      var next = renderDate(parseDate(d.value), target);
      if (!next || next === d.value) return;
      out.push(issue('date.format', 'warn', d.path, d.name,
        'This reads as ' + FORMAT_LABEL[f] + ' while the rest of the document reads as ' + FORMAT_LABEL[target] + '.',
        d.value, {
          label: 'Use ' + FORMAT_LABEL[target],
          bulk: true,
          apply: function (draft) { M.setPath(draft, d.path, next); }
        }));
    });
  }

  /* --- dates: one word for an open end --- */
  function presentRule(dates, out) {
    var kinds = Object.create(null);
    dates.forEach(function (d) {
      var w = openWord(d.value);
      if (w) kinds[w] = (kinds[w] || 0) + 1;
    });
    var words = Object.keys(kinds);
    if (words.length < 2) return;
    var target = words.sort(function (a, b) { return kinds[b] - kinds[a] || (a < b ? -1 : 1); })[0];

    dates.forEach(function (d) {
      var w = openWord(d.value);
      if (!w || w === target) return;
      out.push(issue('date.present', 'warn', d.path, d.name,
        'This says “' + d.value + '” where the rest of the document says “' + target + '”.',
        d.value, {
          label: 'Use “' + target + '”',
          bulk: true,
          apply: function (draft) { M.setPath(draft, d.path, target); }
        }));
    });
  }

  /* --- dates: a range that runs backwards --- */
  function reversedRule(dates, out) {
    dates.forEach(function (d) {
      var s = monthIndexOf(d.start, false);
      var e = monthIndexOf(d.end, true);
      if (s == null || e == null || e >= s) return;
      var a = d.start;
      var b = d.end;
      out.push(issue('date.reversed', 'error', d.endPath, d.name,
        'This entry ends in ' + d.end + ', before it starts in ' + d.start + '.', d.start + ' → ' + d.end, {
          label: 'Swap the two dates',
          bulk: true,
          apply: function (draft) {
            M.setPath(draft, d.startPath, b);
            M.setPath(draft, d.endPath, a);
          }
        }));
    });
  }

  /* --- dates: a start that has not happened --- */
  function futureRule(dates, out) {
    var now = new Date();
    var nowMonth = now.getFullYear() * 12 + now.getMonth();
    dates.forEach(function (d) {
      var s = monthIndexOf(d.start, false);
      if (s == null || s <= nowMonth) return;
      var parsed = parseDate(d.start);
      if (!parsed || !parsed.exact) return;
      out.push(issue('date.future', 'warn', d.startPath, d.name,
        'This starts in ' + d.start + ', which has not happened yet.', d.start, null));
    });
  }

  /* --- experience: two roles at one employer, at the same time --- */
  function overlapRule(resume, out) {
    (Array.isArray(resume.experience) ? resume.experience : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      var roles = (Array.isArray(e.roles) ? e.roles : []).map(function (r, j) {
        return { r: r, j: j };
      }).filter(function (x) { return x.r && typeof x.r === 'object' && x.r.visible !== false; });
      if (roles.length < 2) return;
      var company = tidy(e.company) || 'This employer';

      for (var a = 0; a < roles.length; a++) {
        for (var b = a + 1; b < roles.length; b++) {
          var A = roles[a];
          var B = roles[b];
          var as = monthIndexOf(A.r.start, false);
          var bs = monthIndexOf(B.r.start, false);
          if (as == null || bs == null) continue;
          var ae = openWord(A.r.end) || A.r.current ? Infinity : monthIndexOf(A.r.end, true);
          var be = openWord(B.r.end) || B.r.current ? Infinity : monthIndexOf(B.r.end, true);
          if (ae == null) ae = Infinity;
          if (be == null) be = Infinity;
          /* A role that starts after the other one ended is a promotion, not
           * an overlap. */
          if (as > be || bs > ae) continue;
          if (as <= bs) {
            report(A, B, ae, bs, i, company, out);
          } else {
            report(B, A, be, as, i, company, out);
          }
        }
      }
    });

    function report(early, late, earlyEnd, lateStart, index, company, out_) {
      var earlyPath = 'experience.' + index + '.roles.' + early.j + '.end';
      var who = tidy(early.r.position) || 'the earlier role';
      var other = tidy(late.r.position) || 'the later role';
      var message = who + ' at ' + company + ' runs until ' +
        (isFinite(earlyEnd) && !openWord(early.r.end) ? tidy(early.r.end) : 'an open end') +
        ', and ' + other + ' starts in ' + tidy(late.r.start) + '.';
      var fix = null;
      /* The one repair available without knowing the facts: close the earlier
       * role on the day the later one began. Anything else is a question for
       * the person who lived it. */
      if (isFinite(earlyEnd) && earlyEnd > lateStart && !openWord(early.r.end) && tidy(early.r.end)) {
        var newEnd = tidy(late.r.start);
        fix = {
          label: 'End it in ' + newEnd,
          bulk: false,
          apply: function (draft) { M.setPath(draft, earlyPath, newEnd); }
        };
      } else if (!tidy(early.r.end) && !early.r.current) {
        fix = {
          label: 'End it in ' + tidy(late.r.start),
          bulk: false,
          apply: function (draft) { M.setPath(draft, earlyPath, tidy(late.r.start)); }
        };
      }
      out_.push(issue('overlap.role', 'warn', earlyPath, company, message,
        (tidy(early.r.position) || 'Role') + ': ' + tidy(early.r.start) + ' – ' + (tidy(early.r.end) || 'open'), fix));
    }
  }

  /* --- experience: one entry per employer --- */
  function employerRule(resume, out) {
    var list = Array.isArray(resume.experience) ? resume.experience : [];
    var groups = Object.create(null);
    var order = [];
    list.forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      if (M.isBlankEntry && M.isBlankEntry(e)) return;
      var key = foldKey(e.company);
      if (!key) return;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(i);
    });

    order.forEach(function (key) {
      var idxs = groups[key];
      if (idxs.length < 2) return;
      var first = idxs[0];
      var name = tidy(list[first].company);
      var rest = idxs.slice(1);

      if (rest.some(function (i) { return tidy(list[i].company) !== name; })) {
        out.push(issue('employer.spelling', 'tip', 'experience.' + first + '.company', name,
          'The same employer is written differently in ' + U.pluralize(idxs.length, 'entry', 'entries') + '. A reader reads them as two companies.',
          rest.map(function (i) { return tidy(list[i].company); }).filter(function (v, k, all) { return all.indexOf(v) === k; }).join(' · '), {
            label: 'Use “' + name + '” everywhere',
            bulk: false,
            apply: function (draft) {
              rest.forEach(function (i) { M.setPath(draft, 'experience.' + i + '.company', name); });
            }
          }));
      }

      if (rest.length) {
        var laterRoles = rest.reduce(function (n, i) {
          return n + ((Array.isArray(list[i].roles) ? list[i].roles : []).filter(function (r) {
            return r && !M.isBlankEntry(r);
          }).length);
        }, 0);
        var message = name + ' is listed ' + idxs.length + ' times' +
          (laterRoles ? ', with ' + U.pluralize(laterRoles, 'role') + ' split across them' : '') + '.';
        out.push(issue('employer.duplicate', 'warn', 'experience.' + first, name, message,
          rest.map(function (i) {
            return tidy((list[i].roles && list[i].roles[0] && list[i].roles[0].position) || '');
          }).filter(Boolean).join(' · '), {
            label: 'Merge into one entry',
            bulk: true,
            apply: function (draft) { foldEmployers(draft, first, rest); }
          }));
      }
    });
  }

  /* Move every role from the later entries onto the first one, then drop them.
   * Highest index first so the splice cannot move a target out from under the
   * next one. */
  function foldEmployers(draft, keepIndex, dropIndexes) {
    var host = M.getPath(draft, 'experience.' + keepIndex);
    if (!host || typeof host !== 'object') return;
    if (!Array.isArray(host.roles)) host.roles = [];
    var seen = Object.create(null);
    host.roles.forEach(function (r) {
      if (r && r.position) seen[foldKey(r.position)] = true;
    });
    dropIndexes.slice().sort(function (a, b) { return b - a; }).forEach(function (i) {
      var source = M.getPath(draft, 'experience.' + i);
      if (!source || typeof source !== 'object') return;
      if (!tidy(host.location) && tidy(source.location)) host.location = source.location;
      if (!tidy(host.url) && tidy(source.url)) host.url = source.url;
      if (Array.isArray(source.roles)) {
        source.roles.forEach(function (role) {
          if (!role || typeof role !== 'object' || M.isBlankEntry(role)) return;
          var key = foldKey(role.position) || foldKey(role.start);
          if (key && seen[key]) return;
          if (key) seen[key] = true;
          host.roles.push(role);
        });
      }
    });
    var list = M.getPath(draft, 'experience');
    if (!Array.isArray(list)) return;
    dropIndexes.slice().sort(function (a, b) { return b - a; }).forEach(function (i) {
      if (i >= 0 && i < list.length) list.splice(i, 1);
    });
  }

  /* ------------------------------------------------------------------ *
   * Batch
   * ------------------------------------------------------------------ */

  /* A copy of the resume with every bulk fix applied. The caller hands it to
   * store.replace (or store.update), so the whole pass is one undo step.
   *
   * One fix at a time, re-deriving the rule set between each. A batch that
   * computed every fix against the original document and then applied them in
   * a row was applying stale indexes: merging two employers into index 0
   * shifts everything after it, and the next fix — written for the old
   * index — wrote a brand new phantom entry in its place. One pass, one
   * re-read, no stale paths. */
  var MAX_PASSES = 300;

  function fixAll(resume) {
    var draft = M.deepClone(resume);
    for (var pass = 0; pass < MAX_PASSES; pass++) {
      var result = run(draft);
      var next = null;
      for (var i = 0; i < result.issues.length; i++) {
        if (result.issues[i].fix && result.issues[i].fix.bulk) { next = result.issues[i]; break; }
      }
      if (!next) return draft;
      try {
        next.fix.apply(draft);
      } catch (e) {
        /* A fix that throws would otherwise spin here until the cap. Drop it
         * from this pass by giving up on the run; the panel says how many
         * were applied. */
        return draft;
      }
    }
    return draft;
  }

  /* Rewrite every date on the resume into one format. Separate from fixAll
   * because the target is the reader's choice, not the document's majority.
   * Returns the list of writes as well as the resume, so the caller can apply
   * them path by path instead of swapping the whole document for a clone. */
  function setDateFormat(resume, formatId) {
    if (!DATE_FORMATS.some(function (f) { return f.id === formatId; })) return null;
    var writes = [];
    allDates(resume).forEach(function (d) {
      if (openWord(d.value)) return;
      var next = renderDate(parseDate(d.value), formatId);
      if (!next || next === d.value) return;
      writes.push({ path: d.path, value: next });
    });
    if (!writes.length) return null;
    return { writes: writes, changed: writes.length, format: formatId };
  }

  RB.proof = {
    DATE_FORMATS: DATE_FORMATS,
    FORMAT_LABEL: FORMAT_LABEL,
    run: run,
    fixAll: fixAll,
    setDateFormat: setDateFormat,
    parseDate: parseDate,
    formatOf: formatOf,
    renderDate: renderDate,
    foldKey: foldKey
  };

  /* The panel resolves analysis modules through RB.analysis. Without this the
   * module reads as missing and the panel says so instead of showing results. */
  RB.analysis = RB.analysis || {};
  RB.analysis.proof = run;
})(window);
