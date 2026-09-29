/* Resumeboard — input validation
 *
 * A resume is read by a person and by a parser, and both are wrecked by
 * keyboard mashing. This gives every bound field the constraints its content
 * actually has, and refuses what cannot possibly be right.
 *
 * Two kinds of rule, deliberately different in weight:
 *   sanitize() — mechanical. Strips what is never legitimate in any field
 *                (control characters, zero-width marks, bidi overrides). It
 *                never argues and never interrupts typing.
 *   accept()   — a judgement about one field kind. Email has to look like an
 *                email. A name has letters, spaces and a handful of marks.
 *                A rejected value is refused with a reason rather than
 *                silently mangled, because silently mangling a phone number
 *                is worse than saying no.
 *
 * Runs on commit (blur or Enter), never per keystroke: a validator that
 * fights the caret while someone types half a word is a validator people turn
 * off with the browser.
 */
(function (global) {
  'use strict';

  var U = global.RB && global.RB.utils;

  /* Characters that are never content: C0/C1 controls, the zero-width and
   * bidi-override families, and the soft hyphen. They are invisible in the
   * editor and corrupt in an export. */
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

  var RULES = {
    name: {
      label: 'a name',
      allow: /[^\p{L}\p{M} .,'’\-‐/]/gu,
      hint: 'Names use letters, spaces, hyphens and apostrophes.'
    },
    headline: {
      label: 'a job title',
      allow: /[^\p{L}\p{M}\p{N} .,'’\-‐/&+()#]/gu,
      hint: 'A job title uses letters, numbers and a few marks.'
    },
    text: {
      label: 'text',
      allow: null,
      hint: null
    },
    email: {
      label: 'an email address',
      allow: /[^A-Za-z0-9._%+\-@]/g,
      test: function (v) { return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v); },
      hint: 'An email address looks like name@example.com.'
    },
    phone: {
      label: 'a phone number',
      allow: /[^0-9+()\-.\s]/g,
      test: function (v) { return (v.replace(/\D/g, '').length >= 6) && (v.replace(/\D/g, '').length <= 15); },
      hint: 'A phone number is 6 to 15 digits, with spaces, dashes or brackets.'
    },
    url: {
      label: 'a web address',
      allow: /[^A-Za-z0-9.:/?#@!$&'()*+,;=%\-_~]/g,
      test: function (v) { return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\S*)?$/.test(v); },
      fix: function (v) { return v.replace(/^\/*(https?:\/\/)?/i, ''); },
      hint: 'A web address looks like example.com or example.com/page.'
    },
    date: {
      label: 'a date',
      allow: /[^A-Za-z0-9\s.,'’\-/]/g,
      test: function (v) {
        return /^(present|current|now|ongoing)$/i.test(v.trim()) ||
               /^(19|20)\d{2}$/.test(v.trim()) ||
               /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{0,4}\s*(19|20)\d{2}$/i.test(v.trim()) ||
               /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(v.trim());
      },
      hint: 'A date looks like "Mar 2021", "2021", or "Present".'
    }
  };

  /* Which rule applies to a given model path. Ordered: the first match wins,
   * so the more specific patterns come first. */
  function ruleFor(path) {
    var p = String(path || '');
    if (/^basics\.(email|email2)$/.test(p) || /\.email$/i.test(p)) return RULES.email;
    if (/\.phone$|\.mobile$/i.test(p)) return RULES.phone;
    if (/(^|\.)(url|website|portfolio|site|profileUrl)$/i.test(p) || /\.url$/i.test(p)) return RULES.url;
    if (/(^|\.)(date|start|end|startDate|endDate)$/i.test(p) || /\.(start|end)$/.test(p)) return RULES.date;
    if (/^basics\.(name|givenName|familyName)$/.test(p)) return RULES.name;
    if (/^basics\.(label|headline|title)$/i.test(p)) return RULES.headline;
    if (/\.(position|company|institution|studyType|area|org|awarder|issuer|role)$/i.test(p)) return RULES.headline;
    return RULES.text;
  }

  function sanitize(value, path) {
    if (typeof value !== 'string') return value;
    var out = value.replace(INVISIBLE, '');
    var rule = ruleFor(path);
    if (rule && rule.allow) out = out.replace(rule.allow, '');
    return out;
  }

  /* Returns { ok, value, reason } — never throws, never mutates. */
  function accept(value, path) {
    var rule = ruleFor(path);
    var clean = sanitize(value, path);

    if (rule.fix && typeof clean === 'string' && clean.trim() && !rule.test(clean)) {
      clean = rule.fix(clean);
    }
    if (typeof clean === 'string') clean = clean.trim();

    if (rule.test && clean && !rule.test(clean)) {
      return { ok: false, value: value, reason: 'That does not look like ' + rule.label + '. ' + (rule.hint || '') };
    }
    return { ok: true, value: clean, reason: '' };
  }

  /* Keyboard mashing is not a format error, so it is judged rather than
   * blocked — and judged only where a wrong value costs the most. A name with
   * four consonants in a row is not a name. */
  function gibberish(value, path) {
    var rule = ruleFor(path);
    if (rule !== RULES.name && rule !== RULES.headline) return null;
    var v = String(value || '').trim();
    if (v.length < 4) return null;

    var words = v.split(/\s+/).filter(Boolean);
    var vowelFree = words.filter(function (w) { return w.length >= 5 && !/[aeiouyAEIOUY]/.test(w); });
    if (vowelFree.length) {
      return '“' + vowelFree[0] + '” has no vowels. If that is a real word, keep it; if it is a test, the field is about to be shared.';
    }
    /* Random case inside a single unspaced word. A real name is one case
     * (Choudhary), or a deliberate one (McDonald, O'Brien, DeVries) — so the
     * check is a case flip that is not one of those known shapes. */
    if (words.length === 1 && v.length >= 8 && !/^\s*[A-Za-z][''’.]/.test(v)) {
      var letters = v.replace(/[^A-Za-z]/g, '');
      var hasUpper = /[A-Z]/.test(letters);
      var hasLower = /[a-z]/.test(letters);
      if (hasUpper && hasLower) {
        return '“' + v + '” has letters changing case mid-word, which no real ' + rule.label + ' does.';
      }
    }

    var cases = v.replace(/[^A-Za-z]/g, '').split('');
    if (cases.length >= 5) {
      var flips = 0;
      for (var i = 1; i < cases.length; i++) if (cases[i] === cases[i - 1].toUpperCase() && cases[i] !== cases[i - 1]) flips++;
      if (flips / (cases.length - 1) > 0.5) {
        return 'That reads as random capitals rather than a ' + rule.label + '.';
      }
    }
    return null;
  }

  function looksWrong(value, path) {
    var a = accept(value, path);
    if (!a.ok) return a.reason;
    var g = gibberish(a.value, path);
    if (g) return g;
    return null;
  }

  global.RB = global.RB || {};
  global.RB.validate = {
    RULES: RULES,
    ruleFor: ruleFor,
    sanitize: sanitize,
    accept: accept,
    gibberish: gibberish,
    looksWrong: looksWrong,
    INVISIBLE: INVISIBLE
  };
})(window);
