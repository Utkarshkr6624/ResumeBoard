/* Resumeboard — text import heuristics
 *
 * Turns a pasted resume, a DOCX text dump, or the plain-text output of a PDF
 * into a model resume. Pure and synchronous: no DOM, no network, no async.
 * The caller decides what to do with the result — this module never writes to
 * the store and never invents content that was not in the source text.
 *
 * Everything it does is a guess. `confidence` is the report card: only the
 * email, the phone number, and a heading matched against a curated synonym
 * list are ever 'high'. The user reviews the rest.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  RB.importer = RB.importer || {};

  var M = RB.model || null;
  var U = RB.utils || null;

  var MAX_LINES = 4000;
  var MAX_WARNINGS = 20;
  var MAX_ENTRIES = 200;
  var MAX_TEXT = 400000;

  /* Weakest first. Two conflicting signals can only lower confidence. */
  var LEVELS = ['low', 'medium', 'high'];

  var CONFIDENCE_KEYS = [
    'basics.name', 'basics.label', 'basics.email', 'basics.phone', 'basics.url',
    'basics.location', 'basics.summary',
    'section.summary', 'section.experience', 'section.education', 'section.skills',
    'section.projects', 'section.certifications', 'section.publications', 'section.awards',
    'section.volunteer', 'section.languages', 'section.interests', 'section.references',
    'section.coursework', 'section.presentations', 'section.custom',
    'experience', 'education', 'skills', 'projects', 'certifications', 'publications',
    'awards', 'volunteer', 'languages', 'interests', 'references', 'coursework',
    'presentations', 'custom'
  ];

  /* Tie-break order when a heading matches more than one synonym list. */
  var SECTION_ORDER = [
    'summary', 'experience', 'education', 'skills', 'projects', 'certifications',
    'publications', 'awards', 'volunteer', 'coursework', 'presentations',
    'languages', 'interests', 'references'
  ];

  /* The headings people actually type. A student resume leans on academic and
   * competency headings that no recruiter template uses, so the table is wide
   * on purpose: an unrecognised heading still survives as a custom section, but
   * a recognised one keeps a real type, a real icon and a real parser. */
  var SECTION_SYNONYMS = {
    summary: ['summary', 'profile', 'professional profile', 'professional summary', 'about',
      'about me', 'biography', 'bio', 'objective', 'career objective', 'career summary',
      'overview', 'personal statement', 'executive summary', 'career highlights',
      'key qualifications', 'professional overview', 'career profile', 'executive profile',
      'profile summary', 'career overview', 'professional highlights', 'professional focus',
      'summary and objectives', 'summary of qualifications', 'qualifications summary',
      'professional statement', 'professional background and objectives'],
    experience: ['experience', 'experiences', 'employment', 'employment history',
      'work experience', 'professional experience', 'work history', 'career history',
      'industry experience', 'technical experience', 'relevant experience',
      'professional work experience', 'career record', 'appointments', 'positions',
      'work experience history', 'professional employment', 'employment record',
      'career experience', 'job history', 'positions held', 'previous employment',
      'employment details', 'work experience details', 'relevant employment',
      'practical experience', 'employment timeline', 'professional timeline',
      'career timeline', 'internships', 'internship experience', 'work and employment',
      'professional record', 'relevant work experience'],
    education: ['education', 'educational background', 'academic background', 'academics',
      'qualifications', 'education and training', 'training', 'education and qualifications',
      'academic qualifications', 'degrees', 'educational qualifications', 'academic record',
      'education and certifications', 'academic history', 'educational history',
      'education history', 'formal education', 'educational experience', 'educational details',
      'education details', 'degrees and certifications', 'degrees earned', 'academic credentials',
      'college education', 'university education', 'higher education', 'education qualifications',
      'professional education', 'education and training history'],
    skills: ['skills', 'technical skills', 'core skills', 'key skills', 'core competencies',
      'competencies', 'abilities', 'expertise', 'tools', 'technologies', 'key competencies',
      'skill set', 'it skills', 'software proficiency', 'professional skills',
      'technical expertise', 'areas of expertise', 'proficiencies', 'computer skills',
      'technical proficiencies', 'skill summary', 'familiar with', 'programming languages',
      'programming', 'web development', 'frontend development', 'front end development',
      'backend development', 'back end development', 'full stack development', 'app development',
      'mobile development', 'software development', 'web design', 'user experience',
      'user interface', 'ui ux', 'design skills', 'design tools', 'artificial intelligence',
      'machine learning', 'deep learning', 'data science', 'data analytics', 'data analysis',
      'business analysis', 'statistics', 'mathematics', 'engineering skills', 'computer science',
      'databases', 'database management', 'devops', 'cloud computing', 'cybersecurity',
      'information security', 'network security', 'networking', 'version control',
      'operating systems', 'tools and technologies', 'technical tools', 'tech stack',
      'methodologies', 'digital skills', 'technical abilities', 'specialties', 'strengths',
      'languages and tools', 'technical knowledge', 'core skills and competencies',
      'skills and competencies', 'skills and tools', 'technical skill set', 'hard skills',
      'software and tools', 'additional skills', 'other skills', 'relevant skills',
      'key technical skills', 'technical skills and tools', 'programming and tools',
      'tools and software', 'areas of specialization', 'areas of specialisation',
      'fields of expertise', 'special skills', 'computer proficiency', 'computer proficiencies',
      'tools and skill set', 'applied skills', 'practical skills', 'work skills'],
    projects: ['projects', 'personal projects', 'selected projects', 'key projects',
      'project work', 'portfolio', 'side projects', 'notable projects', 'project highlights',
      'professional projects', 'recent projects', 'academic projects', 'technical projects',
      'software projects', 'web projects', 'project portfolio', 'project experience',
      'project details', 'research projects', 'selected work', 'project showcase',
      'major projects', 'relevant projects', 'ongoing projects', 'capstone project',
      'capstone projects', 'thesis project', 'project work and experience'],
    certifications: ['certifications', 'certification', 'certificates',
      'certification and licenses', 'licenses', 'licenses and certifications',
      'professional certifications', 'courses and certifications', 'credentials',
      'accreditations', 'licences', 'certifications and licences', 'certifications and training',
      'certification and license', 'professional development', 'courses and training',
      'training and certifications', 'accreditation', 'technical certifications',
      'it certifications', 'industry certifications', 'certifications and courses',
      'diplomas and certificates', 'education and licenses', 'credentials and certifications',
      'licenses and accreditations', 'certification details'],
    publications: ['publications', 'papers', 'research', 'research publications',
      'journal articles', 'conference papers', 'selected publications', 'patents',
      'books and publications', 'writing and publications', 'research output',
      'research and publications', 'scholarly work', 'publications and presentations',
      'papers and publications', 'theses', 'dissertations', 'technical writing'],
    awards: ['awards', 'honors', 'honours', 'awards and honors', 'awards and honours',
      'achievements', 'accomplishments', 'recognitions', 'awards and recognition',
      'honors and awards', 'awards and achievements', 'honours and awards',
      'awards and scholarships', 'scholarships', 'honors and scholarships',
      'academic honors', 'achievements and awards', 'distinctions', 'recognition',
      'professional recognition', 'awards received', 'selected awards', 'key achievements',
      'honours and achievements', 'scholarships and awards'],
    volunteer: ['volunteer', 'volunteering', 'volunteer experience', 'volunteer work',
      'community involvement', 'community service', 'service and volunteer',
      'volunteer activities', 'service', 'volunteer and community', 'community engagement',
      'community leadership', 'civic engagement', 'social service', 'charity work',
      'non profit', 'nonprofit work', 'volunteering experience', 'community activities',
      'service learning', 'social impact', 'giving and volunteering', 'community and service'],
    languages: ['languages', 'language skills', 'spoken languages', 'language proficiency',
      'languages spoken', 'language and fluency', 'foreign languages', 'language',
      'bilingual skills', 'multilingual abilities', 'spoken and written languages',
      'language and communication', 'foreign language', 'linguistic skills',
      'language proficiency level', 'additional languages'],
    interests: ['interests', 'hobbies', 'activities', 'interests and hobbies',
      'interests & hobbies', 'outside interests', 'activities and interests',
      'hobbies and interests', 'career interests', 'interests and activities',
      'areas of interest', 'personal interests', 'professional interests', 'other interests',
      'leisure activities', 'sports', 'hobbies and activities',
      'interests hobbies and activities', 'career aspirations', 'career goals',
      'interests and career goals', 'affiliations', 'memberships', 'clubs and organizations',
      'organizations and clubs', 'interests and aspirations'],
    references: ['references', 'referees', 'references and contacts', 'professional references',
      'recommendations', 'references available upon request', 'reference', 'referee',
      'references available on request', 'professional referees', 'contact references'],
    coursework: ['coursework', 'relevant coursework', 'course work', 'classes',
      'course work and projects', 'selected coursework', 'additional coursework',
      'academic coursework', 'academic courses', 'relevant courses', 'relevant classes',
      'coursework highlights', 'key coursework', 'coursework and research',
      'coursework and projects', 'related coursework', 'elective coursework', 'selected courses',
      'selected classes', 'courses taken', 'classes taken', 'academic electives', 'electives',
      'academic training', 'technical coursework', 'advanced coursework', 'core coursework',
      'undergraduate coursework', 'graduate coursework', 'coursework list',
      'classes and coursework', 'relevant training', 'professional training', 'training courses',
      'continuing education', 'academic focus', 'focus areas', 'coursework details',
      'relevant academic coursework'],
    presentations: ['presentations', 'talks', 'speaking engagements', 'presentations and talks',
      'conference talks', 'public speaking', 'presentations and speaking',
      'conference presentations', 'invited talks', 'keynote', 'talks given',
      'presentations and workshops', 'workshops', 'seminars', 'webinars']
  };

  /* Match strength. A heading can hit several lists at once — "Technical
   * Skills and Languages" hits two, "Programming Languages" hits two more — so
   * every hit is scored and the strongest wins instead of whichever list was
   * written first. Without that, "Programming Languages" was filed as spoken
   * languages on a resume that lists no spoken languages at all. */
  var TIER_EXACT = 1000;   /* the heading is the synonym, word for word */
  var TIER_PREFIX = 700;   /* "Technical Skills & Tools" */
  var TIER_SUFFIX = 640;   /* "My Professional Experience" */
  var TIER_INNER = 520;    /* "Artificial Intelligence / Machine Learning" */
  var TIER_LOOSE = 200;    /* the synonym sits inside a longer word */
  var MAX_HEADING_KEY = 64;
  var MAX_HEADING_WORDS = 8;
  var MAX_AFFIX_GAP = 30;  /* how much extra text a prefix or suffix may carry */

  /* Pre-normalised synonym lists, in tie-break order. */
  var SYN_LISTS = SECTION_ORDER.map(function (type) {
    return {
      type: type,
      keys: (SECTION_SYNONYMS[type] || []).map(normalizeKey).filter(function (k) { return k.length > 2; })
    };
  });

  var SYN_INDEX = (function () {
    var map = {};
    SYN_LISTS.forEach(function (list) {
      list.keys.forEach(function (k) { if (!map[k]) map[k] = list.type; });
    });
    return map;
  })();

  /* Nouns that only show up in a job title. Bare domain words are deliberately
   * excluded: "Product roadmap" is not a job. */
  var ROLE_NOUNS = ('manager engineer developer designer analyst consultant specialist coordinator ' +
    'administrator architect scientist researcher technician director officer president lead head ' +
    'assistant associate intern executive strategist planner accountant attorney auditor supervisor ' +
    'teacher professor instructor trainer nurse physician pharmacist dentist lawyer editor writer ' +
    'producer marketer recruiter advisor advocate owner founder principal broker chef driver ' +
    'mechanic operator paralegal notary appraiser actuary underwriter programmer tester ' +
    'representative agent practitioner fellow resident clerk cashier guide handler copywriter ' +
    'proofreader linguist therapist counselor merchandiser').split(' ');

  var DOMAIN_WORDS = ('product project marketing sales software data web mobile cloud security ' +
    'financial accounting human resources digital content graphic industrial mechanical civil ' +
    'electrical user ux ui seo clinical legal medical supply operations business program quality ' +
    'testing visual experience design').split(' ');

  var TITLE_MODIFIERS = ('senior junior lead principal staff associate intern graduate entry ' +
    'trainee apprentice global regional head chief deputy technical operational strategic ' +
    'digital executive creative customer junior-level senior-level mid-level onsite remote')
    .split(' ');

  var MULTIWORD_TITLES = [
    'product manager', 'project manager', 'program manager', 'product designer',
    'ux designer', 'ui designer', 'graphic designer', 'web designer', 'industrial designer',
    'software engineer', 'software developer', 'software architect', 'web developer',
    'front end developer', 'frontend developer', 'backend developer', 'back end developer',
    'full stack developer', 'mobile developer', 'ios developer', 'android developer',
    'data scientist', 'data analyst', 'data engineer', 'data architect',
    'machine learning engineer', 'business analyst', 'business intelligence analyst',
    'system administrator', 'marketing manager', 'sales manager', 'account manager',
    'regional manager', 'engineering manager', 'engineering director', 'it manager',
    'hr manager', 'operations manager', 'office manager', 'general manager', 'plant manager',
    'product owner', 'scrum master', 'agile coach', 'tech lead', 'team lead',
    'research scientist', 'research assistant', 'teaching assistant',
    'clinical research associate', 'regulatory affairs specialist',
    'quality assurance specialist', 'customer success manager',
    'customer service representative', 'chief executive officer',
    'chief technology officer', 'chief financial officer', 'chief operating officer',
    'chief marketing officer', 'vice president', 'senior vice president',
    'assistant vice president', 'board member', 'independent contractor',
    'freelance consultant', 'account executive', 'sales representative',
    'brand manager', 'communications manager', 'community manager', 'content manager',
    'financial analyst', 'credit analyst', 'risk analyst', 'compliance officer',
    'legal counsel', 'compliance manager', 'tax accountant', 'registered nurse',
    'nurse practitioner', 'physician assistant', 'high school teacher',
    'elementary teacher', 'secondary teacher', 'site reliability engineer'
  ];

  var TITLE_RE = (function () {
    var nouns = ROLE_NOUNS.map(escapeRe).join('|');
    var mods = TITLE_MODIFIERS.map(escapeRe).join('|');
    var dom = DOMAIN_WORDS.map(escapeRe).join('|');
    return new RegExp('\\b(?:' + mods + ')\\b[^\\w]{0,3}\\b(?:' + nouns + ')\\b' +
      '|\\b(?:' + dom + ')\\b[^\\w]{0,3}\\b(?:' + nouns + ')\\b' +
      '|\\b(?:' + nouns + ')\\b[^\\w]{0,3}\\b(?:' + mods + ')\\b', 'i');
  })();

  var DEGREE_RES = [
    /bachelor/i, /master/i, /doctorate/i, /\bph\.?\s?d\b/i, /\bm\.?b\.?a\b/i,
    /\bb\.?s\.?c\b|\bm\.?s\.?c\b|\bb\.?s\b|\bm\.?s\b|\bb\.?a\b|\bm\.?a\b/i,
    /\bb\.?tech\b|\bm\.?tech\b|\bb\.?e\b|\bm\.?e\b|\bb\.?com\b|\bm\.?com\b/i,
    /\bb\.?fa\b|\bm\.?fa\b|\bm\.?f\.?a\b|\bb\.?arch\b|\bm\.?arch\b/i,
    /associate(?:['’]s)?\s+degree/i, /diploma/i, /foundation/i,
    /postgraduate|undergraduate|post-?grad/i, /licen[cs]e\b/i, /\bcertificate\b/i,
    /bar\s+admission/i
  ];

  var INSTITUTION_RE = /\b(university|college|institute|school|academy|polytechnic|campus|faculty|conservator(?:y|ie)|universit[a-zäöüéèíóúàñ]{2,}|universidad|hochschule|lyc[ée]e|gymnasium|instituto)\b/i;

  var ORG_SUFFIX_RE = /\b(inc|llc|ltd|limited|corp|corporation|company|gmbh|plc|bv|nv|pty|holdings?|group|partners|associates|ventures|labs?|studios?|systems?|solutions|technolog(?:y|ies)|consulting|enterprises)\b\.?\s*$/i;

  var BULLET_RE = /^\s*(?:[-*+•▪◦‣●○■□·–—]|\d{1,2}[.)])\s+/;
  var BULLET_STRIP_RE = /^\s*(?:[-*+•▪◦‣●○■□·–—]|\d{1,2}[.)])\s+/;

  /* EMAIL_SOURCE and URL_SOURCE state the grammar of the two contact scanners
   * below. Their global forms are kept because text.heuristics exposes them,
   * but the scanners do not use them: on a line with no whitespace the pattern
   * is quadratic (see findUrls). The non-global TEST forms answer the cheap
   * "could this bounded string be an address" question and are fine. */
  var EMAIL_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,24}';
  var EMAIL_RE = new RegExp(EMAIL_SOURCE, 'g');
  var EMAIL_TEST_RE = new RegExp(EMAIL_SOURCE);

  var TLD_LIST = ('online site tech store blog page link pro name mobi tv cc xyz ' +
    'com net org edu gov int mil info biz me io co ai dev app design ' +
    'uk us ca de fr es it nl se no fi dk pl pt gr cz at ch be ie hu ro bg hr si sk ee lt lv ru ua tr il in jp kr cn tw hk sg au nz br mx ar cl za ng ke eg ae sa th ph vn id my').split(' ');
  var TLD_ALT = TLD_LIST.slice().sort(function (a, b) { return b.length - a.length; })
    .map(escapeRe).join('|');
  var URL_SOURCE = '(?:https?:\\/\\/|www\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9-]*[A-Za-z0-9])*\\.(?:' + TLD_ALT + ')(?:\\/[^\\s|<>"\'`]*)?';
  /* The global form carries the left-context test findUrls applies, as a
   * lookbehind. Without it the pattern was missing a rule the scanner had, and
   * paid for it: every start position inside an unbroken run re-scanned the
   * rest of the line, so URL_RE.exec over 200 KB of unbroken text took 35
   * seconds where findUrls over the same text takes 9 ms. The TEST form is
   * deliberately left unguarded — it is only ever asked "could this bounded
   * string be an address", where a lookbehind would change the answer. */
  var URL_RE = new RegExp('(?<![A-Za-z0-9@./-])' + URL_SOURCE, 'gi');
  var URL_TEST_RE = new RegExp(URL_SOURCE, 'i');

  /* "etc." and "no." are two letters and a dot, and so is a real TLD. */
  var URL_STOPWORDS = ('no es in it is at be so to of on or us uk de la el me my we an as by do go he if up am et al id os ok im ox pc ad').split(' ');

  var PHONE_INTL_RE = /(?:\+|00)\d[\d\s().\-–]{6,20}\d/g;
  var PHONE_LOCAL_RE = /\(?\b\d{3}\)?[\s.\-–]{0,3}\b\d{3}[\s.\-–]{0,3}\d{4}\b/g;

  var MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var SEASON = '(?:spring|summer|autumn|fall|winter)';
  var YEAR = '(?:19|20)\\d{2}';
  var NUMERIC_YEAR = YEAR + '|\\d{1,2}[/\\-]\\d{2,4}|\\d{1,2}[/\\-]\\d{1,2}[/\\-]\\d{2,4}|\\d{4}';
  var DATE_TOKEN = MONTH + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+' + YEAR +
    '|' + MONTH + '\\.?\\s+' + YEAR + '|' + NUMERIC_YEAR;
  var SEASON_PREFIXED = '(?:' + SEASON + '\\s+)?(?:' + DATE_TOKEN + ')';
  var PRESENT_SOURCE = '(?:present|current(?:ly)?|now|today|ongoing|to\\s?date|until\\s?now)';
  var SEPARATOR_SOURCE = '\\s*(?:-{1,2}|–|—|~{1,2}|\\bto\\b|\\bthrough\\b|\\buntil\\b|\\btil+l?\\b)\\s*';
  var RANGE_RE = new RegExp('(' + SEASON_PREFIXED + ')' + SEPARATOR_SOURCE + '(' + PRESENT_SOURCE + '|' + SEASON_PREFIXED + ')', 'gi');
  var PRESENT_ONLY_RE = new RegExp('^\\s*(?:' + PRESENT_SOURCE + ')\\s*$', 'i');
  var SINGLE_RE = new RegExp('(?:^|[\\s(\\[,])(' + SEASON_PREFIXED + ')(?=$|[\\s)\\].,;:!])', 'gi');
  var PRESENT_TEST_RE = new RegExp('^(?:' + PRESENT_SOURCE + ')$', 'i');

  var LOCATION_RE = /^[A-ZÀ-Þ][\wÀ-ɏ'’. -]*(?:,\s*[A-Za-zÀ-ɏ'’.-]+(?:\s+[A-Za-zÀ-ɏ'’.-]+){0,2}){1,3}$/;
  var REGION_CODE_RE = /^[A-Z]{2,3}$/;
  var REMOTE_RE = /^(?:remote|hybrid|on-?site|relocation available|open to remote)$/i;

  var NETWORKS = [
    { key: 'linkedin', re: /(^|\.)linkedin\.com$/i },
    { key: 'github', re: /(^|\.)github\.com$/i },
    { key: 'gitlab', re: /(^|\.)gitlab\.com$/i },
    { key: 'dribbble', re: /(^|\.)dribbble\.com$/i },
    { key: 'behance', re: /(^|\.)behance\.net$/i },
    { key: 'medium', re: /(^|\.)medium\.com$/i },
    { key: 'stackoverflow', re: /(^|\.)stackoverflow\.com$/i },
    { key: 'dev', re: /(^|\.)dev\.to$/i },
    { key: 'x', re: /(^|\.)(x|twitter)\.com$/i },
    { key: 'youtube', re: /(^|\.)youtube\.com$/i }
  ];

  /* A line that continues the record above it: "Certified by the Linux
   * Foundation", "Credential ID: ABC-123", "Amazon Web Services, 2022". */
  var CONTINUATION_PREFIX_RE = /^(?:certified\s+by|issued\s+by|awarded\s+by|presented\s+by|by|from|at|through|credential\s*id|credential|id|reference|score|gpa|grade|issued|awarded|presented|supervisor|advisor|adviser)\b\s*[:.\-–—]?/i;

  var NAME_PARTICLES = ['van', 'von', 'de', 'del', 'della', 'da', 'di', 'dos', 'das', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'st'];

  /* ------------------------------------------------------------------ utils */

  var uidCounter = 0;
  function uid(prefix) {
    if (U && typeof U.uid === 'function') return U.uid(prefix);
    uidCounter += 1;
    return (prefix || 'id') + Date.now().toString(36) + uidCounter.toString(36);
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function trim(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function isTrimmed(s) { return trim(s).length > 0; }

  function titleCase(s) {
    return String(s || '').replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
  }

  /* Every list the parsers build is capped, because a resume has limits and an
   * unbounded one is its own kind of hang. A cap that drops the overflow in
   * silence is a defect: the review screen says nothing was lost, so anything
   * over the line disappears from the person's resume with no trace. push()
   * counts what it turns away and text() reports it. Reset per call because
   * text() is synchronous and nothing here nests. */
  var DROPPED = 0;

  function push(list, value, max) {
    if (list.length < (max || MAX_ENTRIES)) { list.push(value); return true; }
    DROPPED += 1;
    return false;
  }

  /* push() only sees what this file decided to build. RB.model.validate is the
   * other writer, and it caps the same lists again — so its caps are measured
   * the same way, by counting the list before and after. One pass, O(entries),
   * and it covers every cap the model applies rather than the ones that were
   * remembered. */
  function census(r) {
    var n = { sections: (r.sections || []).length, entries: 0, roles: 0, bullets: 0, keywords: 0, courses: 0, groups: 0 };
    ((M && M.SECTION_TYPES) || []).forEach(function (def) {
      if (!def.hasMany) return;
      var list = Array.isArray(r[def.type]) ? r[def.type] : [];
      n.entries += list.length;
      list.forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        if (Array.isArray(e.roles)) {
          n.roles += e.roles.length;
          e.roles.forEach(function (role) {
            if (role && Array.isArray(role.highlights)) n.bullets += role.highlights.length;
          });
        }
        if (Array.isArray(e.highlights)) n.bullets += e.highlights.length;
        if (Array.isArray(e.keywords)) n.keywords += e.keywords.length;
        if (Array.isArray(e.courses)) n.courses += e.courses.length;
        if (Array.isArray(e.entries)) n.groups += e.entries.length;
      });
    });
    return n;
  }

  function lost(before, after) {
    return ['sections', 'entries', 'roles', 'bullets', 'keywords', 'courses', 'groups'].reduce(function (sum, key) {
      return sum + Math.max(0, (before[key] || 0) - (after[key] || 0));
    }, 0);
  }

  function normalizeKey(text) {
    return String(text || '')
      .replace(/^\s*\d{1,2}\s*[.)]\s*/, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[‘’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

  /* "Languages: English", "Skills: Python, Spark" and "Tools: Figma" are
   * content. Their leading word is a section synonym, so without this the
   * whole line is taken for a heading and everything under it is filed in the
   * wrong section — or, inside a job, ends the section outright. */
  var LABELLED_LIST_RE = /^[^:]{1,40}:\s*\S/;

  function isLabelledList(text) {
    var t = trim(text);
    return t.length <= 90 && LABELLED_LIST_RE.test(t);
  }

  /* Returns the strongest { type, score, syn } for a normalised heading, or
   * null. Ties go to the longer synonym, then to the order of SECTION_ORDER,
   * so the answer is the same on every run. */
  function matchSynonym(key) {
    if (!key || key.length > MAX_HEADING_KEY) return null;
    if (SYN_INDEX[key]) return { type: SYN_INDEX[key], score: TIER_EXACT, syn: key };
    var words = key.split(' ').length;
    var best = null;
    for (var i = 0; i < SYN_LISTS.length; i++) {
      var keys = SYN_LISTS[i].keys;
      for (var j = 0; j < keys.length; j++) {
        var syn = keys[j];
        if (syn.length > key.length) continue;
        var score = 0;
        if (key.length <= syn.length + MAX_AFFIX_GAP) {
          if (key.indexOf(syn + ' ') === 0) score = TIER_PREFIX;
          /* lastIndexOf answers -1 when the suffix is absent, and -1 is also
           * the index the formula below computes for a synonym as long as the
           * whole key. Without the `at > 0` guard, "educational qualifications"
           * (26 characters) claimed a suffix of "my professional experience"
           * (also 26) and the experience heading was filed as education. */
          var at = key.lastIndexOf(' ' + syn);
          if (at > 0 && at === key.length - syn.length - 1) score = TIER_SUFFIX;
          else if (words <= MAX_HEADING_WORDS && (' ' + key + ' ').indexOf(' ' + syn + ' ') !== -1) score = TIER_INNER;
        }
        if (!score && key.length <= 32 && key.indexOf(syn) !== -1) score = TIER_LOOSE;
        if (!score) continue;
        if (!best || score > best.score || (score === best.score && syn.length > best.syn.length)) {
          best = { type: SYN_LISTS[i].type, score: score, syn: syn };
        }
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- contact */

  /* Both contact scanners walk the text once instead of letting a pattern
   * retry at every offset. Written as a pattern, the host is
   *   (?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9]*[A-Za-z0-9])*
   * which partitions one run of characters several different ways, so a failed
   * match costs O(token) and there are O(n) tokens: O(n^2) overall. A 200 KB
   * run of unbroken text — a PDF dump with the spaces stripped, a pasted data
   * URL, a minified blob, a long hyphenated token — took 19 s in findUrls and
   * the tab never came back. Here one pass finds the spans a match can cover
   * and each surviving start is parsed once, forwards, with no backtracking.
   *
   * The span is exactly the union of the two classes the pattern used: nothing
   * that is whitespace, |, <, >, " or '. No match can cross a gap in it. */
  var SPAN_RE = /[^\s|<>"'\x60]+/g;
  /* A DNS name is 253 characters at most, so a longer run is not a host, and
   * the cap is what bounds the work a single start position can do. */
  var MAX_HOST_SCAN = 512;
  var MAX_LABELS = 256;
  /* Reused across calls: the scanners never nest, so one buffer is enough. */
  var LABEL_SPANS = new Array(MAX_LABELS * 2);
  var WORD_BEFORE = /[\w@./-]/;
  var URL_TAIL_JUNK = /[.,;:!?)\]]+$/;
  var EMAIL_TAIL_JUNK = /[.,;:]+$/;

  function code(text, i) { return i >= 0 && i < text.length ? text.charCodeAt(i) : -1; }
  function isAlpha(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
  function isDigit(c) { return c >= 48 && c <= 57; }
  function isHostChar(c) { return isAlpha(c) || isDigit(c); }
  function isLocalChar(c) { return isHostChar(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45; }

  /* Case-insensitive literal compare that stops at the first mismatch, so it
   * cannot run past the end of the string. */
  function litAt(text, at, lit) {
    for (var i = 0; i < lit.length; i++) {
      var c = text.charCodeAt(at + i);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== lit.charCodeAt(i)) return false;
    }
    return true;
  }

  /* Labels of `label ('.' label)*` starting at `at`, filled into LABEL_SPANS as
   * flat [from, to, from, to, ...] pairs. Returns how many dots were seen. */
  function collectLabels(text, at, hi) {
    var stop = at + MAX_HOST_SCAN < hi ? at + MAX_HOST_SCAN : hi;
    var i = at;
    if (!isHostChar(code(text, i))) return 0;
    while (i < stop && (isHostChar(code(text, i)) || text.charCodeAt(i) === 45)) i++;
    var n = 0;
    while (i < stop && text.charCodeAt(i) === 46) {
      if (n >= MAX_LABELS) break;
      var from = i + 1;
      var to = from;
      while (to < stop && isHostChar(code(text, to))) to++;
      if (to === from) return n;                 /* an empty label ends the run */
      LABEL_SPANS[n * 2] = from;
      LABEL_SPANS[n * 2 + 1] = to;
      n++;
      i = to;
    }
    return n;
  }

  /* The longest TLD entry that is a prefix of the label. TLD_LIST is sorted
   * longest first, so the first hit is the longest. */
  function tldPrefix(text, from, to) {
    for (var i = 0; i < TLD_LIST.length; i++) {
      var t = TLD_LIST[i];
      if (from + t.length <= to && litAt(text, from, t)) return t.length;
    }
    return 0;
  }

  /* End of the longest host starting at `at`, or -1. The pattern this replaces
   * took the longest host, which is the last dot whose label starts a known
   * TLD — the same answer this walks backwards to. */
  function hostEnd(text, at, hi) {
    var n = collectLabels(text, at, hi);
    for (var d = n - 1; d >= 0; d--) {
      var from = LABEL_SPANS[d * 2];
      var len = tldPrefix(text, from, LABEL_SPANS[d * 2 + 1]);
      if (!len) continue;
      var end = from + len;
      /* A TLD that is only the start of a longer word ("foo.company") is
       * followed by a letter. The pattern rejected that match and then refused
       * to retry from one character later, because the character before the
       * retry belonged to the word and failed its own left-context test. */
      if (isHostChar(code(text, end))) return -1;
      return end;
    }
    return -1;
  }

  /* End of the longest domain starting at `at`, or -1. The pattern ended in
   * \.[A-Za-z]{2,24} with nothing after it, so a domain ending in an alphabetic
   * run of 2 to 24 letters is a match even when digits follow in the label. */
  function domainEnd(text, at, hi) {
    var n = collectLabels(text, at, hi);
    for (var d = n - 1; d >= 0; d--) {
      var from = LABEL_SPANS[d * 2];
      var to = LABEL_SPANS[d * 2 + 1];
      var run = 0;
      while (from + run < to && isAlpha(code(text, from + run))) run++;
      if (run >= 2 && run <= 24) return from + run;
    }
    return -1;
  }

  function findEmails(text, skip) {
    var found = [];
    SPAN_RE.lastIndex = 0;
    var m;
    while ((m = SPAN_RE.exec(text)) !== null) {
      var lo = m.index;
      var hi = lo + m[0].length;
      var at = lo;
      while (at < hi) {
        if (text.charCodeAt(at) !== 64) { at += 1; continue; }   /* '@' */
        /* Walking back stops at the previous '@', which is not a local-part
         * character, so consecutive '@' runs never make the walks overlap. */
        var from = at;
        while (from > lo && isLocalChar(text.charCodeAt(from - 1))) from -= 1;
        if (from === at) { at += 1; continue; }
        var end = domainEnd(text, at + 1, hi);
        if (end < 0) { at += 1; continue; }
        var value = text.slice(from, end).replace(EMAIL_TAIL_JUNK, '');
        var stop = from + value.length;
        if (stop === from) { at += 1; continue; }
        if (skip && skip.some(function (s) { return overlaps(s.start, s.end, from, stop); })) { at = stop; continue; }
        found.push({ value: value, start: from, end: stop });
        at = stop;
      }
    }
    return found;
  }

  function findUrls(text, skip) {
    var found = [];
    SPAN_RE.lastIndex = 0;
    var m;
    while ((m = SPAN_RE.exec(text)) !== null) {
      var lo = m.index;
      var hi = lo + m[0].length;
      var at = lo;
      while (at < hi) {
        /* A match starts on a word character, and one that starts inside a word
         * fails the left-context test the pattern applied, so those are the
         * only starts worth trying. That filter is what keeps a 200 KB unbroken
         * run down to a single attempt. */
        if (!isHostChar(text.charCodeAt(at)) || (at > 0 && WORD_BEFORE.test(text.charAt(at - 1)))) { at += 1; continue; }
        var hostAt = at;
        if (litAt(text, hostAt, 'https://')) hostAt += 8;
        else if (litAt(text, hostAt, 'http://')) hostAt += 7;
        else if (litAt(text, hostAt, 'www.')) hostAt += 4;
        var end = hostEnd(text, hostAt, hi);
        if (end < 0) { at += 1; continue; }
        if (text.charCodeAt(end) === 47) {           /* '/' starts the path */
          while (end < hi) end += 1;
        }
        var value = text.slice(at, end).replace(URL_TAIL_JUNK, '');
        var stop = at + value.length;
        if (stop === at) { at += 1; continue; }
        if (looksLikeWordUrl(value)) { at = stop > at ? stop : at + 1; continue; }
        if (skip && skip.some(function (s) { return overlaps(s.start, s.end, at, stop); })) { at = stop; continue; }
        found.push({ value: value, start: at, end: stop, host: urlHost(value) });
        at = stop > at ? stop : at + 1;
      }
    }
    return found;
  }

  function looksLikeWordUrl(slice) {
    var bare = slice.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    var labels = bare.split('.');
    if (labels.length < 2) return true;
    var first = labels[0].toLowerCase();
    return first.length < 2 || URL_STOPWORDS.indexOf(first) !== -1;
  }

  function urlHost(value) {
    return String(value).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }

  function findPhones(text, skip) {
    var found = [];
    var re = PHONE_INTL_RE;
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      var digits = m[0].replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) { re.lastIndex = m.index + 1; continue; }
      if (skip && skip.some(function (s) { return overlaps(s.start, s.end, m.index, m.index + m[0].length); })) { re.lastIndex = m.index + m[0].length; continue; }
      found.push({ value: normalizePhone(m[0]), start: m.index, end: m.index + m[0].length });
      re.lastIndex = m.index + m[0].length;
    }
    if (found.length) return found;
    re = PHONE_LOCAL_RE;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var local = m[0].replace(/\D/g, '');
      if (local.length !== 10) { re.lastIndex = m.index + 1; continue; }
      if (skip && skip.some(function (s) { return overlaps(s.start, s.end, m.index, m.index + m[0].length); })) { re.lastIndex = m.index + m[0].length; continue; }
      found.push({ value: normalizePhone(m[0]), start: m.index, end: m.index + m[0].length });
      re.lastIndex = m.index + m[0].length;
    }
    return found;
  }

  function normalizePhone(value) {
    var s = String(value).trim();
    var ext = /\s*(?:ext\.?|x|extension)\s*(\d{1,6})\s*$/i.exec(s);
    var suffix = ext ? ' ext. ' + ext[1] : '';
    var core = ext ? s.slice(0, ext.index) : s;
    var digits = core.replace(/\D/g, '');
    if (digits.length === 10) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6) + suffix;
    if (digits.length === 11 && digits.charAt(0) === '1') return '+1 (' + digits.slice(1, 4) + ') ' + digits.slice(4, 7) + '-' + digits.slice(7) + suffix;
    return trim(core) + suffix;
  }

  /* ------------------------------------------------------------------ dates */

  function scanDates(text) {
    var ranges = [];
    var singles = [];
    var m;
    RANGE_RE.lastIndex = 0;
    while ((m = RANGE_RE.exec(text)) !== null) {
      var raw = m[0];
      var endToken = m[2] || '';
      var isPresent = PRESENT_TEST_RE.test(trim(endToken));
      ranges.push({
        raw: raw,
        from: trim(m[1]),
        to: isPresent ? '' : trim(endToken),
        current: isPresent,
        start: m.index,
        end: m.index + raw.length
      });
      RANGE_RE.lastIndex = m.index + raw.length;
    }
    /* A date already claimed by a range is not a second, separate date. The
     * ranges used to be blanked out of a copy of the text so this fell out of
     * the match; that rebuilt the whole string per range, so a line carrying
     * thousands of ranges went quadratic. Ranges and singles are both in
     * ascending order, so one cursor answers every lookup. */
    var cursor = 0;
    SINGLE_RE.lastIndex = 0;
    while ((m = SINGLE_RE.exec(text)) !== null) {
      var at = m.index + m[0].indexOf(m[1]);
      if (!m[1].trim()) { SINGLE_RE.lastIndex = m.index + m[0].length; continue; }
      while (cursor < ranges.length && ranges[cursor].end <= at) cursor++;
      if (cursor < ranges.length && at >= ranges[cursor].start) {
        SINGLE_RE.lastIndex = m.index + m[0].length;
        continue;
      }
      singles.push({ value: trim(m[1]), start: at, end: at + m[1].length });
      SINGLE_RE.lastIndex = m.index + m[0].length;
    }
    return { ranges: ranges, singles: singles };
  }

  function lineDateInfo(scan, text) {
    if (scan.ranges.length) {
      var r = scan.ranges[0];
      return { start: r.from, end: r.to, current: r.current, hasRange: true, hasSingle: false };
    }
    if (scan.singles.length === 1) {
      return { start: '', end: scan.singles[0].value, current: false, hasRange: false, hasSingle: true };
    }
    if (PRESENT_ONLY_RE.test(text)) return { start: '', end: '', current: true, hasRange: false, hasSingle: false };
    return null;
  }

  /* The text with every recognised span blanked out. Built in one pass over the
   * gaps between merged spans: masking each span in turn rebuilt the whole
   * string every time, which is quadratic on a line carrying thousands of them
   * (a 428 KB line of links spent 2 s here alone). Each span leaves one space,
   * which is what the old full-width mask collapsed to once trim() ran, so
   * "see" + link + "now" still reads as two words and not one. */
  function residueOf(text, scan) {
    var spans = scan.ranges.concat(scan.urls, scan.emails, scan.phones)
      .filter(function (s) { return s && s.end > s.start; })
      .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var out = '';
    var at = 0;
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].start >= text.length) break;
      if (spans[i].start > at) out += text.slice(at, spans[i].start);
      if (spans[i].end > at) { out += ' '; at = spans[i].end; }
    }
    if (at < text.length) out += text.slice(at);
    return trim(out.replace(/[\s|,;:•·–—-]+$/, '').replace(/^[\s|,;:•·–—-]+/, ''));
  }

  /* ------------------------------------------------------------------ lines */

  function toLines(raw) {
    var out = [];
    var parts = String(raw).split('\n');
    for (var i = 0; i < parts.length && out.length < MAX_LINES; i++) {
      var original = parts[i].replace(/\s+$/, '');
      var indent = (/^[ \t]*/.exec(original) || [''])[0].length;
      var text = original.replace(/[ \t]+/g, ' ').trim();
      out.push({ text: text, indent: indent, empty: text === '' });
    }
    DROPPED += Math.max(0, parts.length - MAX_LINES);
    return out;
  }

  function splitParts(text) {
    if (!/[|·‧]/.test(text)) return null;
    var parts = text.split(/[|·‧]/).map(trim).filter(function (p) { return p.length; });
    return parts.length > 1 ? parts : null;
  }

  function scanLine(line) {
    var text = line.text;
    var taken = [];
    var emails = findEmails(text, taken);
    emails.forEach(function (e) { taken.push(e); });
    var urls = findUrls(text, taken);
    urls.forEach(function (u) { taken.push(u); });
    var dates = scanDates(text);
    dates.ranges.forEach(function (r) { taken.push(r); });
    var phones = findPhones(text, taken);
    phones.forEach(function (p) { taken.push(p); });
    return {
      email: emails.length ? emails[0].value : '',
      emails: emails,
      url: urls.length ? urls[0].value : '',
      urls: urls,
      phone: phones.length ? phones[0].value : '',
      phones: phones,
      ranges: dates.ranges,
      singles: dates.singles
    };
  }

  function scanText(text) { return scanLine({ text: text, indent: 0, empty: !text }); }

  function classify(rawLines) {
    return rawLines.map(function (line) {
      var scan = scanLine(line);
      var residue = residueOf(line.text, scan);
      var bullet = BULLET_RE.test(line.text);
      var parts = splitParts(line.text);
      return {
        text: line.text,
        indent: line.indent,
        empty: line.empty,
        bullet: bullet,
        body: bullet ? trim(line.text.replace(BULLET_STRIP_RE, '')) : line.text,
        scan: scan,
        residue: residue,
        date: lineDateInfo(scan, line.text),
        parts: parts,
        partsInfo: parts ? parts.map(function (p) {
          var s = scanText(p);
          var r = residueOf(p, s);
          return { text: p, scan: s, residue: r, date: lineDateInfo(s, p), title: isTitleLike(r || p) };
        }) : null,
        title: isTitleLike(residue)
      };
    });
  }

  function previousContentLine(lines, i) {
    for (var j = i - 1; j >= 0; j--) {
      if (lines[j].empty) continue;
      if (lines[j].bullet) return null;
      return lines[j];
    }
    return null;
  }

  function nextContentLine(lines, i) {
    for (var j = i + 1; j < lines.length; j++) {
      if (lines[j].empty) continue;
      return lines[j];
    }
    return null;
  }

  /* Does a title follow within the next few lines? Only a line that is purely
   * dates, a link or a place may be looked past — "Northwind Labs" / "San
   * Francisco, CA · Mar 2021 – Present · northwind.example.com" / "Senior
   * Designer" is a common shape, and the employer is the line before the meta
   * line, not the line after it. */
  function titleFollows(lines, i) {
    var scanned = 0;
    for (var j = i + 1; j < lines.length && scanned < 3; j++) {
      var ln = lines[j];
      if (ln.empty) continue;
      scanned += 1;
      if (ln.bullet) return false;
      var parts = readParts(ln);
      if ((parts && (parts.title || parts.company)) || isTitleLike(ln.residue)) return true;
      if (!ln.date && !ln.scan.url && !parseLocation(ln.residue)) return false;
    }
    return false;
  }

  /* The other common stacking: the position comes first and the employer sits
   * under it, followed by the place and the dates. Nothing else in the entry
   * has a name, so without this the employer is read as a stray sentence and
   * printed as one. Requiring a date, a place or a link straight after keeps
   * a prose line under a job title out. */
  function employerTailFollows(lines, i) {
    for (var j = i + 1; j < lines.length; j++) {
      var ln = lines[j];
      if (ln.empty) continue;
      if (ln.bullet) return false;
      return !!(ln.date || ln.scan.url || parseLocation(ln.residue));
    }
    return false;
  }

  /* Word and LaTeX templates pack an entry onto one line:
   * "Senior Designer | Acme | Berlin | Mar 2021 - Present". */
  function readParts(ln) {
    if (!ln.partsInfo) return null;
    var out = { title: '', company: '', location: '', url: '', start: '', end: '', current: false, leftover: [] };
    ln.partsInfo.forEach(function (p) {
      if (p.date && p.date.hasRange) {
        if (!out.start) { out.start = p.date.start; out.end = p.date.end; out.current = p.date.current; }
        return;
      }
      if (p.scan.url) { if (!out.url) out.url = p.scan.url; return; }
      var label = p.residue || p.text;
      if (!label) return;
      if (p.title && !out.title) { out.title = label; return; }
      if (!out.location && !p.title) {
        var loc = parseLocation(label);
        if (loc) { out.location = loc.raw; return; }
      }
      if (looksLikeCompany(label) && !out.company) { out.company = label; return; }
      out.leftover.push(label);
    });
    if (!out.title && !out.company) return null;
    return out;
  }

  /* ------------------------------------------------------------------ title */

  function isTitleLike(text) {
    var t = trim(text);
    if (!t || t.length > 70) return false;
    if (BULLET_RE.test(t)) return false;
    var words = t.split(/\s+/);
    if (words.length > 8) return false;
    if (/[.!?;]$/.test(t) && words.length > 4) return false;
    if (scanDates(t).ranges.length) return false;
    var lower = t.toLowerCase();
    for (var i = 0; i < MULTIWORD_TITLES.length; i++) {
      if (lower.indexOf(MULTIWORD_TITLES[i]) !== -1) return true;
    }
    return TITLE_RE.test(lower);
  }

  function isTitleWord(text) {
    return isTitleLike(text);
  }

  function looksLikeCompany(text) {
    var t = trim(text);
    if (!t || t.length > 70) return false;
    if (BULLET_RE.test(t)) return false;
    if (EMAIL_TEST_RE.test(t) || URL_TEST_RE.test(t)) return false;
    if (scanDates(t).ranges.length) return false;
    if (isTitleLike(t)) return false;
    if (DEGREE_RES.some(function (re) { return re.test(t); })) return false;
    /* A full stop is how a company ends ("Acme Ltd."), so only sentence
     * punctuation rules it out — testing the bare name keeps every entry whose
     * employer carries a legal suffix from being merged into the next one. And
     * a place is not an employer: "San Francisco, CA" was reading as one. */
    var bare = t.replace(ORG_SUFFIX_RE, '');
    if (/[;!?]/.test(bare)) return false;
    if (/[.!?]\s+\S/.test(bare) || /[.!?]\s*$/.test(bare)) return false;
    if (parseLocation(bare)) return false;
    if (t.split(/\s+/).length > 9) return false;
    if (isLabelledList(t)) return false;
    if (headingType(t)) return false;
    return true;
  }

  function looksLikeInstitution(text) {
    var t = trim(text);
    if (!t || t.length > 90) return false;
    return INSTITUTION_RE.test(t) && !isTitleLike(t);
  }

  function isDegreeLine(text) {
    return DEGREE_RES.some(function (re) { return re.test(text); });
  }

  /* ---------------------------------------------------------------- heading */

  function isCapsHeading(text) {
    var t = trim(text);
    if (t.length < 3 || t.length > 48) return false;
    /* A bare 2-5 letter capital token is an initialism — MIT, UCLA, IIT, NYU,
     * CMU. Reading one as a section heading is what turned "EDUCATION / MIT /
     * BS Computer Science 2016" into an empty education section and a custom
     * one called MIT, with nothing but the generic "unrecognised heading"
     * warning to say so. A heading somebody typed is a word, and every real
     * one-word heading here is longer than five letters or is a lookup that
     * headingType() has already answered before this runs. */
    if (/^[A-Z]{2,5}$/.test(t)) return false;
    if (!/[A-Z]{2,}/.test(t)) return false;
    if (/[a-z]{3,}/.test(t)) return false;
    if (!/^[A-Z0-9 &/,'’()\-+.]+$/.test(t)) return false;
    if (/\d{2,}/.test(t)) return false;
    if (ORG_SUFFIX_RE.test(t)) return false;
    return (t.match(/[A-Za-z]/g) || []).length >= 3;
  }

  var TRAILING_COLON_RE = /[:：]\s*$/;

  /* Returns { type, label, generic, score, certain } or null. `score` is how
   * strongly the heading matched the table — the caller uses it to say so in the
   * warnings when the answer was a guess rather than a lookup. */
  function headingType(text) {
    var label = trim(text).slice(0, 80);
    if (isLabelledList(label)) return null;
    var m = matchSynonym(normalizeKey(text));
    /* A line in capitals that only matched a synonym buried inside a word is a
     * heading of its own, not a section: "WEB DEVELOPMENT" contains "web", and
     * was opening a second skills section that then overwrote the real one. */
    if (m && !(m.score === TIER_LOOSE && isCapsHeading(text))) {
      /* "Bachelor of Science in Computer Science" contains a subject that is
       * also a section name. A degree is an entry, never a heading, so a line
       * that reads as one stays content — unless the whole line is the synonym,
       * which is a heading somebody actually meant. */
      if (m.score < TIER_PREFIX && isDegreeLine(label)) return null;
      /* A line that names a school is an entry, on the same reasoning. A
       * Coursework line of "Operating Systems — State University" carries the
       * skills synonym "operating systems" in the middle of it, which opened a
       * Skills section there and took every line after it along. The cost is
       * that a heading somebody wrote as "University Research" is kept as
       * content instead; the exact-synonym lookup still answers the headings
       * that are only a synonym, which is all of the common ones. */
      if (m.score < TIER_PREFIX && looksLikeInstitution(label)) return null;
      return {
        type: m.type,
        label: label.replace(TRAILING_COLON_RE, ''),
        generic: false,
        score: m.score,
        certain: m.score >= TIER_INNER
      };
    }
    if (isCapsHeading(text)) return { type: 'custom', label: label, generic: true, score: 0, certain: false };
    return null;
  }

  /* --------------------------------------------------------------- location */

  function parseLocation(text) {
    var t = trim(text);
    if (!t || t.length > 60) return null;
    if (REMOTE_RE.test(t)) return { raw: t, city: titleCase(t), region: '', countryCode: '' };
    if (scanDates(t).ranges.length) return null;
    if (EMAIL_TEST_RE.test(t) || URL_TEST_RE.test(t)) return false || null;
    if (!LOCATION_RE.test(t)) return null;
    var parts = t.split(',').map(trim).filter(Boolean);
    if (parts.length < 2) return null;
    var out = { raw: t, city: parts[0], region: parts[1], countryCode: '' };
    if (parts.length >= 3) {
      var tail = parts[parts.length - 1];
      if (REGION_CODE_RE.test(tail) && parts[parts.length - 2].length > 2) {
        out.region = parts[parts.length - 2];
        out.countryCode = tail;
      } else {
        out.region = parts.slice(1, -1).join(', ');
      }
    }
    if (out.city.length > 60 || isDegreeLine(out.city)) return null;
    return out;
  }

  /* ------------------------------------------------------------------- name */

  function isAllCapsName(text) {
    var t = trim(text);
    return t.length > 2 && t.length < 50 && !/[a-z]{3,}/.test(t) && /[A-Za-z]/.test(t) && !EMAIL_TEST_RE.test(t);
  }

  function splitName(full) {
    var parts = trim(full).split(/\s+/).filter(Boolean);
    if (!parts.length) return { givenName: '', familyName: '' };
    var i = parts.length - 1;
    if (i > 0 && /^(jr|sr|ii|iii|iv|phd|md|mba|esq)\.?$/i.test(parts[i])) i -= 1;
    while (i > 0 && NAME_PARTICLES.indexOf(parts[i - 1].toLowerCase().replace(/\./g, '')) !== -1) i -= 1;
    return { givenName: parts.slice(0, i).join(' '), familyName: parts.slice(i).join(' ') };
  }

  function nameScore(line, scan, position) {
    var t = line.text;
    if (!t || t.length < 3 || t.length > 60) return -1;
    if (scan && (scan.email || scan.phone || scan.url)) return -1;
    if (scanDates(t).ranges.length) return -1;
    if (BULLET_RE.test(t) || /[@|]/.test(t)) return -1;
    if (/[.!?;:]$/.test(t)) return -1;
    if (/\d/.test(t)) return -1;
    var words = t.split(/\s+/);
    if (words.length > 6) return -1;
    if (isTitleLike(t) || looksLikeInstitution(t) || isDegreeLine(t)) return -1;
    var lowerWord = 0;
    words.forEach(function (w) {
      if (/^[a-z]/.test(w) && NAME_PARTICLES.indexOf(w.toLowerCase().replace(/\./g, '')) === -1) lowerWord += 1;
    });
    if (words.length >= 2 && lowerWord > 0) return -1;
    var score = Math.min(t.length, 46);
    score -= position * 3;
    score -= line.indent > 4 ? 12 : 0;
    if (words.length >= 2 && words.length <= 4) score += 14;
    if (/[a-z]/.test(t) && !isAllCapsName(t)) score -= 10;
    if (isAllCapsName(t)) score += 4;
    if (isTitleWord(t)) score -= 20;
    return score;
  }

  function pickName(lines) {
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < Math.min(lines.length, 16); i++) {
      if (lines[i].empty) continue;
      var score = nameScore(lines[i], lines[i].scan, i);
      if (score > bestScore) { bestScore = score; best = lines[i]; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- entries */

  function newRole() {
    return { id: uid('role'), position: '', start: '', end: '', current: false, summary: '', highlights: [''], skills: [], visible: true };
  }

  function newExperience() {
    return { id: uid('exp'), company: '', companyEntity: '', location: '', url: '', roles: [newRole()], visible: true };
  }

  function newVolunteer() {
    return { id: uid('vol'), role: '', organization: '', location: '', start: '', end: '', current: false, highlights: [''], visible: true };
  }

  function addHighlight(list, text) {
    var t = trim(text);
    if (!t) return;
    if (!list.length || (list.length === 1 && !trim(list[0]))) { list[0] = t; return; }
    push(list, t, 40);
  }

  function lastHighlight(list) {
    return list.length ? list[list.length - 1] : '';
  }

  function attachDates(target, date) {
    target.start = date.start || '';
    target.end = date.end || '';
    target.current = !!date.current;
  }

  /* A closing "Skills: Python, Spark" or "Tech: React, Go" names the toolkit of
   * the job above it. Left to the generic path it reads as the next employer. */
  var ROLE_SKILLS_RE = /^(?:key\s+|core\s+|technical\s+)?(?:skills?|tools?|tech\s*stack|technologies|technicals|software|systems|stack)\s*[:：]\s*(.+)$/i;

  /* Splits a role-shaped section (experience, volunteering) into entries. The
   * dominant shape is "employer / title / dates / bullets"; the pipe-packed
   * single-line shape is the other. Everything else is a guess and says so. */
  function parseRoleSection(sec, isVolunteer) {
    var lines = sec.lines;
    var entries = [];
    var cur = null;
    var role = null;
    var sawBullets = false;

    function startEntry() {
      cur = isVolunteer ? newVolunteer() : newExperience();
      role = isVolunteer ? cur : cur.roles[0];
      sawBullets = false;
      push(entries, cur);
    }

    function setCompany(value) {
      if (isVolunteer) { if (!cur.organization) cur.organization = value; return; }
      if (!cur.company) cur.company = value;
    }

    function setPosition(value) {
      if (isVolunteer) { if (!cur.role) cur.role = value; return; }
      if (!role.position) role.position = value;
    }

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;

      if (ln.bullet) {
        if (!cur) startEntry();
        addHighlight(isVolunteer ? cur.highlights : role.highlights, ln.body);
        sawBullets = true;
        continue;
      }

      var parts = readParts(ln);
      var residue = ln.residue;
      var hasTitle = (parts && parts.title) || isTitleLike(residue);
      var bareDate = ln.date && !hasTitle && !(parts && parts.company);

      if (bareDate) {
        if (!cur) startEntry();
        /* "San Francisco, CA · Mar 2021 – Present" carries both; taking the
         * dates must not throw the place away. */
        var place = parseLocation(residue);
        if (place && !cur.location && !isVolunteer && residue.length < 48) cur.location = place.raw;
        if (isVolunteer) {
          if (!cur.start) attachDates(cur, ln.date);
        } else if (!role.start && !role.end) {
          attachDates(role, ln.date);
        } else {
          var extra = newRole();
          attachDates(extra, ln.date);
          push(cur.roles, extra, 20);
          role = extra;
        }
        continue;
      }

      if (cur && role) {
        var toolkit = ROLE_SKILLS_RE.exec(residue);
        if (toolkit) {
          String(toolkit[1]).split(SKILL_DELIM).map(trim).forEach(function (k) {
            if (k && k.length <= 60 && role.skills.indexOf(k) === -1) push(role.skills, k, 60);
          });
          sawBullets = true;
          continue;
        }
      }

      if (hasTitle || (parts && parts.company)) {
        if (cur && sawBullets) startEntry();
        if (!cur) startEntry();

        /* A bare title right below another title with no dates is a promotion
         * at the same employer, not a new job. Capped like every other list:
         * a run of title lines grew this without bound, and the model then
         * cut it to twenty with nothing to say that it had. */
        if (cur && !isVolunteer && !sawBullets && role.position && !role.start && !role.end) {
          var promoted = newRole();
          promoted.start = role.end || '';
          push(cur.roles, promoted, 20);
          role = promoted;
        }

        var prev = previousContentLine(lines, i);
        if (prev && !prev.parts) {
          if (looksLikeCompany(prev.text)) setCompany(prev.residue || prev.text);
          else if (isVolunteer) {
            var prevLoc = parseLocation(prev.residue || prev.text);
            if (prevLoc && !cur.location) cur.location = prevLoc.raw;
          }
        }

        if (parts) {
          var title = parts.title;
          /* "<org> · <role> · <place> · <dates>": the part reader has no slot
           * for a role, so it parks it in `company`. Once the organisation is
           * already known that leftover is the role. */
          if (isVolunteer && !title && parts.company && trim(cur.organization) && parts.company !== cur.organization) {
            title = parts.company;
          }
          setPosition(title);
          if (parts.company) setCompany(parts.company);
          if (parts.location && !cur.location) cur.location = parts.location;
          if (parts.url && !cur.url) cur.url = parts.url;
          if (parts.start) {
            if (isVolunteer) { if (!cur.start) attachDates(cur, { start: parts.start, end: parts.end, current: parts.current }); }
            else if (!role.start && !role.end) attachDates(role, { start: parts.start, end: parts.end, current: parts.current });
          }
        } else {
          setPosition(residue);
          if (ln.date && ln.date.hasRange) {
            if (isVolunteer) { if (!cur.start) attachDates(cur, ln.date); }
            else if (!role.start) attachDates(role, ln.date);
          }
        }
        sawBullets = false;
        continue;
      }

      /* Plain line. It is a new employer only when a title follows it. */
      if (looksLikeCompany(residue) && titleFollows(lines, i)) {
        if (sawBullets) startEntry();
        if (!cur) startEntry();
        setCompany(residue);
        sawBullets = false;
        continue;
      }

      /* Position / employer / place / dates. The employer here is the entry's
       * only name, so it is taken before the line can be read as prose. */
      if (!isVolunteer && !sawBullets && cur && role && role.position && !trim(cur.company) &&
          looksLikeCompany(residue) && employerTailFollows(lines, i)) {
        setCompany(residue);
        continue;
      }

      if (!cur) {
        if (isVolunteer) { startEntry(); addHighlight(cur.highlights, residue); sawBullets = true; }
        else { startEntry(); addHighlight(role.highlights, residue); sawBullets = true; }
        continue;
      }

      var loc = parseLocation(residue);
      if (loc && !cur.location && residue.length < 48) { cur.location = loc.raw; continue; }
      if (ln.scan.url && !cur.url) { cur.url = ln.scan.url; continue; }
      if (isVolunteer) { addHighlight(cur.highlights, residue); continue; }
      /* A line with no marker under a bullet is that bullet wrapped. It extends
       * the last one in place: handing the joined text to addHighlight() would
       * push a second entry and print the bullet twice, the first time short. */
      if (lastHighlight(role.highlights)) {
        var list = role.highlights;
        list[list.length - 1] = list[list.length - 1] + ' ' + residue;
      } else if (role.summary) role.summary += ' ' + residue;
      else role.summary = residue;
    }

    return entries.filter(function (entry) {
      if (isVolunteer) return trim(entry.role) || trim(entry.organization) || entry.highlights.some(isTrimmed);
      entry.roles = entry.roles.filter(function (r) {
        return trim(r.position) || trim(r.start) || trim(r.end) || r.highlights.some(isTrimmed);
      });
      if (!entry.roles.length) return false;
      return trim(entry.company) || entry.roles.some(function (r) {
        return trim(r.position) || r.highlights.some(isTrimmed) || trim(r.summary);
      });
    });
  }

  /* Splits flat record sections (certs, awards, publications) into records. A
   * line joins the current record when it is a date, a URL, or an
   * issuer/credential fragment — the "Name / Issuer, 2021" shape. */
  function chunkRecords(lines) {
    var records = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;
      if (ln.bullet) {
        if (!cur) { cur = { head: null, lines: [] }; records.push(cur); }
        cur.lines.push(ln);
        continue;
      }
      if (!cur || !cur.head || startsNewRecord(cur, ln)) {
        cur = { head: ln, lines: [], dateFromLine: false };
        records.push(cur);
        continue;
      }
      if (ln.date) cur.dateFromLine = true;
      cur.lines.push(ln);
    }
    return records;
  }

  /* Whether the record being built already carries a date, on its head line or
   * on a line that joined it. */
  function recordHasDate(cur) {
    if (!cur || !cur.head) return false;
    if (cur.dateFromLine) return true;
    var scan = scanDates(cur.head.text);
    return scan.ranges.length > 0 || scan.singles.length > 0;
  }

  function startsNewRecord(cur, ln) {
    var t = ln.text;
    if (!trim(t)) return true;
    if (isDateOnlyText(t) || isUrlOnlyText(t)) return false;
    if (CONTINUATION_PREFIX_RE.test(t)) return false;
    /* A date continues the record only while that record has no date of its
     * own. Keying on the date alone merged every one-line credential, award and
     * publication in a section into the first record: "AWS Certified
     * Solutions Architect, 2022 / Certified Kubernetes Administrator, 2023 /
     * PMP, 2021" arrived as one certification, and the review screen said the
     * import worked. The continuation shapes this is meant to catch still
     * merge, because a bare date is isDateOnlyText and an issuer line starts
     * with the words CONTINUATION_PREFIX_RE lists. */
    if (ln.date) return recordHasDate(cur);
    if (looksLikeInstitution(t) && !looksLikeInstitution(cur.head.text)) return false;
    return true;
  }

  function isDateOnlyText(text) {
    var scan = scanText(text);
    return scan.ranges.length > 0 && residueOf(text, scan).length <= 3;
  }

  function isUrlOnlyText(text) {
    var scan = scanText(text);
    return !!scan.url && residueOf(text, scan).length <= 3;
  }

  function recordText(record) {
    return record.lines.filter(function (l) { return !l.bullet; }).map(function (l) { return l.text; }).join(' ');
  }

  function recordDate(record) {
    if (record.head && record.head.date) return record.head.date.end || record.head.date.start || '';
    for (var i = 0; i < record.lines.length; i++) {
      if (record.lines[i].date) return record.lines[i].date.end || record.lines[i].date.start || '';
    }
    return '';
  }

  function recordUrl(record) {
    var all = [record.head].concat(record.lines).filter(Boolean);
    for (var i = 0; i < all.length; i++) {
      if (all[i].scan.url) return all[i].scan.url;
    }
    return '';
  }

  function stripTrailingYear(text) {
    return trim(String(text).replace(/[\s,;(\[]*\(?\b(?:19|20)\d{2}\b\)?[\s,;)\]]*$/, ''));
  }

  /* ------------------------------------------------------------- per type */

  function parseExperience(sec) { return parseRoleSection(sec, false); }

  function parseVolunteer(sec) { return parseRoleSection(sec, true); }

  /* The dotted abbreviations are the ones students actually write: "B.Tech in
   * Computer Science" has no word for the degree in it, so without them the
   * whole line lands in studyType and the field of study is lost. */
  var DEGREE_HEAD_RE = /^(?:bachelor|master|doctor(?:ate)?|phd|mb[as]|bsc?|msc?|ba|ma|associate|foundation|diploma|postgraduate|undergraduate|[bm]\.?\s?tech|[bm]\.?\s?sc|[bm]\.?\s?com|[bm]\.?\s?arch|[bm]\.?\s?fa|[bm]\.?\s?bus|[bm]\.?\s?ed|[bm]\.?\s?eng|[bm]\.?\s?des|[bm]\.?[sa]\.?)\b/i;
  /* "BFA", "BFAH", "GDip" — the abbreviations DEGREE_HEAD_RE has no word for. */
  var DEGREE_ABBR_RE = /^[A-Z][A-Z.]{1,5}$/;

  function startsDegree(text) {
    var t = trim(text);
    if (DEGREE_HEAD_RE.test(t) || DEGREE_ABBR_RE.test(t)) return true;
    /* "BFA in Graphic Design, Rhode Island School of Design" opens with the
     * abbreviation; the rest is the field. */
    return /^[A-Z][A-Z.]{1,5}\s+(?:in|of)\b/.test(t);
  }

  /* The abbreviations a degree actually turns up as. A list rather than a
   * shape test, because "MIT", "UCLA" and "VIT" are school acronyms of exactly
   * the same shape and reading one as a degree loses the school. */
  var DEGREE_ABBR_TOKENS = ('bs ba bsc ms msc mba ma btech mtech be me bcom mcom bfa mfa ' +
    'barch march bed med bdes mdes gdip llb mlb mbb bsba bsm bam dip dipg pgcert').split(' ');
  var DEGREE_ABBR_INDEX = {};
  DEGREE_ABBR_TOKENS.forEach(function (t) { DEGREE_ABBR_INDEX[t] = true; });

  function isDegreeAbbrToken(t) {
    var s = trim(t).replace(/\./g, '').toLowerCase();
    return !!s && !!DEGREE_ABBR_INDEX[s];
  }

  /* The degree at the front of the line, as written: "B.Tech", "BFA", "M.Sc". */
  var DEGREE_LEAD_RE = /^[A-Za-z][A-Za-z.]*/;

  /* "B.S. Computer Science, University of Michigan" — commas and dashes are
   * real separators. "of" and "in" are not: splitting on them turns
   * "University of Michigan" into two unrelated words, so they only apply to a
   * leading degree field. */
  function splitDegreeLine(text) {
    /* A line with a single date keeps its year in the residue, so the school
     * would otherwise be read as the year and the year as a field of study. */
    var body = stripTrailingYear(text);
    var parts = body.split(/\s*[,—–|]\s*/).map(trim).filter(Boolean);
    if (parts.length > 1) {
      /* "B.Sc, M.Sc": every piece is a degree and nothing else, so they are
       * one degree written twice. "B.A., M.A. History" has a field on the end
       * of it and is split below. */
      var allDegrees = parts.every(function (part) {
        var lead = DEGREE_LEAD_RE.exec(part);
        return !!lead && lead[0] === part && (isDegreeAbbrToken(part) || DEGREE_HEAD_RE.test(part));
      });
      if (allDegrees) return { type: parts.join(', '), area: '' };
      /* "BFA, Interaction Design — University of Texas at Austin": the school
       * is the last piece, not another field of study. Without this the
       * university lands in the area and the entry prints with an empty
       * institution. */
      var last = parts[parts.length - 1];
      if (looksLikeInstitution(last) && (parts.length > 2 || startsDegree(parts[0]))) {
        return { type: parts[0], area: parts.slice(1, -1).join(', '), institution: last };
      }
      /* "MIT, B.S. Computer Science": the school leads. */
      if (looksLikeInstitution(parts[0]) && !parts.slice(1).some(looksLikeInstitution)) {
        return { type: '', area: parts.slice(1).join(', '), institution: parts[0] };
      }
      return { type: parts[0], area: parts.slice(1).join(', ') };
    }
    var field = /^(.{2,60}?)\s+in\s+(.{2,60})$/i.exec(body);
    if (field && startsDegree(field[1].trim())) {
      return { type: field[1].trim(), area: field[2].trim() };
    }
    /* "BS Computer Science", "M.Tech Artificial Intelligence" — no "in" to split
     * on. Only an abbreviation leads here, so "Master of Science" keeps its
     * "of Science" as part of the degree name. */
    if (startsDegree(body)) {
      var token = (DEGREE_LEAD_RE.exec(body) || [''])[0];
      if (token && isDegreeAbbrToken(token) && body.length > token.length + 2) {
        return { type: token, area: trim(body.slice(token.length)) };
      }
    }
    return { type: body, area: '' };
  }

  /* A degree word anywhere in the line, including one that opens it:
   * "BFA, Interaction Design — University of Texas at Austin" is a degree line
   * even though DEGREE_RES has no word for "BFA". A bare abbreviation on its
   * own is left out, because "MIT" is as likely to be a school as a degree. */
  function hasDegreeToken(text) {
    var t = trim(text);
    if (!t) return false;
    var at = firstDegreeHit(t);
    if (at >= 0) {
      /* The word has to open the line. "Cambridge, MA" ends in a state code
       * that spells M.A., and "the undergraduate programme" is a sentence
       * about a degree rather than one. */
      if (at === 0) return true;
      var head = trim((/^[^,;|·–—-]+/.exec(t) || [''])[0]);
      if (head === t) return false;
      /* A school may still lead the line: "MIT, B.S. Computer Science". */
      return INSTITUTION_RE.test(head) || isDegreeAbbrToken(head) || /^[A-Z][A-Z0-9]{1,4}$/.test(head);
    }
    var lead = DEGREE_LEAD_RE.exec(t);
    if (!lead) return false;
    var token = lead[0];
    if (t.length <= token.length + 2) return false;
    /* DEGREE_ABBR_RE is not consulted here: it reads "VIT" and "UCLA" as
     * degrees, and those are the schools this line is supposed to name. */
    return isDegreeAbbrToken(token) || DEGREE_HEAD_RE.test(token);
  }

  function firstDegreeHit(text) {
    var at = -1;
    for (var i = 0; i < DEGREE_RES.length; i++) {
      var m = DEGREE_RES[i].exec(text);
      if (m && (at < 0 || m.index < at)) at = m.index;
    }
    return at;
  }

  /* A line that says only where the student stands: "Currently pursuing
   * undergraduate degree", "Expected to graduate 2029". Every one of these
   * carries a degree word or a year, so without this they arrive as a second
   * education entry with no school on it and print as an empty row. */
  var STATUS_NOTE_RE = /^(?:currently\s+|presently\s+|now\s+)?(?:pursuing|enrolled|studying|completing|working\s+(?:towards?|toward)|in\s+progress|ongoing|(?:expected|anticipated|due|projected)\s+to\s+graduat\w*|on\s+track\s+to\s+graduat\w*|graduating|class\s+of|awaiting\s+(?:graduation|admission|results|grades)|continuing\s+my\s+studies)\b/i;

  function educationStatusNote(text) {
    var t = trim(text).replace(/[.;:!?]+$/, '').trim();
    if (!t || t.length > 60) return '';
    if (t.split(/\s+/).length > 8) return '';
    /* A range on the line means it is dates, not a note. */
    if (scanDates(t).ranges.length) return '';
    if (URL_TEST_RE.test(t) || EMAIL_TEST_RE.test(t)) return '';
    return STATUS_NOTE_RE.test(t) ? t : '';
  }

  /* "2029", "2012 - 2016" — a date on its own never names a school, but
   * looksLikeCompany has no opinion about "2029" and would take it for one. */
  function isDateTokenOnly(text) {
    var t = trim(text);
    if (!t) return false;
    return /^(?:19|20)\d{2}$/.test(t) || isDateOnlyText(t);
  }

  /* A school, by what a school line is allowed to look like. It does not ask
   * headingType(): the section splitter reads plenty of school names as
   * headings — "University of Washington" matches the experience synonyms —
   * and an education entry cannot afford to inherit that verdict and lose its
   * institution. */
  function looksLikeSchool(text) {
    var t = trim(text);
    if (!t || t.length > 90) return false;
    if (BULLET_RE.test(t)) return false;
    if (EMAIL_TEST_RE.test(t) || URL_TEST_RE.test(t)) return false;
    if (isDegreeLine(t) || isDateTokenOnly(t)) return false;
    if (isTitleLike(t) || parseLocation(t)) return false;
    if (scanDates(t).ranges.length) return false;
    if (/[.!?]\s+\S/.test(t) || /[;!?]/.test(t)) return false;
    if (t.split(/\s+/).length > 9) return false;
    if (isLabelledList(t)) return false;
    if (INSTITUTION_RE.test(t)) return true;
    /* No institution word, so only a bare acronym is still a school — "MIT",
     * "IIT Bombay", "BITS Pilani". Course names and stray prose are Title Case
     * too, and reading one as a school is worse than missing the line. */
    var words = t.split(/\s+/);
    if (words.length > 4) return false;
    if (!/^[A-Z0-9][\w&'’.\- ]*$/.test(t)) return false;
    return words.some(function (w) { return /^[A-Z][A-Z0-9]{1,4}$/.test(w); });
  }

  function parseEducation(sec) {
    var lines = sec.lines;
    var out = [];
    var cur = null;
    var sawBullets = false;
    /* Whether a degree line has already been read for the entry being built.
     * A school line on its own does not count: "VIT-AP University" followed by
     * "B.Tech – ..." is one qualification, not two. */
    var degAnchored = false;
    /* Whether the last course came from a wrapped line rather than a bullet. */
    var proseLast = false;
    var statusNotes = [];
    var unidentified = [];

    function note(code, message) {
      sec.notes = sec.notes || [];
      if (sec.notes.length < 6) sec.notes.push({ code: code, message: message });
    }

    function addCourse(text, isProse) {
      var t = trim(text);
      if (!t) return;
      var last = cur.courses.length ? cur.courses[cur.courses.length - 1] : '';
      /* A line wrapped by the source is one thought, not two courses. Only a
       * bullet is known to have ended, so only prose is merged. */
      if (isProse && proseLast && last && !/[.!?;:]$/.test(last)) {
        cur.courses[cur.courses.length - 1] = (last + ' ' + t).slice(0, 200);
        return;
      }
      if (cur.courses.length < 30) cur.courses.push(t);
      else DROPPED += 1;
      proseLast = !!isProse;
    }

    function attachDates(ln) {
      if (!ln.date) return;
      if (ln.date.hasRange) {
        if (cur.start || cur.end) return;
        cur.start = ln.date.start;
        cur.end = ln.date.end;
        return;
      }
      if (ln.date.hasSingle && !cur.end) cur.end = ln.date.end;
    }

    function close() {
      if (cur) out.push(cur);
      cur = null;
      degAnchored = false;
      sawBullets = false;
      proseLast = false;
    }

    function hasInstitution() { return !!cur && !!trim(cur.institution) && !isDateTokenOnly(cur.institution); }

    function setDates(ln) {
      attachDates(ln);
      if (gpa) cur.score = gpa;
      if (ln.scan.url && !cur.url) cur.url = ln.scan.url;
      sawBullets = false;
      proseLast = false;
    }

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;
      var gpa = (/(?:gpa|cgpa|grade|score)\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)/i.exec(ln.text) || [])[1] || '';
      if (ln.bullet) {
        if (!cur) cur = newEducation();
        addCourse(ln.body, false);
        sawBullets = true;
        continue;
      }

      var residue = ln.residue;

      /* Checked before anything else: a status note contains a degree word or
       * a year, so it would otherwise open an entry of its own. */
      var status = educationStatusNote(ln.text);
      if (status) {
        if (statusNotes.length < 6) statusNotes.push(status);
        continue;
      }

      var degreeLine = hasDegreeToken(residue);
      var schoolLine = !degreeLine && looksLikeSchool(residue);
      /* A plain line under a school that has neither a degree nor a field yet
       * is the rest of that qualification, not a second one. */
      var fieldLine = !degreeLine && !schoolLine && hasInstitution() && !sawBullets &&
        !trim(cur.studyType) && !trim(cur.area) && residue.length < 90;

      if (degreeLine) {
        if (cur && (sawBullets || degAnchored)) close();
        if (!cur) cur = newEducation();
        var prev = previousContentLine(lines, i);
        if (prev && !prev.bullet && !prev.parts && !hasInstitution() &&
            (looksLikeSchool(prev.text) || looksLikeSchool(prev.residue || prev.text))) {
          cur.institution = prev.residue || prev.text;
        }
        var pieces = splitDegreeLine(residue);
        cur.studyType = pieces.type;
        if (pieces.area) cur.area = pieces.area;
        /* The school named on the degree line outranks a guess taken from
         * the line above it. */
        if (pieces.institution) cur.institution = pieces.institution;
        setDates(ln);
        degAnchored = true;
        continue;
      }

      if (schoolLine) {
        /* The same school twice in a row is a repeat, not a second school. */
        if (cur && residue === trim(cur.institution)) continue;
        /* A different school on a line of its own opens the next
         * qualification; a school under a degree is that degree's school. */
        if (hasInstitution() && residue !== trim(cur.institution) && looksLikeSchool(residue)) close();
        if (!cur) cur = newEducation();
        if (!hasInstitution()) {
          cur.institution = residue;
          setDates(ln);
          continue;
        }
      }

      if (fieldLine) {
        /* A place under the school is a location, and an education entry has
         * nowhere to put one. "MIT / Cambridge, MA" is still one entry. */
        if (parseLocation(residue)) continue;
        var tail = splitDegreeLine(residue);
        cur.area = tail.area || residue;
        if (tail.institution) cur.institution = tail.institution;
        if (gpa && !cur.score) cur.score = gpa;
        if (ln.scan.url && !cur.url) cur.url = ln.scan.url;
        proseLast = false;
        continue;
      }

      /* "Rhode Island School of Design · 2012 – 2016 · risd.edu" — one line
       * carrying the school, the dates and the link. The URL branch below would
       * otherwise swallow the line and drop the school. */
      if (cur && !hasInstitution() && ln.date && ln.date.hasRange && trim(residue)) {
        cur.institution = residue;
        setDates(ln);
        continue;
      }
      /* "University of Washington / Bachelor of Science in Computer Science /
       * 2014 - 2018" — the dates arrive on their own line, with nothing left
       * of it but the date. Below, that empty remainder became a course
       * called "" and the years were lost. */
      if (cur && ln.date && !trim(residue)) {
        setDates(ln);
        continue;
      }
      if (!cur) {
        if (isDateTokenOnly(ln.text)) continue;
        if (trim(residue) && unidentified.length < 6) unidentified.push(residue);
        continue;
      }
      if (gpa && !cur.score) { cur.score = gpa; continue; }
      if (ln.scan.url && !cur.url) { cur.url = ln.scan.url; continue; }
      if (!trim(residue)) continue;
      /* The school named a line below its own degree. */
      if (!hasInstitution() && looksLikeSchool(residue)) {
        cur.institution = residue;
        setDates(ln);
        continue;
      }
      /* A parenthetical on its own line is the tail of a degree the source
       * wrapped: "B.Tech – Computer Science and Engineering" / "(AI and ML)". */
      if (/^\(/.test(residue) && trim(cur.area) && cur.area.length + residue.length <= 150) {
        cur.area = cur.area + ' ' + residue;
        proseLast = false;
        continue;
      }
      if (!trim(cur.area) && residue.length < 90 && looksLikeCompany(residue)) { cur.area = residue; continue; }
      addCourse(residue, true);
    }
    close();

    if (statusNotes.length) {
      note('education-status', statusNotes.length === 1
        ? 'The Education line "' + statusNotes[0] + '" is a note about your status, not a qualification. It was left off — add it yourself if you want it on the page.'
        : statusNotes.length + ' Education lines are notes about your status rather than qualifications (' + statusNotes[0] + '). They were left off — add them yourself if you want them on the page.');
    }

    var kept = [];
    out.forEach(function (e) {
      /* A row with no school and no degree prints as an empty line, so it
       * never reaches the page. Saying so beats dropping the text quietly. */
      var named = (trim(e.institution) && !isDateTokenOnly(e.institution)) || trim(e.studyType);
      if (named) { kept.push(e); return; }
      var stray = [e.area, e.score, trim(e.courses.join(' '))].filter(isTrimmed).join(' ').trim();
      if (stray && unidentified.length < 6) unidentified.push(stray);
    });

    if (unidentified.length) {
      note('education-unidentified', 'Some Education text did not name a school or a degree: "' +
        unidentified[0] + '"' + (unidentified.length > 1 ? ' and ' + (unidentified.length - 1) + ' more line' + (unidentified.length > 2 ? 's' : '') : '') +
        '. Add the school yourself, or move the line to another section.');
    }

    return kept;
  }

  function newEducation() {
    return { id: uid('edu'), institution: '', url: '', studyType: '', area: '', score: '', courses: [], start: '', end: '', visible: true };
  }

  var SKILL_DELIM = /[,;|•·/]|\s+and\s+|\s+&\s+/i;

  /* Comma-class separators only. "Data Structures and Algorithms" is one skill,
   * not two: splitting on "and" cut multi-word skills in half, and the halves
   * then reappeared under other groups as separate entries. */
  var SKILL_SPLIT = /\s*[,;|•·]\s*|\s+\/\s+|\s+&\s+/;
  /* "Health & Safety" is one skill, "Git, Docker & AWS" is three. The ampersand
   * only reads as a separator once the line has already shown it is a list. */
  var SKILL_SPLIT_SOLO = /\s*[,;|•·]\s*|\s+\/\s+/;
  var SKILL_SPLIT_EDGE = /^(?:and|or|plus|also)\s+/i;
  var MAX_SKILL_GROUPS = 200;
  var MAX_SKILL_KEYWORDS = 60;

  /* Duplicates are judged inside one group only. HTML listed under both
   * "Programming Languages" and "Web Development" is the person being
   * thorough, not a mistake to be silently tidied away. */
  function hasKeyword(entry, keyword) {
    var lower = String(keyword).toLowerCase();
    return entry.keywords.some(function (k) { return String(k).toLowerCase() === lower; });
  }

  function newSkill(label) {
    return { id: uid('skl'), label: label || '', keywords: [], level: null, visible: true };
  }

  /* "Tools: Git, Docker" and "Tools:" both open a group; the second form, with
   * the list on the lines below, is the one the old pattern missed because it
   * demanded text after the colon. */
  var SKILL_HEAD_COLON = /^([^:：\n]{1,48}?)\s*[:：]\s*(.*)$/;
  /* "Java (5+ years)", "Design (advanced):" — the parenthetical is kept, either
   * as the level the model understands or as part of the label. */
  var SKILL_HEAD_LEVEL = /^([^()（）\n]{1,48}?)\s*[(（]([^()（）\n]{1,24})[)）]\s*[:：]?\s*(.*)$/;
  var SKILL_LEVEL_WORDS = ['beginner', 'intermediate', 'advanced', 'expert', 'fluent', 'proficient', 'native', 'professional'];

  function isSkillLabel(label) {
    var t = trim(label);
    if (!t || t.length > 48) return false;
    if (t.split(/\s+/).length > 6) return false;
    if (/[.!?;,|/]/.test(t)) return false;
    if (EMAIL_TEST_RE.test(t) || URL_TEST_RE.test(t)) return false;
    if (scanDates(t).ranges.length) return false;
    if (isTitleLike(t)) return false;
    return true;
  }

  /* Returns { label, level, inline, colon } or null. Shared with the section
   * splitter, which has to recognise these lines to know they are not new
   * section headings. */
  function skillHeadOf(text) {
    var t = trim(text);
    if (!t) return null;
    var m = SKILL_HEAD_LEVEL.exec(t);
    if (m && isSkillLabel(m[1])) {
      var note = trim(m[2]);
      var level = SKILL_LEVEL_WORDS.indexOf(note.toLowerCase()) !== -1 ? note.toLowerCase() : null;
      return {
        label: level ? trim(m[1]) : trim(m[1]) + ' (' + note + ')',
        level: level,
        inline: trim(m[3]),
        colon: /[:：]/.test(t.slice(t.indexOf(')') + 1))
      };
    }
    m = SKILL_HEAD_COLON.exec(t);
    if (m && isSkillLabel(m[1])) return { label: trim(m[1]), level: null, inline: trim(m[2]), colon: true };
    return null;
  }

  /* A sub-heading with no colon at all leaves nothing in the line to key on, so
   * the only usable signal is what follows: a bullet run, a comma list on its
   * own line, or another heading that carries items of its own. A flat list
   * written one skill per line has none of those and stays content. */
  function bareSkillHead(lines, i, text) {
    if (text.length > 40 || text.split(/\s+/).length > 4) return null;
    if (/[.,;:!?()[\]&/]/.test(text)) return null;
    /* A line in capitals is a section heading however it is punctuated, and a
     * bullet run under "WEB DEVELOPMENT" is a section, not a skills group. */
    if (isCapsHeading(text)) return null;
    var next = nextContentLine(lines, i);
    if (!next) return null;
    if (next.bullet) return text;
    /* "Design" then "Tools: Git, Docker" — a run of headings, the first of which
     * has nothing under it. It is still a heading, just an empty one, and the
     * section says so rather than filing the word as a skill. */
    if (skillHeadOf(next.text)) {
      var after = nextContentLine(lines, lines.indexOf(next));
      if (!after || after.bullet) return text;
      if (!skillHeadOf(after.text) && SKILL_SPLIT.test(trim(after.residue || after.text))) return text;
      return null;
    }
    if (next.parts) return null;
    var tail = trim(next.residue || next.text);
    if (!tail || tail.length > 90) return null;
    if (next.date || next.scan.url || next.scan.email || next.scan.phone) return null;
    if (!SKILL_SPLIT.test(tail)) return null;
    /* Only a title-cased line reads as a heading here; a lower-case line is far
     * more likely to be a stray skill that happens to be followed by a list. */
    if (!/^[A-Z0-9]/.test(text)) return null;
    return text;
  }

  function parseSkills(sec) {
    var lines = sec.lines || [];
    var entries = [];
    var current = null;
    var prose = 0, dupes = 0, dropped = 0, unlabelled = 0, orphanHeads = 0;
    /* A second heading of the same type is merged into this section as another
     * group, so its own wording becomes that group's label. */
    var pendingLabel = sec.carriesLabel ? trim(sec.label) : '';

    function say(code, message) {
      sec.notes = sec.notes || [];
      if (sec.notes.length < 6) sec.notes.push({ code: code, message: message });
    }

    function group(label, level) {
      if (entries.length >= MAX_SKILL_GROUPS) { dropped += 1; return current; }
      var e = newSkill(label || pendingLabel || '');
      e.level = level || null;
      entries.push(e);
      current = e;
      pendingLabel = '';
      if (!trim(e.label)) unlabelled += 1;
      return e;
    }

    function ensureGroup() { return current || group(''); }
    function addItems(entry, text, depth) {
      if (!entry || !text) return;
      var level = depth || 0;
      var parts = String(text).split(/[,;|•·]/.test(text) ? SKILL_SPLIT : SKILL_SPLIT_SOLO);
      /* A full stop belongs to the sentence the line was written as, not to the
       * last skill on it. "… using Vercel, Render, and GitHub." ended up with
       * "GitHub." in the list. */
      var lastBit = trim(parts[parts.length - 1]);
      if (lastBit && /[.!?]+$/.test(lastBit)) {
        parts[parts.length - 1] = lastBit.replace(/[.!?]+$/, '');
      }
      for (var n = 0; n < parts.length; n++) {
        var part = trim(parts[n]);
        /* "React, TypeScript, and Vite" leaves a dangling connector on the last
         * piece. Only when the line was really a list — stripping it from a
         * whole line would eat the first word of a sentence. */
        if (parts.length > 1) part = part.replace(SKILL_SPLIT_EDGE, '').trim();
        if (!part) continue;
        /* Two columns pasted as one line: "Cloud: AWS, Docker; Data: SQL, Pandas".
         * The cell after the second label belongs to the second label, so the
         * rest of the line moves with it. */
        if (level < 2) {
          var inner = skillHeadOf(part);
          if (inner && inner.inline) {
            addItems(group(inner.label, inner.level),
              [inner.inline].concat(parts.slice(n + 1)).join(', '), level + 1);
            return;
          }
        }
        /* Too long to be a skill name, so it is a sentence. Kept whole rather
         * than dropped, and counted so the section can say what it did. */
        if (part.length > 60 || part.split(/\s+/).length > 6) prose += 1;
        if (hasKeyword(entry, part)) { dupes += 1; continue; }
        if (entry.keywords.length >= MAX_SKILL_KEYWORDS) { dropped += 1; continue; }
        entry.keywords.push(part);
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;

      if (ln.bullet) {
        addItems(ensureGroup(), ln.body);
        continue;
      }

      /* A link, an address or a date means the line is a record, not a group
       * name: "GitHub: github.com/x" would otherwise open an empty group. */
      if (ln.scan.url || ln.scan.email || ln.scan.phone || ln.date) {
        var tailText = trim(ln.residue);
        if (tailText) addItems(ensureGroup(), tailText);
        continue;
      }

      var text = trim(ln.text);
      if (!text) continue;

      var head = skillHeadOf(text);
      /* A proficiency form alone on a line is a skill, not a group — it is
       * only a group when something follows it. A trailing colon is a strong
       * enough signal on its own to be taken at face value. */
      if (head && !head.colon && !head.inline) {
        var after = nextContentLine(lines, i);
        if (!after || !after.bullet) head = null;
      }
      if (head) {
        group(head.label, head.level);
        if (head.inline) addItems(current, head.inline);
        continue;
      }

      /* Nothing in "Design" marks it as a head, so the only evidence is what
       * follows it. */
      var bare = bareSkillHead(lines, i, text);
      if (bare) { group(bare); continue; }

      addItems(ensureGroup(), text);
    }

    /* A heading with nothing under it still belongs to the resume: the person
     * wrote it, and the review screen can show it better than silence. */
    var kept = entries.filter(function (e) { return e.keywords.length || trim(e.label); });
    kept.forEach(function (e) { if (!e.keywords.length) orphanHeads += 1; });

    if (prose) {
      say('skills-prose', prose + ' part' + (prose === 1 ? '' : 's') + ' of the skills section read as ' +
        (prose === 1 ? 'a sentence' : 'sentences') + ' rather than skill names. ' +
        (prose === 1 ? 'It was' : 'They were') + ' kept as written — split ' + (prose === 1 ? 'it' : 'them') + ' up or delete ' + (prose === 1 ? 'it' : 'them') + '.');
    }
    if (dupes) {
      say('skills-duplicates', dupes + ' repeated skill' + (dupes === 1 ? ' was' : 's were') + ' listed twice in the same group and kept once. The same skill listed under two different groups is kept in both.');
    }
    if (orphanHeads) {
      say('skills-empty-groups', orphanHeads + ' skill heading' + (orphanHeads === 1 ? '' : 's') + ' had no skills under ' +
        (orphanHeads === 1 ? 'it' : 'them') + '. Nothing was written under those labels — add what belongs there.');
    }
    if (dropped) {
      say('skills-truncated', 'The skills section is longer than a resume can hold. Some groups or skills were left out — add them yourself if they matter.');
    }
    if (unlabelled && kept.length > 1) {
      say('skills-unlabelled', unlabelled + ' group' + (unlabelled === 1 ? '' : 's') + ' of skills ' +
        (unlabelled === 1 ? 'has' : 'have') + ' no heading of its own. It ' + (unlabelled === 1 ? 'was' : 'were') +
        ' kept without a label — give ' + (unlabelled === 1 ? 'it' : 'them') + ' one if that reads better.');
    }
    return kept;
  }

  function newProject() {
    return { id: uid('prj'), name: '', url: '', start: '', end: '', current: false, summary: '', highlights: [''], keywords: [], visible: true };
  }

  function parseProjects(sec) {
    var lines = sec.lines;
    var out = [];
    var cur = null;
    var sawBullets = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;
      if (ln.bullet) {
        if (!cur) cur = newProject();
        addHighlight(cur.highlights, ln.body);
        sawBullets = true;
        continue;
      }
      var parts = readParts(ln);
      var residue = ln.residue;
      var isHeader = (parts && (parts.title || parts.company)) || isTitleLike(residue) || (!cur && !!residue);
      if (isHeader) {
        if (cur && (sawBullets || trim(cur.name))) out.push(cur);
        cur = newProject();
        var prev = previousContentLine(lines, i);
        if (prev && !prev.bullet && !prev.parts && looksLikeCompany(prev.text) && !isTitleLike(residue) && !trim(cur.name)) {
          cur.name = residue || prev.residue || prev.text;
        } else {
          cur.name = (parts && (parts.title || parts.company)) || residue;
        }
        if (parts) {
          if (parts.url) cur.url = parts.url;
          if (parts.start) { attachDates(cur, { start: parts.start, end: parts.end, current: parts.current }); }
        }
        if (ln.scan.url && !cur.url) cur.url = ln.scan.url;
        if (ln.date && ln.date.hasRange && !cur.start) attachDates(cur, ln.date);
        var stack = residue.match(/\b(javascript|typescript|python|react|node|docker|aws|gcp|golang|rust|java|kotlin|swift|android|ios|flask|django|rails|sql|postgres|mongo|redis|graphql|next\.js|vue|svelte|tailwind|figma)\b/gi);
        if (stack) stack.forEach(function (k) { if (cur.keywords.indexOf(k) === -1) push(cur.keywords, k, 40); });
        sawBullets = false;
        continue;
      }
      if (!cur) { cur = newProject(); cur.summary = residue; continue; }
      if (lastHighlight(cur.highlights)) {
        cur.highlights[cur.highlights.length - 1] = lastHighlight(cur.highlights) + ' ' + residue;
      } else cur.summary = cur.summary ? cur.summary + ' ' + residue : residue;
    }
    if (cur) out.push(cur);
    return out.filter(function (e) { return trim(e.name) || e.highlights.some(isTrimmed) || trim(e.summary); });
  }

  function parseCertifications(sec) {
    return chunkRecords(sec.lines).map(function (record) {
      var head = record.head ? record.head.text : '';
      var tail = recordText(record);
      var issuer = /(?:certified\s+by|issued\s+by|awarded\s+by|\bby\b|\bfrom\b)\s+([^,;|]{3,60})/i.exec(head);
      return {
        id: uid('crt'),
        name: stripTrailingYear(head),
        issuer: issuer ? trim(issuer[1]) : (looksLikeCompany(tail) ? tail : ''),
        date: recordDate(record),
        url: recordUrl(record),
        credentialId: (/(?:credential\s*id|\bid\b|serial)\s*[:\-#]?\s*([A-Za-z0-9][\w-]{3,40})/i.exec(tail) || [])[1] || '',
        visible: true
      };
    }).filter(function (e) { return trim(e.name); });
  }

  function parseAwards(sec) {
    return chunkRecords(sec.lines).map(function (record) {
      var head = record.head ? record.head.text : '';
      var tail = recordText(record);
      var awarder = /(?:awarded\s+by|\bfrom\b|\bby\b)\s+([^,;|]{3,60})/i.exec(head);
      return {
        id: uid('awd'),
        title: stripTrailingYear(head),
        awarder: awarder ? trim(awarder[1]) : (looksLikeCompany(tail) ? tail : ''),
        date: recordDate(record),
        visible: true
      };
    }).filter(function (e) { return trim(e.title); });
  }

  function parsePublications(sec) {
    return chunkRecords(sec.lines).map(function (record) {
      var head = record.head ? record.head.text : '';
      var tail = recordText(record);
      var authors = (/\bby\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,6}(?:,|\s+et\s+al\.?)?)/.exec(head) || [])[1] || '';
      var venue = (/(?:\bin\s+|\|)\s*([^|]{3,80})/.exec(head) || [])[1] || '';
      var firstSub = record.lines.filter(function (l) { return !l.bullet; })[0];
      return {
        id: uid('pub'),
        title: trim(head.split(/\s*\|\s*/)[0].replace(/^[\s|]+/, '')),
        authors: trim(authors),
        venue: trim(venue) || (firstSub ? firstSub.text : ''),
        date: recordDate(record),
        url: recordUrl(record),
        doi: (/\b(10\.\d{4,9}\/[\w.\-;()/]+)/.exec(tail) || [])[1] || '',
        visible: true
      };
    }).filter(function (e) { return trim(e.title); });
  }

  var FLUENCY_RE = /^(?:native|native speaker|fluent|full professional|professional working proficiency|professional working|professional|proficient|highly proficient|advanced|intermediate|upper intermediate|elementary|basic|beginner|limited working|conversational|working|bilingual|mother tongue|written|spoken|c1|c2|b1|b2|a1|a2)$/i;

  function parseLanguages(sec) {
    var out = [];
    sec.lines.forEach(function (ln) {
      if (ln.empty) return;
      var text = ln.residue;
      if (!text) return;
      var pieces = text.split(/\s*(?:\||—|–|[:：])\s*|\s*\(([^)]*)\)\s*/).map(trim).filter(Boolean);
      if (pieces.length >= 2 && pieces[1].length <= 40) {
        push(out, { id: uid('lng'), language: pieces[0], fluency: FLUENCY_RE.test(pieces[1]) ? pieces[1] : '' });
        return;
      }
      text.split(SKILL_DELIM).map(trim).filter(function (p) { return p && p.length < 40; })
        .forEach(function (p) { push(out, { id: uid('lng'), language: p, fluency: '' }); });
    });
    return out;
  }

  function parseInterests(sec) {
    var out = [];
    sec.lines.forEach(function (ln) {
      if (ln.empty) return;
      var text = ln.residue;
      if (!text) return;
      text.split(SKILL_DELIM).map(trim).filter(function (p) { return p && p.length < 60; })
        .forEach(function (p) { push(out, { id: uid('int'), label: p }); });
    });
    return out;
  }

  function parseReferences(sec) {
    return chunkRecords(sec.lines).map(function (record) {
      var head = record.head ? record.head.text : '';
      var pieces = head.split(/\s*[,|–—]\s*/).map(trim).filter(Boolean);
      var tail = recordText(record);
      return {
        id: uid('ref'),
        name: pieces[0] || tail,
        label: pieces.length > 1 ? pieces.slice(1).join(', ') : '',
        contact: tail && tail !== pieces[0] ? tail : '',
        visible: true
      };
    }).filter(function (e) { return trim(e.name); });
  }

  function parseCoursework(sec) {
    var out = [];
    chunkRecords(sec.lines).forEach(function (record) {
      var tail = recordText(record);
      var institution = looksLikeInstitution(tail) ? tail : '';
      var date = recordDate(record);
      var url = recordUrl(record);
      function entry(name) {
        return { id: uid('crs'), name: name, institution: institution, date: date, url: url };
      }
      /* "ACADEMIC COURSEWORK" followed by one course per bullet is the common
       * shape, and a record built only from bullets has no head line to take a
       * name from. Folding those into one entry filed the first course and
       * threw the rest away, which emptied the section entirely. */
      if (!record.head) {
        record.lines.forEach(function (l) {
          var name = trim(l.bullet ? l.body : l.text);
          if (name) push(out, entry(name));
        });
        return;
      }
      if (trim(record.head.text)) push(out, entry(record.head.text));
    });
    return out;
  }

  function parsePresentations(sec) {
    var lines = sec.lines;
    var out = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.empty) continue;
      if (ln.bullet) {
        if (!cur) cur = newPresentation();
        var tail = cur.highlights[cur.highlights.length - 1];
        if (tail) cur.highlights[cur.highlights.length - 1] = tail + ' ' + ln.body;
        else cur.highlights[0] = ln.body;
        continue;
      }
      var residue = ln.residue;
      if (!residue) continue;
      if (!cur || trim(cur.title)) { if (cur) out.push(cur); cur = newPresentation(); }
      if (!trim(cur.title)) cur.title = residue;
      else if (/^(?:at|for)\s+/i.test(ln.text) || looksLikeCompany(residue)) { if (!cur.event) cur.event = residue; }
      else if (!cur.location && parseLocation(residue)) cur.location = parseLocation(residue).raw;
      else if (!cur.date && ln.date) cur.date = ln.date.end || ln.date.start || '';
      else if (cur.highlights.length === 1 && !trim(cur.highlights[0])) cur.highlights[0] = residue;
      if (ln.scan.url && !cur.url) cur.url = ln.scan.url;
    }
    if (cur) out.push(cur);
    return out.filter(function (e) { return trim(e.title); });
  }

  function newPresentation() {
    return { id: uid('prs'), title: '', event: '', date: '', location: '', url: '', highlights: [''] };
  }

  function parseCustom(sec) {
    var entries = [];
    var cur = null;
    /* The entry is pushed here, not in the bullet branch. A custom section is
     * whatever the heading table did not recognise, so prose under an odd
     * heading is the common case; the bullet-only push meant a section with no
     * bullets in it produced nothing at all and every line in it was dropped. */
    function open() {
      if (cur) return;
      cur = newCustomEntry();
      push(entries, cur);
    }
    sec.lines.forEach(function (ln) {
      if (ln.empty) return;
      var residue = ln.residue;
      if (ln.bullet) {
        open();
        if (ln.date && ln.date.hasRange) attachDates(cur, ln.date);
        cur.text = cur.text ? cur.text + ' ' + ln.body : ln.body;
        return;
      }
      if (!residue) return;
      open();
      if (ln.date && ln.date.hasRange && !trim(cur.title)) {
        attachDates(cur, ln.date);
        cur.text = residue;
        return;
      }
      if (!trim(cur.title)) { cur.title = residue; return; }
      if (!cur.org && looksLikeCompany(residue)) { cur.org = residue; return; }
      cur.text = cur.text ? cur.text + ' ' + residue : residue;
    });
    return entries.filter(function (e) { return trim(e.title) || trim(e.text); });
  }

  function newCustomEntry() {
    return { id: uid('ent'), title: '', org: '', start: '', end: '', text: '' };
  }

  var PARSERS = {
    experience: parseExperience,
    education: parseEducation,
    skills: parseSkills,
    projects: parseProjects,
    certifications: parseCertifications,
    publications: parsePublications,
    awards: parseAwards,
    volunteer: parseVolunteer,
    languages: parseLanguages,
    interests: parseInterests,
    references: parseReferences,
    coursework: parseCoursework,
    presentations: parsePresentations,
    custom: parseCustom
  };

  /* ------------------------------------------------------------------ entry */

  function fileBase(name) {
    return String(name || '').replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80) || 'Imported resume';
  }

  function joinSummary(lines) {
    var out = [];
    lines.forEach(function (ln) {
      out.push(ln.bullet ? ln.body : (ln.residue || ln.text));
    });
    return trim(out.filter(isTrimmed).join(' '));
  }

  function text(rawText, opts) {
    opts = opts || {};

    DROPPED = 0;
    var confidence = {};
    CONFIDENCE_KEYS.forEach(function (k) { confidence[k] = 'low'; });
    var warnings = [];

    /* Two conflicting signals can only raise the score, never lower it. The
     * seed used to be written first, which made every later `high` a no-op and
     * pinned the whole report at "low". */
    function setConfidence(key, level) {
      var at = LEVELS.indexOf(level);
      if (at < 0) return;
      if (!(key in confidence) || at > LEVELS.indexOf(confidence[key])) confidence[key] = level;
    }

    function warn(code, message) {
      if (warnings.length < MAX_WARNINGS) warnings.push({ code: code, message: message });
      else if (warnings.length === MAX_WARNINGS) warnings.push({ code: 'more', message: 'Further issues were found and are not listed.' });
    }

    function safeUrlFor(value) {
      if (M && typeof M.safeUrl === 'function') return M.safeUrl(value);
      return /^https?:\/\//i.test(String(value)) ? String(value) : '';
    }

    if (!M) {
      warn('no-model', 'The resume model is not loaded, so the text could not be turned into a resume.');
      return { resume: null, confidence: confidence, warnings: warnings };
    }
    if (typeof rawText !== 'string' || !rawText.trim()) {
      warn('empty-input', 'No text was provided. Paste the resume text and import it again.');
      return { resume: M.emptyResume(), confidence: confidence, warnings: warnings };
    }

    var cleaned = rawText
      .slice(0, MAX_TEXT)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2028\u2029]/g, String.fromCharCode(10))
      .replace(/[ ]/g, ' ')
      /* Every bidi override and mark, not just the ones U+202A..U+202E cover.
       * A stray U+200E left in a name is invisible on screen and travels all
       * the way into the exported PDF. */
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');

    if (cleaned.indexOf('�') !== -1) warn('encoding', 'The text contains replacement characters, which usually means the source file was decoded incorrectly.');
    if (cleaned.indexOf('\u0000') !== -1) warn('control-characters', 'The text contains null characters, which are often left behind by a bad text extraction.');
    if (rawText.length > MAX_TEXT) warn('too-long', 'Only the first part of the text was read. Importing the file directly will handle the rest.');

    var lines = classify(toLines(cleaned));
    var contentLines = lines.filter(function (l) { return !l.empty; });

    if (!contentLines.length) {
      warn('empty-input', 'No readable lines were found in that text.');
      return { resume: M.emptyResume(), confidence: confidence, warnings: warnings };
    }

    /* ---- contact --------------------------------------------------------- */
    var email = '', phone = '', url = '';
    var emailCount = 0, phoneCount = 0, urlCount = 0, extraUrls = 0;
    var profiles = [];
    /* A lookup, not a list: indexOf over a growing array is quadratic, and a
     * resume carrying a few thousand links spent most of its import time in
     * it. Null prototype, because the key is untrusted text. */
    var seenUrls = Object.create(null);
    lines.forEach(function (ln) {
      if (ln.empty) return;
      if (!email && ln.scan.email) email = ln.scan.email;
      if (!phone && ln.scan.phone) phone = ln.scan.phone;
      emailCount += ln.scan.emails.length;
      phoneCount += ln.scan.phones.length;
      ln.scan.urls.forEach(function (u) {
        urlCount += 1;
        if (urlCount === 1 && !url) url = u.value;
        /* The first link is already basics.url. Keeping it here as well is
         * how a profile ends up printed twice. */
        if (url === u.value) return;
        if (seenUrls[u.value]) return;
        seenUrls[u.value] = true;
        var network = NETWORKS.filter(function (n) { return n.re.test(u.host); })[0];
        /* A host with no badge is still a link the person wrote down. Dropping
         * it because it is not a known network loses their portfolio, and a
         * review screen cannot warn about text that never arrived. */
        if (profiles.length >= 8) { extraUrls += 1; return; }
        profiles.push({
          network: network ? network.key : 'other',
          label: u.value,
          url: safeUrlFor(u.value)
        });
      });
    });

    if (email) setConfidence('basics.email', 'high');
    else warn('no-email', 'No email address was found. Add it in your contact details.');
    if (phone) setConfidence('basics.phone', 'high');
    else warn('no-phone', 'No phone number was found. Add it in your contact details.');
    if (url) setConfidence('basics.url', 'medium');
    if (emailCount > 1) warn('duplicate-email', 'More than one email address was found. The first one was used — check whether the others belong in your profiles.');
    if (phoneCount > 1) warn('duplicate-phone', 'More than one phone number was found. The first one was used — check the rest.');
    if (urlCount > 1) {
      if (Object.keys(seenUrls).length) {
        warn('multiple-urls', 'More than one link was found. The first is now your main site and the rest are under your links — check each one landed where you want it.');
      } else {
        warn('repeated-url', 'The same link appears more than once in the text. It has been added once.');
      }
    }
    if (extraUrls) warn('too-many-urls', 'There were more links than Resumeboard keeps. The first eight are on the resume; add the rest yourself if they matter.');

    /* ---- headings -------------------------------------------------------- */
    var sections = [];
    var headerLines = [];
    var current = null;
    var bullets = 0;
    var genericHeadings = 0;
    var seenContent = 0;
    var skillSubHeadings = [];
    var unsureHeadings = 0;

    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li];
      if (ln.empty) { if (current) current.lines.push(ln); continue; }
      if (ln.bullet) bullets += 1;
      seenContent += 1;
      /* The first two lines are the masthead, never a section heading. */
      var heading = seenContent > 2 ? headingType(ln.text) : null;
      if (heading && (ln.bullet || ln.date || ln.scan.email || ln.scan.phone || ln.scan.url)) heading = null;
      /* A sub-heading inside a skills list ("Programming Languages:", "Developer
       * Tools:") is a group, not a new section. Synonym matching reads the first
       * as the languages section and the second as a fresh skills section, and
       * everything between them lands in the wrong place. */
      if (heading && current && (current.type === 'skills' || current.type === 'languages')) {
        var sub = skillHeadOf(ln.text);
        if (sub) { heading = null; skillSubHeadings.push(sub.label); }
        /* A comma list inside a skills section is a row of skills, however much
         * it happens to resemble a heading. Left to the synonym matcher it
         * opened a section of its own and took every line after it with it.
         * Only commas count: "AI / MACHINE LEARNING" is a heading. */
        else if (/[,;|•·]/.test(trim(ln.text))) heading = null;
        /* A heading with nothing after the colon, and a bare title-cased line
         * with a bullet run under it, are both group labels. Without this the
         * split happens here and parseSkills never gets to see the line. */
        else if (!ln.bullet && current.type === 'skills') {
          var bare = bareSkillHead(lines, li, trim(ln.text));
          if (bare) { heading = null; skillSubHeadings.push(bare); }
        }
      }
      if (heading) {
        current = { type: heading.type, label: heading.label, generic: heading.generic, certain: heading.certain, lines: [] };
        sections.push(current);
        if (heading.generic) genericHeadings += 1;
        else if (heading.certain === false) unsureHeadings += 1;
        continue;
      }
      if (current) current.lines.push(ln);
      else headerLines.push(ln);
    }

    if (!sections.length) {
      warn('no-sections', 'No section headings were recognised, so the whole text was placed in one section. Import text that uses headings such as "Experience" or "Education" to get a much better result.');
      if (contentLines.length) {
        current = { type: 'custom', label: opts.filename ? fileBase(opts.filename) : 'Imported text', generic: true, lines: contentLines.slice() };
        sections.push(current);
        genericHeadings += 1;
      }
    } else if (genericHeadings) {
      warn('unknown-section', genericHeadings + ' heading' + (genericHeadings === 1 ? ' was' : 's were') + ' not recognised and went into a custom section. Review the labels.');
    }
    if (!bullets && sections.length) warn('no-bullets', 'No bullet markers were found. Wrapped lines were merged into paragraphs, so some sections may read as long blocks of text.');
    if (skillSubHeadings.length) {
      warn('skills-subheadings', skillSubHeadings.length + ' line' + (skillSubHeadings.length === 1 ? '' : 's') +
        ' inside the skills section read like ' + (skillSubHeadings.length === 1 ? 'a sub-heading' : 'sub-headings') +
        ' (' + skillSubHeadings.slice(0, 6).join(', ') + (skillSubHeadings.length > 6 ? ', …' : '') +
        '). They are now groups inside the skills section rather than sections of their own.');
    }
    if (unsureHeadings) {
      warn('uncertain-heading', unsureHeadings + ' heading' + (unsureHeadings === 1 ? '' : 's') +
        ' only partly matched a known section name, so the type is a guess. Check the labels on the resume.');
    }

    var veryLong = lines.filter(function (l) { return l.text.length > 400; }).length;
    if (veryLong > 3) warn('long-lines', veryLong + ' lines are unusually long, which usually means the text came from a table or a PDF. Check that nothing was merged together.');

    /* ---- masthead -------------------------------------------------------- */
    var head = { name: '', givenName: '', familyName: '', label: '', location: null, summary: '' };
    var nameLine = pickName(headerLines);
    var nameIndex = nameLine ? headerLines.indexOf(nameLine) : -1;
    if (nameLine) {
      var parts = splitName(nameLine.text);
      head.name = nameLine.text;
      head.givenName = parts.givenName;
      head.familyName = parts.familyName;
    } else {
      warn('no-name', 'No name was found near the top of the text. Enter it in your contact details.');
    }

    for (var h = 0; h < Math.min(headerLines.length, 14); h++) {
      var hln = headerLines[h];
      if (h === nameIndex) continue;
      var residue = hln.residue;
      if (!residue) continue;

      /* "Senior Data Engineer | San Francisco, CA" packs a title and a place
       * onto one line; take them apart before either claims the whole thing. */
      if (residue.indexOf('|') !== -1) {
        var pieces = residue.split(/\s*\|\s*/).map(trim).filter(Boolean);
        var titlePiece = null, placePiece = null;
        pieces.forEach(function (piece) {
          if (!titlePiece && isTitleLike(piece)) { titlePiece = piece; return; }
          if (!placePiece && parseLocation(piece)) placePiece = piece;
        });
        if (titlePiece && placePiece) {
          if (!head.label) head.label = titlePiece;
          if (!head.location) head.location = parseLocation(placePiece);
          continue;
        }
      }

      if (!head.label && h > nameIndex && h - nameIndex <= 3 && residue.length <= 60 && isTitleLike(residue)) {
        head.label = residue;
        continue;
      }
      if (!head.location && h <= 9) {
        var loc = parseLocation(residue);
        if (loc) { head.location = loc; continue; }
      }
      if (!head.summary && residue.split(/\s+/).length >= 12) head.summary = residue;
    }

    /* ---- sections -------------------------------------------------------- */
    var parsed = {};
    var used = [];
    var emptySections = 0;

    /* A second heading of the same type is merged into the first, so its own
     * wording has to survive somewhere or "Web Development" and "Artificial
     * Intelligence" become an unlabelled pile of keywords. The flag lets the
     * parser seed its first group with the heading it was given. */
    var firstOfType = {};
    sections.forEach(function (sec) {
      if (sec.type === 'summary') return;
      sec.carriesLabel = !!firstOfType[sec.type];
      firstOfType[sec.type] = true;
    });

    sections.forEach(function (sec) {
      sec.lines = sec.lines.filter(function (l) { return !l.empty; });
      if (!sec.lines.length) return;
      if (sec.type === 'summary') {
        var body = joinSummary(sec.lines);
        if (body) {
          head.summary = head.summary ? head.summary + ' ' + body : body;
          used.push(sec);
        }
        return;
      }
      var parser = PARSERS[sec.type];
      if (!parser) return;
      var entries = parser(sec) || [];
      /* A parser that set a line aside has to say so here, before the early
       * return: an empty section and a section that lost content are two
       * different problems for the person reading the review screen. */
      if (sec.notes && sec.notes.length) {
        sec.notes.forEach(function (n) { warn(n.code, n.message); });
      }
      if (!entries.length) { emptySections += 1; return; }
      sec.entries = entries;
      /* Two headings of the same type are two groups inside one section, not a
       * replacement. Assigning dropped everything the earlier heading had
       * collected, which is how a whole TECHNICAL SKILLS list disappeared the
       * moment a later "Developer Tools:" heading was read as a second skills
       * section. */
      if (sec.type !== 'custom') parsed[sec.type] = (parsed[sec.type] || []).concat(entries);
      used.push(sec);
    });

    if (emptySections) {
      warn('empty-sections', emptySections + ' section' + (emptySections === 1 ? '' : 's') + ' had a heading but no content that could be read, so it was left out.');
    }

    /* ---- assemble -------------------------------------------------------- */
    var resume = M.emptyResume();
    var basics = resume.basics;

    basics.name = head.name;
    basics.givenName = head.givenName;
    basics.familyName = head.familyName;
    basics.label = head.label;
    basics.email = email;
    basics.phone = phone;
    basics.url = safeUrlFor(url);
    basics.summary = head.summary;
    if (head.location) {
      basics.location.city = head.location.city;
      basics.location.region = head.location.region;
      /* Only a country the pasted text actually named. emptyResume() seeds the
       * browser's region, and a UK browser would otherwise stamp "Austin, TX"
       * with GB — a wrong fact that reaches the Word export. */
      basics.location.countryCode = head.location.countryCode || '';
    }
    /* Always assigned, never merged: emptyResume() ships one empty LinkedIn
     * profile as a starting point, and leaving it behind puts a blank profile
     * row on every resume built from text. */
    basics.profiles = profiles.map(function (p) {
      return { id: uid('prf'), network: p.network, label: p.label, url: p.url };
    });

    resume.sections = [];
    var order = 0;
    function addSectionFor(type, label) {
      if (resume.sections.some(function (s) { return s.type === type; })) return;
      var section = M.blankSection(type, order);
      if (label) section.label = label.slice(0, 80);
      resume.sections.push(section);
      order += 1;
    }

    /* Every unrecognised heading keeps its own wording as a separate custom
     * group. One shared bucket made the last unknown heading overwrite the
     * others, so only the final one was ever visible. */
    var customGroups = [];
    used.forEach(function (sec) {
      if (sec.type === 'summary') { addSectionFor('summary', sec.label); return; }
      addSectionFor(sec.type, sec.label);
      if (sec.type === 'custom') {
        customGroups.push({ id: uid('cus'), label: sec.label, entries: sec.entries });
        return;
      }
      resume[sec.type] = parsed[sec.type];
    });
    if (customGroups.length) resume.custom = customGroups;
    if (head.summary && !resume.sections.some(function (s) { return s.type === 'summary'; })) {
      var summarySection = M.blankSection('summary', -1);
      resume.sections.unshift(summarySection);
    }
    if (!resume.sections.length) resume.sections = M.emptyResume().sections;

    if (head.name) {
      resume.meta.title = head.label || head.name;
      resume.meta.targetRole = head.label || '';
    } else if (opts.filename) {
      resume.meta.title = fileBase(opts.filename);
    }

    /* ---- confidence ------------------------------------------------------ */
    used.forEach(function (sec) {
      if (sec.type === 'custom') return;
      setConfidence('section.' + sec.type, sec.generic ? 'medium' : 'high');
      if (parsed[sec.type]) setConfidence(sec.type, 'low');
    });
    if (customGroups.length) setConfidence('section.custom', 'medium');
    if (basics.name) setConfidence('basics.name', 'low');
    if (basics.label) setConfidence('basics.label', 'low');
    if (basics.location.city) setConfidence('basics.location', 'low');
    if (basics.summary) setConfidence('basics.summary', 'low');

    var recognised = used.filter(function (s) { return s.type !== 'summary' && s.type !== 'custom'; }).length;
    if (recognised <= 1 && !customGroups.length) {
      warn('few-sections', 'Only ' + (recognised === 1 ? 'one section was' : 'no sections were') + ' recognised. Text with clear headings separates into sections far more reliably.');
    }

    /* The model is the last writer, and it truncates too: 200 entries a
     * section, 20 roles an employer, 40 bullets a role, 60 keywords a group,
     * 30 courses a qualification, 40 sections. Every one of those has to be
     * counted here. Reporting only the summary meant a 500-line education or
     * presentations section lost 300 records with the review screen saying the
     * import worked — the person has no way to tell the text they can see from
     * the text that went missing. */
    var keptBefore = census(resume);
    var validated = M.validate(resume);
    if (validated && validated.resume) {
      var summaryBefore = resume.basics.summary || '';
      resume = validated.resume;
      if ((resume.basics.summary || '').length < summaryBefore.length) {
        warn('summary-truncated', 'The summary is ' + summaryBefore.length + ' characters long and only the first ' +
          (resume.basics.summary || '').length + ' were kept. Shorten it yourself if that is not what you wanted.');
      }
      var keptAfter = census(resume);
      DROPPED += lost(keptBefore, keptAfter);
    }
    if (DROPPED) {
      warn('truncated', 'This resume is longer than a resume can hold. ' + DROPPED + ' item' +
        (DROPPED === 1 ? ' was' : 's were') + ' left out — most often extra roles, entries or bullets past the limit. ' +
        'Everything that was kept is here; add back anything that matters.');
    }

    return { resume: resume, confidence: confidence, warnings: warnings };
  }

  text.heuristics = {
    SECTION_SYNONYMS: SECTION_SYNONYMS,
    BULLET_RE: BULLET_RE,
    EMAIL_RE: EMAIL_RE,
    URL_RE: URL_RE,
    PHONE_INTL_RE: PHONE_INTL_RE,
    PHONE_LOCAL_RE: PHONE_LOCAL_RE,
    RANGE_RE: RANGE_RE,
    MATCH_TIERS: {
      exact: TIER_EXACT, prefix: TIER_PREFIX, suffix: TIER_SUFFIX,
      inner: TIER_INNER, loose: TIER_LOOSE
    },
    matchSynonym: matchSynonym
  };
  text.headingType = headingType;
  /* Section parsers take a { type, lines } section whose lines are the output of
   * classify(). Exposed so an education section can be exercised on its own,
   * without the heading splitter deciding which lines ever reach it. */
  text.parseEducation = parseEducation;
  text.isTitleLike = isTitleLike;
  text.looksLikeCompany = looksLikeCompany;
  text.parseLocation = parseLocation;
  text.scanLine = scanLine;
  text.classify = classify;

  RB.importer.text = text;
})(window);
