/* Resumeboard — JSON import / export
 *
 * Two directions:
 *   export   our own schema (round-trips losslessly) and JSON Resume (interop)
 *   import   our own schema, JSON Resume, and a permissive "loose" shape so a
 *            person or an LLM can hand-write a resume into a text file
 *
 * Invariant: nothing returned by parseJSON reaches a caller unvalidated. Every
 * path runs RB.model.migrate -> RB.model.validate, and anything the mapper or
 * the validator discarded is reported back as a warning rather than dropped
 * silently.
 */
(function (global) {
  'use strict';

  function getModel() { return (global.RB && global.RB.model) || null; }
  function getUtils() { return (global.RB && global.RB.utils) || null; }

  /* ---------- warning collector ------------------------------------------- */

  function Ctx() { this.warnings = []; }
  Ctx.prototype.push = function (level, path, message) {
    this.warnings.push({ level: level, path: path || '', message: message });
  };
  Ctx.prototype.error = function (path, message) { this.push('error', path, message); };
  Ctx.prototype.warn = function (path, message) { this.push('warn', path, message); };
  Ctx.prototype.info = function (path, message) { this.push('info', path, message); };
  Ctx.prototype.hasError = function () {
    return this.warnings.some(function (w) { return w.level === 'error'; });
  };

  /* ---------- small coercion helpers -------------------------------------- */

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function asStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.filter(function (x) { return typeof x === 'string'; }).join(', ');
    return '';
  }
  function asArr(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) return v.split(/\r?\n/);
    return [];
  }
  function cleanList(v) {
    return asArr(v).map(asStr).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  }
  function hasContent(o) {
    return Object.keys(o).some(function (k) {
      var v = o[k];
      if (Array.isArray(v)) return v.length > 0;
      return typeof v === 'string' && v.trim() !== '';
    });
  }
  function normLocation(loc) {
    if (typeof loc === 'string') return { city: loc.trim(), region: '', countryCode: '' };
    if (isObj(loc)) {
      return {
        city: asStr(loc.city || loc.cityName || loc.town).trim(),
        region: asStr(loc.region || loc.state || loc.province || loc.county).trim(),
        countryCode: asStr(loc.countryCode || loc.country_code || loc.country || loc.countryName).trim().toUpperCase().slice(0, 2)
      };
    }
    return { city: '', region: '', countryCode: '' };
  }
  function safeU(v) {
    var s = asStr(v).trim();
    if (!s) return '';
    var model = getModel();
    if (model && typeof model.safeUrl === 'function') {
      try { return model.safeUrl(s); } catch (e) { /* fall through to local guard */ }
    }
    if (/^(https?:)?\/\//i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return 'https://' + s;
    return '';
  }

  /* A reader tracks which alias keys were actually consumed so that anything
   * left over can be reported as "dropped" instead of vanishing. Multiple
   * aliases present at once are all marked consumed, so redundant synonyms do
   * not produce noise. */
  function reader(obj, path, ctx) {
    var consumed = Object.create(null);
    return {
      obj: obj,
      pick: function (aliases) {
        var first;
        for (var i = 0; i < aliases.length; i++) {
          var k = aliases[i];
          var v = obj[k];
          if (v === undefined || v === null) continue;
          if (typeof v === 'string' && v.trim() === '') continue;
          if (Array.isArray(v) && v.length === 0) continue;
          consumed[k] = true;
          if (first === undefined) first = v;
        }
        return first;
      },
      str: function (aliases) { return asStr(this.pick(aliases)).trim(); },
      leftovers: function () {
        Object.keys(obj).forEach(function (k) {
          if (consumed[k]) return;
          var v = obj[k];
          if (v === undefined || v === null) return;
          if (typeof v === 'string' && v.trim() === '') return;
          if (Array.isArray(v) && v.length === 0) return;
          ctx.warn(path ? path + '.' + k : k, 'Ignored field "' + k + '" — no matching slot in the resume.');
        });
      }
    };
  }

  function stripFences(text) {
    var s = String(text).replace(/^\uFEFF/, '').trim();
    var m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
    if (m) return m[1].trim();
    return s;
  }

  /* ---------- format detection --------------------------------------------- */

  var FORMAT_LABEL = { own: 'Resumeboard', jsonresume: 'JSON Resume', loose: 'loose' };

  function detect(obj) {
    if (Array.isArray(obj.sections) ||
        typeof obj.schemaVersion === 'number' ||
        (typeof obj.$schema === 'string' && /resumeboard/i.test(obj.$schema))) return 'own';
    if (Array.isArray(obj.work) ||
        Array.isArray(obj.certificates) ||
        (typeof obj.$schema === 'string' && /jsonresume/i.test(obj.$schema))) return 'jsonresume';
    if (isObj(obj.basics) &&
        (Array.isArray(obj.education) || Array.isArray(obj.skills) || Array.isArray(obj.projects) ||
         Array.isArray(obj.languages) || Array.isArray(obj.basics.profiles) ||
         'label' in obj.basics || 'image' in obj.basics)) return 'jsonresume';
    return 'loose';
  }

  /* ---------- section scaffolding for the mapped formats ------------------- */

  function buildSections(r, model) {
    var secs = [];
    function add(type) {
      var s = model.blankSection(type, secs.length);
      s.order = secs.length;
      secs.push(s);
    }
    add('summary');
    (model.SECTION_TYPES || []).forEach(function (def) {
      if (!def.hasMany) return;
      var list = Array.isArray(r[def.type]) ? r[def.type] : [];
      var core = def.type === 'experience' || def.type === 'education' || def.type === 'skills';
      if (list.length || core) add(def.type);
    });
    return secs;
  }

  function buildBasics(b) {
    return {
      name: b.name || '', givenName: b.givenName || '', familyName: b.familyName || '',
      label: b.label || '', email: b.email || '', phone: b.phone || '', url: b.url || '',
      location: normLocation(b.location),
      summary: b.summary || '',
      photo: b.photo && /^data:image\//i.test(b.photo) ? b.photo : null,
      profiles: Array.isArray(b.profiles) ? b.profiles : []
    };
  }

  /* ---------- mapper: our own schema (pass-through + sweep) ---------------- */

  var OWN_KEYS = {
    $schema: 1, schemaVersion: 1, id: 1, meta: 1, basics: 1, sections: 1, design: 1, versions: 1,
    experience: 1, education: 1, skills: 1, projects: 1, certifications: 1, publications: 1,
    awards: 1, volunteer: 1, languages: 1, interests: 1, references: 1, coursework: 1,
    presentations: 1, custom: 1
  };

  function fromOwn(obj, ctx) {
    Object.keys(obj).forEach(function (k) {
      if (OWN_KEYS[k]) return;
      var v = obj[k];
      if (v === undefined || v === null) return;
      if (typeof v === 'string' && v.trim() === '') return;
      if (Array.isArray(v) && v.length === 0) return;
      ctx.warn(k, 'Ignored field "' + k + '" — not part of the Resumeboard schema.');
    });
    return obj; // migrate() upgrades older versions; validate() sanitizes
  }

  /* ---------- mapper: JSON Resume ------------------------------------------ */

  function fromJSONResume(obj, ctx) {
    var r = { basics: {}, experience: [], volunteer: [], education: [], awards: [], certifications: [], publications: [], skills: [], languages: [], interests: [], references: [], projects: [] };
    var b = isObj(obj.basics) ? obj.basics : {};
    var br = reader(b, 'basics', ctx);
    var photo = br.str(['photo', 'image', 'picture', 'avatar']);
    if (photo && !/^data:image\//i.test(photo)) {
      ctx.warn('basics.photo', 'Photo kept only if it is an embedded data URL; the provided value was ignored.');
    }
    r.basics = buildBasics({
      name: br.str(['name', 'fullName']),
      label: br.str(['label', 'title']),
      email: br.str(['email', 'emailAddress']),
      phone: br.str(['phone', 'phoneNumber', 'mobile']),
      url: safeU(br.str(['url', 'website'])),
      location: normLocation(br.pick(['location', 'address'])),
      summary: br.str(['summary', 'about', 'bio']),
      photo: photo,
      profiles: mapJSONResumeProfiles(br.pick(['profiles', 'social', 'socials']), ctx)
    });

    r.experience = asArr(obj.work).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'work[' + i + ']', ctx);
      var company = rd.str(['name', 'company', 'organization', 'employer']);
      var position = rd.str(['position', 'title', 'role']);
      var start = rd.str(['startDate', 'start', 'from']);
      var end = rd.str(['endDate', 'end', 'to']);
      var summary = rd.str(['summary', 'description']);
      var highlights = cleanList(rd.pick(['highlights', 'bullets', 'achievements']));
      var url = safeU(rd.str(['url', 'website', 'link']));
      var current = end === '';
      rd.leftovers();
      return {
        company: company, companyEntity: '', location: '', url: url, visible: true,
        roles: [{ position: position, start: start, end: current ? '' : end, current: current, summary: summary, highlights: highlights.length ? highlights : [''], skills: [] }]
      };
    });

    r.volunteer = asArr(obj.volunteer).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'volunteer[' + i + ']', ctx);
      var e = {
        role: rd.str(['position', 'role', 'title']),
        organization: rd.str(['organization', 'name', 'employer']),
        location: '',
        start: rd.str(['startDate', 'start', 'from']),
        end: rd.str(['endDate', 'end', 'to']),
        current: false,
        highlights: cleanList(rd.pick(['highlights', 'bullets', 'achievements'])),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    r.education = asArr(obj.education).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'education[' + i + ']', ctx);
      var e = {
        institution: rd.str(['institution', 'school', 'university', 'name']),
        url: safeU(rd.str(['url', 'website', 'link'])),
        studyType: rd.str(['studyType', 'degree', 'type']),
        area: rd.str(['area', 'field', 'fieldOfStudy', 'subject']),
        score: rd.str(['score', 'gpa', 'grade']),
        courses: cleanList(rd.pick(['courses', 'coursework', 'classes'])),
        start: rd.str(['startDate', 'start', 'from']),
        end: rd.str(['endDate', 'end', 'to']),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    r.awards = asArr(obj.awards).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'awards[' + i + ']', ctx);
      var e = { title: rd.str(['title', 'name', 'award']), awarder: rd.str(['awarder', 'awardedBy', 'issuer', 'organization']), date: rd.str(['date', 'dateAwarded', 'awardedDate']), visible: true };
      rd.leftovers();
      return e;
    });

    /* JSON Resume's key is `certificates`; accept the common `certifications`
     * variant too, since several tools emit it. */
    var certs = asArr(obj.certificates);
    if (!certs.length) certs = asArr(obj.certifications);
    r.certifications = certs.map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'certifications[' + i + ']', ctx);
      var e = { name: rd.str(['name', 'title', 'certificate']), issuer: rd.str(['issuer', 'issuerName', 'organization', 'awardedBy']), date: rd.str(['date', 'issueDate', 'releaseDate']), url: safeU(rd.str(['url', 'link'])), credentialId: rd.str(['credentialId', 'serialNumber', 'id']), visible: true };
      rd.leftovers();
      return e;
    });

    r.publications = asArr(obj.publications).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'publications[' + i + ']', ctx);
      var e = { title: rd.str(['name', 'title']), authors: rd.str(['authors', 'author']), venue: rd.str(['publisher', 'venue', 'publication', 'journal']), date: rd.str(['releaseDate', 'date', 'publishedDate']), url: safeU(rd.str(['url', 'link'])), doi: rd.str(['doi']), visible: true };
      rd.leftovers();
      return e;
    });

    r.skills = asArr(obj.skills).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'skills[' + i + ']', ctx);
      var e = { label: rd.str(['name', 'label', 'category', 'skill']), keywords: cleanList(rd.pick(['keywords', 'items', 'skills'])), level: rd.str(['level', 'proficiency']) || null, visible: true };
      rd.leftovers();
      return e;
    });

    r.languages = asArr(obj.languages).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'languages[' + i + ']', ctx);
      var e = { language: rd.str(['language', 'name']), fluency: rd.str(['fluency', 'level', 'proficiency']) };
      rd.leftovers();
      return e;
    });

    r.interests = asArr(obj.interests).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'interests[' + i + ']', ctx);
      var e = { label: rd.str(['name', 'label', 'interest']) };
      rd.leftovers();
      return e;
    });

    r.references = asArr(obj.references).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'references[' + i + ']', ctx);
      var e = { name: rd.str(['name', 'fullName']), label: '', contact: rd.str(['reference', 'contact', 'email', 'phone']), visible: true };
      rd.leftovers();
      return e;
    });

    r.projects = asArr(obj.projects).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'projects[' + i + ']', ctx);
      var start = rd.str(['startDate', 'start', 'from']);
      var end = rd.str(['endDate', 'end', 'to']);
      var e = {
        name: rd.str(['name', 'title', 'project']),
        url: safeU(rd.str(['url', 'website', 'link', 'repository'])),
        start: start, end: end, current: end === '',
        summary: rd.str(['description', 'summary']),
        highlights: cleanList(rd.pick(['highlights', 'bullets', 'features'])),
        keywords: cleanList(rd.pick(['keywords', 'technologies', 'tags'])),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    Object.keys(obj).forEach(function (k) {
      if (['basics', 'work', 'volunteer', 'education', 'awards', 'certificates', 'certifications', 'publications', 'skills', 'languages', 'interests', 'references', 'projects', 'meta', '$schema'].indexOf(k) !== -1) return;
      var v = obj[k];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) return;
      ctx.warn(k, 'Ignored field "' + k + '" — not a JSON Resume section.');
    });

    return r;
  }

  function mapJSONResumeProfiles(value, ctx) {
    var out = [];
    asArr(value).forEach(function (p, i) {
      if (!isObj(p)) return;
      var rd = reader(p, 'basics.profiles[' + i + ']', ctx);
      var net = rd.str(['network', 'site', 'name']) || 'other';
      var url = safeU(rd.str(['url', 'link']));
      var user = rd.str(['username', 'user', 'handle', 'label']);
      if (!user && url) { var m = /\/([^/]+)\/?$/.exec(url); user = m ? m[1] : ''; }
      rd.leftovers();
      if (user || url) out.push({ network: net, label: user, url: url });
    });
    return out;
  }

  /* ---------- mapper: loose (hand-written / LLM) ---------------------------- */

  function fromLoose(obj, ctx) {
    var r = { basics: {}, experience: [], education: [], skills: [], projects: [], certifications: [], publications: [], awards: [], volunteer: [], languages: [], interests: [], references: [], coursework: [], presentations: [] };
    var rt = reader(obj, '', ctx);
    var basics = rt.pick(['basics']);
    var b = isObj(basics) ? basics : obj;
    var br = isObj(basics) ? reader(basics, 'basics', ctx) : null;

    function srt(aliases) {
      if (br) {
        var v = br.str(aliases);
        if (v) return v;
      }
      return rt.str(aliases);
    }
    var photo = srt(['photo', 'image', 'picture', 'avatar']);
    if (photo && !/^data:image\//i.test(photo)) {
      ctx.warn('basics.photo', 'Photo kept only if it is an embedded data URL; the provided value was ignored.');
    }
    r.basics = buildBasics({
      name: srt(['name', 'fullName', 'full_name']),
      label: srt(['label', 'title', 'headline', 'profession']),
      email: srt(['email', 'emailAddress', 'mail']),
      phone: srt(['phone', 'phoneNumber', 'mobile', 'tel', 'telephone']),
      url: safeU(srt(['url', 'website', 'portfolio', 'site', 'homepage', 'link'])),
      location: normLocation(br ? (br.pick(['location', 'address']) || rt.pick(['location', 'address'])) : rt.pick(['location', 'address'])),
      summary: srt(['summary', 'bio', 'objective', 'about', 'tagline', 'profile', 'description']),
      photo: photo,
      profiles: mapLooseProfiles(br ? br.pick(['profiles', 'social', 'socials', 'links']) : rt.pick(['profiles', 'social', 'socials', 'links']), ctx)
    });

    r.experience = asArr(rt.pick(['experience', 'work', 'employment', 'jobs'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'experience[' + i + ']', ctx);
      var company = rd.str(['company', 'employer', 'organization', 'name', 'workplace', 'business']);
      var position = rd.str(['title', 'position', 'role', 'jobTitle', 'roleTitle']);
      var start = rd.str(['start', 'startDate', 'from', 'start_date', 'began']);
      var end = rd.str(['end', 'endDate', 'to', 'end_date', 'ended', 'until']);
      var flag = rd.pick(['current', 'present', 'isCurrent', 'ongoing']);
      var current = !!flag || (!end && !!start);
      var description = rd.str(['description', 'summary', 'about', 'details', 'responsibilities']);
      var bullets = cleanList(rd.pick(['bullets', 'highlights', 'achievements', 'points', 'accomplishments', 'tasks', 'duties', 'results', 'responsibilities']));
      var location = rd.str(['location', 'city', 'place', 'where']);
      var url = safeU(rd.str(['url', 'website', 'link']));
      rd.leftovers();
      return {
        company: company, companyEntity: '', location: location, url: url, visible: true,
        roles: [{ position: position, start: start, end: current ? '' : end, current: current, summary: description, highlights: bullets.length ? bullets : [''], skills: [] }]
      };
    });

    r.education = asArr(rt.pick(['education', 'schools', 'degrees'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'education[' + i + ']', ctx);
      var e = {
        institution: rd.str(['institution', 'school', 'university', 'college', 'name', 'schoolName']),
        url: safeU(rd.str(['url', 'website', 'link'])),
        studyType: rd.str(['studyType', 'degree', 'degreeType', 'type', 'level']),
        area: rd.str(['area', 'field', 'fieldOfStudy', 'major', 'subject', 'discipline']),
        score: rd.str(['score', 'gpa', 'grade']),
        courses: cleanList(rd.pick(['courses', 'coursework', 'classes'])),
        start: rd.str(['start', 'startDate', 'from']),
        end: rd.str(['end', 'endDate', 'to', 'graduated', 'graduationDate']),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    r.skills = mapLooseSkills(rt.pick(['skills', 'technologies', 'competencies', 'expertise']), ctx);

    r.projects = asArr(rt.pick(['projects', 'portfolio'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'projects[' + i + ']', ctx);
      var start = rd.str(['start', 'startDate', 'from']);
      var end = rd.str(['end', 'endDate', 'to']);
      var e = {
        name: rd.str(['name', 'title', 'project']),
        url: safeU(rd.str(['url', 'website', 'link', 'repository'])),
        start: start, end: end, current: end === '',
        summary: rd.str(['description', 'summary', 'about']),
        highlights: cleanList(rd.pick(['highlights', 'bullets', 'features', 'accomplishments'])),
        keywords: cleanList(rd.pick(['keywords', 'technologies', 'tags', 'stack'])),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    r.certifications = asArr(rt.pick(['certifications', 'certificates', 'licenses'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'certifications[' + i + ']', ctx);
      var e = { name: rd.str(['name', 'title', 'certificate']), issuer: rd.str(['issuer', 'organization', 'awardedBy', 'authority']), date: rd.str(['date', 'issueDate', 'obtained']), url: safeU(rd.str(['url', 'link'])), credentialId: rd.str(['credentialId', 'serialNumber', 'id']), visible: true };
      rd.leftovers();
      return e;
    });

    r.publications = asArr(rt.pick(['publications', 'papers'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'publications[' + i + ']', ctx);
      var e = { title: rd.str(['title', 'name']), authors: rd.str(['authors', 'author']), venue: rd.str(['venue', 'publisher', 'journal', 'publication']), date: rd.str(['date', 'publishedDate', 'releaseDate']), url: safeU(rd.str(['url', 'link'])), doi: rd.str(['doi']), visible: true };
      rd.leftovers();
      return e;
    });

    r.awards = asArr(rt.pick(['awards', 'honors', 'achievements'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'awards[' + i + ']', ctx);
      var e = { title: rd.str(['title', 'name', 'award']), awarder: rd.str(['awarder', 'awardedBy', 'issuer', 'organization']), date: rd.str(['date', 'awardedDate', 'dateAwarded']), visible: true };
      rd.leftovers();
      return e;
    });

    r.volunteer = asArr(rt.pick(['volunteer', 'volunteering', 'volunteerExperience'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'volunteer[' + i + ']', ctx);
      var start = rd.str(['start', 'startDate', 'from']);
      var end = rd.str(['end', 'endDate', 'to']);
      var flag = rd.pick(['current', 'present', 'isCurrent', 'ongoing']);
      var e = {
        role: rd.str(['role', 'position', 'title']),
        organization: rd.str(['organization', 'organisation', 'name', 'employer', 'company']),
        location: rd.str(['location', 'city', 'place']),
        start: start, end: !!flag ? '' : end, current: !!flag || (!end && !!start),
        highlights: cleanList(rd.pick(['highlights', 'bullets', 'responsibilities', 'achievements'])),
        visible: true
      };
      rd.leftovers();
      return e;
    });

    r.languages = asArr(rt.pick(['languages', 'language'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'languages[' + i + ']', ctx);
      var e = { language: rd.str(['language', 'name']), fluency: rd.str(['fluency', 'level', 'proficiency']) };
      rd.leftovers();
      return e;
    });

    r.interests = asArr(rt.pick(['interests', 'hobbies'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'interests[' + i + ']', ctx);
      var e = { label: rd.str(['name', 'label', 'interest']) };
      rd.leftovers();
      return e;
    });

    r.references = asArr(rt.pick(['references', 'referees'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'references[' + i + ']', ctx);
      var e = { name: rd.str(['name', 'fullName']), label: rd.str(['title', 'label', 'position']), contact: rd.str(['contact', 'email', 'phone', 'reference']), visible: true };
      rd.leftovers();
      return e;
    });

    r.coursework = asArr(rt.pick(['coursework', 'courses'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'coursework[' + i + ']', ctx);
      var e = { name: rd.str(['name', 'course', 'title']), institution: rd.str(['institution', 'school', 'university']), date: rd.str(['date']), url: safeU(rd.str(['url', 'link', 'website'])) };
      rd.leftovers();
      return e;
    });

    r.presentations = asArr(rt.pick(['presentations', 'talks'])).map(function (it, i) {
      var rd = reader(isObj(it) ? it : {}, 'presentations[' + i + ']', ctx);
      var e = { title: rd.str(['title', 'name']), event: rd.str(['event', 'conference', 'venue']), date: rd.str(['date']), location: rd.str(['location', 'city']), url: safeU(rd.str(['url', 'link'])), highlights: cleanList(rd.pick(['highlights', 'bullets'])) };
      rd.leftovers();
      return e;
    });

    rt.leftovers();
    return r;
  }

  function mapLooseProfiles(value, ctx) {
    var out = [];
    asArr(value).forEach(function (p, i) {
      if (typeof p === 'string') {
        var u = safeU(p);
        if (u) out.push({ network: networkFromUrl(u), label: handleFromUrl(u), url: u });
        return;
      }
      if (!isObj(p)) return;
      var rd = reader(p, 'basics.profiles[' + i + ']', ctx);
      var net = rd.str(['network', 'site', 'name']) || 'other';
      var url = safeU(rd.str(['url', 'link', 'website']));
      var user = rd.str(['username', 'user', 'handle', 'label']) || (url ? handleFromUrl(url) : '');
      rd.leftovers();
      if (user || url) out.push({ network: net, label: user, url: url });
    });
    return out;
  }

  function mapLooseSkills(value, path, ctx) {
    var out = [];
    if (!value) return out;
    if (Array.isArray(value)) {
      if (value.every(function (x) { return typeof x === 'string'; })) {
        var kws = cleanList(value);
        if (kws.length) out.push({ label: '', keywords: kws, level: null, visible: true });
        return out;
      }
      value.forEach(function (it, i) {
        if (!isObj(it)) return;
        var rd = reader(it, (path || 'skills') + '[' + i + ']', ctx);
        var label = rd.str(['name', 'label', 'category', 'group', 'skill']);
        var keywords = cleanList(rd.pick(['keywords', 'items', 'skills', 'technologies', 'values']));
        var level = rd.str(['level', 'proficiency']) || null;
        rd.leftovers();
        if (label || keywords.length) out.push({ label: label, keywords: keywords, level: level, visible: true });
      });
      return out;
    }
    if (isObj(value)) {
      Object.keys(value).forEach(function (group) {
        var kws = cleanList(value[group]);
        if (kws.length) out.push({ label: group, keywords: kws, level: null, visible: true });
      });
      return out;
    }
    var single = cleanList(value);
    if (single.length) out.push({ label: '', keywords: single, level: null, visible: true });
    return out;
  }

  function networkFromUrl(url) {
    var m = /^https?:\/\/(?:www\.)?([^/]+)/i.exec(url);
    if (!m) return 'other';
    var host = m[1].toLowerCase();
    if (host.indexOf('linkedin') !== -1) return 'linkedin';
    if (host.indexOf('github') !== -1) return 'github';
    if (host.indexOf('gitlab') !== -1) return 'gitlab';
    if (host.indexOf('twitter') !== -1 || host.indexOf('x.com') === 0) return 'twitter';
    if (host.indexOf('dribbble') !== -1) return 'dribbble';
    return host;
  }
  function handleFromUrl(url) {
    var m = /\/([^/]+)\/?$/.exec(url);
    return m ? m[1] : '';
  }

  /* ---------- dispatch + validation ---------------------------------------- */

  function toInternal(obj, format, ctx, model) {
    var r;
    if (format === 'own') r = fromOwn(obj, ctx);
    else if (format === 'jsonresume') r = fromJSONResume(obj, ctx);
    else r = fromLoose(obj, ctx);

    if (format !== 'own') {
      r.sections = buildSections(r, model);
      if (typeof r.basics.name === 'string' && r.basics.name.trim()) {
        var parts = r.basics.name.trim().split(/\s+/);
        if (parts.length > 1) {
          r.basics.givenName = parts[0];
          r.basics.familyName = parts.slice(1).join(' ');
        }
      }
      (model.SECTION_TYPES || []).forEach(function (def) {
        if (!def.hasMany || !Array.isArray(r[def.type])) return;
        r[def.type] = r[def.type].filter(function (e) { return !model.isBlankEntry(e); });
      });
    }
    return r;
  }

  function reportDrops(draft, validated, ctx, model) {
    (model.SECTION_TYPES || []).forEach(function (def) {
      if (!def.hasMany) return;
      var before = Array.isArray(draft[def.type]) ? draft[def.type] : null;
      if (!before) return;
      var after = Array.isArray(validated[def.type]) ? validated[def.type] : [];
      if (after.length < before.length) {
        ctx.warn(def.type, (before.length - after.length) + ' of ' + before.length + ' ' + def.label + ' entries were dropped during validation (empty or malformed).');
      }
    });
  }

  function parseJSON(text) {
    var ctx = new Ctx();
    var model = getModel();
    if (!model) {
      ctx.error('', 'The resume model is not loaded, so this file cannot be read yet.');
      return { resume: null, warnings: ctx.warnings, format: null, ok: false };
    }
    if (typeof text !== 'string') {
      ctx.error('', 'No JSON text was provided.');
      return { resume: null, warnings: ctx.warnings, format: null, ok: false };
    }

    var cleaned = stripFences(text);
    if (!cleaned) {
      ctx.error('', 'The file is empty.');
      return { resume: null, warnings: ctx.warnings, format: null, ok: false };
    }

    var obj;
    try {
      obj = JSON.parse(cleaned);
    } catch (e) {
      ctx.error('', 'That is not valid JSON. Check for a missing comma, quote, or brace.');
      return { resume: null, warnings: ctx.warnings, format: null, ok: false };
    }
    if (!isObj(obj)) {
      ctx.error('', 'Expected a JSON object at the top level.');
      return { resume: null, warnings: ctx.warnings, format: null, ok: false };
    }

    var format = detect(obj);
    ctx.info('', 'Read as ' + FORMAT_LABEL[format] + ' format.');

    var draft;
    try {
      draft = toInternal(obj, format, ctx, model);
    } catch (e) {
      ctx.error('', 'The structure could not be read: ' + (e && e.message ? e.message : 'unknown error') + '.');
      return { resume: null, warnings: ctx.warnings, format: format, ok: false };
    }

    /* migrate then validate — the only objects we hand back are validated. */
    var migrated = model.migrate(draft);
    var result = model.validate(migrated);
    if (result.errors && result.errors.length) {
      result.errors.forEach(function (err) { ctx.error(err.path || '', err.message); });
    }
    reportDrops(draft, result.resume, ctx, model);

    if (ctx.hasError()) return { resume: null, warnings: ctx.warnings, format: format, ok: false };
    return { resume: result.resume, warnings: ctx.warnings, format: format, ok: true };
  }

  /* ---------- export: our own schema --------------------------------------- */

  function cleanResume(resume) {
    var model = getModel();
    if (model) {
      try { return model.validate(model.migrate(resume)).resume; } catch (e) { /* fall through */ }
    }
    return resume;
  }

  function jsonString(resume) {
    if (!resume || typeof resume !== 'object') return '';
    try {
      return JSON.stringify(cleanResume(resume), null, 2) + '\n';
    } catch (e) {
      return '';
    }
  }

  function jsonDownload(resume) {
    var text = jsonString(resume);
    if (!text) return null;
    var U = getUtils();
    if (!U || typeof U.download !== 'function' || typeof U.slugify !== 'function') {
      if (global.RB && global.RB.ui && global.RB.ui.toast) global.RB.ui.toast('File download is not available.', { tone: 'error' });
      return null;
    }
    var r = resume || {};
    var b = r.basics || {};
    var name = b.name || (r.meta && r.meta.title) || 'resume';
    var filename = U.slugify(name) + '.json';
    try {
      U.download(filename, text, 'application/json');
    } catch (e) {
      if (global.RB && global.RB.ui && global.RB.ui.toast) global.RB.ui.toast('The file could not be saved.', { tone: 'error' });
      return null;
    }
    return filename;
  }

  /* ---------- export: JSON Resume ------------------------------------------ */

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  /* Our model stores dates as free text on purpose ("Present", "Summer 2019").
   * JSON Resume wants ISO, so normalize only the unambiguous shapes and pass
   * the rest through rather than invent a wrong date. */
  function toISOish(v) {
    var s = asStr(v).trim();
    if (!s) return '';
    if (/^\d{4}(-\d{1,2}){0,2}$/.test(s)) {
      var p = s.split('-');
      if (p.length === 2) return p[0] + '-' + pad2(p[1]);
      return s;
    }
    var m;
    if ((m = /^(\d{4})[\/.](\d{1,2})$/.exec(s))) return m[1] + '-' + pad2(m[2]);
    if ((m = /^(\d{1,2})[\/.](\d{4})$/.exec(s))) return m[2] + '-' + pad2(m[1]);
    if ((m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s))) {
      var mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi !== -1) return m[2] + '-' + pad2(mi + 1);
    }
    return s;
  }

  function toJSONResume(resume) {
    var r = cleanResume(resume) || {};
    var b = r.basics || {};
    var out = {};

    var basics = {
      name: asStr(b.name),
      label: asStr(b.label),
      email: asStr(b.email),
      phone: asStr(b.phone),
      url: asStr(b.url),
      summary: asStr(b.summary)
    };
    /* JSON Resume `image` is a URL; a base64 data photo would bloat the file
     * and is not a URL, so only http(s) photos are carried over. */
    var photo = asStr(b.photo);
    if (/^https?:\/\//i.test(photo)) basics.image = photo;
    var loc = normLocation(b.location);
    if (loc.city || loc.region || loc.countryCode) {
      basics.location = { city: loc.city, region: loc.region, postalCode: '', countryCode: loc.countryCode };
    }
    var profiles = asArr(b.profiles).map(function (p) {
      if (!isObj(p)) return null;
      var url = asStr(p.url);
      var user = asStr(p.label) || handleFromUrl(url);
      var net = asStr(p.network) || 'other';
      if (!user && !url) return null;
      return { network: net, username: user, url: url };
    }).filter(Boolean);
    if (profiles.length) basics.profiles = profiles;
    out.basics = basics;

    var work = [];
    asArr(r.experience).forEach(function (e) {
      asArr(e.roles).forEach(function (role) {
        var item = { name: asStr(e.company), position: asStr(role.position), summary: asStr(role.summary) };
        if (e.url) item.url = asStr(e.url);
        if (role.start) item.startDate = toISOish(role.start);
        var end = role.current ? '' : asStr(role.end);
        if (end) item.endDate = toISOish(end);
        var hl = cleanList(role.highlights);
        if (hl.length) item.highlights = hl;
        if (hasContent(item)) work.push(item);
      });
    });
    if (work.length) out.work = work;

    var volunteer = asArr(r.volunteer).map(function (v) {
      var item = { position: asStr(v.role), organization: asStr(v.organization) };
      if (v.start) item.startDate = toISOish(v.start);
      var end = v.current ? '' : asStr(v.end);
      if (end) item.endDate = toISOish(end);
      var hl = cleanList(v.highlights);
      if (hl.length) item.highlights = hl;
      return item;
    }).filter(hasContent);
    if (volunteer.length) out.volunteer = volunteer;

    var education = asArr(r.education).map(function (e) {
      var item = { institution: asStr(e.institution), studyType: asStr(e.studyType), area: asStr(e.area) };
      if (e.url) item.url = asStr(e.url);
      if (e.score) item.score = asStr(e.score);
      var courses = cleanList(e.courses);
      if (courses.length) item.courses = courses;
      if (e.start) item.startDate = toISOish(e.start);
      if (e.end) item.endDate = toISOish(e.end);
      return item;
    }).filter(hasContent);
    if (education.length) out.education = education;

    var awards = asArr(r.awards).map(function (a) {
      var item = { title: asStr(a.title) };
      if (a.awarder) item.awarder = asStr(a.awarder);
      if (a.date) item.date = toISOish(a.date);
      return item;
    }).filter(hasContent);
    if (awards.length) out.awards = awards;

    var certifications = asArr(r.certifications).map(function (c) {
      var item = { name: asStr(c.name) };
      if (c.issuer) item.issuer = asStr(c.issuer);
      if (c.date) item.date = toISOish(c.date);
      if (c.url) item.url = asStr(c.url);
      return item;
    }).filter(hasContent);
    if (certifications.length) out.certifications = certifications;

    var publications = asArr(r.publications).map(function (p) {
      var item = { name: asStr(p.title) };
      if (p.publisher) item.publisher = asStr(p.publisher);
      if (p.date) item.releaseDate = toISOish(p.date);
      if (p.url) item.url = asStr(p.url);
      if (p.doi) item.doi = asStr(p.doi);
      return item;
    }).filter(hasContent);
    if (publications.length) out.publications = publications;

    var skills = asArr(r.skills).map(function (s) {
      var item = { name: asStr(s.label) };
      if (s.level) item.level = asStr(s.level);
      var kw = cleanList(s.keywords);
      if (kw.length) item.keywords = kw;
      return item;
    }).filter(hasContent);
    if (skills.length) out.skills = skills;

    var languages = asArr(r.languages).map(function (l) {
      var item = { language: asStr(l.language) };
      if (l.fluency) item.fluency = asStr(l.fluency);
      return item;
    }).filter(hasContent);
    if (languages.length) out.languages = languages;

    var interests = asArr(r.interests).map(function (i) { return { name: asStr(i.label) }; }).filter(hasContent);
    if (interests.length) out.interests = interests;

    var references = asArr(r.references).map(function (ref) {
      var item = { name: asStr(ref.name) };
      if (ref.contact) item.reference = asStr(ref.contact);
      return item;
    }).filter(hasContent);
    if (references.length) out.references = references;

    var projects = asArr(r.projects).map(function (p) {
      var item = { name: asStr(p.name), description: asStr(p.summary) };
      if (p.url) item.url = asStr(p.url);
      if (p.start) item.startDate = toISOish(p.start);
      var end = p.current ? '' : asStr(p.end);
      if (end) item.endDate = toISOish(end);
      var hl = cleanList(p.highlights);
      if (hl.length) item.highlights = hl;
      var kw = cleanList(p.keywords);
      if (kw.length) item.keywords = kw;
      return item;
    }).filter(hasContent);
    if (projects.length) out.projects = projects;

    out.meta = {
      version: '1.0',
      lastModified: asStr(r.meta && r.meta.updatedAt) || new Date().toISOString()
    };

    return out;
  }

  /* ---------- register ------------------------------------------------------ */

  global.RB = global.RB || {};
  global.RB.exporters = global.RB.exporters || {};
  global.RB.exporters.jsonString = jsonString;
  global.RB.exporters.jsonDownload = jsonDownload;
  global.RB.exporters.parseJSON = parseJSON;
  global.RB.exporters.toJSONResume = toJSONResume;
})(window);
