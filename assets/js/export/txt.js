/* Resumeboard — ATS plain-text exporter
 * The format Greenhouse and Workable parse most reliably: one fact per line,
 * uppercase headings surrounded by blank lines, no rules, no columns, no art.
 * Everything is read straight from the model; nothing is mutated.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils;
  var M = RB.model;
  var EXPORTERS = RB.exporters = RB.exporters || {};

  var EMDASH = '\u2014';
  var PRESENT = 'Present';
  var BULLET = '- ';
  var MIME = 'text/plain;charset=utf-8';

  /* Users paste their own bullets, glyphs and all. Left in place they render
   * as "- \u2022 Did the thing", which most parsers read as a stray token. */
  var LEAD_MARK = /^[\s*\u2022\u2023\u2043\u2219\u25AA\u25CF\u25E6\u00B7-]+/;
  var ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

  function text(value) {
    if (value == null) return '';
    var raw = U ? U.htmlToText(String(value)) : String(value);
    return String(raw)
      .replace(/\u00A0/g, ' ')
      .replace(ZERO_WIDTH, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\t/g, ' ');
  }

  function collapse(value) {
    return text(value).replace(/[ ]+/g, ' ').replace(/\s*\n+\s*/g, ' ').trim();
  }

  function textLines(value) {
    return text(value).split('\n').map(collapse).filter(Boolean);
  }

  function unbullet(value) {
    return collapse(value).replace(LEAD_MARK, '').trim();
  }

  function list(value) {
    if (!Array.isArray(value)) return '';
    return value.map(collapse).filter(Boolean).join(', ');
  }

  function pipe(parts) {
    return parts.filter(Boolean).join(' | ');
  }

  function bullets(value) {
    if (!Array.isArray(value)) return [];
    return value.map(unbullet).filter(Boolean);
  }

  /* ATS keyword matching is literal, so a bare host is worth promoting to a
   * full URL. Anything we cannot recognise is passed through untouched. */
  function href(value) {
    var s = collapse(value);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return 'https://' + s;
    return s;
  }

  function place(loc) {
    if (!loc || typeof loc !== 'object') return collapse(loc);
    return [loc.city, loc.region].map(collapse).filter(Boolean).join(', ');
  }

  function wordish(value) {
    var s = collapse(value);
    if (!s) return '';
    return U && typeof U.titleCase === 'function' ? U.titleCase(s) : s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* titleCase would render these as "Linkedin" and "Github", which looks
   * careless in a document a recruiter reads out loud. */
  var NETWORK_NAME = {
    linkedin: 'LinkedIn', github: 'GitHub', gitlab: 'GitLab', x: 'X', twitter: 'X',
    dribbble: 'Dribbble', behance: 'Behance', medium: 'Medium', youtube: 'YouTube',
    stackoverflow: 'Stack Overflow'
  };

  function networkName(value) {
    var key = collapse(value).toLowerCase();
    return NETWORK_NAME[key] || wordish(value);
  }

  /* A missing end date on a live role is the common case, not an error: the
   * user just never ticked "current". */
  function span(item) {
    if (!item) return '';
    var start = collapse(item.start);
    var end = item.current ? PRESENT : collapse(item.end);
    if (start && end) return start + ' - ' + end;
    return start || end;
  }

  function enabled(resume, node) {
    if (!node || typeof node !== 'object') return false;
    if (node.visible === false) return false;
    var disabled = resume && resume.versions && resume.versions.disabled;
    return !(disabled && node.id && disabled[node.id] === true);
  }

  function entries(resume, type) {
    var list = resume[type];
    if (!Array.isArray(list)) return [];
    return list.filter(function (entry) { return enabled(resume, entry); });
  }

  function isUsable(entry) {
    return !!(M && typeof M.isBlankEntry === 'function' ? !M.isBlankEntry(entry) : true);
  }

  function head(a, b) {
    var left = collapse(a);
    var right = collapse(b);
    if (left && right) return left + ' ' + EMDASH + ' ' + right;
    return left || right;
  }

  /* ---- per-section bodies: arrays of lines, heading emitted separately ---- */

  function highlightBlock(summary, highlights, skills, skillLabel) {
    var lines = [];
    textLines(summary).forEach(function (line) { lines.push(line); });
    bullets(highlights).forEach(function (line) { lines.push(BULLET + line); });
    var named = list(skills);
    if (named) lines.push((skillLabel || 'Skills') + ': ' + named);
    return lines;
  }

  /* Entry groups are separated by one blank line: an ATS reads the blank as an
   * entry boundary, and it is the only signal it has in a flat text file. */
  function join(groups) {
    var lines = [];
    (groups || []).forEach(function (group) {
      var body = (Array.isArray(group) ? group : [group]).filter(Boolean);
      if (!body.length) return;
      if (lines.length) lines.push('');
      body.forEach(function (line) { lines.push(line); });
    });
    return lines;
  }

  var BODY = {
    summary: function (resume) {
      return textLines(resume.basics && resume.basics.summary);
    },

    experience: function (resume) {
      return entries(resume, 'experience').filter(isUsable).map(function (e) {
        var lines = [];
        var company = collapse(e.company);
        var entity = collapse(e.companyEntity);
        if (entity) company = (company ? company + ' ' : '') + entity;
        var line = head(company, e.location);
        if (line) lines.push(line);
        var site = href(e.url);
        if (site) lines.push(site);
        var roles = Array.isArray(e.roles) && e.roles.length ? e.roles : [e];
        roles.filter(function (r) { return r.visible !== false; }).forEach(function (role) {
          var meta = pipe([collapse(role.position), span(role)]);
          if (meta) lines.push(meta);
          lines = lines.concat(highlightBlock(role.summary, role.highlights, role.skills));
        });
        return lines;
      });
    },

    volunteer: function (resume) {
      return entries(resume, 'volunteer').filter(isUsable).map(function (e) {
        var lines = [];
        var line = head(e.organization, e.location);
        if (line) lines.push(line);
        var meta = pipe([collapse(e.role), span(e)]);
        if (meta) lines.push(meta);
        return lines.concat(highlightBlock(e.summary, e.highlights, e.skills));
      });
    },

    education: function (resume) {
      return entries(resume, 'education').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.institution)) lines.push(collapse(e.institution));
        var meta = pipe([[collapse(e.studyType), collapse(e.area)].filter(Boolean).join(', '), span(e)]);
        if (meta) lines.push(meta);
        if (collapse(e.score)) lines.push(collapse(e.score));
        var courses = list(e.courses);
        if (courses) lines.push('Coursework: ' + courses);
        var site = href(e.url);
        if (site) lines.push(site);
        return lines;
      });
    },

    skills: function (resume) {
      return entries(resume, 'skills').filter(isUsable).map(function (e) {
        var name = collapse(e.label);
        if (e.level) name = name ? name + ' (' + wordish(e.level) + ')' : wordish(e.level);
        var named = list(e.keywords);
        if (name && named) return [name + ': ' + named];
        if (name) return [name];
        return named ? [named] : [];
      });
    },

    projects: function (resume) {
      return entries(resume, 'projects').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.name)) lines.push(collapse(e.name));
        var when = span(e);
        if (when) lines.push(when);
        lines = lines.concat(highlightBlock(e.summary, e.highlights, e.keywords, 'Technologies'));
        var site = href(e.url);
        if (site) lines.push(site);
        return lines;
      });
    },

    certifications: function (resume) {
      return entries(resume, 'certifications').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.name)) lines.push(collapse(e.name));
        var meta = pipe([collapse(e.issuer), collapse(e.date)]);
        if (meta) lines.push(meta);
        if (collapse(e.credentialId)) lines.push('Credential ID: ' + collapse(e.credentialId));
        var site = href(e.url);
        if (site) lines.push(site);
        return lines;
      });
    },

    publications: function (resume) {
      return entries(resume, 'publications').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.title)) lines.push(collapse(e.title));
        var meta = pipe([collapse(e.authors), collapse(e.venue), collapse(e.date)]);
        if (meta) lines.push(meta);
        var site = href(e.url);
        if (site) lines.push(site);
        if (collapse(e.doi)) lines.push('DOI: ' + collapse(e.doi));
        return lines;
      });
    },

    awards: function (resume) {
      return entries(resume, 'awards').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.title)) lines.push(collapse(e.title));
        var meta = pipe([collapse(e.awarder), collapse(e.date)]);
        if (meta) lines.push(meta);
        return lines;
      });
    },

    languages: function (resume) {
      return entries(resume, 'languages').filter(isUsable).map(function (e) {
        var name = collapse(e.language);
        var fluency = collapse(e.fluency);
        if (name && fluency) return [name + ': ' + fluency];
        return name ? [name] : [];
      });
    },

    interests: function (resume) {
      return entries(resume, 'interests').filter(isUsable).map(function (e) {
        var label = collapse(e.label);
        return label ? [label] : [];
      });
    },

    references: function (resume) {
      return entries(resume, 'references').filter(isUsable).map(function (e) {
        var lines = [];
        var name = collapse(e.name);
        if (name) lines.push(name);
        if (collapse(e.label)) lines.push(collapse(e.label));
        if (collapse(e.contact)) lines.push(collapse(e.contact));
        return lines;
      });
    },

    coursework: function (resume) {
      return entries(resume, 'coursework').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.name)) lines.push(collapse(e.name));
        var meta = pipe([collapse(e.institution), collapse(e.date)]);
        if (meta) lines.push(meta);
        var site = href(e.url);
        if (site) lines.push(site);
        return lines;
      });
    },

    presentations: function (resume) {
      return entries(resume, 'presentations').filter(isUsable).map(function (e) {
        var lines = [];
        if (collapse(e.title)) lines.push(collapse(e.title));
        var meta = pipe([collapse(e.event), collapse(e.date)]);
        if (meta) lines.push(meta);
        if (collapse(e.location)) lines.push(collapse(e.location));
        return lines.concat(highlightBlock(e.summary, e.highlights, e.keywords, 'Topics'));
      });
    },

    custom: function (resume) {
      /* Returned flat: sectionBody's join() supplies the blank line between
       * rows. Calling join() here as well would nest the separator inside a
       * single group, where it is filtered straight back out. */
      var rows = [];
      entries(resume, 'custom').filter(isUsable).forEach(function (group) {
        (Array.isArray(group.entries) ? group.entries : []).forEach(function (e) {
          if (!isUsable(e)) return;
          var lines = [];
          if (collapse(e.title)) lines.push(collapse(e.title));
          var meta = pipe([collapse(e.org), span(e)]);
          if (meta) lines.push(meta);
          textLines(e.text).forEach(function (line) { lines.push(line); });
          if (lines.length) rows.push(lines);
        });
      });
      return rows;
    }
  };

  function orderedSections(resume) {
    var sections = Array.isArray(resume.sections) ? resume.sections : [];
    if (M && typeof M.orderedSections === 'function') return M.orderedSections(resume);
    return sections.slice();
  }

  function heading(resume, section) {
    var label = collapse(section.label);
    /* Custom sections are labelled by the user on the entry, not the section,
     * so fall back to the first entry that names one. */
    if (!label && section.type === 'custom') {
      var custom = Array.isArray(resume.custom) ? resume.custom : [];
      for (var i = 0; i < custom.length; i++) {
        var candidate = collapse(custom[i] && custom[i].label);
        if (candidate) { label = candidate; break; }
      }
    }
    if (!label && M && typeof M.typeMeta === 'function') {
      var meta = M.typeMeta(section.type);
      if (meta) label = collapse(meta.defaultLabel || meta.label);
    }
    if (!label) label = String(section.type || 'Section');
    return label.toUpperCase();
  }

  function header(resume) {
    var b = resume.basics || {};
    var lines = [];
    var name = collapse(b.name) || [collapse(b.givenName), collapse(b.familyName)].filter(Boolean).join(' ');
    if (!name) name = collapse(resume.meta && resume.meta.title);
    if (name) lines.push(name);
    var label = collapse(b.label) || collapse(resume.meta && resume.meta.targetRole);
    if (label && label !== name) lines.push(label);
    var contact = pipe([collapse(b.email), collapse(b.phone), href(b.url), place(b.location)]);
    if (contact) lines.push(contact);
    if (Array.isArray(b.profiles)) {
      b.profiles.forEach(function (p) {
        if (!p) return;
        var value = collapse(p.label) || href(p.url);
        if (value) lines.push(networkName(p.network || 'Profile') + ': ' + value);
      });
    }
    return lines;
  }

  function sectionBody(resume, section) {
    var fn = BODY[section.type];
    if (!fn) return [];
    var groups = fn(resume);
    return Array.isArray(groups) ? join(groups) : [];
  }

  function assemble(blocks) {
    return blocks
      .map(function (block) {
        var body = block.lines.join('\n');
        if (!body.trim()) return '';
        return block.heading ? block.heading + '\n\n' + body : body;
      })
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim() + '\n';
  }

  function txt(resume) {
    if (!resume || typeof resume !== 'object') return '';
    var blocks = [{ heading: '', lines: header(resume) }];
    orderedSections(resume).forEach(function (section) {
      if (!section || !enabled(resume, section)) return;
      var body = sectionBody(resume, section);
      if (!body.length) return;
      blocks.push({ heading: heading(resume, section), lines: body });
    });
    return assemble(blocks);
  }

  function txtFilename(resume) {
    var b = (resume && resume.basics) || {};
    var seed = collapse(b.name) || collapse(resume && resume.meta && resume.meta.title);
    var slug = U && typeof U.slugify === 'function' ? U.slugify(seed) : 'resume';
    /* A resume with no name is titled "Untitled resume", so a plain append
     * would hand the user "untitled-resume-resume.txt". */
    slug = slug.replace(/(^|-)resume$/, '');
    return (slug ? slug + '-' : '') + 'resume.txt';
  }

  function txtDownload(resume) {
    if (!resume || typeof resume !== 'object') return null;
    if (M && typeof M.isBlankResume === 'function' && M.isBlankResume(resume)) {
      if (RB.ui && typeof RB.ui.toast === 'function') {
        RB.ui.toast('This resume is empty. Add a name or one entry, then export again.', { tone: 'warn' });
      }
      return null;
    }
    var body = txt(resume);
    if (!body) return null;
    if (!U || typeof U.download !== 'function') return null;
    var filename = txtFilename(resume);
    U.download(filename, body, MIME);
    return filename;
  }

  EXPORTERS.txt = txt;
  EXPORTERS.txtFilename = txtFilename;
  EXPORTERS.txtDownload = txtDownload;
})(window);
