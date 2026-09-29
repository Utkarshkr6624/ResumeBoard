/* Resumeboard — Markdown exporter
 * Resume model in, GitHub-flavored Markdown out. Pure text: it touches no DOM,
 * never writes to the store, and makes no network calls, so it is safe to call
 * from any surface (export menu, share sheet, print preview).
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var M = global.RB.model;

  var EM = '\u2014';   // em dash: the "Title — Company" separator
  var EN = '\u2013';   // en dash: the date range
  var DOT = ' \u00b7 '; // contact-line separator
  var PRESENT = 'Present';

  /* Characters that can turn user text into Markdown structure. `#`, `-`, `+`,
   * `=` and `1.` only matter at the start of a line, so they are handled
   * separately; the rest break inline formatting anywhere they appear. */
  var INLINE_SPECIALS = /([\\`*_[\]<>|])/g;
  /* `#`, `>` and `=` are structural anywhere a line begins. `-`, `+` and `1.`
   * only start a list when a space follows, so `+1 415 555` stays unescaped. */
  var LINE_START_BLOCK = /^([ \t]*)([>#=])/;
  var LINE_START_LIST = /^([ \t]*)([+\-]|\d+[.)])(?=[ \t]|$)/;

  function plain(value) {
    if (value == null) return '';
    if (typeof value === 'object') return '';
    var s = String(value).replace(/\r\n?/g, '\n');
    /* Editor fields may hold sanitized inline HTML (<b>, <br>, <a>). Unwrap it
     * first so the escaper never sees markup and a pasted <br> becomes a break. */
    if (/<[a-z/!][^>]*>/i.test(s)) s = U.htmlToText(s);
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function oneLine(value) {
    return plain(value).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  function escLine(line) {
    line = line == null ? '' : String(line);
    return line
      .replace(INLINE_SPECIALS, '\\$1')
      .replace(LINE_START_BLOCK, '$1\\$2')
      .replace(LINE_START_LIST, '$1\\$2');
  }

  function esc(value) { return escLine(oneLine(value)); }

  function escBlock(value) {
    return plain(value).split('\n').map(escLine).join('\n');
  }

  function bold(text) { return text ? '**' + text + '**' : ''; }

  function typeDefault(type) {
    if (typeof M.typeMeta === 'function') {
      var meta = M.typeMeta(type);
      if (meta && meta.defaultLabel) return meta.defaultLabel;
    }
    return String(type || 'Section').toUpperCase();
  }

  function heading(sec) {
    var label = oneLine(sec.label) || typeDefault(sec.type);
    return '## ' + escLine(label);
  }

  /* Double-quoted YAML scalar: unambiguous regardless of what the user typed. */
  function yaml(value) {
    var s = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!s) return '""';
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function encodeUrl(s) {
    return s.replace(/[\s()<>]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function href(value, kind) {
    var s = oneLine(value);
    if (!s) return '';
    if (kind === 'mailto') {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? 'mailto:' + encodeUrl(s) : '';
    }
    var safe = M.safeUrl(s);
    return safe ? encodeUrl(safe) : '';
  }

  function link(label, value, kind) {
    var h = href(value, kind);
    var text = oneLine(label);
    if (!h) return esc(text);
    if (!text) text = esc(h);
    return '[' + text + '](' + h + ')';
  }

  function urlLabel(value) {
    return oneLine(value).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  }

  function siteLink(value) {
    if (!oneLine(value)) return '';
    return link(urlLabel(value) || 'Website', value);
  }

  function list(value) {
    if (!Array.isArray(value)) return '';
    return value.map(oneLine).filter(Boolean).map(esc).join(', ');
  }

  /* Users paste their own bullets, glyphs and all. Kept in the text, the
   * glyph renders as a second marker: "- • Did the thing". A leading digit or
   * dash only counts when a space follows, so "-5% margin" survives. */
  var LEAD_MARK = /^(?:[\s*•▪‣⁓·]+|[-–—+]\s+|\d{1,2}[.)]\s+)/;

  function stripLeadMark(line) {
    return String(line == null ? '' : line).replace(LEAD_MARK, '').trim();
  }

  function bullets(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    value.forEach(function (item) {
      plain(item).split('\n').forEach(function (line) {
        var text = stripLeadMark(line);
        if (text) out.push('- ' + escLine(text));
      });
    });
    return out;
  }

  function joinParts(parts) {
    return parts.filter(Boolean).join('\n\n');
  }

  function locationLine(b) {
    var loc = (b && b.location) || {};
    var city = oneLine(loc.city);
    var region = oneLine(loc.region);
    if (city && region) return city + ', ' + region;
    return city || region || oneLine(loc.countryCode);
  }

  /* A bare country code reads as noise in a contact line; only fall back to it
   * for front matter, where an empty location is worse than a vague one. */
  function locationDisplay(b) {
    var loc = (b && b.location) || {};
    return oneLine(loc.city) || oneLine(loc.region) ? locationLine(b) : '';
  }

  function dateRange(start, end, current) {
    var from = oneLine(start);
    var to = oneLine(end) || (current ? PRESENT : '');
    if (from && to) return from + ' ' + EN + ' ' + to;
    return from || to || '';
  }

  function companyName(entry) {
    var name = oneLine(entry.company);
    var entity = oneLine(entry.companyEntity);
    if (name && entity) return name + ', ' + entity;
    return name || entity;
  }

  function items(r, type) {
    var list_ = typeof M.sectionEntries === 'function' ? M.sectionEntries(r, type) : r[type];
    if (!Array.isArray(list_)) return [];
    return list_.filter(function (entry) {
      if (!entry || typeof entry !== 'object') return false;
      if (entry.visible === false) return false;
      return !(typeof M.isBlankEntry === 'function' && M.isBlankEntry(entry));
    });
  }

  function firstOf(value) {
    return oneLine(value);
  }

  /* "**Term** [em dash] Detail (Date)". The date glues to the detail so a
   * second dash never lands between them. */
  function dashLine(term, detail, date) {
    var parts = [term];
    if (detail) parts.push(EM + ' ' + detail);
    if (date) parts.push('(' + date + ')');
    return parts.filter(Boolean).join(' ');
  }

  function details(parts) {
    return parts.filter(Boolean).join(' ' + EM + ' ');
  }

  function metaLine(parts) {
    return parts.filter(Boolean).join(' \u00b7 ');
  }

  /* ---- contact header -------------------------------------------------- */

  function networkLabel(network) {
    var known = { linkedin: 'LinkedIn', github: 'GitHub', x: 'X', twitter: 'X', dribbble: 'Dribbble', behance: 'Behance' };
    var key = oneLine(network).toLowerCase();
    if (known[key]) return known[key];
    return key ? U.titleCase(key) : 'Profile';
  }

  function contactParts(b) {
    var parts = [];
    var label = oneLine(b.label);
    if (label) parts.push(esc(label));
    var loc = locationDisplay(b);
    if (loc) parts.push(esc(loc));
    if (oneLine(b.email)) parts.push(link(oneLine(b.email), b.email, 'mailto'));
    if (oneLine(b.phone)) parts.push(esc(oneLine(b.phone)));
    var site = siteLink(b.url);
    if (site) parts.push(site);
    (Array.isArray(b.profiles) ? b.profiles : []).forEach(function (profile) {
      if (!profile || profile.visible === false) return;
      /* Two profiles often share one handle; without the network name the line
       * reads "alexrivera · alexrivera". */
      var net = networkLabel(profile.network);
      var text = oneLine(profile.label);
      var display = (text && text.toLowerCase() !== net.toLowerCase()) ? net + ': ' + text : (text || net);
      var h = href(profile.url);
      if (h) parts.push('[' + esc(display) + '](' + h + ')');
      else if (display) parts.push(esc(display));
    });
    return parts;
  }

  function frontMatter(b) {
    var rows = [
      ['name', oneLine(b.name)],
      ['title', oneLine(b.label)],
      ['email', oneLine(b.email)],
      ['location', locationDisplay(b)],
      ['date', U.todayISO()]
    ];
    return '---\n' + rows.map(function (row) { return row[0] + ': ' + yaml(row[1]); }).join('\n') + '\n---';
  }

  /* ---- section renderers ----------------------------------------------- */

  function renderExperience(r) {
    var out = [];
    items(r, 'experience').forEach(function (entry) {
      var company = companyName(entry);
      var roles = (Array.isArray(entry.roles) ? entry.roles : []).filter(function (role) {
        return role && typeof role === 'object' && role.visible !== false;
      });
      var usable = roles.filter(function (role) {
        return oneLine(role.position) || oneLine(role.start) || oneLine(role.end) ||
          oneLine(role.summary) || bullets(role.highlights).length;
      });
      if (!usable.length) usable = roles.length ? [roles[0]] : [];

      if (!usable.length) {
        var lone = [bold(esc(company))];
        if (entry.location) lone.push(esc(oneLine(entry.location)));
        var loneSite = siteLink(entry.url);
        if (loneSite) lone.push(loneSite);
        out.push(joinParts([details(lone)]));
        return;
      }

      usable.forEach(function (role) {
        var position = oneLine(role.position);
        var range = dateRange(role.start, role.end, role.current);
        out.push(joinParts([
          dashLine(bold(esc(position || company)), position && company ? esc(company) : '', range ? esc(range) : ''),
          metaLine([esc(oneLine(entry.location)), siteLink(entry.url)]),
          escBlock(role.summary),
          bullets(role.highlights).join('\n'),
          list(role.skills) ? bold('Skills:') + ' ' + list(role.skills) : ''
        ]));
      });
    });
    return out.join('\n\n');
  }

  function renderVolunteer(r) {
    var out = [];
    items(r, 'volunteer').forEach(function (entry) {
      var role = oneLine(entry.role);
      var org = oneLine(entry.organization);
      var range = dateRange(entry.start, entry.end, entry.current);
      out.push(joinParts([
        dashLine(bold(esc(role || org)), role && org ? esc(org) : '', range ? esc(range) : ''),
        metaLine([esc(oneLine(entry.location))]),
        escBlock(entry.text || entry.summary),
        bullets(entry.highlights).join('\n')
      ]));
    });
    return out.join('\n\n');
  }

  function renderEducation(r) {
    var out = [];
    items(r, 'education').forEach(function (entry) {
      var degree = [oneLine(entry.studyType), oneLine(entry.area)].filter(Boolean).join(', ');
      var range = dateRange(entry.start, entry.end, false);
      out.push(joinParts([
        dashLine(bold(esc(oneLine(entry.institution))), degree ? esc(degree) : '', range ? esc(range) : ''),
        metaLine([
          oneLine(entry.score) ? esc(oneLine(entry.score)) : '',
          siteLink(entry.url)
        ]),
        list(entry.courses) ? bold('Courses:') + ' ' + list(entry.courses) : ''
      ]));
    });
    return out.join('\n\n');
  }

  function renderSkills(r) {
    var out = [];
    items(r, 'skills').forEach(function (entry) {
      var label = oneLine(entry.label);
      var keywords = list(entry.keywords);
      if (label && entry.level) label += ' (' + U.titleCase(entry.level) + ')';
      if (label && keywords) out.push('- ' + bold(esc(label)) + ': ' + keywords);
      else if (label) out.push('- ' + bold(esc(label)));
      else if (keywords) out.push('- ' + keywords);
    });
    return out.join('\n');
  }

  function renderProjects(r) {
    var out = [];
    items(r, 'projects').forEach(function (entry) {
      var range = dateRange(entry.start, entry.end, entry.current);
      out.push(joinParts([
        bold(esc(oneLine(entry.name))) + (range ? ' (' + esc(range) + ')' : ''),
        metaLine([siteLink(entry.url)]),
        escBlock(entry.summary),
        bullets(entry.highlights).join('\n'),
        list(entry.keywords) ? bold('Keywords:') + ' ' + list(entry.keywords) : ''
      ]));
    });
    return out.join('\n\n');
  }

  function renderCertifications(r) {
    var out = [];
    items(r, 'certifications').forEach(function (entry) {
      var date = oneLine(entry.date);
      out.push(joinParts([
        dashLine(bold(esc(oneLine(entry.name))), esc(oneLine(entry.issuer)), date ? esc(date) : ''),
        metaLine([
          siteLink(entry.url),
          oneLine(entry.credentialId) ? 'Credential ID: ' + esc(oneLine(entry.credentialId)) : ''
        ])
      ]));
    });
    return out.join('\n\n');
  }

  function renderPublications(r) {
    var out = [];
    items(r, 'publications').forEach(function (entry) {
      out.push(joinParts([
        bold(esc(oneLine(entry.title))),
        metaLine([
          esc(oneLine(entry.authors)),
          esc(oneLine(entry.venue)),
          esc(oneLine(entry.date))
        ]),
        metaLine([siteLink(entry.url), oneLine(entry.doi) ? link(oneLine(entry.doi), 'https://doi.org/' + oneLine(entry.doi)) : ''])
      ]));
    });
    return out.join('\n\n');
  }

  function renderAwards(r) {
    var out = [];
    items(r, 'awards').forEach(function (entry) {
      var date = oneLine(entry.date);
      out.push('- ' + dashLine(bold(esc(oneLine(entry.title))), esc(oneLine(entry.awarder)), date ? esc(date) : ''));
    });
    return out.join('\n');
  }

  function renderLanguages(r) {
    var out = [];
    items(r, 'languages').forEach(function (entry) {
      var language = oneLine(entry.language);
      if (!language) return;
      out.push('- ' + dashLine(bold(esc(language)), esc(oneLine(entry.fluency)), ''));
    });
    return out.join('\n');
  }

  function renderInterests(r) {
    var out = [];
    items(r, 'interests').forEach(function (entry) {
      var label = oneLine(entry.label);
      if (label) out.push('- ' + esc(label));
    });
    return out.join('\n');
  }

  function renderReferences(r) {
    var out = [];
    items(r, 'references').forEach(function (entry) {
      var contact = oneLine(entry.contact);
      var contactText = contact
        ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? link(contact, contact, 'mailto') : (M.safeUrl(contact) ? link(contact, contact) : esc(contact)))
        : '';
      out.push('- ' + (contactText
        ? dashLine(bold(esc(oneLine(entry.name))), details([esc(oneLine(entry.label)), contactText]), '')
        : dashLine(bold(esc(oneLine(entry.name))), esc(oneLine(entry.label)), '')));
    });
    return out.join('\n');
  }

  function renderCoursework(r) {
    var out = [];
    items(r, 'coursework').forEach(function (entry) {
      out.push('- ' + dashLine(
        bold(esc(oneLine(entry.name))),
        details([esc(oneLine(entry.institution)), siteLink(entry.url)]),
        oneLine(entry.date) ? esc(oneLine(entry.date)) : ''
      ));
    });
    return out.join('\n');
  }

  function renderPresentations(r) {
    var out = [];
    items(r, 'presentations').forEach(function (entry) {
      var head = '- ' + dashLine(
        bold(esc(oneLine(entry.title))),
        details([esc(oneLine(entry.event)), esc(oneLine(entry.location)), siteLink(entry.url)]),
        oneLine(entry.date) ? esc(oneLine(entry.date)) : ''
      );
      var points = bullets(entry.highlights);
      out.push(points.length ? head + '\n' + points.map(function (p) { return '  ' + p; }).join('\n') : head);
    });
    return out.join('\n');
  }

  function renderCustom(r, sec) {
    var out = [];
    /* The section already carries a heading; repeating it as "### Patents"
     * directly under "## PATENTS" is noise unless the groups are named. */
    var sectionLabel = sec ? oneLine(sec.label).toLowerCase() : '';
    items(r, 'custom').forEach(function (entry) {
      var entryLabel = oneLine(entry.label);
      var group = [];
      if (entryLabel && entryLabel.toLowerCase() !== sectionLabel) group.push('### ' + escLine(entryLabel));
      (Array.isArray(entry.entries) ? entry.entries : []).forEach(function (sub) {
        if (!sub || typeof sub !== 'object') return;
        var title = oneLine(sub.title);
        var org = oneLine(sub.org);
        var range = dateRange(sub.start, sub.end, false);
        if (!title && !org && !oneLine(sub.text) && !range) return;
        group.push(joinParts([
          dashLine(bold(esc(title || org)), title && org ? esc(org) : '', range ? esc(range) : ''),
          escBlock(sub.text)
        ]));
      });
      if (group.length) out.push(group.join('\n\n'));
    });
    return out.join('\n\n');
  }

  /* Fallback for section types outside the known set. */
  function renderGeneric(r, type) {
    var out = [];
    items(r, type).forEach(function (entry) {
      var title = firstOf(entry.title || entry.label || entry.name || entry.role);
      if (!title) return;
      out.push(joinParts([bold(esc(title)), escBlock(entry.text || entry.summary)]));
    });
    return out.join('\n\n');
  }

  var RENDERERS = {
    experience: renderExperience,
    volunteer: renderVolunteer,
    education: renderEducation,
    skills: renderSkills,
    projects: renderProjects,
    certifications: renderCertifications,
    publications: renderPublications,
    awards: renderAwards,
    languages: renderLanguages,
    interests: renderInterests,
    references: renderReferences,
    coursework: renderCoursework,
    presentations: renderPresentations,
    custom: renderCustom
  };

  function renderSection(r, sec) {
    var render = RENDERERS[sec.type];
    var body = render ? render(r, sec) : renderGeneric(r, sec.type);
    return body ? heading(sec) + '\n\n' + body : '';
  }

  function renderSummary(b, sec) {
    var text = plain(b.summary);
    if (!text) return '';
    var title = sec && oneLine(sec.label) ? sec.label : typeDefault('summary');
    return '## ' + escLine(title) + '\n\n' + escBlock(text);
  }

  function emptyResume() {
    return typeof M.emptyResume === 'function' ? M.emptyResume() : { basics: {}, sections: [] };
  }

  function orderedSections(r) {
    var secs = typeof M.orderedSections === 'function' ? M.orderedSections(r) : r.sections;
    return Array.isArray(secs) ? secs : [];
  }

  function markdown(resume) {
    var r = resume && typeof resume === 'object' ? resume : emptyResume();
    var b = r.basics && typeof r.basics === 'object' ? r.basics : {};

    var out = [frontMatter(b), '# ' + escBlock(oneLine(b.name) || 'Resume')];

    var contacts = contactParts(b);
    if (contacts.length) {
      /* Label present: the whole line is the identity line, so bold it.
       * Otherwise bold just the first item to keep the line from reading flat. */
      out.push(oneLine(b.label)
        ? bold(contacts.join(DOT))
        : bold(contacts[0]) + (contacts.length > 1 ? DOT + contacts.slice(1).join(DOT) : ''));
    }

    var hasSummary = false;
    var seen = Object.create(null);
    orderedSections(r).forEach(function (sec) {
      if (!sec || sec.visible === false) return;
      /* The model keeps one section per type; guard anyway so a hand-edited or
       * imported file cannot emit the same heading twice. */
      if (seen[sec.type]) return;
      seen[sec.type] = true;
      if (sec.type === 'summary') {
        var block = renderSummary(b, sec);
        if (block) { out.push(block); hasSummary = true; }
        return;
      }
      var rendered = renderSection(r, sec);
      if (rendered) out.push(rendered);
    });

    if (!hasSummary) {
      var fallback = renderSummary(b, null);
      if (fallback) out.unshift(fallback);
    }

    return out.filter(Boolean).join('\n\n') + '\n';
  }

  function filename(resume) {
    var name = resume && resume.basics ? oneLine(resume.basics.name) : '';
    return U.slugify(name ? name + '-resume' : 'resume') + '.md';
  }

  function notify(message, tone) {
    var ui = global.RB.ui;
    if (ui && typeof ui.toast === 'function') ui.toast(message, { tone: tone });
  }

  function markdownDownload(resume) {
    var text;
    try {
      text = markdown(resume);
    } catch (err) {
      notify('The Markdown export could not be built. Your resume is unchanged.', 'error');
      return '';
    }
    if (!U || typeof U.download !== 'function') return text;
    U.download(filename(resume), text, 'text/markdown;charset=utf-8');
    return text;
  }

  RB.exporters = RB.exporters || {};
  RB.exporters.markdown = markdown;
  RB.exporters.markdownDownload = markdownDownload;
  RB.exporters.markdownFilename = filename;
})(window);
