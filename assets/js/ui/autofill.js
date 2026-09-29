/* Resumeboard — auto-build
 *
 * The front door of the product: hand us something you already have and get a
 * structured, fully editable resume back.
 *
 * Four inputs, in descending order of how much work they save the user:
 *   1. A LinkedIn data export (.zip)   — parsed locally, most complete result
 *   2. A public profile or portfolio URL — fetched if the site allows it
 *   3. Pasted profile text            — always works, no permissions needed
 *   4. An existing resume file        — .docx / .json / .txt / .pdf
 *
 * LinkedIn's own export is the supported path for LinkedIn. A browser cannot
 * read a LinkedIn profile page directly: the response requires an authenticated
 * session, the site sends no permissive CORS headers, and automated fetching
 * violates their terms. Saying so plainly beats a spinner that never resolves.
 */
(function (global) {
  'use strict';

  var U = global.RB.utils;
  var bus = global.RB.bus;
  var store = global.RB.store;
  var model = global.RB.model;
  var ui = global.RB.ui;
  var icons = global.RB.icons;
  var el = U.el;
  var doc = global.document;

  /* ------------------------------------------------------------------ *
   * CSV — LinkedIn's export is RFC-4180-ish quoted CSV.
   * ------------------------------------------------------------------ */

  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    text = String(text).replace(/^﻿/, '');

    while (i < text.length) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    var out = [];
    if (!rows.length) return out;
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0] === '') continue;
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c] || 'col' + c] = rows[r][c] == null ? '' : String(rows[r][c]).trim();
      }
      out.push(obj);
    }
    return out;
  }

  function field(rec, names) {
    for (var i = 0; i < names.length; i++) {
      var v = rec[names[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  /* LinkedIn dates: "Mar 2021 - Present", "2016 - 2018", "1 Jan 2015 - 1 Mar 2017" */
  function splitRange(range) {
    if (!range) return { start: '', end: '', current: false };
    var parts = String(range).split(/\s*(?:–|—|-|\bto\b)\s*/i);
    if (parts.length === 1) return { start: parts[0].trim(), end: '', current: false };
    var end = parts[1].trim();
    return {
      start: parts[0].trim(),
      end: /present|current|ongoing|now/i.test(end) ? '' : end,
      current: /present|current|ongoing|now/i.test(end)
    };
  }

  /* ------------------------------------------------------------------ *
   * ZIP — minimal central-directory reader for the LinkedIn export.
   * Stored (method 0) entries need no inflate; anything else uses the
   * native DecompressionStream.
   * ------------------------------------------------------------------ */

  function readZipIndex(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var scanFrom = Math.max(0, bytes.length - 66000);
    for (var i = bytes.length - 22; i >= scanFrom; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Not a ZIP archive.');

    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    if (cdOffset === 0xFFFFFFFF) throw new Error('ZIP64 archives are not supported.');

    var entries = {};
    var p = cdOffset;
    for (var n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, view: view };
  }

  function readZipText(bytes, name) {
    var idx = readZipIndex(bytes);
    var e = idx.entries[name];
    if (!e) return null;
    var view = idx.view;
    var lo = e.localOffset;
    if (view.getUint32(lo, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry: ' + name);
    var nameLen = view.getUint16(lo + 26, true);
    var extraLen = view.getUint16(lo + 28, true);
    var start = lo + 30 + nameLen + extraLen;
    var raw = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return new TextDecoder().decode(raw);
    if (!U.canCompress) throw new Error('This browser cannot unzip compressed entries.');
    return U.inflate(raw).then(function (buf) { return new TextDecoder().decode(buf); });
  }

  function readZipEntryMaybeAsync(bytes, name) {
    var res = readZipText(bytes, name);
    return res && typeof res.then === 'function' ? res : Promise.resolve(res);
  }

  function listZipNames(bytes) {
    try { return Object.keys(readZipIndex(bytes).entries); }
    catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ *
   * LinkedIn export -> resume
   * ------------------------------------------------------------------ */

  function normaliseName(full) {
    var parts = String(full || '').trim().split(/\s+/);
    return {
      name: String(full || '').trim(),
      givenName: parts[0] || '',
      familyName: parts.length > 1 ? parts[parts.length - 1] : ''
    };
  }

  function cleanDescription(html) {
    if (!html) return '';
    /* LinkedIn stores descriptions with HTML and entity escapes. */
    var t = String(html);
    t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/&amp;#39;|&apos;/g, "'").replace(/&amp;quot;|&quot;/g, '"')
         .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
         .replace(/&amp;/g, '&').replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); });
    return t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
  }

  function bulletsFrom(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n+/)
      .map(function (l) { return l.replace(/^[\s•·▪◦‣●○■□*\-–—>]+/, '').trim(); })
      .filter(function (l) { return l.length > 2; });
  }

  /* Each field records how we learned it, so the review screen can be honest
   * rather than asking the user to trust a black box. */
  function provenance(map, field, value, method) {
    if (value == null || value === '' ) return false;
    map[field] = method;
    return true;
  }

  function resumeFromLinkedIn(files) {
    var resume = model.emptyResume();
    var prov = {};
    var warnings = [];
    var used = [];

    function take(fileName, fn) {
      var data = files[fileName];
      if (!data || !data.rows || !data.rows.length) return false;
      used.push(fileName);
      try { fn(data.rows); return true; }
      catch (err) { warnings.push('Could not read ' + fileName + '.'); return false; }
    }

    var profile = null;
    take('Profile.csv', function (rows) { profile = rows[0]; });

    if (profile) {
      var nm = normaliseName(field(profile, ['First Name', 'firstName']));
      var full = field(profile, ['Full Name', 'Name', 'firstName']);
      var first = field(profile, ['First Name', 'firstName']);
      var last = field(profile, ['Last Name', 'lastName']);
      var assembled = [first, last].filter(Boolean).join(' ');
      var finalName = full && full.indexOf('  ') === -1 && full.split(/\s+/).length > 2 ? full : (assembled || full);
      Object.assign(resume.basics, {
        name: finalName,
        givenName: first || nm.givenName,
        familyName: last || nm.familyName
      });
      provenance(prov, 'basics.name', finalName, 'linkedin');
      resume.basics.label = field(profile, ['Headline', 'headline']);
      provenance(prov, 'basics.label', resume.basics.label, 'linkedin');
      resume.basics.summary = cleanDescription(field(profile, ['About', 'Summary', 'summary']));
      provenance(prov, 'basics.summary', resume.basics.summary, 'linkedin');
      resume.basics.email = field(profile, ['Email', 'Email Address', 'emailAddress']);
      provenance(prov, 'basics.email', resume.basics.email, 'linkedin');
      resume.basics.phone = field(profile, ['Phone', 'Phone Numbers', 'phoneNumber']);
      provenance(prov, 'basics.phone', resume.basics.phone, 'linkedin');
      resume.basics.url = field(profile, ['URL', 'Public Profile URL', 'publicProfileUrl'])
        .replace(/^https?:\/\/(www\.)?linkedin\.com/, '').replace(/^\//, '');
      provenance(prov, 'basics.url', resume.basics.url, 'linkedin');
      var loc = [field(profile, ['Location', 'Location Country']), field(profile, ['Country'])].filter(Boolean).join(', ');
      resume.basics.location.city = loc;
      provenance(prov, 'basics.location', loc, 'linkedin');
    }

    take('Positions.csv', function (rows) {
      var byCompany = [];
      rows.forEach(function (r) {
        if (!provenance(prov, 'experience', field(r, ['Company Name']), 'linkedin')) return;
        var range = splitRange(field(r, ['Date From', 'Started On', 'Start Date']));
        var end = field(r, ['Date To', 'Ended On', 'End Date']);
        var endRange = end ? splitRange(range.start + ' - ' + end) : range;
        var loc = field(r, ['Location']);
        var existing = byCompany.filter(function (c) { return c.company === field(r, ['Company Name']); })[0];
        var role = {
          id: U.uid('role'),
          position: field(r, ['Title', 'Position']),
          start: endRange.start,
          end: /present/i.test(field(r, ['Date To', 'Ended On', 'End Date'])) ? '' : endRange.end,
          current: /present/i.test(field(r, ['Date To', 'Ended On', 'End Date'])),
          summary: '',
          highlights: bulletsFrom(cleanDescription(field(r, ['Description']))),
          skills: [],
          visible: true
        };
        if (existing) existing.roles.push(role);
        else byCompany.push({
          id: U.uid('exp'),
          company: field(r, ['Company Name']),
          companyEntity: '',
          location: loc,
          url: '',
          roles: [role],
          visible: true
        });
      });
      byCompany.sort(function (a, b) {
        var as = a.roles[0].start, bs = b.roles[0].start;
        return String(bs).localeCompare(String(as));
      });
      resume.experience = byCompany;
    });

    take('Educations.csv', function (rows) {
      resume.education = rows.map(function (r) {
        var range = splitRange(field(r, ['Start Date']) + ' - ' + field(r, ['End Date']));
        return {
          id: U.uid('edu'),
          institution: field(r, ['School Name']),
          url: '',
          studyType: field(r, ['Degree']),
          area: field(r, ['Field Of Study']),
          score: field(r, ['Grade']),
          courses: [],
          start: field(r, ['Start Date']),
          end: /present/i.test(field(r, ['End Date'])) ? '' : field(r, ['End Date']),
          visible: true
        };
      });
      provenance(prov, 'education', '', 'linkedin');
    });

    take('Skills.csv', function (rows) {
      var groups = {};
      rows.forEach(function (r) {
        var k = field(r, ['Skill']) || field(r, ['Name']);
        if (!k) return;
        var g = field(r, ['Skill Group']) || 'Skills';
        (groups[g] = groups[g] || []).push(k);
      });
      resume.skills = Object.keys(groups).map(function (g) {
        return { id: U.uid('skl'), label: g, keywords: groups[g].slice(0, 40), level: null, visible: true };
      });
      provenance(prov, 'skills', '', 'linkedin');
    });

    take('Certifications.csv', function (rows) {
      resume.certifications = rows.map(function (r) {
        return {
          id: U.uid('crt'),
          name: field(r, ['Name', 'Certification Name']),
          issuer: field(r, ['Issuing Organization', 'Issuer']),
          date: field(r, ['Issue Date', 'Issued On']),
          url: field(r, ['Certification URL', 'Url']),
          credentialId: field(r, ['Certification ID']),
          visible: true
        };
      }).filter(function (c) { return c.name; });
    });

    take('Languages.csv', function (rows) {
      resume.languages = rows.map(function (r) {
        return { id: U.uid('lng'), language: field(r, ['Language Name', 'Name']), fluency: field(r, ['Fluency']) };
      }).filter(function (l) { return l.language; });
    });

    take('Volunteer_Experiences.csv', function (rows) {
      resume.volunteer = rows.map(function (r) {
        return {
          id: U.uid('vol'),
          role: field(r, ['Title', 'Role']),
          organization: field(r, ['Organization']),
          location: '',
          start: field(r, ['Start Date']),
          end: /present/i.test(field(r, ['End Date'])) ? '' : field(r, ['End Date']),
          current: /present/i.test(field(r, ['End Date'])),
          highlights: bulletsFrom(cleanDescription(field(r, ['Description']))),
          visible: true
        };
      }).filter(function (v) { return v.role || v.organization; });
    });

    take('Honors_Awards.csv', function (rows) {
      resume.awards = rows.map(function (r) {
        return {
          id: U.uid('awd'),
          title: field(r, ['Title']),
          awarder: field(r, ['Issuing Organization', 'Awarder']),
          date: field(r, ['Issued On', 'Date']),
          visible: true
        };
      }).filter(function (a) { return a.title; });
    });

    take('Publications.csv', function (rows) {
      resume.publications = rows.map(function (r) {
        return {
          id: U.uid('pub'),
          title: field(r, ['Name', 'Title', 'Publication Name']),
          authors: field(r, ['Authors', 'Author']),
          venue: field(r, ['Publication', 'Publisher', 'Journal']),
          date: field(r, ['Publication Date', 'Date']),
          url: field(r, ['Url', 'URL']),
          doi: field(r, ['DOI']),
          visible: true
        };
      }).filter(function (p) { return p.title; });
    });

    /* A LinkedIn profile is a web page; it is not a resume. Turn the headline
     * into a summary only when the user never wrote an About section. */
    if (!resume.basics.summary && resume.basics.label) {
      resume.basics.summary = '';
    }

    if (profile) {
      var slug = (resume.basics.url || '').split('/').filter(Boolean).pop();
      if (slug && /linkedin\.com\/in\//i.test(resume.basics.url)) {
        /* The same value was just promoted to a profile. Carrying it as the
         * website too prints the link twice on the contact line. */
        resume.basics.profiles = [{ id: U.uid('prf'), network: 'linkedin', label: 'linkedin.com/in/' + slug, url: 'https://linkedin.com/in/' + slug }];
        resume.basics.url = '';
      } else if (resume.basics.url) {
        resume.basics.profiles = [{ id: U.uid('prf'), network: 'other', label: resume.basics.url, url: 'https://' + resume.basics.url }];
        resume.basics.url = '';
      }
    }

    addSectionFor(resume, 'summary');
    addSectionFor(resume, 'experience');
    addSectionFor(resume, 'education');
    addSectionFor(resume, 'skills');
    if (resume.projects && resume.projects.length) addSectionFor(resume, 'projects');
    if (resume.certifications.length) addSectionFor(resume, 'certifications');
    if (resume.publications.length) addSectionFor(resume, 'publications');
    if (resume.awards.length) addSectionFor(resume, 'awards');
    if (resume.volunteer.length) addSectionFor(resume, 'volunteer');
    if (resume.languages.length) addSectionFor(resume, 'languages');

    if (!used.length) warnings.push('That archive did not contain any recognisable LinkedIn export files.');
    return { resume: resume, provenance: prov, warnings: warnings, usedFiles: used };
  }

  /* Register a section without seeding a starter entry. `model.addSection`
   * also pushes a blank entry, which is what you want when a user clicks "Add
   * section" and wrong here: the lists are already populated, so it leaves an
   * empty row at the foot of every section. */
  function addSectionFor(resume, type) {
    var has = (resume.sections || []).some(function (s) { return s.type === type; });
    if (has) return;
    var max = resume.sections.reduce(function (m, s) { return Math.max(m, s.order || 0); }, 0);
    var sec = model.blankSection(type, max + 1);
    resume.sections.push(sec);
  }

  /* ------------------------------------------------------------------ *
   * URL fetch — for sites that actually permit it.
   * ------------------------------------------------------------------ */

  function describeUrl(url) {
    try {
      var u = new URL(url);
      var host = u.hostname.replace(/^www\./, '');
      if (/linkedin\.com$/i.test(host)) {
        return {
          kind: 'linkedin',
          host: host,
          canFetch: false,
          reason: 'LinkedIn requires you to be signed in, so a web page cannot read your profile. The reliable way to import a LinkedIn profile is the data export below.'
        };
      }
      return { kind: 'web', host: host, canFetch: true, reason: '' };
    } catch (e) {
      return { kind: 'invalid', host: '', canFetch: false, reason: 'That does not look like a URL.' };
    }
  }

  /* Fetches a public page and reduces it to readable text. A site that sends no
   * permissive CORS header will fail here, which is expected and is reported
   * plainly rather than retried. */
  function fetchPageText(url) {
    return fetch(url, { credentials: 'omit', redirect: 'follow' })
      .then(function (res) {
        if (!res.ok) throw new Error('The site returned ' + res.status + '.');
        return res.text();
      })
      .then(function (html) {
        if (!/<[a-z][\s\S]*>/i.test(html)) return html;
        /* Inert parse: a detached innerHTML still runs the onerror of an
         * <img> on a page we do not control, and still requests every image
         * on it. A DOMParser document has no browsing context, so neither
         * happens. */
        var holder = new global.DOMParser().parseFromString(html, 'text/html').body;
        holder.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form').forEach(function (n) { n.remove(); });
        var main = holder.querySelector('main,article,[role="main"]') || holder;
        var text = (main.innerText || main.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        var title = (holder.querySelector('title') || {}).textContent || '';
        return (title ? title.trim() + '\n' : '') + text;
      });
  }

  /* ------------------------------------------------------------------ *
   * Bookmarklet — the only way a browser can read a page you can see.
   *
   * A page cannot fetch linkedin.com because the response needs your session
   * and LinkedIn sends no permissive CORS header. But a script you run YOURSELF,
   * in YOUR OWN tab, while you are already signed in, is not crossing any
   * boundary. So we hand the user a bookmarklet: click it on your profile and
   * it carries the visible text straight into the builder. No server, no
   * third party, no extension install.
   * ------------------------------------------------------------------ */

  /* The editor, not the home page. `#p=` is read by boot.js, which only runs
   * on editor.html, so pointing the bookmarklet at index.html dropped the
   * captured profile into a URL nobody reads and left the reader on the front
   * door with no error. Both pages sit in the same directory, so this resolves
   * the same from either. */
  function appUrl() {
    var path = global.location.pathname.replace(/[^/]*$/, '');
    return global.location.origin + path + 'editor.html';
  }

  function buildBookmarklet() {
    var target = appUrl();
    var src =
      "javascript:(function(){" +
      "var m=document.querySelector('main')||document.querySelector('[role=main]')||document.body;" +
      "var t=(m.innerText||m.textContent||'').replace(/\\s+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();" +
      "if(t.length<200){alert('Open your full profile first, then click this again.');return;}" +
      "var u='" + target + "#p='+encodeURIComponent(btoa(unescape(encodeURIComponent(t))));" +
      "var w=window.open(u,'_blank');" +
      "if(!w)location.href=u;" +
      "})();";
    return src;
  }

  function buildBookmarkletNode() {
    var a = el('a', { class: 'rb-af__bm', href: buildBookmarklet(), draggable: 'true' });
    a.setAttribute('role', 'button');
    a.setAttribute('tabindex', '0');
    a.setAttribute('aria-label', 'Resumeboard bookmarklet. Drag this to your bookmarks bar, then click it on your LinkedIn profile.');
    a.appendChild(el('span', { html: icons.svg('bookmark' in {} ? 'bookmark' : 'star', { size: 'sm' }) || icons.svg('star', { size: 'sm' }) }));
    a.appendChild(el('strong', { text: 'Read my LinkedIn' }));
    a.setAttribute('data-bm-help', 'A button for your bookmarks bar');
    a.appendChild(el('span', { class: 'rb-af__bm-hint', text: 'drag me to your bookmarks bar' }));
    return a;
  }

  /* ------------------------------------------------------------------ *
   * The auto-build dialog
   * ------------------------------------------------------------------ */

  var SAMPLE_TEXT = [
    'Jordan Ellis',
    'Senior Software Engineer',
    'jordan.ellis@example.com · +1 206 555 0117 · Seattle, WA',
    'linkedin.com/in/jordanellis',
    '',
    'ABOUT',
    'Software engineer with nine years building payment and data infrastructure.',
    'Led a team of five through a migration of 30 services to a new event bus with zero',
    'downtime. Reduced p99 checkout latency from 900ms to 240ms.',
    '',
    'EXPERIENCE',
    'Senior Software Engineer',
    'Tidepool Systems',
    'Seattle, WA',
    'Mar 2021 - Present',
    '- Led a team of five through a migration of 30 services to a new event bus with zero downtime.',
    '- Cut p99 checkout latency from 900ms to 240ms by rewriting the hot path in Rust.',
    '- Introduced preview environments, taking integration setup from 2 days to 20 minutes.',
    '',
    'Software Engineer',
    'Kestrel Financial',
    'Remote',
    'Jun 2018 - Feb 2021',
    '- Built an idempotent payments API handling $40M in annual volume.',
    '- Reduced failed transactions by 22% by fixing a currency-rounding defect.',
    '',
    'EDUCATION',
    'University of Washington',
    'Bachelor of Science in Computer Science',
    '2014 - 2018',
    '',
    'SKILLS',
    'Go, Rust, TypeScript, PostgreSQL, Kubernetes, AWS, Terraform, Kafka'
  ].join('\n');

  /* The importers report problems in two shapes: plain strings from the text
   * reader, and {level, path, message} records from the JSON reader. Both mean
   * the same thing to the person reading the review screen, and both have to
   * reach it — a warning that is computed and then dropped is the one way
   * content goes missing without anybody being told. */
  function notesFrom(warnings) {
    if (!Array.isArray(warnings)) return [];
    return warnings.map(function (w) {
      if (typeof w === 'string') return { tone: 'warn', text: w };
      if (!w || typeof w !== 'object') return null;
      var where = w.path ? ' (' + w.path + ')' : '';
      /* The text reader reports {code, message} with no level, and everything
       * it reports is a warning. Defaulting those to a quiet hint is how a
       * warning about dropped content ends up looking like a caption. */
      return { tone: w.level === 'info' ? 'info' : 'warn', text: (w.message || '') + where };
    }).filter(function (n) { return n && n.text; });
  }

  function open(options) {
    options = options || {};
    var body = el('div', { class: 'rb-af' });
    var dialog = null;
    var busy = null;

    function setBusy(node) {
      if (busy) busy.remove();
      busy = node || null;
      if (node) body.prepend(node);
      U.qsa('button, input, textarea, select', body).forEach(function (c) { c.disabled = !!node; });
    }

    function progress(label) {
      var bar = el('div', { class: 'rb-af__progress' }, [
        el('div', { class: 'rb-progress' }, [el('div', { class: 'rb-progress__bar', style: 'width:35%' })]),
        el('span', { class: 'rb-hint', text: label })
      ]);
      var t = setInterval(function () {
        var b = bar.querySelector('.rb-progress__bar');
        var w = parseFloat(b.style.width) || 35;
        b.style.width = Math.min(92, w + (92 - w) * 0.12) + '%';
      }, 260);
      setBusy(bar);
      return function done(msg) { clearInterval(t); setBusy(null); if (msg) U.announce(msg); };
  }

    /* ---- tab: paste ---- */
    function buildPaste() {
      var ta = el('textarea', {
        class: 'rb-textarea rb-af__paste',
        id: 'rb-af-paste',
        rows: '12',
        placeholder: 'Paste your LinkedIn profile, your old resume, or anything at all…',
        'aria-label': 'Profile or resume text',
        'aria-describedby': 'rb-af-paste-hint'
      });
      var hint = el('p', { class: 'rb-hint', id: 'rb-af-paste-hint', html: 'On LinkedIn: open your profile, select all the text on the page, and paste it here. Headings, dates, and job entries are detected automatically.' });

      var run = el('button', { class: 'rb-btn rb-btn--primary rb-btn--lg', type: 'button', html: icons.svg('wand') + '<span>Build my resume</span>' });
      var sample = el('button', { class: 'rb-btn rb-btn--secondary', type: 'button', text: 'Use example text' });

      sample.addEventListener('click', function () { ta.value = SAMPLE_TEXT; ta.focus(); });

      run.addEventListener('click', function () {
        var text = ta.value.trim();
        if (!text) { ta.focus(); U.announce('Paste some text first.'); return; }
        var done = progress('Reading your profile…');
        setTimeout(function () {
          try {
            var out = global.RB.importer.text(text, { filename: 'pasted' });
            done();
            review(out.resume, { source: 'Pasted text', fields: fieldList(out.resume), warnings: notesFrom(out.warnings) });
          } catch (err) {
            done();
            ui.toast('That text could not be read as a resume.', { tone: 'error' });
          }
        }, 60);
      });

      return el('div', { class: 'rb-af__pane' }, [ta, hint, el('div', { class: 'rb-af__actions' }, [run, sample])]);
    }

    /* ---- tab: link ---- */
    function buildLink() {
      var input = el('input', { class: 'rb-input', type: 'url', id: 'rb-af-url', placeholder: 'https://linkedin.com/in/yourname', autocomplete: 'url' });
      var note = el('div', { class: 'rb-af__note', role: 'status' });
      var go = el('button', { class: 'rb-btn rb-btn--primary', type: 'button', html: icons.svg('download') + '<span>Fetch page</span>' });

      function assess() {
        var v = input.value.trim();
        note.innerHTML = '';
        note.className = 'rb-af__note';
        if (!v) return null;
        var d = describeUrl(v);
        if (d.kind === 'invalid') {
          note.classList.add('is-bad');
          note.textContent = d.reason;
          return d;
        }
        if (d.kind === 'linkedin') {
          note.classList.add('is-warn');
          note.appendChild(el('strong', { text: 'No website can read a LinkedIn profile — it needs your login. ' }));
          note.appendChild(doc.createTextNode('But you can read it yourself in one click, using the bookmarklet below. Or use the data export, which has every date and every entry.'));
          return d;
        }
        note.classList.add('is-ok');
        note.textContent = 'Will try to read the public page at ' + d.host + '. Some sites block this.';
        return d;
      }

      input.addEventListener('input', assess);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });

      go.addEventListener('click', function () {
        var url = input.value.trim();
        var d = assess();
        if (!d || d.kind === 'invalid' || !d.canFetch) { input.focus(); return; }
        var done = progress('Requesting ' + d.host + '…');
        fetchPageText(url).then(function (text) {
          done();
          if (text.trim().length < 120) throw new Error('That page had almost no readable text.');
          var out = global.RB.importer.text(text, { filename: d.host });
          review(out.resume, { source: d.host, fields: fieldList(out.resume), warnings: notesFrom(out.warnings) });
        }).catch(function (err) {
          done();
          note.className = 'rb-af__note is-bad';
          note.textContent = (err && err.message ? err.message : 'That page could not be read.') +
            ' Most sites block cross-origin requests from a web page. Pasting the text works every time.';
          var a = el('button', { class: 'rb-linkish', type: 'button', text: 'Paste it instead' });
          a.addEventListener('click', function () { selectTab('paste'); });
          note.appendChild(doc.createTextNode(' '));
          note.appendChild(a);
        });
      });

      var copy = el('button', { class: 'rb-btn rb-btn--secondary rb-btn--sm', type: 'button', text: 'Copy bookmarklet' });
      copy.addEventListener('click', function () {
        U.copyText(buildBookmarklet()).then(function () {
          ui.toast('Copied. Paste it into your bookmarks bar.', { tone: 'success' });
        }).catch(function () {
          ui.toast('Could not copy — drag the button instead.', { tone: 'warn' });
        });
      });

      var fallback = el('button', { class: 'rb-linkish', type: 'button', text: 'use the LinkedIn data export instead' });
      fallback.addEventListener('click', function () { selectTab('export'); });

      return el('div', { class: 'rb-af__pane' }, [
        el('div', { class: 'rb-field' }, [
          el('label', { class: 'rb-label', for: 'rb-af-url', text: 'Public profile or portfolio link' }),
          input,
          el('span', { class: 'rb-hint', html: 'Works for sites that serve their HTML openly — a personal site, a portfolio, a <strong>GitHub</strong> profile or a blog. Most sites block cross-origin reads, and LinkedIn always does because it needs your login.' })
        ]),
        note,
        el('div', { class: 'rb-af__actions' }, [go]),
        el('hr', { class: 'rb-divider', style: 'margin:var(--rb-space-3) 0' }),
        el('div', { class: 'rb-af__bmwrap' }, [buildBookmarkletNode(), copy]),
        el('ol', { class: 'rb-af__steps rb-af__steps--tight' }, [
          el('li', {}, ['Show your bookmarks bar with ', el('span', { class: 'rb-kbd', text: U.isMac() ? '⇧⌘B' : 'Ctrl+Shift+B' }), '.']),
          el('li', {}, ['Drag ', el('strong', { text: 'Read my LinkedIn' }), ' onto that bar.']),
          el('li', {}, ['Open your profile, scroll so everything has loaded, then click the bookmark.']),
          el('li', {}, ['It opens here as a draft you can edit.'])
        ]),
        el('p', { class: 'rb-hint' }, ['The bookmarklet runs in your own tab, where you are already signed in, and hands the text to this page. Nothing is sent anywhere. Or ', fallback])
      ]);
    }

    /* ---- tab: export ---- */
    function buildExport() {
      var status = el('div', { class: 'rb-af__note', role: 'status' });
      var drop = el('label', { class: 'rb-af__drop', tabindex: '0', role: 'button' }, [
        el('span', { class: 'rb-af__drop-icon', html: icons.svg('file-up', { size: 'xl' }) }),
        el('strong', { text: 'Choose your LinkedIn archive' }),
        el('span', { class: 'rb-hint', text: 'A .zip file, read here in your browser. Nothing is uploaded.' })
      ]);
      var file = el('input', { type: 'file', accept: '.zip,application/zip', class: 'sr-only' });
      drop.appendChild(file);

      var steps = el('ol', { class: 'rb-af__steps' }, [
        el('li', {}, [el('strong', { text: 'On LinkedIn, go to Settings → Data privacy.' })]),
        el('li', {}, ['Request your archive with ', el('strong', { text: 'Include profile data' }), ' ticked.']),
        el('li', {}, ['LinkedIn emails a download link within a few minutes to a few hours.']),
        el('li', {}, ['Download the .zip and drop it here.'])
      ]);

      function handle(f) {
        if (!f) return;
        if (!/\.zip$/i.test(f.name)) { status.className = 'rb-af__note is-bad'; status.textContent = 'Pick the .zip archive LinkedIn gives you.'; return; }
        var done = progress('Reading ' + f.name + '…');
        U.readAsArrayBuffer(f)
          .then(function (buf) {
            var names = listZipNames(new Uint8Array(buf));
            if (!names.length) throw new Error('That file is not a ZIP archive.');
            var csvNames = names.filter(function (n) { return /\.csv$/i.test(n) && !/connections|recommendation|invitation|message|search|skill endorsements|group/i.test(n); });
            if (!csvNames.length) throw new Error('That archive has no LinkedIn profile files in it.');
            status.className = 'rb-af__note';
            status.textContent = 'Found ' + csvNames.length + ' profile files.';
            return Promise.all(csvNames.map(function (n) {
              return readZipEntryMaybeAsync(new Uint8Array(buf), n).then(function (text) {
                return [n, text];
              }).catch(function () { return null; });
            }));
          })
          .then(function (pairs) {
            var files = {};
            (pairs || []).forEach(function (p) {
              if (!p || !p[1]) return;
              files[p[0]] = { text: p[1], rows: parseCSV(p[1]) };
            });
            var out = resumeFromLinkedIn(files);
            done();
            if (model.isBlankResume(out.resume)) {
              status.className = 'rb-af__note is-bad';
              status.textContent = 'That archive did not contain a readable profile.';
              return;
            }
            review(out.resume, {
              source: 'LinkedIn export',
              fields: fieldList(out.resume),
              note: out.usedFiles.length ? 'Read: ' + out.usedFiles.join(', ') + '.' : '',
              warnings: notesFrom(out.warnings)
            });
          })
          .catch(function (err) {
            done();
            status.className = 'rb-af__note is-bad';
            status.textContent = (err && err.message) || 'That archive could not be read.';
          });
      }

      file.addEventListener('change', function () { handle(file.files && file.files[0]); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('is-over'); handle(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
      drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });

      return el('div', { class: 'rb-af__pane' }, [drop, steps, status]);
    }

    /* ---- tab: file ---- */
    function buildFile() {
      var status = el('div', { class: 'rb-af__note', role: 'status' });
      var drop = el('label', { class: 'rb-af__drop', tabindex: '0', role: 'button' }, [
        el('span', { class: 'rb-af__drop-icon', html: icons.svg('file-down', { size: 'xl' }) }),
        el('strong', { text: 'Drop a resume you already have' }),
        el('span', { class: 'rb-hint', text: '.docx, .json, .txt or .md — all read locally' })
      ]);
      var file = el('input', { type: 'file', accept: '.docx,.json,.txt,.md,.markdown,application/json,text/plain', class: 'sr-only' });
      drop.appendChild(file);

      function handle(f) {
        if (!f) return;
        var done = progress('Reading ' + f.name + '…');
        var name = f.name;
        if (/\.json$/i.test(name)) {
          U.readAsText(f).then(function (t) {
            var out = global.RB.exporters.parseJSON(t);
            done();
            review(out.resume, { source: name, fields: fieldList(out.resume), warnings: notesFrom(out.warnings) });
          }).catch(function (err) { done(); status.className = 'rb-af__note is-bad'; status.textContent = 'That JSON file could not be read.'; });
          return;
        }
        if (/\.docx$/i.test(name)) {
          U.readAsArrayBuffer(f).then(function (buf) {
            return global.RB.importer.docxText(buf);
          }).then(function (res) {
            var out = global.RB.importer.text(res.text, { filename: name });
            done();
            review(out.resume, { source: name, fields: fieldList(out.resume), warnings: notesFrom(out.warnings) });
          }).catch(function (err) {
            done();
            status.className = 'rb-af__note is-bad';
            status.textContent = (err && err.message) || 'That .docx could not be read.';
          });
          return;
        }
        U.readAsText(f).then(function (t) {
          var out = global.RB.importer.text(t, { filename: name });
          done();
          review(out.resume, { source: name, fields: fieldList(out.resume), warnings: notesFrom(out.warnings) });
        }).catch(function () { done(); status.className = 'rb-af__note is-bad'; status.textContent = 'That file could not be read.'; });
      }

      file.addEventListener('change', function () { handle(file.files && file.files[0]); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('is-over'); handle(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
      drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });

      return el('div', { class: 'rb-af__pane' }, [drop, status]);
    }

    /* ---- tabs ---- */
    var TABS = [
      { id: 'paste', label: 'Paste your profile', icon: 'text-cursor' },
      { id: 'link', label: 'Paste a link', icon: 'link' },
      { id: 'export', label: 'LinkedIn export', icon: 'file-down' },
      { id: 'file', label: 'Upload a resume', icon: 'file-up' }
    ];
    var panes = {};
    var current = null;

    function selectTab(id) {
      current = id;
      U.qsa('.rb-af__tab', body).forEach(function (b) {
        var on = b.dataset.tab === id;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      U.qsa('.rb-af__pane', body).forEach(function (p) { p.hidden = p.dataset.pane !== id; });
      var first = panes[id] && panes[id].querySelector('input, textarea, button, [tabindex]');
      if (first) U.requestIdle(function () { first.focus(); }, 40);
    }

    var tablist = el('div', { class: 'rb-af__tabs', role: 'tablist', 'aria-label': 'How to bring in your details' });
    TABS.forEach(function (t) {
      var b = el('button', { class: 'rb-af__tab', type: 'button', role: 'tab', id: 'rb-aftab-' + t.id, dataset: { tab: t.id, pane: t.id } }, [
        el('span', { html: icons.svg(t.icon, { size: 'sm' }) }),
        el('span', { text: t.label })
      ]);
      b.setAttribute('aria-controls', 'rb-afpane-' + t.id);
      b.addEventListener('click', function () { selectTab(t.id); });
      b.addEventListener('keydown', function (e) {
        var i = TABS.findIndex(function (x) { return x.id === current; });
        if (e.key === 'ArrowRight') { e.preventDefault(); selectTab(TABS[(i + 1) % TABS.length].id); U.qs('#rb-aftab-' + current).focus(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); selectTab(TABS[(i - 1 + TABS.length) % TABS.length].id); U.qs('#rb-aftab-' + current).focus(); }
      });
      tablist.appendChild(b);
    });

    ['paste', 'link', 'export', 'file'].forEach(function (id) {
      var pane = { paste: buildPaste, link: buildLink, export: buildExport, file: buildFile }[id]();
      pane.classList.add('rb-af__pane');
      pane.dataset.pane = id;
      pane.id = 'rb-afpane-' + id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', 'rb-aftab-' + id);
      panes[id] = pane;
      body.appendChild(pane);
    });

    body.prepend(tablist);
    body.appendChild(el('p', {
      class: 'rb-af__privacy',
      html: icons.svg('shield', { size: 'sm' }) +
        '<span>Everything here is read in your browser. Nothing is uploaded, there is no account, and no cookies are set.</span>'
    }));

    /* ---- review ---- */
    /* Everything the review screen offers to untick, in one place. A checkbox
     * that does not remove what it names is worse than no checkbox, so the
     * list and the commit read from the same source. */
    var SECTION_KEYS = ['experience', 'education', 'skills', 'projects', 'certifications', 'publications', 'awards', 'volunteer', 'languages'];

    function fieldList(res) {
      var out = [];
      if (res.basics && res.basics.name) out.push({ label: 'Name', value: res.basics.name });
      if (res.basics && res.basics.label) out.push({ label: 'Headline', value: res.basics.label });
      if (res.basics && res.basics.email) out.push({ label: 'Email', value: res.basics.email });
      if (res.basics && res.basics.phone) out.push({ label: 'Phone', value: res.basics.phone });
      if (res.basics && res.basics.location && res.basics.location.city) out.push({ label: 'Location', value: res.basics.location.city });
      if (res.basics && res.basics.url) out.push({ label: 'Website', value: res.basics.url });
      if (res.basics && res.basics.profiles && res.basics.profiles.length) {
        out.push({ label: 'Links', value: res.basics.profiles.map(function (p) { return p.label || p.url; }).filter(Boolean).join(', ') });
      }
      if (res.basics && res.basics.summary) out.push({ label: 'Summary', value: res.basics.summary.slice(0, 120) + (res.basics.summary.length > 120 ? '…' : '') });
      SECTION_KEYS.forEach(function (k) {
        if (res[k] && res[k].length) out.push({ label: U.titleCase(k), value: U.pluralize(res[k].length, 'entry', 'entries') });
      });
      return out;
    }

    function review(resume, meta) {
      /* Keyed by the label the row shows, so commit can ask "did they keep
       * this?" without the list and the commit drifting apart. The boxes are
       * read at commit time rather than mirrored into a map on change: a
       * second copy of the state is a second thing to forget to update, and
       * when it is forgotten the tickboxes quietly do nothing. */
      var boxes = {};

      var list = el('div', { class: 'rb-af__review' });
      (meta.fields || []).forEach(function (f) {
        var id = U.uid('f');
        var box = el('input', { type: 'checkbox', id: id, checked: true });
        boxes[f.label] = box;
        var row = el('label', { class: 'rb-af__row', for: id }, [
          box,
          el('span', { class: 'rb-af__row-label', text: f.label }),
          el('span', { class: 'rb-af__row-value rb-truncate', text: f.value })
        ]);
        list.appendChild(row);
      });

      function kept(label) { return !boxes[label] || boxes[label].checked; }

      /* A resume is already on the page. A plain store.replace here would
       * discard it without a word, which is the one outcome this product must
       * never produce by surprise. RB.mergeStep asks first, and the commit
       * below only runs once an option has been chosen. */
      var hasWork = !!(global.RB.mergeStep && global.RB.merge && global.RB.merge.needsStep(store.get()));
      var commit = el('button', {
        class: 'rb-btn rb-btn--primary rb-btn--lg', type: 'button',
        html: icons.svg(hasWork ? 'shield' : 'check') + '<span>' + (hasWork ? 'See what this changes' : 'Use this resume') + '</span>'
      });
      var back = el('button', { class: 'rb-btn rb-btn--secondary', type: 'button', text: 'Back' });

      back.addEventListener('click', function () { showPanes(); });
      commit.addEventListener('click', function () {
        var prepared = model.validate(prepare()).resume;
        if (hasWork) { showMerge(prepared, meta); return; }
        land(prepared, meta);
      });

      /* A copy, not the import in place. Stepping back from the comparison
       * screen has to show the tick boxes as the reader left them, and a
       * resume that was blanked on the way in would come back with everything
       * ticked and nothing in it. */
      function prepare() {
        var out = model.deepClone(resume);
        var b = out.basics;
        if (!kept('Name')) { b.name = ''; b.givenName = ''; b.familyName = ''; }
        if (!kept('Headline')) b.label = '';
        if (!kept('Email')) b.email = '';
        if (!kept('Phone')) b.phone = '';
        if (!kept('Location')) b.location = { city: '', region: '', countryCode: b.location.countryCode };
        if (!kept('Website')) b.url = '';
        if (!kept('Links')) b.profiles = [];
        if (!kept('Summary')) b.summary = '';
        SECTION_KEYS.forEach(function (k) {
          if (!kept(U.titleCase(k))) out[k] = [];
        });
        return out;
      }

      /* The comparison screen. It lives inside this dialog rather than on top
       * of it, so there is still one focus trap and one Back button. */
      function showMerge(prepared, mergeMeta) {
        body.textContent = '';
        body.appendChild(global.RB.mergeStep.render({
          current: store.get(),
          incoming: prepared,
          source: 'this ' + String(mergeMeta.source || 'import').toLowerCase(),
          onBack: function () { review(resume, mergeMeta); },
          onApply: function (next) { land(model.validate(next).resume, mergeMeta); }
        }));
      }

      /* The single write. One store.replace, so one undo takes the whole
       * import back out, merged or replaced. */
      function land(validated, landMeta) {
        store.replace(validated, { source: 'import' });
        if (dialog) dialog.close();
        /* The store debounces its write. Navigating immediately would race it
         * and land on an empty document, so flush before handing off. */
        (store.persistNow ? store.persistNow() : Promise.resolve()).then(function () {
          ui.toast('Resume built. Everything is editable.', {
            tone: 'success',
            action: { label: 'Undo', onClick: function () { store.undo(); } }
          });
          if (options.onDone) options.onDone(validated);
          bus.emit('autofill:done', { resume: validated, source: landMeta.source });
        });
      }

      var head = el('div', { class: 'rb-af__review-head' }, [
        el('h3', { text: 'Here is what we found' }),
        el('p', { class: 'rb-hint', text: (meta.fields || []).length + ' items read from your ' + (meta.source || 'profile') + '. Untick anything you do not want, then continue — you can edit every word afterwards.' }),
        meta.note ? el('p', { class: 'rb-hint', text: meta.note }) : null
      ]);
      (meta.warnings || []).forEach(function (w) {
        var note = typeof w === 'string' ? { tone: 'warn', text: w } : w;
        if (!note || !note.text) return;
        var cls = note.tone === 'bad' ? 'rb-af__note is-bad' : (note.tone === 'warn' ? 'rb-af__note is-warn' : 'rb-hint');
        head.appendChild(el('p', { class: cls, text: note.text }));
      });

      var foot = el('div', { class: 'rb-af__actions' }, [back, el('span', { class: 'rb-spacer' }), commit]);

      body.innerHTML = '';
      body.appendChild(head);
      body.appendChild(list);
      body.appendChild(foot);
      body.appendChild(el('p', {
        class: 'rb-af__privacy',
        html: icons.svg('info', { size: 'sm' }) + '<span>A LinkedIn profile is a web page, not a resume. It gives us the facts; the wording still needs you. That is what the editor is for.</span>'
      }));
      U.announce('Resume built. Review the items we found.');
      U.requestIdle(function () { commit.focus(); }, 40);
    }

    function showPanes() {
      body.innerHTML = '';
      body.appendChild(tablist);
      Object.keys(panes).forEach(function (k) { body.appendChild(panes[k]); });
      body.appendChild(el('p', {
        class: 'rb-af__privacy',
        html: icons.svg('shield', { size: 'sm' }) +
          '<span>Everything here is read in your browser. Nothing is uploaded, there is no account, and no cookies are set.</span>'
      }));
      selectTab(current || 'paste');
    }

    dialog = ui.modal({
      title: 'Build it from what you already have',
      wide: true,
      body: body,
      actions: [{ label: 'Start blank instead' }],
      onClose: function () { if (options.onDismiss) options.onDismiss(); }
    });

    showPanes();
    return dialog;
  }

  global.RB = global.RB || {};
  global.RB.autofill = {
    open: open,
    parseCSV: parseCSV,
    resumeFromLinkedIn: resumeFromLinkedIn,
    listZipNames: listZipNames,
    describeUrl: describeUrl,
    SAMPLE_TEXT: SAMPLE_TEXT
  };
})(window);
