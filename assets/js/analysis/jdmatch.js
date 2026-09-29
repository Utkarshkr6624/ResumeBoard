/* Resumeboard — job-description matcher
 *
 * Pure analysis. Touches no DOM, and only writes to the store when the caller
 * hands a suggestion to applySuggestion().
 *
 * Pipeline: JD text -> ranked terms -> per-term classification against a
 * field-level index of the resume -> score, gaps, suggestions.
 *
 * The field index is the interesting part. Every piece of resume text carries
 * the chain of flags that decides whether it reaches the printed page. A term
 * hidden behind a switched-off section is a different problem from a term that
 * is not in the resume at all, and the two get different fixes.
 */
(function (global) {
  'use strict';

  function R() { return global.RB || {}; }
  function U() { return R().utils || null; }
  function MODEL() { return R().model || null; }
  function STORE() { return R().store || null; }

  /* A resume reaches these functions from a hand-edited JSON import, a share
   * link, or a model the store has already sanitised — three places where a
   * list can arrive as a string and a field as a number. The other analysis
   * modules absorb that; this one used to throw on it, and a throw here takes
   * the whole Check tab with it. */
  function list(value) { return Array.isArray(value) ? value : []; }
  function rows(value) { return list(value).filter(function (r) { return r && typeof r === 'object'; }); }

  /* A JD can be a whole ATS page. Past this point the tail is legal
   * boilerplate, and ranking it only costs precision. */
  var MAX_JD_CHARS = 24000;
  var MAX_TERMS = 44;
  var MAX_FIELDS = 4000;

  var STRENGTH = { WEAK: 0, MEDIUM: 1, STRONG: 2 };

  var CREDIT = { present: 1, near: 0.85, hidden: 0.45, missing: 0 };

  /* An unrecognised noun repeated 30 times in a posting ("team", "company")
   * must not outrank a skill named twice. */
  var UNKNOWN_PENALTY = 0.62;

  /* ------------------------------------------------------------------ text */

  /* Inline-HTML aware, but deliberately DOM-free: the matcher has to be
   * callable headlessly, and a throwaway element per field is not free. */
  function plain(raw) {
    var s;
    if (raw == null) s = '';
    else if (typeof raw === 'string') s = raw;
    else { try { s = String(raw); } catch (e) { s = ''; } }
    if (!/[<&]/.test(s)) return s;
    return s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
      .replace(/\s+/g, ' ');
  }

  /* Kept shallow on purpose. It only has to be symmetric — the same function
   * runs on both sides — so "kubernetes" -> "kubernete" is harmless as long as
   * the resume side does the same. Aggressive stemming would collapse distinct
   * skills into each other. */
  function stem(w) {
    if (w.length > 5 && w.slice(-3) === 'ies') return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 5 && w.slice(-3) === 'ing') {
      var base = w.slice(0, -3);
      if (/([bdfglmnprt])\1$/.test(base) && base.length > 3) base = base.slice(0, -1);
      return base;
    }
    if (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }

  var TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9+#.\/-]*/g;

  function tokenize(text) {
    var out = [];
    var s = String(text == null ? '' : text);
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s)) !== null) {
      var raw = m[0].replace(/[.\/-]+$/, '');
      if (raw.length < 2 || raw.length > 28) continue;
      var low = raw.toLowerCase();
      if (/^\d+$/.test(low)) continue;
      if (STOP[low] && !KEEP[low]) continue;
      out.push({ raw: raw, low: low, stem: stem(low) });
    }
    return out;
  }

  function stemSeq(text) {
    var toks = tokenize(text);
    var out = [];
    for (var i = 0; i < toks.length; i++) out.push(toks[i].stem);
    return out.join(' ');
  }

  /* Padded, bounded matching so a term can never match across a token
   * boundary. Every term/field comparison goes through this one function. */
  function countKey(hay, key) {
    if (!key) return 0;
    var padded = ' ' + hay + ' ';
    var needle = ' ' + key + ' ';
    var n = 0, i = 0, at;
    while ((at = padded.indexOf(needle, i)) !== -1) { n++; i = at + needle.length; }
    return n;
  }

  function hasKey(hay, key) { return countKey(hay, key) > 0; }

  /* ------------------------------------------------------------ dictionaries
   * Object.create(null) throughout: a JD is untrusted input and "constructor"
   * is a plausible token. A plain {} would answer from Object.prototype. */

  function nullObj() { return Object.create(null); }

  function toSet(str) {
    var out = nullObj();
    str.split(/\s+/).forEach(function (w) { if (w) out[w] = true; });
    return out;
  }

  var STOP = Object.assign(nullObj(), toSet(
    /* ordinary English */
    'a an the and or but if then else of in on at to for from by with without within into onto over under again ' +
    'further is are was were be been being am do does did doing done have has had having will would shall should ' +
    'can could may might must not no nor so than that this these those there here it its as also such own same ' +
    'other another each any all both few more most some only very just about above below up down out off why how ' +
    'when where which who whom what while during before after between because until unless whether per via you ' +
    'your yours we our ours us they them their he she his her him hers i me my mine' +
    /* posting register: real words that say nothing about the role */
    'job role position company employer candidate candidates team teams department org organization workplace ' +
    'work working experience experienced ability able across apply applicant applicants please email send resume ' +
    'cv application opportunity offer opportunities benefits salary compensation pay range diversity inclusion ' +
    'responsibilities requirement requirements qualification qualifications required require need needs must ' +
    'using use used help helping helps new well good great strong excellent professional preferably ideal ' +
    'plus preferred minimum year years month months time times day days week weeks looking join joining ' +
    'service services including include includes included etc opportunity'
  ));

  /* Words that read as filler but are genuinely part of a skill name. */
  var KEEP = toSet('go node rust java spring boot full stack front end back end dev ops site reliability sci machine deep learning web cloud data');

  var HARD_UNIGRAM = toSet(
    'python java javascript typescript ruby rust golang php kotlin swift scala perl r matlab clojure elixir haskell ' +
    'bash shell sql nosql html css sass less scss tailwind bootstrap jquery angular react vue svelte next nuxt ' +
    'node express django flask fastapi rails laravel spring hibernate graphql grpc websocket ' +
    'aws azure gcp kubernetes docker terraform ansible jenkins gitlab github bitbucket unix linux windows macos ' +
    'nginx apache kafka rabbitmq redis postgres postgresql mysql mongodb mssql snowflake bigquery ' +
    'databricks airflow dbt spark hadoop hive pandas numpy scipy sklearn pytorch tensorflow keras nlp ml ai ' +
    'mlops etl crm erp sap netsuite tableau looker excel powerpoint sharepoint jira confluence ' +
    'figma sketch adobe illustrator photoshop indesign xd framer zeplin miro notion canva html5 css3 a11y wcag ' +
    'seo sem ga4 accessibility ux ui hmi plc scada cad cam fea simulink verilog vhdl ' +
    'puppet chef vagrant istio envoy consul vault okta auth0 saml oauth jwt oauth2 restful crud ' +
    'cicd tdd bdd ddd devops sre qa qos sla slo sli mttr rto rpo ' +
    'symfony codeigniter yii netcore dotnet aspnet vbnet objective delphi cobol ' +
    'rpa zapier make salesforce servicenow workday epic'
  );

  var HARD_PHRASE = {
    'machine learning': 1.9, 'deep learning': 1.9, 'natural language processing': 1.9, 'computer vision': 1.85,
    'large language model': 1.8, 'generative ai': 1.75, 'data analysis': 1.7, 'data engineering': 1.8,
    'data pipeline': 1.7, 'data warehouse': 1.7, 'business intelligence': 1.6, 'predictive modeling': 1.7,
    'distributed systems': 1.7, 'system design': 1.75, 'design systems': 1.6, 'design system': 1.6,
    'user research': 1.65, 'user experience': 1.6, 'user interface': 1.6, 'product design': 1.6,
    'product management': 1.7, 'project management': 1.6, 'program management': 1.6, 'people management': 1.6,
    'customer experience': 1.5, 'customer success': 1.5, 'cross functional': 1.5, 'cross-functional': 1.5,
    'stakeholder management': 1.6, 'change management': 1.5, 'risk management': 1.55, 'vendor management': 1.5,
    'cost optimization': 1.5, 'process improvement': 1.5, 'supply chain': 1.5, 'quality assurance': 1.6,
    'test automation': 1.6, 'unit testing': 1.55, 'integration testing': 1.5, 'performance testing': 1.5,
    'accessibility audit': 1.5, 'wcag compliance': 1.5, 'responsive design': 1.5, 'wireframing': 1.5,
    'prototyping': 1.5, 'agile methodology': 1.55, 'agile development': 1.55, 'kanban': 1.4, 'scrum': 1.45,
    'technical leadership': 1.7, 'mentoring': 1.4, 'onboarding': 1.4, 'continuous integration': 1.55,
    'continuous delivery': 1.55, 'continuous deployment': 1.55, 'infrastructure as code': 1.6,
    'cloud architecture': 1.6, 'serverless': 1.5, 'multi tenant': 1.4, 'a/b testing': 1.6, 'user testing': 1.5,
    'go to market': 1.4, 'product launch': 1.45, 'roadmap': 1.4,
    'budget management': 1.4, 'problem solving': 1.35, 'critical thinking': 1.3,
    'attention to detail': 1.25, 'time management': 1.25, 'written communication': 1.3, 'verbal communication': 1.3,
    'public speaking': 1.25
  };

  var SOFT_UNIGRAM = toSet(
    'leadership communication collaboration teamwork mentoring coaching ownership initiative adaptability ' +
    'resilience empathy listening negotiation facilitation presentation storytelling ' +
    'reliability accountability proactive meticulous ' +
    'multicultural patience persistence tact diplomacy motivation detail'
  );

  var DEGREE_TERM = {
    'mba': 1.9, 'phd': 1.9, 'ph.d': 1.9, 'doctorate': 1.8, 'bachelor': 1.75, 'masters': 1.75, 'bsc': 1.8,
    'msc': 1.8, 'bs': 1.6, 'ms': 1.6, 'ba': 1.6, 'ma': 1.6, 'bfa': 1.75, 'mfa': 1.75, 'btech': 1.8,
    'mtech': 1.8, 'beng': 1.8, 'meng': 1.8, 'bsn': 1.75, 'msn': 1.75, 'jd': 1.7, 'md': 1.5,
    'associate degree': 1.6, 'diploma': 1.5, 'high school': 1.3, 'postgraduate': 1.7, 'undergraduate': 1.6
  };

  var CERT_TERM = {
    'pmp': 1.9, 'cissp': 1.9, 'cka': 1.9, 'ckad': 1.85, 'aws certified': 1.85, 'csm': 1.7, 'psm': 1.7,
    'itil': 1.7, 'scrum master': 1.7, 'six sigma': 1.7, 'lean six sigma': 1.75, 'cpa': 1.85, 'cfa': 1.85,
    'comptia': 1.7, 'ccna': 1.8, 'ccnp': 1.8, 'ccie': 1.85, 'nclex': 1.85, 'cpr': 1.6, 'first aid': 1.5,
    'bls': 1.6, 'acls': 1.6, 'pals': 1.6, 'istqb': 1.7, 'istqb ctsl': 1.8, 'nn/g': 1.7, 'google ux': 1.7,
    'iso 27001': 1.8, 'iso 27002': 1.7, 'soc 2': 1.75, 'sox': 1.6, 'gdpr': 1.6, 'hipaa': 1.7,
    'pci dss': 1.7, 'wcag': 1.6, 'a+': 1.6, 'network+': 1.6, 'security+': 1.6,
    'aws solutions architect': 1.85, 'google cloud professional': 1.85, 'terraform associate': 1.8,
    'professional engineer': 1.7, 'pe license': 1.75, 'chartered': 1.7
  };

  /* Acronym <-> expansion. Initials are derived, so one entry covers both
   * directions. */
  var ACRONYM = {
    'master of business administration': 'mba',
    'master of science': 'msc',
    'master of arts': 'ma',
    'bachelor of science': 'bsc',
    'bachelor of arts': 'ba',
    'bachelor of fine arts': 'bfa',
    'master of fine arts': 'mfa',
    'doctor of philosophy': 'phd',
    'human resources': 'hr',
    'quality assurance': 'qa',
    'user experience': 'ux',
    'user interface': 'ui',
    'search engine optimization': 'seo',
    'search engine marketing': 'sem',
    'customer relationship management': 'crm',
    'enterprise resource planning': 'erp',
    'business to business': 'b2b',
    'business to consumer': 'b2c',
    'return on investment': 'roi',
    'key performance indicator': 'kpi',
    'research and development': 'rnd',
    'artificial intelligence': 'ai',
    'machine learning': 'ml',
    'natural language processing': 'nlp',
    'computer vision': 'cv',
    'service level agreement': 'sla',
    'service level objective': 'slo',
    'mean time to recovery': 'mttr',
    'system on a chip': 'soc',
    'application programming interface': 'api',
    'representational state transfer': 'rest',
    'hypertext markup language': 'html',
    'cascading style sheets': 'css',
    'personally identifiable information': 'pii',
    'general data protection regulation': 'gdpr',
    'payment card industry': 'pci',
    'chief executive officer': 'ceo',
    'chief technology officer': 'cto',
    'chief financial officer': 'cfo',
    'continuous integration': 'ci',
    'continuous delivery': 'cd',
    'information technology': 'it',
    'operational technology': 'ot',
    'internet of things': 'iot',
    'software development life cycle': 'sdlc',
    'test driven development': 'tdd',
    'accessibility conformance': 'wcag'
  };

  /* Where derived initials give the wrong answer. */
  var ACRONYM_FIXUPS = { 'a/b testing': 'ab', 'business to business': 'b2b', 'c/c++': 'cpp' };

  var ALIAS = {
    'kubernetes': ['k8s'],
    'continuous integration': ['ci/cd'],
    'node.js': ['nodejs', 'node'],
    'amazon web services': ['aws'],
    'google cloud platform': ['gcp'],
    'microsoft azure': ['azure'],
    'product management': ['pm'],
    'people management': ['hr'],
    'key performance indicator': ['kpi', 'kpis'],
    'electronic commerce': ['ecommerce', 'e-commerce'],
    'user experience': ['ux'],
    'user interface': ['ui'],
    'human resources': ['hr'],
    'artificial intelligence': ['ai'],
    'machine learning': ['ml'],
    'natural language processing': ['nlp', 'nlu'],
    'version control': ['git'],
    'object oriented programming': ['oop'],
    'service oriented architecture': ['soa'],
    'cross functional': ['cross-functional'],
    'a/b testing': ['ab testing', 'a/b', 'split testing'],
    'go to market': ['gtm'],
    'first aid': ['bls']
  };

  var CANONICAL = {
    'aws': 'AWS', 'gcp': 'GCP', 'api': 'API', 'apis': 'APIs', 'sql': 'SQL', 'nosql': 'NoSQL',
    'html': 'HTML', 'css': 'CSS', 'html/css': 'HTML/CSS', 'ux': 'UX', 'ui': 'UI', 'seo': 'SEO', 'sem': 'SEM',
    'crm': 'CRM', 'erp': 'ERP', 'kpi': 'KPI', 'kpis': 'KPIs', 'roi': 'ROI', 'b2b': 'B2B', 'b2c': 'B2C',
    'ml': 'ML', 'nlp': 'NLP', 'cv': 'CV', 'ai': 'AI', 'iot': 'IoT', 'it': 'IT', 'ot': 'OT',
    'qa': 'QA', 'sla': 'SLA', 'slo': 'SLO', 'sli': 'SLI', 'mttr': 'MTTR', 'pii': 'PII', 'gdpr': 'GDPR',
    'hipaa': 'HIPAA', 'pci': 'PCI', 'sdlc': 'SDLC', 'tdd': 'TDD', 'ci': 'CI', 'cd': 'CD', 'cpa': 'CPA',
    'cfa': 'CFA', 'cissp': 'CISSP', 'pmp': 'PMP', 'cka': 'CKA', 'ccna': 'CCNA', 'ccnp': 'CCNP',
    'ccie': 'CCIE', 'nclex': 'NCLEX', 'php': 'PHP', 'c': 'C', 'c++': 'C++', 'c#': 'C#', 'r#': 'R#',
    'node.js': 'Node.js', 'next.js': 'Next.js', 'vue.js': 'Vue.js', 'asp.net': 'ASP.NET', '.net': '.NET',
    'graphql': 'GraphQL', 'rest': 'REST', 'grpc': 'gRPC',
    'nlp': 'NLP', 'etl': 'ETL', 'a11y': 'a11y', 'wcag': 'WCAG', 'ux/ui': 'UX/UI', 'a/b testing': 'A/B testing',
    'mba': 'MBA', 'phd': 'PhD', 'bsc': 'BSc', 'msc': 'MSc', 'bfa': 'BFA', 'mfa': 'MFA',
    'beng': 'BEng', 'meng': 'MEng', 'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow', 'numpy': 'NumPy',
    'aws certified': 'AWS Certified', 'nn/g': 'NN/g', 'ci/cd': 'CI/CD', 'k8s': 'K8s'
  };

  var DICT = nullObj();

  (function buildDict() {
    Object.keys(HARD_UNIGRAM).forEach(function (w) { dictPut(w, 'hard', 1.6); });
    Object.keys(SOFT_UNIGRAM).forEach(function (w) { dictPut(w, 'soft', 1.25); });
    Object.keys(DEGREE_TERM).forEach(function (w) { dictPut(w, 'degree', DEGREE_TERM[w]); });
    Object.keys(CERT_TERM).forEach(function (w) { dictPut(w, 'cert', CERT_TERM[w]); });
    Object.keys(HARD_PHRASE).forEach(function (w) { dictPut(w, 'hard', HARD_PHRASE[w]); });
  })();

  function dictPut(key, category, weight) {
    if (!key) return;
    var k = key.toLowerCase();
    var cur = DICT[k];
    if (!cur || weight > cur.weight) DICT[k] = { category: category, weight: weight };
  }

  function initialsOf(expansion) {
    var words = expansion.toLowerCase().split(/[^a-z0-9+]+/);
    var out = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || w === 'of' || w === 'and' || w === 'to' || w === 'in') continue;
      out += w.charAt(0);
    }
    return out;
  }

  var ACR_INDEX = nullObj();
  (function buildAcronyms() {
    Object.keys(ACRONYM).forEach(function (expansion) {
      var acr = ACRONYM[expansion];
      ACR_INDEX[expansion] = acr;
      ACR_INDEX[acr] = acr;
      var ini = initialsOf(expansion);
      if (ini.length >= 2 && ini.length <= 6 && !ACR_INDEX[ini]) ACR_INDEX[ini] = acr;
    });
    Object.keys(ACRONYM_FIXUPS).forEach(function (k) { ACR_INDEX[k] = ACRONYM_FIXUPS[k]; });
  })();

  function expansionFor(acr) {
    var found = null;
    Object.keys(ACRONYM).some(function (exp) {
      if (ACRONYM[exp] === acr) { found = exp; return true; }
      return false;
    });
    return found;
  }

  function isAcronymish(low) { return /^[a-z0-9+]{2,6}$/.test(low); }

  /* Every surface a concept can take, all reduced to one stem key. */
  function conceptKeys(term) {
    var low = String(term).toLowerCase().trim();
    var keys = nullObj();
    function put(v) { if (v && String(v).length > 1) keys[stemSeq(v)] = true; }
    put(low);
    var acr = ACR_INDEX[low];
    if (acr && isAcronymish(low) && acr !== low) {
      put(acr);
      var exp = expansionFor(acr);
      if (exp) { put(exp); put(initialsOf(exp)); }
    } else if (acr && !isAcronymish(low)) {
      put(acr);
      put(initialsOf(low));
    }
    var al = ALIAS[low];
    if (al) al.forEach(put);
    if (CANONICAL[low]) put(CANONICAL[low]);
    return Object.keys(keys);
  }

  function categoryOf(term) {
    var low = String(term).toLowerCase();
    if (ACR_INDEX[low] && isAcronymish(low)) {
      /* An abbreviation that is also a degree or credential keeps that
       * meaning: "MBA" is a degree, not a business buzzword. */
      if (DEGREE_TERM[low]) return 'degree';
      if (CERT_TERM[low]) return 'cert';
      return null;
    }
    var exact = DICT[low];
    if (exact) return exact.category;
    var best = null;
    Object.keys(DICT).forEach(function (k) {
      if (k.indexOf(' ') === -1) return;
      if (k.split(' ').indexOf(low) !== -1 && (!best || DICT[k].weight > DICT[best].weight)) best = k;
    });
    return best ? DICT[best].category : null;
  }

  function displayTerm(term) {
    var low = term.toLowerCase();
    if (CANONICAL[low]) return CANONICAL[low];
    if (ACR_INDEX[low] && isAcronymish(low) && low !== ACR_INDEX[low] && !/^[A-Z]/.test(term)) {
      var u = U();
      return u ? u.titleCase(term) : term;
    }
    return term;
  }

  /* ---------------------------------------------------------------- ranking */

  var CUE_RE = /\b(required|requirement|requirements|qualification|qualifications|must|essential|mandatory|you have|you will have|we are looking for|looking for|ideally|preferred|you should|ability to|experience with|proficiency|proficient|skills|responsibilit)/i;
  var BULLET_RE = /^\s*([-*•·▪‣◦]|\d+[.)])\s+/;

  function splitLines(text) {
    return String(text)
      .split(/\r\n|\r|\n|\s*[•▪‣◦]\s+/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 1; });
  }

  function mostCommonForm(forms, key) {
    var best = null, bestN = -1;
    Object.keys(forms).forEach(function (f) {
      if (!f || !f.trim()) return;
      if (stemSeq(f) !== key) return;
      if (forms[f] > bestN || (forms[f] === bestN && f.length < best.length)) { best = f; bestN = forms[f]; }
    });
    return best;
  }

  /* Ranked term list: log-damped frequency, multiplied by the average
   * position weight of its occurrences and by dictionary standing. */
  function extractTerms(jdText) {
    var text = String(jdText == null ? '' : jdText).slice(0, MAX_JD_CHARS);
    var lines = splitLines(text);
    if (!lines.length) return [];

    var acc = nullObj();
    var n = lines.length;

    function slot(key) {
      if (!acc[key]) acc[key] = { key: key, count: 0, weight: 0, cued: false, forms: nullObj() };
      return acc[key];
    }

    for (var i = 0; i < n; i++) {
      var line = lines[i];
      var cued = CUE_RE.test(line);
      var cue = cued ? 1.8 : 1;
      var bullet = (BULLET_RE.test(line) || line.length < 140) ? 1.35 : 1;
      /* Earlier lines carry the title and the hard requirements. */
      var pos = 1.25 - 0.5 * (i / Math.max(1, n - 1));
      var w = pos * cue * bullet;

      var toks = tokenize(line);
      var t;
      for (t = 0; t < toks.length; t++) {
        var s = slot(toks[t].stem);
        s.count++; s.weight += w;
        if (cued) s.cued = true;
        s.forms[toks[t].raw] = (s.forms[toks[t].raw] || 0) + 1;
      }
      /* Adjacent content words are where the real requirements live:
       * "user research", "design systems", "cloud infrastructure". */
      for (t = 0; t < toks.length - 1; t++) {
        var p = slot(toks[t].stem + ' ' + toks[t + 1].stem);
        var pairForm = toks[t].raw + ' ' + toks[t + 1].raw;
        p.count++; p.weight += w * 1.25;
        if (cued) p.cued = true;
        p.forms[pairForm] = (p.forms[pairForm] || 0) + 1;
      }
    }

    var list = [];
    Object.keys(acc).forEach(function (key) {
      var rec = acc[key];
      if (!key || key.length < 3) return;
      var form = mostCommonForm(rec.forms, key);
      if (!form) return;

      var lowForm = form.toLowerCase();
      var wordCount = key.split(' ').length;
      var entry = DICT[lowForm] || null;
      if (!entry) {
        var cat = categoryOf(lowForm);
        if (cat) entry = { category: cat, weight: cat === 'hard' ? 1.35 : 1.2 };
      }

      var dictWeight = entry ? entry.weight : UNKNOWN_PENALTY;
      var score = (1 + Math.log(rec.count))
        * (rec.weight / rec.count)
        * dictWeight
        * (rec.cued ? 1.45 : 1)
        * (wordCount > 1 ? 1.15 : 1);

      list.push({
        term: displayTerm(form),
        key: key,
        keys: conceptKeys(lowForm),
        stems: key.split(' '),
        count: rec.count,
        score: score,
        cued: rec.cued,
        wordCount: wordCount,
        category: entry ? entry.category : null
      });
    });

    list.sort(function (a, b) { return b.score - a.score; });
    return selectTerms(list);
  }

  /* When a phrase wins, its unigrams are noise: "user research" beats "user".
   * A unigram survives only when it stands on its own. */
  function selectTerms(list) {
    var picked = [];
    for (var i = 0; i < list.length && picked.length < MAX_TERMS; i++) {
      var t = list[i];
      if (t.wordCount === 1) {
        var swallowed = false;
        for (var j = 0; j < picked.length; j++) {
          var p = picked[j];
          if (p.wordCount > 1 && p.stems.indexOf(t.key) !== -1 && p.score > t.score) { swallowed = true; break; }
        }
        if (swallowed) continue;
      }
      picked.push(t);
    }
    return picked;
  }

  /* -------------------------------------------------------- resume field index */

  function sectionChoice(resume, type) {
    var sections = list(resume.sections);
    var first = -1, visibleAt = -1;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i] && sections[i].type === type) {
        if (first === -1) first = i;
        if (visibleAt === -1 && sections[i].visible !== false) visibleAt = i;
      }
    }
    return { index: visibleAt !== -1 ? visibleAt : first, has: first !== -1 };
  }

  /* The chain of flags keeping a piece of text off the printed page.
   * Empty array means the text is on the page. */
  function blockersFor(resume, type, entryIndex, roleIndex) {
    var blockers = [];
    var versions = (resume.versions && typeof resume.versions === 'object') ? resume.versions : {};
    var disabled = (versions.disabled && typeof versions.disabled === 'object') ? versions.disabled : {};
    var choice = sectionChoice(resume, type);

    if (!choice.has) {
      blockers.push({ label: 'section', kind: 'add-section', sectionType: type });
    } else {
      var sec = list(resume.sections)[choice.index];
      if (sec.visible === false) blockers.push({ label: 'section', kind: 'flag', path: 'sections.' + choice.index + '.visible', value: true });
      if (sec.id && disabled[sec.id]) blockers.push({ label: 'version', kind: 'flag', path: 'versions.disabled.' + sec.id, value: false });
    }

    if (entryIndex != null) {
      var entry = list(resume[type])[entryIndex];
      if (entry) {
        if (entry.visible === false) blockers.push({ label: 'entry', kind: 'flag', path: type + '.' + entryIndex + '.visible', value: true });
        if (entry.id && disabled[entry.id]) blockers.push({ label: 'version', kind: 'flag', path: 'versions.disabled.' + entry.id, value: false });
      }
    }
    if (roleIndex != null) {
      var role = list(((list(resume.experience)[entryIndex]) || {}).roles)[roleIndex];
      if (role && role.visible === false) {
        blockers.push({ label: 'role', kind: 'flag', path: 'experience.' + entryIndex + '.roles.' + roleIndex + '.visible', value: true });
      }
    }
    return blockers;
  }

  function buildIndex(resume) {
    var fields = [];

    function add(ctx, path, value, strength) {
      if (fields.length >= MAX_FIELDS) return;
      var text = plain(value);
      if (!text || !text.trim()) return;
      fields.push({
        path: path,
        raw: text,
        text: text,
        norm: stemSeq(text),
        strength: strength,
        blockers: ctx.blockers,
        sectionType: ctx.sectionType,
        entryType: ctx.entryType,
        entryId: ctx.entryId,
        roleId: ctx.roleId
      });
    }

    function ctxFor(type, entryIndex, roleIndex, header) {
      var at = list(resume[type]);
      var entry = entryIndex != null ? at[entryIndex] : null;
      var role = null;
      if (roleIndex != null) {
        role = list(((list(resume.experience)[entryIndex]) || {}).roles)[roleIndex] || null;
      }
      return {
        blockers: header ? [] : blockersFor(resume, type, entryIndex, roleIndex),
        sectionType: header ? null : type,
        entryType: type,
        entryId: entry ? entry.id : null,
        roleId: role ? role.id : null
      };
    }

    var b = (resume.basics && typeof resume.basics === 'object') ? resume.basics : {};
    var loc = (b.location && typeof b.location === 'object') ? b.location : {};
    var head = ctxFor('summary', null, null, true);
    add(head, 'basics.name', b.name, STRENGTH.STRONG);
    add(head, 'basics.givenName', b.givenName, STRENGTH.STRONG);
    add(head, 'basics.familyName', b.familyName, STRENGTH.STRONG);
    add(head, 'basics.label', b.label, STRENGTH.STRONG);
    add(head, 'basics.email', b.email, STRENGTH.WEAK);
    add(head, 'basics.phone', b.phone, STRENGTH.WEAK);
    add(head, 'basics.url', b.url, STRENGTH.WEAK);
    add(head, 'basics.location.city', loc.city, STRENGTH.WEAK);
    add(head, 'basics.location.region', loc.region, STRENGTH.WEAK);
    rows(b.profiles).forEach(function (p, i) {
      add(head, 'basics.profiles.' + i + '.network', p.network, STRENGTH.WEAK);
      add(head, 'basics.profiles.' + i + '.label', p.label, STRENGTH.MEDIUM);
    });

    add(ctxFor('summary'), 'basics.summary', b.summary, STRENGTH.MEDIUM);

    rows(resume.experience).forEach(function (e, i) {
      var c = ctxFor('experience', i);
      add(c, 'experience.' + i + '.company', e.company, STRENGTH.MEDIUM);
      add(c, 'experience.' + i + '.companyEntity', e.companyEntity, STRENGTH.WEAK);
      add(c, 'experience.' + i + '.location', e.location, STRENGTH.WEAK);
      rows(e.roles).forEach(function (r, j) {
        var rc = ctxFor('experience', i, j);
        add(rc, 'experience.' + i + '.roles.' + j + '.position', r.position, STRENGTH.STRONG);
        add(rc, 'experience.' + i + '.roles.' + j + '.summary', r.summary, STRENGTH.MEDIUM);
        list(r.highlights).forEach(function (h, k) { add(rc, 'experience.' + i + '.roles.' + j + '.highlights.' + k, h, STRENGTH.MEDIUM); });
        list(r.skills).forEach(function (sk, k) { add(rc, 'experience.' + i + '.roles.' + j + '.skills.' + k, sk, STRENGTH.STRONG); });
      });
    });

    rows(resume.education).forEach(function (e, i) {
      var c = ctxFor('education', i);
      add(c, 'education.' + i + '.studyType', e.studyType, STRENGTH.STRONG);
      add(c, 'education.' + i + '.area', e.area, STRENGTH.STRONG);
      add(c, 'education.' + i + '.institution', e.institution, STRENGTH.MEDIUM);
      add(c, 'education.' + i + '.score', e.score, STRENGTH.WEAK);
      list(e.courses).forEach(function (cr, k) { add(c, 'education.' + i + '.courses.' + k, cr, STRENGTH.MEDIUM); });
    });

    rows(resume.skills).forEach(function (e, i) {
      var c = ctxFor('skills', i);
      add(c, 'skills.' + i + '.label', e.label, STRENGTH.STRONG);
      list(e.keywords).forEach(function (kw, k) { add(c, 'skills.' + i + '.keywords.' + k, kw, STRENGTH.STRONG); });
    });

    rows(resume.projects).forEach(function (e, i) {
      var c = ctxFor('projects', i);
      add(c, 'projects.' + i + '.name', e.name, STRENGTH.STRONG);
      add(c, 'projects.' + i + '.summary', e.summary, STRENGTH.MEDIUM);
      list(e.keywords).forEach(function (kw, k) { add(c, 'projects.' + i + '.keywords.' + k, kw, STRENGTH.STRONG); });
      list(e.highlights).forEach(function (h, k) { add(c, 'projects.' + i + '.highlights.' + k, h, STRENGTH.MEDIUM); });
    });

    rows(resume.certifications).forEach(function (e, i) {
      var c = ctxFor('certifications', i);
      add(c, 'certifications.' + i + '.name', e.name, STRENGTH.STRONG);
      add(c, 'certifications.' + i + '.issuer', e.issuer, STRENGTH.MEDIUM);
      add(c, 'certifications.' + i + '.credentialId', e.credentialId, STRENGTH.WEAK);
    });

    rows(resume.publications).forEach(function (e, i) {
      var c = ctxFor('publications', i);
      add(c, 'publications.' + i + '.title', e.title, STRENGTH.STRONG);
      add(c, 'publications.' + i + '.venue', e.venue, STRENGTH.MEDIUM);
      add(c, 'publications.' + i + '.authors', e.authors, STRENGTH.MEDIUM);
    });

    rows(resume.awards).forEach(function (e, i) {
      var c = ctxFor('awards', i);
      add(c, 'awards.' + i + '.title', e.title, STRENGTH.STRONG);
      add(c, 'awards.' + i + '.awarder', e.awarder, STRENGTH.MEDIUM);
    });

    rows(resume.volunteer).forEach(function (e, i) {
      var c = ctxFor('volunteer', i);
      add(c, 'volunteer.' + i + '.role', e.role, STRENGTH.STRONG);
      add(c, 'volunteer.' + i + '.organization', e.organization, STRENGTH.MEDIUM);
      list(e.highlights).forEach(function (h, k) { add(c, 'volunteer.' + i + '.highlights.' + k, h, STRENGTH.MEDIUM); });
    });

    rows(resume.languages).forEach(function (e, i) {
      var c = ctxFor('languages', i);
      add(c, 'languages.' + i + '.language', e.language, STRENGTH.STRONG);
      add(c, 'languages.' + i + '.fluency', e.fluency, STRENGTH.MEDIUM);
    });

    rows(resume.interests).forEach(function (e, i) {
      add(ctxFor('interests', i), 'interests.' + i + '.label', e.label, STRENGTH.MEDIUM);
    });

    rows(resume.references).forEach(function (e, i) {
      var c = ctxFor('references', i);
      add(c, 'references.' + i + '.name', e.name, STRENGTH.STRONG);
      add(c, 'references.' + i + '.label', e.label, STRENGTH.MEDIUM);
    });

    rows(resume.coursework).forEach(function (e, i) {
      var c = ctxFor('coursework', i);
      add(c, 'coursework.' + i + '.name', e.name, STRENGTH.STRONG);
      add(c, 'coursework.' + i + '.institution', e.institution, STRENGTH.MEDIUM);
    });

    rows(resume.presentations).forEach(function (e, i) {
      var c = ctxFor('presentations', i);
      add(c, 'presentations.' + i + '.title', e.title, STRENGTH.STRONG);
      add(c, 'presentations.' + i + '.event', e.event, STRENGTH.MEDIUM);
      list(e.highlights).forEach(function (h, k) { add(c, 'presentations.' + i + '.highlights.' + k, h, STRENGTH.MEDIUM); });
    });

    rows(resume.custom).forEach(function (e, i) {
      var c = ctxFor('custom', i);
      add(c, 'custom.' + i + '.label', e.label, STRENGTH.STRONG);
      rows(e.entries).forEach(function (x, k) {
        add(c, 'custom.' + i + '.entries.' + k + '.title', x.title, STRENGTH.STRONG);
        add(c, 'custom.' + i + '.entries.' + k + '.org', x.org, STRENGTH.MEDIUM);
        add(c, 'custom.' + i + '.entries.' + k + '.text', x.text, STRENGTH.MEDIUM);
      });
    });

    return fields;
  }

  /* --------------------------------------------------------- classification */

  function classifyTerm(term, fields) {
    var keys = term.keys && term.keys.length ? term.keys : [term.key];
    var occurrences = 0;
    var bestVisible = null;
    var hidden = nullObj();

    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      /* Max, not sum: one mention that matches both "ux" and "user
       * experience" is one mention. */
      var n = 0;
      for (var k = 0; k < keys.length; k++) {
        var c = countKey(f.norm, keys[k]);
        if (c > n) n = c;
      }
      if (!n) continue;
      occurrences += n;
      if (!f.blockers.length) {
        if (!bestVisible || f.strength > bestVisible.strength) bestVisible = f;
      } else {
        var prior = hidden[f.path];
        hidden[f.path] = { field: f, count: (prior ? prior.count : 0) + n };
      }
    }

    if (bestVisible) {
      return {
        term: term.term, found: true, status: 'present',
        near: bestVisible.strength < STRENGTH.STRONG,
        occurrences: occurrences, where: bestVisible.path
      };
    }

    var paths = Object.keys(hidden);
    if (paths.length) {
      var best = hidden[paths[0]];
      for (var p = 1; p < paths.length; p++) {
        if (hidden[paths[p]].field.strength > best.field.strength) best = hidden[paths[p]];
      }
      return {
        term: term.term, found: true, status: 'hidden',
        near: best.field.strength < STRENGTH.STRONG,
        occurrences: occurrences, where: best.field.path, blockers: best.field.blockers
      };
    }

    return { term: term.term, found: false, status: 'missing', near: false, occurrences: 0 };
  }

  /* ------------------------------------------------------------ acronym gaps */

  function titleish(s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  function resolveForms(low) {
    var acr = null, expansion = null;
    if (ACR_INDEX[low]) {
      if (isAcronymish(low) && ACR_INDEX[low] !== low) {
        acr = ACR_INDEX[low];
        expansion = expansionFor(acr);
      } else if (isAcronymish(low)) {
        acr = low;
        expansion = expansionFor(acr);
      } else {
        expansion = low;
        acr = ACR_INDEX[low];
      }
    }
    if (!acr || !expansion || acr === expansion) return null;
    return { acr: acr, expansion: expansion, acrKey: stemSeq(acr), expKey: stemSeq(expansion) };
  }

  /* Insert the missing form right after the first mention. HTML-bearing fields
   * are skipped: an offset into the stripped text does not map back onto the
   * raw string, and guessing would corrupt the markup. */
  function injectAfter(field, needle, addition) {
    if (/[<&]/.test(field.raw)) return null;
    var at = field.text.toLowerCase().indexOf(needle.toLowerCase());
    if (at === -1) return null;
    var end = at + needle.length;
    return field.raw.slice(0, end) + ' ' + addition + field.raw.slice(end);
  }

  function findGaps(terms, fields, jdNorm) {
    var gaps = [];
    var seen = nullObj();

    for (var i = 0; i < terms.length; i++) {
      var forms = resolveForms(terms[i].term.toLowerCase());
      if (!forms) continue;

      var jdHasAcr = hasKey(jdNorm, forms.acrKey);
      var jdHasExp = hasKey(jdNorm, forms.expKey);
      if (!jdHasAcr && !jdHasExp) continue;

      var resumeAcr = null, resumeExp = null;
      for (var f = 0; f < fields.length; f++) {
        if (!resumeAcr && hasKey(fields[f].norm, forms.acrKey)) resumeAcr = fields[f];
        if (!resumeExp && hasKey(fields[f].norm, forms.expKey)) resumeExp = fields[f];
        if (resumeAcr && resumeExp) break;
      }
      if (!!resumeAcr === !!resumeExp) continue;

      var id = forms.acr + '|' + (jdHasAcr ? 'acr' : 'exp');
      if (seen[id]) continue;
      seen[id] = true;

      var target = resumeExp || resumeAcr;
      var gap = {
        acronym: forms.acr,
        expansion: forms.expansion,
        jdForm: jdHasAcr ? 'acronym' : 'expansion',
        resumeForm: resumeAcr ? 'acronym' : 'expansion',
        where: target.path,
        blocked: target.blockers.length > 0
      };

      if (jdHasAcr) {
        /* The posting searches the short form. Spell it out, then abbreviate. */
        gap.insert = '(' + forms.acr.toUpperCase() + ')';
        gap.emit = titleish(forms.expansion) + ' ' + gap.insert;
      } else {
        gap.insert = '(' + titleish(forms.expansion) + ')';
        gap.emit = forms.acr.toUpperCase() + ' ' + gap.insert;
      }
      gap.reason = jdHasAcr
        ? 'The posting looks for ' + forms.acr.toUpperCase() + '. Give the full name once, then abbreviate.'
        : 'The posting spells out "' + titleish(forms.expansion) + '". Lead with the abbreviation.';

      var patched = injectAfter(target, resumeExp ? forms.expansion : forms.acr, gap.insert);
      if (patched != null) {
        gap.action = { kind: 'annotate', path: target.path, value: patched, needsWriting: false };
      }
      gaps.push(gap);
    }
    return gaps;
  }

  /* --------------------------------------------------------- entry targeting */

  function pickTarget(resume, term) {
    var category = term.category;
    var stems = term.stems || [term.key];

    if (category === 'degree') {
      var edu = rows(resume.education);
      for (var e = 0; e < edu.length; e++) {
        if (edu[e].visible !== false) {
          return { entryType: 'education', entryId: edu[e].id, index: e, path: 'education.' + e + '.studyType', confidence: 'high', reason: 'Degrees belong under Education.' };
        }
      }
      if (edu.length) return { entryType: 'education', entryId: edu[0].id, index: 0, path: 'education.0.studyType', confidence: 'medium', reason: 'Degrees belong under Education.' };
      return { sectionType: 'education', confidence: 'low', reason: 'Add an Education section, then name the degree there.' };
    }

    if (category === 'cert') {
      var certs = rows(resume.certifications);
      for (var c = 0; c < certs.length; c++) {
        if (certs[c].visible !== false) {
          return { entryType: 'certifications', entryId: certs[c].id, index: c, path: 'certifications.' + c + '.name', confidence: 'high', reason: 'Credentials belong under Certifications.' };
        }
      }
      if (certs.length) return { entryType: 'certifications', entryId: certs[0].id, index: 0, path: 'certifications.0.name', confidence: 'medium', reason: 'Credentials belong under Certifications.' };
      return { sectionType: 'certifications', confidence: 'low', reason: 'Add a Certifications section and list the credential there.' };
    }

    var skills = rows(resume.skills);
    var best = -1, bestScore = 0;
    for (var s = 0; s < skills.length; s++) {
      if (skills[s].visible === false) continue;
      var pool = stemSeq(plain(skills[s].label) + ' ' + list(skills[s].keywords).map(plain).join(' '));
      var score = 0;
      for (var t = 0; t < stems.length; t++) {
        if (stems[t].length < 3) continue;
        if (hasKey(pool, stems[t])) score++;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best !== -1) {
      return {
        entryType: 'skills', entryId: skills[best].id, index: best, path: 'skills.' + best + '.keywords',
        confidence: bestScore > 1 ? 'high' : 'medium',
        reason: 'It sits next to ' + (plain(skills[best].label) ? '"' + plain(skills[best].label) + '"' : 'related skills') + '.'
      };
    }
    for (var w = 0; w < skills.length; w++) {
      if (skills[w].visible === false) continue;
      if (best === -1 || list(skills[w].keywords).length > list(skills[best].keywords).length) best = w;
    }
    if (best !== -1) {
      return {
        entryType: 'skills', entryId: skills[best].id, index: best, path: 'skills.' + best + '.keywords',
        confidence: 'low', reason: 'Nothing in your resume groups with it. Your broadest skills group is the safest home.'
      };
    }

    var exp = rows(resume.experience);
    for (var x = 0; x < exp.length; x++) {
      if (exp[x].visible === false) continue;
      var roles = list(exp[x].roles);
      for (var q = roles.length - 1; q >= 0; q--) {
        if (roles[q].visible === false) continue;
        return {
          entryType: 'experience', entryId: exp[x].id, roleId: roles[q].id, index: x, roleIndex: q,
          path: 'experience.' + x + '.roles.' + q + '.skills',
          confidence: 'medium', reason: 'No skills section yet. This role already tracks its own stack.'
        };
      }
    }
    return { sectionType: 'skills', confidence: 'low', reason: 'Add a Skills section and group it with related tools.' };
  }

  /* -------------------------------------------------------------- suggestions */

  function buildSuggestions(resume, terms, classified, gaps) {
    var out = [];
    var seen = nullObj();

    function push(s) {
      var id = s.kind + '|' + (s.term || '') + '|' + (s.action ? (s.action.path || s.action.sectionType || '') : '');
      if (seen[id]) return;
      seen[id] = true;
      out.push(s);
    }

    for (var i = 0; i < classified.length; i++) {
      var c = classified[i];
      var term = terms[i];

      if (c.status === 'hidden') {
        var addSection = null;
        var flags = [];
        for (var b = 0; b < c.blockers.length; b++) {
          if (c.blockers[b].kind === 'add-section') addSection = c.blockers[b].sectionType;
          else flags.push(c.blockers[b]);
        }
        if (addSection) {
          push({
            kind: 'reveal', term: c.term, severity: 'high',
            title: 'Your ' + addSection + ' section is switched off',
            detail: '"' + c.term + '" is written in ' + c.where + ', but its section never renders, so a reader never sees it.',
            action: { kind: 'add-section', sectionType: addSection, needsWriting: false },
            path: c.where, entryType: addSection
          });
        } else {
          push({
            kind: 'reveal', term: c.term, severity: 'high',
            title: '"' + c.term + '" is on the page source but hidden',
            detail: 'It is written in ' + c.where + ', and something in that chain is switched off.',
            action: { kind: 'reveal', steps: flags.map(function (f) { return { path: f.path, value: f.value }; }), needsWriting: false },
            path: c.where, entryType: c.blockers.length ? null : term.entryType
          });
        }
      } else if (c.status === 'present' && c.near) {
        var tgt = pickTarget(resume, term);
        if (tgt.path) {
          push({
            kind: 'strengthen', term: c.term, severity: 'medium',
            title: '"' + c.term + '" only shows up in passing',
            detail: 'It appears in ' + c.where + ', which reads as context rather than a claim. Say it again where skills are listed.',
            action: { kind: 'add-keyword', path: tgt.path, value: c.term, needsWriting: false },
            entryType: tgt.entryType, entryId: tgt.entryId, path: c.where
          });
        }
      } else if (c.status === 'missing') {
        var target = pickTarget(resume, term);
        if (target.sectionType) {
          push({
            kind: 'add-section', term: c.term, severity: term.cued ? 'high' : 'medium',
            title: 'Add a ' + target.sectionType + ' section for "' + c.term + '"',
            detail: target.reason,
            action: { kind: 'add-section', sectionType: target.sectionType, needsWriting: false },
            entryType: target.sectionType
          });
        } else {
          push({
            kind: 'add-term', term: c.term, severity: term.cued ? 'high' : 'medium',
            title: 'The posting asks for "' + c.term + '", your resume never says it',
            detail: target.reason + ' Only add it if it is true. This one is yours to write.',
            action: { kind: 'add-keyword', path: target.path, value: c.term, needsWriting: true },
            entryType: target.entryType, entryId: target.entryId, path: target.path, confidence: target.confidence
          });
        }
      }
    }

    for (var g = 0; g < gaps.length; g++) {
      var gap = gaps[g];
      push({
        kind: 'acronym', term: gap.acronym, severity: 'medium',
        title: 'Write both forms of ' + gap.acronym.toUpperCase(),
        detail: gap.reason + ' Recommended: ' + gap.emit + '.',
        action: gap.action || null,
        path: gap.where
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ scoring */

  function creditOf(c) {
    if (c.status === 'present') return c.near ? CREDIT.near : CREDIT.present;
    if (c.status === 'hidden') return CREDIT.hidden;
    return CREDIT.missing;
  }

  function scoreOf(classified, terms) {
    var total = 0, earned = 0;
    for (var i = 0; i < classified.length; i++) {
      /* A term named under "requirements you must have" counts double. */
      var weight = terms[i].score * (terms[i].cued ? 1.5 : 1);
      total += weight;
      earned += weight * creditOf(classified[i]);
    }
    if (total <= 0) return 0;
    var pct = Math.round(100 * earned / total);
    var u = U();
    return u ? u.clamp(pct, 0, 100) : Math.max(0, Math.min(100, pct));
  }

  function emptyResult() {
    return { match: 0, required: [], missing: [], present: [], acronymGaps: [], suggestions: [] };
  }

  function notice(kind, title, detail) {
    var r = emptyResult();
    r.suggestions.push({ kind: kind, severity: 'info', title: title, detail: detail, action: null });
    return r;
  }

  /* -------------------------------------------------------------------- match */

  function match(resume, jdText) {
    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return emptyResult();
    if (typeof jdText !== 'string' || !jdText.trim()) {
      return notice('no-jd', 'Paste a job description to start',
        'The matcher reads the posting, ranks what it asks for, and tells you which of it your resume already answers.');
    }

    var m = MODEL();
    /* isBlankResume reads basics fields as strings, so a resume carrying a
     * number in basics.name — a hand-edited JSON import will do it — throws
     * here and takes the tab with it. The other analysis modules already treat
     * an unreadable field as an empty one. */
    var blank = false;
    if (m && typeof m.isBlankResume === 'function') {
      try { blank = m.isBlankResume(resume); } catch (e) { blank = false; }
    }
    if (blank) {
      return notice('blank-resume', 'This resume is still empty',
        'Fill in a name and one role first. An empty resume matches nothing, and the advice would be noise.');
    }

    var terms = extractTerms(jdText);
    if (!terms.length) {
      return notice('no-keywords', 'Nothing recognisable in that description',
        'Paste the full posting, including the requirements list.');
    }

    var fields = buildIndex(resume);
    var classified = terms.map(function (t) { return classifyTerm(t, fields); });
    /* The same slice extractTerms() read. Passing the whole posting here meant
     * tokenising megabytes of page furniture to answer questions about the
     * first 24,000 characters. */
    var gaps = findGaps(terms, fields, stemSeq(jdText.slice(0, MAX_JD_CHARS)));

    var result = {
      match: scoreOf(classified, terms),
      required: classified,
      /* `present` is what the page already shows. `missing` is what the page
       * does not show, which includes terms hidden behind a flag. */
      present: classified.filter(function (c) { return c.status === 'present'; }),
      missing: classified.filter(function (c) { return c.status !== 'present'; }),
      acronymGaps: gaps,
      suggestions: buildSuggestions(resume, terms, classified, gaps)
    };
    return result;
  }

  /* ------------------------------------------------------------- the fixers
   * Only fixes that cannot put a false claim on the page run here. Anything
   * that needs the user to write something returns false on purpose. */

  function applySuggestion(suggestion) {
    var store = STORE();
    var model = MODEL();
    var bus = R().bus;
    var action = suggestion && suggestion.action;
    if (!store || !model || !action) return false;
    if (action.needsWriting) return false;

    var done = false;
    store.update(function (draft) {
      if (action.kind === 'reveal') {
        var steps = action.steps || [];
        for (var i = 0; i < steps.length; i++) model.setPath(draft, steps[i].path, steps[i].value);
        done = true;
      } else if (action.kind === 'add-section') {
        if (typeof model.addSection !== 'function') return false;
        model.addSection(draft, action.sectionType);
        done = true;
      } else if (action.kind === 'add-keyword') {
        var current = model.getPath(draft, action.path);
        if (!Array.isArray(current)) return false;
        var already = current.some(function (x) { return String(x).toLowerCase() === String(action.value).toLowerCase(); });
        if (already) return false;
        current.push(action.value);
        done = true;
      } else if (action.kind === 'annotate') {
        model.setPath(draft, action.path, action.value);
        done = true;
      } else {
        return false;
      }
    }, { source: 'field', coalesce: false });

    if (!done) return false;

    if (bus && typeof bus.emit === 'function' && suggestion.entryType) {
      bus.emit('selection', {
        path: action.path || null,
        entryType: suggestion.entryType,
        entryId: suggestion.entryId || null,
        roleId: null
      });
      bus.emit('section:focus', { sectionId: null, type: suggestion.entryType });
    }
    return true;
  }

  R().jdmatch = {
    match: match,
    keywords: extractTerms,
    applySuggestion: applySuggestion,
    version: 1
  };

  /* The Check panel resolves every analysis module through RB.analysis
   * (assets/js/ui/analysis-panel.js). Without this the Job match tab reports
   * the module as missing as soon as a posting is pasted. */
  var RB = R();
  RB.analysis = RB.analysis || {};
  RB.analysis.jdMatch = match;
})(window);
