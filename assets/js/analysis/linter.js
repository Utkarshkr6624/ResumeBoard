/* Resumeboard — writing linter
 * Deterministic and offline: every finding comes from a fixed rule set over
 * the plain text of the resume. No AI, no network, no model inference.
 *
 * Public surface (see RB.linter at the bottom of this file):
 *   run(resume)                    -> findings[]  (synchronous, pure)
 *   schedule(source, cb, opts)     -> cancel()    (debounced + requestIdle)
 *   verbs(), verbGroups()          -> action-verb taxonomy for a picker
 *   RULES, summarize(findings)
 *
 * A finding is {id, severity, path, section, title, message, evidence, fix?}
 * where fix is {label, apply(draft)}. apply() mutates the draft it is handed;
 * the store owns persisting it. It never writes anywhere itself.
 */
(function (global) {
  'use strict';

  var RB = global.RB = global.RB || {};
  var U = RB.utils || null;
  var M = RB.model || null;

  /* ------------------------------------------------------------------ *
   * Action-verb taxonomy
   *
   * Buzzwords are deliberately absent: "leverage", "utilize" and "facilitate"
   * read as filler, so offering them in a verb picker would fight our own
   * rules. Base forms only; run() matches every inflection via stem rules.
   * ------------------------------------------------------------------ */
  var VERB_GROUPS = [
    { group: 'Leadership', verbs: [
      'lead', 'manage', 'direct', 'oversee', 'supervise', 'coordinate', 'head', 'chair',
      'steer', 'orchestrate', 'govern', 'command', 'delegate', 'authorize', 'prioritize',
      'align', 'mobilize', 'champion', 'sponsor', 'escalate', 'empower', 'counsel', 'advise',
      'consult', 'mentor', 'coach', 'nurture', 'appraise', 'evaluate', 'supervise', 'direct'
    ] },
    { group: 'Build & ship', verbs: [
      'build', 'develop', 'construct', 'create', 'make', 'assemble', 'produce', 'generate',
      'design', 'architect', 'engineer', 'program', 'code', 'implement', 'deploy', 'release',
      'ship', 'launch', 'integrate', 'migrate', 'port', 'refactor', 'rewrite', 'redesign',
      'optimize', 'accelerate', 'automate', 'script', 'configure', 'provision', 'install',
      'upgrade', 'patch', 'harden', 'instrument', 'containerize', 'compile', 'package',
      'stand up', 'spin up', 'sunset', 'deprecate', 'backfill', 'ingest', 'transform',
      'index', 'cache', 'batch', 'stream', 'synchronize', 'reconcile', 'wire', 'stitch',
      'prototype', 'render', 'compile', 'glue', 'ship', 'operate', 'maintain', 'support'
    ] },
    { group: 'Analysis & research', verbs: [
      'analyze', 'assess', 'evaluate', 'research', 'investigate', 'examine', 'explore',
      'test', 'measure', 'quantify', 'track', 'monitor', 'benchmark', 'audit', 'survey',
      'query', 'model', 'forecast', 'predict', 'identify', 'discover', 'compare', 'contrast',
      'diagnose', 'troubleshoot', 'review', 'synthesize', 'distill', 'interpret', 'validate',
      'verify', 'map', 'segment', 'score', 'rank', 'visualize', 'interview', 'observe',
      'formulate', 'calculate', 'derive', 'compile', 'tabulate', 'spot', 'isolate'
    ] },
    { group: 'Communication', verbs: [
      'write', 'edit', 'proofread', 'revise', 'translate', 'present', 'brief', 'communicate',
      'negotiate', 'persuade', 'advocate', 'moderate', 'summarize', 'document', 'publish',
      'speak', 'explain', 'teach', 'demonstrate', 'answer', 'respond', 'clarify', 'articulate',
      'report', 'present', 'narrate', 'script', 'pitch', 'announce', 'address', 'correspond'
    ] },
    { group: 'Delivery & operations', verbs: [
      'schedule', 'plan', 'execute', 'deliver', 'run', 'own', 'drive', 'streamline',
      'standardize', 'process', 'procure', 'vendor', 'logistics', 'inventory', 'quality',
      'comply', 'certify', 'prioritize', 'roadmap', 'scope', 'estimate', 'fulfill', 'mitigate',
      'triage', 'improve', 'transform', 'restructure', 'consolidate', 'rightsize', 'offload',
      'coordinate', 'broker', 'settle', 'close', 'sign', 'renew', 'onboard', 'handoff'
    ] },
    { group: 'Commercial', verbs: [
      'sell', 'close', 'acquire', 'retain', 'win', 'expand', 'upsell', 'convert', 'engage',
      'attract', 'capture', 'grow', 'promote', 'market', 'brand', 'position', 'differentiate',
      'prospect', 'outreach', 'network', 'partner', 'source', 'invoice', 'price', 'bill',
      'budget', 'revenue', 'monetize', 'contract', 'renew', 'quote', 'underwrite', 'resell'
    ] },
    { group: 'Customer & service', verbs: [
      'support', 'serve', 'welcome', 'guide', 'resolve', 'de-escalate', 'handle', 'retain',
      'advocate', 'delight', 'assist', 'accompany', 'counsel', 'answer', 'respond', 'listen',
      'check in', 'follow up', 'refer', 'reimburse', 'route', 'unblock', 'enable'
    ] },
    { group: 'Creative', verbs: [
      'illustrate', 'photograph', 'animate', 'compose', 'storyboard', 'curate', 'annotate',
      'typeset', 'sculpt', 'sketch', 'wireframe', 'mock up', 'polish', 'refine', 'iterate',
      'style', 'art direct', 'edit', 'retouch', 'grade', 'mix', 'master', 'choreograph'
    ] },
    { group: 'Finance & compliance', verbs: [
      'reconcile', 'allocate', 'appraise', 'invest', 'divest', 'refund', 'bill', 'expense',
      'subsidize', 'capitalize', 'depreciate', 'amortize', 'accrue', 'provision', 'collect',
      'settle', 'attest', 'notarize', 'redline', 'register', 'license', 'protect', 'safeguard',
      'file', 'litigate', 'arbitrate', 'mediate', 'certify', 'enforce', 'delegate'
    ] },
    { group: 'People & learning', verbs: [
      'teach', 'train', 'tutor', 'lecture', 'curriculum', 'grade', 'mentor', 'coach', 'hire',
      'recruit', 'retain', 'motivate', 'develop', 'assess', 'appraise', 'promote', 'rotate',
      'pair with', 'shadow', 'delegate', 'empower', 'onboard', 'offboard'
    ] }
  ];

  var VERB_LIST = [];
  (function buildVerbs() {
    var seen = Object.create(null);
    VERB_GROUPS.forEach(function (g) {
      g.verbs.forEach(function (v) {
        if (seen[v]) return;
        seen[v] = true;
        VERB_LIST.push(v);
      });
    });
  })();

  var VERB_SET = Object.create(null);
  VERB_LIST.forEach(function (v) { VERB_SET[v] = true; });

  function isVerbForm(word) {
    if (!word) return false;
    var w = word.toLowerCase();
    if (VERB_SET[w]) return true;
    /* Inflections: led, leading, leads, spearheaded-style compounds. Matching
     * the whole vocabulary against every suffix variant would be 3000 entries;
     * testing the candidate stems is cheaper and covers the same ground. */
    var stems = [];
    if (/ies$/.test(w)) stems.push(w.slice(0, -3) + 'y');
    if (/(ches|shes|sses|xes|zes)$/.test(w)) stems.push(w.slice(0, -2));
    if (/s$/.test(w)) stems.push(w.slice(0, -1));
    if (/ed$/.test(w)) stems.push(w.slice(0, -2), w.slice(0, -1));
    if (/ing$/.test(w)) stems.push(w.slice(0, -3), w.slice(0, -3) + 'e');
    for (var i = 0; i < stems.length; i++) {
      if (VERB_SET[stems[i]]) return true;
      if (/ed$/.test(stems[i]) && VERB_SET[stems[i].slice(0, -1)]) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Word lists
   * ------------------------------------------------------------------ */
  var BE_VERBS = { am: 1, is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1 };
  /* "was responsible", "was involved" — participles used as adjectives. Not
   * passive voice, so the passive rule must not fire on them. */
  var ADJ_PARTICIPLES = {
    responsible: 1, involved: 1, engaged: 1, experienced: 1, interested: 1, qualified: 1,
    committed: 1, dedicated: 1, aware: 1, able: 1, available: 1, open: 1, excited: 1,
    passionate: 1, known: 1, accustomed: 1, willing: 1, ready: 1, successful: 1,
    related: 1, based: 1, located: 1, situated: 1, concerned: 1, confident: 1,
    disappointed: 1, crowded: 1, detailed: 1, suitable: 1, suited: 1
  };
  var IRREGULAR_PARTICIPLES = {
    written: 1, spoken: 1, done: 1, made: 1, built: 1, held: 1, kept: 1, sent: 1,
    brought: 1, caught: 1, chosen: 1, driven: 1, eaten: 1, forgotten: 1, given: 1,
    known: 1, paid: 1, seen: 1, shown: 1, taken: 1, taught: 1, thought: 1, found: 1,
    bound: 1, cut: 1, hit: 1, hurt: 1, set: 1, put: 1, read: 1, run: 1, led: 1, won: 1
  };
  var ADVERB_BRIDGE = {
    also: 1, often: 1, always: 1, already: 1, then: 1, immediately: 1, automatically: 1,
    regularly: 1, consistently: 1, only: 1, just: 1, never: 1, widely: 1, routinely: 1,
    successfully: 1, previously: 1, largely: 1, partially: 1, fully: 1, properly: 1
  };
  var PAST_MARKERS = {
    was: 1, were: 1, had: 1, has: 1, have: 1, did: 1, could: 1, would: 1, should: 1,
    wrote: 1, won: 1, ran: 1, built: 1, made: 1, took: 1, gave: 1, led: 1, brought: 1,
    sold: 1, bought: 1, found: 1, kept: 1, held: 1, met: 1, sent: 1, spent: 1,
    taught: 1, thought: 1, felt: 1, got: 1, came: 1, saw: 1, grew: 1, drove: 1,
    cut: 1, set: 1, put: 1, read: 1, began: 1, became: 1, broke: 1, chose: 1,
    delivered: 1, designed: 1, built: 1, led: 1, launched: 1, shipped: 1, created: 1,
    developed: 1, improved: 1, increased: 1, reduced: 1, migrated: 1, established: 1,
    implemented: 1, managed: 1, coordinated: 1, achieved: 1, accomplished: 1,
    generated: 1, secured: 1, earned: 1, saved: 1, streamlined: 1, scaled: 1,
    orchestrated: 1, rebuilt: 1, mentored: 1, analyzed: 1, automated: 1, optimized: 1,
    refactored: 1, prototyped: 1, researched: 1, interviewed: 1, trained: 1, hired: 1,
    presented: 1, published: 1, defined: 1, introduced: 1, eliminated: 1, cut: 1,
    won: 1, built: 1, ran: 1, wrote: 1, drove: 1, brought: 1, sold: 1, grew: 1,
    turned: 1, converted: 1, standardized: 1, rebuilt: 1, revamped: 1, outsourced: 1
  };
  var PRONOUNS_BULLET = {
    i: 1, we: 1, me: 1, my: 1, our: 1, ours: 1, mine: 1, myself: 1, ourselves: 1,
    us: 1, "we've": 1, "i'm": 1, "i've": 1, "i'd": 1, "i'll": 1, "we're": 1, "we'd": 1, "we'll": 1
  };
  var PRONOUNS_FIRST = {
    i: 1, me: 1, my: 1, mine: 1, myself: 1, "i'm": 1, "i've": 1, "i'd": 1, "i'll": 1
  };
  var NUMBER_WORDS = {
    one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1,
    ten: 1, eleven: 1, twelve: 1, fifteen: 1, twenty: 1, thirty: 1, forty: 1, fifty: 1,
    sixty: 1, seventy: 1, eighty: 1, ninety: 1, hundred: 1, thousands: 1, thousand: 1,
    millions: 1, million: 1, billions: 1, billion: 1, dozen: 1, half: 1, halves: 1,
    double: 1, doubled: 1, triple: 1, tripled: 1, quarter: 1, quarters: 1
  };
  var VAGUE_QUANTIFIERS = [
    'a lot of', 'lots of', 'many', 'several', 'numerous', 'various', 'multiple',
    'countless', 'a number of', 'tons of', 'plenty of', 'a wide range of', 'range of',
    'significant number of', 'a few', 'some', 'most', 'all types of', 'all kinds of',
    'dozens of', 'hundreds of', 'lots', 'plenty'
  ];
  var BUZZWORDS = [
    { term: 'synergy', fix: 'collaborate' },
    { term: 'synergize', fix: 'collaborate' },
    { term: 'passionate', fix: null },
    { term: 'passion', fix: null },
    { term: 'results-driven', fix: null },
    { term: 'results driven', fix: null },
    { term: 'hard-working', fix: null },
    { term: 'hardworking', fix: null },
    { term: 'hard worker', fix: null },
    { term: 'dynamic', fix: null },
    { term: 'self-starter', fix: null },
    { term: 'self starter', fix: null },
    { term: 'team player', fix: null },
    { term: 'think outside the box', fix: null },
    { term: 'outside of the box', fix: null },
    { term: 'go-getter', fix: null },
    { term: 'go getter', fix: null },
    { term: 'detail-oriented', fix: null },
    { term: 'detail oriented', fix: null },
    { term: 'proactive', fix: null },
    { term: 'leverages', fix: 'use' },
    { term: 'leveraging', fix: 'using' },
    { term: 'leveraged', fix: 'used' },
    { term: 'leverage', fix: 'use' },
    { term: 'spearhead', fix: 'lead' },
    { term: 'spearheaded', fix: 'led' },
    { term: 'spearheading', fix: 'leading' },
    { term: 'world-class', fix: null },
    { term: 'world class', fix: null },
    { term: 'cutting-edge', fix: null },
    { term: 'cutting edge', fix: null },
    { term: 'best-in-class', fix: null },
    { term: 'best in class', fix: null },
    { term: 'utilize', fix: 'use' },
    { term: 'utilizes', fix: 'uses' },
    { term: 'utilized', fix: 'used' },
    { term: 'utilizing', fix: 'using' },
    { term: 'utilization', fix: 'use' },
    { term: 'facilitate', fix: 'run' },
    { term: 'facilitates', fix: 'runs' },
    { term: 'facilitated', fix: 'ran' },
    { term: 'facilitating', fix: 'running' }
  ];
  var WEAK_OPENERS = [
    { re: /^(helped?|assisted?)\s+(to\s+|with\s+)/i, why: '"Helped" and "assisted" hide how much of the work was yours.' },
    { re: /^(was\s+|were\s+)?(involved\s+in|involved\s+with)\b/i, why: '"Involved in" describes proximity, not contribution.' },
    { re: /^(worked?|working)\s+(on|with|alongside)\b/i, why: '"Worked on" is the weakest verb in a resume.' },
    { re: /^(tasked\s+with|charged\s+with)\b/i, why: 'Lead with what you did, not what you were given.' },
    { re: /^(participated\s+in|took\s+part\s+in)\b/i, why: 'Say what you contributed.' },
    { re: /^part\s+of\s+(a|an|the)\b/i, why: 'Membership is not contribution.' },
    { re: /^(duties|responsibilities|tasks)\s+(included|involved|were)\b/i, why: 'Name the work itself.' }
  ];
  var CONNECTING_OPENERS = ['and', 'but', 'so', 'then', 'also', 'plus', 'however', 'because', 'while', 'besides', 'meanwhile'];
  var RESPONSIBLE_RE = /^\s*(?:was\s+|were\s+)?responsible\s+for\s+/i;
  var VAGUE_RE = (function () {
    var esc = VAGUE_QUANTIFIERS.map(function (q) { return q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    return new RegExp('\\b(?:' + esc.join('|') + ')\\b', 'i');
  })();
  var BUZZWORD_RE = BUZZWORDS.map(function (bw) {
    return { term: bw.term, fix: bw.fix, re: new RegExp('\\b' + bw.term.replace(/-/g, '[- ]') + '\\b', 'i') };
  });
  /* Tokens that are legitimately lower-case at the start of a bullet. */
  var LOWERCASE_OK = /^(ios|macos|ui|ux|seo|hr|it|api|apis|sdk|aws|gcp|azure|sla|slas|crm|erp|roi|kpi|okrs|b2b|b2c|qa|rn|rns|e2e|ai|ml|llm|ip|ids|p\d+|q[1-4]|pm|mvp|nps|ctr|covid|devops|sre)\b/i;
  var TITLES = {
    'verb.action': 'Start with a strong action verb',
    'verb.weak-opener': 'Weak opener',
    'verb.past-tense': 'No past-tense verb',
    'pronoun.personal': 'Personal pronoun in a bullet',
    'pronoun.first-person': 'First person in prose',
    'voice.passive': 'Passive voice',
    'metric.missing': 'No number in this bullet',
    'metric.vague': 'Vague quantifier',
    'metric.none': 'No numbers anywhere',
    'buzzword': 'Buzzword or filler',
    'opener.responsible-for': '"Responsible for" opener',
    'length.short': 'Very short bullet',
    'length.long': 'Bullet too long',
    'length.summary': 'Summary length',
    'date.inconsistent': 'Mixed date formats',
    'date.present-mixed': '"Present" and "Current" mixed',
    'date.missing': 'Missing dates',
    'capital.missing': 'Bullet does not start with a capital',
    'punctuation.inconsistent': 'Mixed bullet punctuation',
    'duplicate.bullet': 'Duplicate bullet',
    'heading.length': 'Section heading length',
    'section.empty': 'Empty section',
    'vague.responsibilities': 'Vague framing',
    'adjectives.stacked': 'Stacked adjectives',
    'entry.incomplete': 'Incomplete entry',
    'skills.duplicate': 'Keyword repeated',
    'opener.repeated': 'Same opener in a row',
    'opener.conjunction': 'Bullet starts with a connector',
    'text.spacing': 'Stray whitespace',
    'summary.missing': 'No summary',
    'entry.duplicate': 'Duplicate entry'
  };

  var RULES = [
    { id: 'verb.action', severity: 'warn', hint: 'Open each bullet with a verb from the taxonomy: RB.linter.verbs().' },
    { id: 'verb.weak-opener', severity: 'warn', hint: '"Helped", "worked on" and "involved in" understate ownership.' },
    { id: 'verb.past-tense', severity: 'warn', hint: 'Completed work reads better in the past tense.' },
    { id: 'pronoun.personal', severity: 'error', hint: 'Resume bullets are written without pronouns.' },
    { id: 'pronoun.first-person', severity: 'warn', hint: 'Prose reads better in the third person.' },
    { id: 'voice.passive', severity: 'warn', hint: 'Name who did the work.' },
    { id: 'metric.missing', severity: 'warn', hint: 'Say how much changed, not just that it did.' },
    { id: 'metric.vague', severity: 'warn', hint: 'Replace "many" or "a range of" with a figure.' },
    { id: 'metric.none', severity: 'warn', hint: 'At least one number anchors the whole document.' },
    { id: 'buzzword', severity: 'warn', hint: 'Filler adjectives are not evidence.' },
    { id: 'opener.responsible-for', severity: 'error', hint: 'Replace the job description with a claim.' },
    { id: 'length.short', severity: 'tip', hint: 'Under 40 characters rarely carries an accomplishment.' },
    { id: 'length.long', severity: 'warn', hint: 'Over 220 characters wraps to three lines on the page.' },
    { id: 'length.summary', severity: 'tip', hint: 'A summary reads best at two to four lines.' },
    { id: 'date.inconsistent', severity: 'warn', hint: 'Pick one date format and use it everywhere.' },
    { id: 'date.present-mixed', severity: 'warn', hint: 'Use "Present" for an open end date.' },
    { id: 'date.missing', severity: 'warn', hint: 'An undated entry reads as an omission.' },
    { id: 'capital.missing', severity: 'tip', hint: 'Capitalize the first letter of every bullet.' },
    { id: 'punctuation.inconsistent', severity: 'warn', hint: 'Bullets either end in a period or they do not.' },
    { id: 'duplicate.bullet', severity: 'error', hint: 'The same achievement listed twice.' },
    { id: 'heading.length', severity: 'warn', hint: 'Headings are scanned, not read.' },
    { id: 'section.empty', severity: 'error', hint: 'A visible heading with nothing under it.' },
    { id: 'vague.responsibilities', severity: 'warn', hint: 'Replace "responsibilities included" with the work.' },
    { id: 'adjectives.stacked', severity: 'tip', hint: 'Three adjectives in a row read as filler.' },
    { id: 'entry.incomplete', severity: 'warn', hint: 'The name of the thing is missing.' },
    { id: 'skills.duplicate', severity: 'tip', hint: 'The same keyword in two groups adds nothing.' },
    { id: 'opener.repeated', severity: 'tip', hint: 'Vary the verbs so the list does not read as a chant.' },
    { id: 'opener.conjunction', severity: 'tip', hint: 'Bullets start with the verb, not with "and".' },
    { id: 'text.spacing', severity: 'tip', hint: 'Double spaces and trailing breaks survive into print.' },
    { id: 'summary.missing', severity: 'tip', hint: 'Three lines at the top set the frame for everything below.' },
    { id: 'entry.duplicate', severity: 'tip', hint: 'The same employer and role listed twice.' }
  ];

  var ADJECTIVES = {
    accomplished: 1, successful: 1, experienced: 1, seasoned: 1, veteran: 1,
    dedicated: 1, committed: 1, passionate: 1, driven: 1, motivated: 1,
    enthusiastic: 1, proactive: 1, innovative: 1, creative: 1, analytical: 1,
    proven: 1, solid: 1, robust: 1, scalable: 1, efficient: 1, effective: 1,
    reliable: 1, dependable: 1, trustworthy: 1, honest: 1, approachable: 1,
    personable: 1, professional: 1, collaborative: 1, cooperative: 1, functional: 1,
    technical: 1, strategic: 1, tactical: 1, operational: 1, organizational: 1,
    managerial: 1, executive: 1, senior: 1, junior: 1, principal: 1, distinguished: 1,
    excellent: 1, outstanding: 1, superior: 1, exceptional: 1, remarkable: 1,
    impressive: 1, notable: 1, significant: 1, substantial: 1, considerable: 1,
    extensive: 1, comprehensive: 1, thorough: 1, complete: 1, deep: 1, wide: 1,
    broad: 1, diverse: 1, complex: 1, dynamic: 1, fast: 1, rapid: 1, quick: 1,
    agile: 1, flexible: 1, versatile: 1, adaptable: 1, resilient: 1, resourceful: 1,
    ambitious: 1, visionary: 1, forward: 1, thinking: 1, quality: 1, high: 1,
    top: 1, key: 1, core: 1, critical: 1, vital: 1, central: 1, growing: 1,
    international: 1, local: 1, regional: 1, remote: 1, hybrid: 1, well: 1,
    highly: 1, very: 1, truly: 1, real: 1, time: 1, first: 1, last: 1, next: 1,
    best: 1, better: 1, good: 1, strong: 1, weak: 1, small: 1, large: 1, human: 1
  };
  var ADJ_BRIDGE = { and: 1, or: 1, but: 1, very: 1, highly: 1, truly: 1, really: 1, quite: 1, extremely: 1, most: 1, more: 1, less: 1 };

  var BULLET_TRIM = /^[\s•·▪◦‣⁃\-–—*+>»]+/;

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */
  function plain(v) {
    if (v == null) return '';
    var str;
    if (typeof v === 'string') str = v;
    else { try { str = String(v); } catch (e) { str = ''; } }
    var s = str;
    if (!/[<&]/.test(s)) return s;
    if (U && U.htmlToText) return U.htmlToText(s);
    return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  /* Model fields are user text, but a malformed import can leave a value that
   * String() itself refuses to coerce. An unreadable field is an empty field,
   * not a reason to lose every finding on the page. */
  function tidy(s) {
    var str;
    if (s == null) str = '';
    else if (typeof s === 'string') str = s;
    else { try { str = String(s); } catch (e) { str = ''; } }
    return str.replace(/\s+/g, ' ').trim();
  }

  function getPath(obj, path) {
    if (M && M.getPath) return M.getPath(obj, path);
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    if (M && M.setPath) { M.setPath(obj, path, value); return; }
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) cur[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function removeAtPath(draft, path) {
    var idx = String(path).lastIndexOf('.');
    if (idx === -1) return false;
    var parent = getPath(draft, path.slice(0, idx));
    var key = path.slice(idx + 1);
    if (!Array.isArray(parent)) return false;
    var i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
    parent.splice(i, 1);
    return true;
  }

  function tokens(text) {
    var re = /[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’]*/g;
    var out = [];
    var m;
    while ((m = re.exec(text)) !== null) {
      out.push({ raw: m[0], low: m[0].toLowerCase() });
    }
    return out;
  }

  function firstWord(text) {
    var t = tidy(text).replace(BULLET_TRIM, '');
    var m = /^[^A-Za-z0-9]+([A-Za-z0-9'’\-]+)/.exec(t);
    return m ? m[1] : '';
  }

  function hasNumber(text) {
    if (/[0-9]/.test(text)) return true;
    if (/[%x×$€£]/.test(text)) return true;
    var t = tokens(text);
    for (var i = 0; i < t.length; i++) {
      if (NUMBER_WORDS[t[i].low]) return true;
      if (/^[0-9]/.test(t[i].raw)) return true;
    }
    return false;
  }

  function clampText(s, n) {
    s = tidy(s);
    return s.length <= n ? s : s.slice(0, n - 1).trim() + '…';
  }

  /* ------------------------------------------------------------------ *
   * Passive voice / past tense
   * ------------------------------------------------------------------ */
  function isParticiple(low) {
    if (ADJ_PARTICIPLES[low]) return false;
    if (IRREGULAR_PARTICIPLES[low]) return true;
    if (low.length < 5) return false;
    if (!/ed$/.test(low)) return false;
    if (/(eed|ied)$/.test(low)) return true;
    var stem = low.slice(0, -1);           /* "worked" -> "worke" */
    if (verbBase(stem)) return true;
    return !/[aeiou]ed$/.test(low);          /* "targeted", "analysed" */
  }

  function verbBase(w) {
    if (isVerbForm(w)) return true;
    if (/ies$/.test(w)) return isVerbForm(w.slice(0, -3) + 'y');
    if (/(ches|shes|sses|xes|zes)$/.test(w)) return isVerbForm(w.slice(0, -2));
    if (/s$/.test(w)) return isVerbForm(w.slice(0, -1));
    return false;
  }

  function findPassive(text) {
    var t = tokens(text);
    for (var i = 0; i < t.length; i++) {
      if (!BE_VERBS[t[i].low]) continue;
      for (var j = i + 1; j <= Math.min(i + 3, t.length - 1); j++) {
        var w = t[j].low;
        if (ADJ_PARTICIPLES[w]) return null;                 /* "was responsible" */
        if (isParticiple(w)) return t[j].raw;
        if (!ADVERB_BRIDGE[w]) return null;                  /* a real verb ends it */
      }
    }
    return null;
  }

  function hasPastTense(text) {
    var t = tokens(text);
    for (var i = 0; i < t.length; i++) {
      var w = t[i].low;
      if (PAST_MARKERS[w]) return true;
      if (t[i].raw === t[i].raw.toUpperCase() && t[i].raw.length > 1) return true; /* acronym: KPI, AWS */
      if (/ed$/.test(w) && w.length > 4) {
        var stem = w.slice(0, -1);
        if (PAST_MARKERS[stem] || isVerbForm(stem) || isVerbForm(w)) return true;
      }
    }
    return false;
  }

  function findStackedAdjectives(text) {
    var t = tokens(text);
    var run = [];
    var i = 0;
    while (i < t.length) {
      var w = t[i].low;
      if (ADJECTIVES[w] && w !== 'lead' && w !== 'on' && w !== 'self' && w !== 'high' && w !== 'low') {
        run.push(t[i]);
        i++;
        continue;
      }
      if (ADJ_BRIDGE[w] && run.length) { i++; continue; }
      if (run.length >= 3) {
        return run.map(function (x) { return x.raw; }).join(' ');
      }
      run = [];
      i++;
    }
    if (run.length >= 3) return run.map(function (x) { return x.raw; }).join(' ');
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */
  function dateFormat(v) {
    var s = tidy(v);
    if (!s) return null;
    if (presentWord(s)) return 'present';
    if (/^\d{4}$/.test(s)) return 'YYYY';
    if (/^\d{4}[-/.]\d{1,2}$/.test(s)) return 'YYYY-MM';
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return 'YYYY-MM-DD';
    if (/^\d{1,2}[-/.]\d{4}$/.test(s)) return 'MM/YYYY';
    if (/^[A-Za-z]{3,9}[\s.\-/]\d{4}$/.test(s)) {
      var m = /^([A-Za-z]{3,9})/.exec(s);
      return m[1].length <= 3 ? 'MMM YYYY' : 'MMMM YYYY';
    }
    if (/^\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}$/.test(s)) return 'D MMM YYYY';
    if (/\d{4}/.test(s)) return 'free';
    return null;
  }

  /* "Present", "Current", "to present", "Now" — whatever spelling, the open
   * end of a date range. Substring matching because users type "to present"
   * and "presently" should not be classified as a date at all. */
  function presentWord(v) {
    var s = tidy(v);
    if (!s) return null;
    var low = s.toLowerCase();
    if (/\d/.test(low)) return null;
    if (/present/.test(low)) return 'present';
    if (/current/.test(low)) return 'current';
    var stripped = low.replace(/[^a-z]/g, '');
    if (stripped === 'now' || stripped === 'today' || stripped === 'ongoing') return stripped;
    return null;
  }

  var META_FORMAT_MAP = {
    'YYYY': 'YYYY', 'YY': 'YYYY', 'YYYY-MM': 'YYYY-MM', 'MM/YYYY': 'MM/YYYY',
    'MM.YYYY': 'MM/YYYY', 'MMM YYYY': 'MMM YYYY', 'MMMM YYYY': 'MMMM YYYY',
    'MMM YY': 'MMM YYYY', 'D MMM YYYY': 'D MMM YYYY', 'YYYY-MM-DD': 'YYYY-MM-DD'
  };

  /* ------------------------------------------------------------------ *
   * Collection — flatten the resume into addressable text nodes
   * ------------------------------------------------------------------ */
  function collect(resume) {
    var ctx = {
      resume: resume,
      bullets: [],
      prose: [],
      dates: [],
      sections: [],
      sectionByType: {},
      textNodes: []
    };

    (Array.isArray(resume.sections) ? resume.sections : []).forEach(function (sec, i) {
      if (!sec || typeof sec !== 'object') return;
      var info = {
        id: sec.id, type: sec.type, label: tidy(sec.label) || (M ? M.typeMeta(sec.type).label : sec.type),
        visible: sec.visible !== false, path: 'sections.' + i, index: i
      };
      ctx.sections.push(info);
      if (info.type && !ctx.sectionByType[info.type]) ctx.sectionByType[info.type] = info;
    });

    function sectionInfo(type) {
      var s = ctx.sectionByType[type];
      if (s) return s;
      return { type: type, label: M ? M.typeMeta(type).label : type, path: '', visible: true, synthetic: true };
    }

    function pushBullet(path, text, type, label) {
      var raw = plain(text);
      if (!tidy(raw)) return;
      ctx.bullets.push({ path: path, text: raw, clean: tidy(raw), type: type, label: label || '', section: sectionInfo(type) });
      ctx.textNodes.push(ctx.bullets[ctx.bullets.length - 1]);
    }

    function pushProse(path, text, type, label) {
      var raw = plain(text);
      if (!tidy(raw)) return;
      ctx.prose.push({ path: path, text: raw, clean: tidy(raw), type: type, label: label || '', section: sectionInfo(type) });
      ctx.textNodes.push(ctx.prose[ctx.prose.length - 1]);
    }

    function pushDate(path, value, type, kind) {
      var s = tidy(value);
      if (!s) return;
      ctx.dates.push({ path: path, value: s, type: type, kind: kind, section: sectionInfo(type) });
    }

    var b = resume.basics || {};
    pushProse('basics.summary', b.summary, 'summary', 'Summary');

    (Array.isArray(resume.experience) ? resume.experience : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var ep = 'experience.' + i;
      var label = tidy(e.company) || 'Role';
      (Array.isArray(e.roles) ? e.roles : []).forEach(function (r, j) {
        if (!r || typeof r !== 'object') return;
        var rp = ep + '.roles.' + j;
        pushProse(rp + '.summary', r.summary, 'experience', label);
        (Array.isArray(r.highlights) ? r.highlights : []).forEach(function (h, k) {
          pushBullet(rp + '.highlights.' + k, h, 'experience', label);
        });
        pushDate(rp + '.start', r.start, 'experience', 'start');
        pushDate(rp + '.end', r.end, 'experience', 'end');
      });
    });

    (Array.isArray(resume.projects) ? resume.projects : []).forEach(function (p, i) {
      if (!p || typeof p !== 'object') return;
      var pp = 'projects.' + i;
      var label = tidy(p.name) || 'Project';
      pushProse(pp + '.summary', p.summary, 'projects', label);
      (Array.isArray(p.highlights) ? p.highlights : []).forEach(function (h, k) {
        pushBullet(pp + '.highlights.' + k, h, 'projects', label);
      });
      pushDate(pp + '.start', p.start, 'projects', 'start');
      pushDate(pp + '.end', p.end, 'projects', 'end');
    });

    (Array.isArray(resume.volunteer) ? resume.volunteer : []).forEach(function (v, i) {
      if (!v || typeof v !== 'object') return;
      var vp = 'volunteer.' + i;
      var label = tidy(v.organization) || tidy(v.role) || 'Volunteering';
      (Array.isArray(v.highlights) ? v.highlights : []).forEach(function (h, k) {
        pushBullet(vp + '.highlights.' + k, h, 'volunteer', label);
      });
      pushDate(vp + '.start', v.start, 'volunteer', 'start');
      pushDate(vp + '.end', v.end, 'volunteer', 'end');
    });

    (Array.isArray(resume.presentations) ? resume.presentations : []).forEach(function (p, i) {
      if (!p || typeof p !== 'object') return;
      var pp = 'presentations.' + i;
      (Array.isArray(p.highlights) ? p.highlights : []).forEach(function (h, k) {
        pushBullet(pp + '.highlights.' + k, h, 'presentations', tidy(p.title) || 'Presentation');
      });
      pushDate(pp + '.date', p.date, 'presentations', 'date');
    });

    (Array.isArray(resume.education) ? resume.education : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var ep = 'education.' + i;
      pushDate(ep + '.start', e.start, 'education', 'start');
      pushDate(ep + '.end', e.end, 'education', 'end');
    });

    ['certifications', 'publications', 'awards', 'coursework'].forEach(function (type) {
      (Array.isArray(resume[type]) ? resume[type] : []).forEach(function (e, i) {
        if (!e || typeof e !== 'object') return;
        pushDate(type + '.' + i + '.date', e.date, type, 'date');
      });
    });

    (Array.isArray(resume.custom) ? resume.custom : []).forEach(function (c, i) {
      if (!c || typeof c !== 'object') return;
      (Array.isArray(c.entries) ? c.entries : []).forEach(function (x, j) {
        if (!x || typeof x !== 'object') return;
        pushProse('custom.' + i + '.entries.' + j + '.text', x.text, 'custom', tidy(c.label) || 'Custom');
        pushDate('custom.' + i + '.entries.' + j + '.start', x.start, 'custom', 'start');
        pushDate('custom.' + i + '.entries.' + j + '.end', x.end, 'custom', 'end');
      });
    });

    return ctx;
  }

  /* ------------------------------------------------------------------ *
   * Rules
   * ------------------------------------------------------------------ */
  function finding(id, severity, path, section, message, evidence, fix) {
    return {
      id: id,
      severity: severity,
      path: path || '',
      section: section || '',
      title: TITLES[id] || id,
      message: message,
      evidence: evidence == null ? '' : clampText(evidence, 140),
      fix: fix || null
    };
  }

  var SEVERITY_RANK = { error: 0, warn: 1, tip: 2 };

  function run(resume) {
    if (!resume || typeof resume !== 'object') return [];
    /* A brand-new resume has every heading and nothing under it. Reporting
     * that as four errors is noise, not feedback. isBlankResume assumes basics
     * fields are strings, so a resume carrying a non-string name (a malformed
     * import) would throw here and lose every other finding with it. */
    if (M && typeof M.isBlankResume === 'function') {
      var blank = false;
      try { blank = M.isBlankResume(resume); } catch (e) { blank = false; }
      if (blank) return [];
    }
    var ctx = collect(resume);
    var out = [];
    var i, node;

    sectionRules(ctx, out);
    completenessRules(ctx, resume, out);
    duplicateBulletRule(ctx, out);
    skillsDuplicateRule(ctx, out);

    for (i = 0; i < ctx.bullets.length; i++) {
      node = ctx.bullets[i];
      textNodeRules(node, 'bullet', out);
      lengthRules(node, out);
      metricRules(node, out);
      openerRules(node, out);
    }

    for (i = 0; i < ctx.prose.length; i++) {
      node = ctx.prose[i];
      textNodeRules(node, 'prose', out);
      firstPersonRule(node, out);
      if (node.path !== 'basics.summary') continue;
      var len = node.clean.length;
      if (len < 200) {
        out.push(finding('length.summary', 'tip', node.path, node.section.label,
          'A summary under 200 characters rarely says what you are known for.', node.clean));
      } else if (len > 1000) {
        out.push(finding('length.summary', 'warn', node.path, node.section.label,
          'This summary runs ' + len + ' characters. Recruiters stop reading around the fourth line.',
          node.clean));
      }
    }

    if (!tidy(plain((resume.basics || {}).summary)) && hasContent(resume.experience)) {
      out.push(finding('summary.missing', 'tip', 'basics.summary', 'Summary',
        'You have experience but no summary. Three lines at the top set the frame for everything below.', ''));
    }

    punctuationRule(ctx, out);
    repeatedOpenerRule(ctx, out);
    dateRules(ctx, resume, out);
    documentMetricRule(ctx, out);

    out.sort(function (a, b) {
      var d = (SEVERITY_RANK[a.severity] || 9) - (SEVERITY_RANK[b.severity] || 9);
      if (d) return d;
      if (a.section !== b.section) return a.section < b.section ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return out;
  }

  function hasContent(list) {
    if (!Array.isArray(list)) return false;
    return list.some(function (e) {
      if (!e || e.visible === false) return false;
      return M ? !M.isBlankEntry(e) : true;
    });
  }

  /* --- structure --- */
  function sectionRules(ctx, out) {
    ctx.sections.forEach(function (sec) {
      if (!sec.visible) return;
      var filled = sec.type === 'summary'
        ? !!tidy(plain((ctx.resume.basics || {}).summary))
        : hasContent(ctx.resume[sec.type]);
      if (!filled) {
        out.push(finding('section.empty', 'error', sec.path, sec.label,
          '“' + sec.label + '” has a heading and nothing under it. Add content or hide the section.', ''));
      }

      var label = tidy(sec.label);
      if (!label) return;
      if (label.length > 40) {
        out.push(finding('heading.length', 'warn', sec.path + '.label', sec.label,
          'This heading is ' + label.length + ' characters. Headings are scanned, not read.', label));
      } else if (label.length < 3) {
        out.push(finding('heading.length', 'warn', sec.path + '.label', sec.label,
          'This heading is too short to identify the section.', label));
      }
    });
  }

  function completenessRules(ctx, resume, out) {
    (Array.isArray(resume.experience) ? resume.experience : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      var ep = 'experience.' + i;
      var sec = sectionName(ctx, 'experience');
      if (!tidy(plain(e.company))) {
        out.push(finding('entry.incomplete', 'warn', ep + '.company', sec,
          'This experience entry has no employer name.', ''));
      }
      (Array.isArray(e.roles) ? e.roles : []).forEach(function (r, j) {
        if (!r || typeof r !== 'object' || r.visible === false) return;
        var rp = ep + '.roles.' + j;
        if (!tidy(plain(r.position))) {
          out.push(finding('entry.incomplete', 'warn', rp + '.position', sec,
            'This role has no job title.', ''));
        }
        if (!tidy(r.start)) {
          out.push(finding('date.missing', 'warn', rp + '.start', sec,
            'This role has no start date.', ''));
        }
        if (!tidy(r.end) && !r.current) {
          out.push(finding('date.missing', 'warn', rp + '.end', sec,
            'This role has no end date. Mark it current or add one.', ''));
        }
      });
    });

    (Array.isArray(resume.education) ? resume.education : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      var ep = 'education.' + i;
      var sec = sectionName(ctx, 'education');
      if (!tidy(plain(e.institution))) {
        out.push(finding('entry.incomplete', 'warn', ep + '.institution', sec,
          'This education entry has no institution name.', ''));
      }
      if (!tidy(e.start) && !tidy(e.end)) {
        out.push(finding('date.missing', 'tip', ep + '.start', sec,
          'This education entry has no dates.', ''));
      }
    });

    [['projects', 'name'], ['certifications', 'name'], ['publications', 'title'],
     ['awards', 'title'], ['presentations', 'title'], ['coursework', 'name']].forEach(function (pair) {
      (Array.isArray(resume[pair[0]]) ? resume[pair[0]] : []).forEach(function (e, i) {
        if (!e || typeof e !== 'object' || e.visible === false) return;
        if (tidy(plain(e[pair[1]]))) return;
        out.push(finding('entry.incomplete', 'warn', pair[0] + '.' + i + '.' + pair[1],
          sectionName(ctx, pair[0]), 'This entry has no name or title.', ''));
      });
    });

    (Array.isArray(resume.languages) ? resume.languages : []).forEach(function (l, i) {
      if (!l || typeof l !== 'object') return;
      if (tidy(plain(l.language))) return;
      out.push(finding('entry.incomplete', 'warn', 'languages.' + i + '.language',
        sectionName(ctx, 'languages'), 'This language entry is blank.', ''));
    });

    (Array.isArray(resume.skills) ? resume.skills : []).forEach(function (s, i) {
      if (!s || typeof s !== 'object' || s.visible === false) return;
      var kws = (Array.isArray(s.keywords) ? s.keywords : []).map(function (k) { return tidy(plain(k)); })
        .filter(function (k) { return !!k; });
      if (tidy(plain(s.label)) || kws.length) return;
      out.push(finding('entry.incomplete', 'warn', 'skills.' + i + '.label',
        sectionName(ctx, 'skills'), 'This skill group has no label and no keywords.', ''));
    });
  }

  function sectionName(ctx, type) {
    var s = ctx.sectionByType[type];
    if (s) return s.label;
    return M ? M.typeMeta(type).label : type;
  }

  function duplicateBulletRule(ctx, out) {
    var seen = Object.create(null);
    ctx.bullets.forEach(function (b) {
      var key = b.clean.toLowerCase().replace(/[.!?;:]+$/, '').replace(/\s+/g, ' ');
      if (!key) return;
      if (seen[key] === undefined) { seen[key] = b; return; }
      out.push(finding('duplicate.bullet', 'error', b.path, b.section.label,
        'This bullet says the same thing as an earlier one.', b.clean, {
          label: 'Remove this duplicate',
          apply: function (draft) { removeAtPath(draft, b.path); }
        }));
    });

    var exp = Array.isArray(ctx.resume.experience) ? ctx.resume.experience : [];
    var byKey = Object.create(null);
    exp.forEach(function (e, i) {
      if (!e || typeof e !== 'object' || e.visible === false) return;
      var role = (Array.isArray(e.roles) && e.roles[0]) || {};
      var key = tidy(e.company).toLowerCase() + '|' + tidy(role.position).toLowerCase();
      if (!tidy(e.company) || !tidy(role.position)) return;
      if (byKey[key] === undefined) { byKey[key] = i; return; }
      out.push(finding('entry.duplicate', 'tip', 'experience.' + i, sectionName(ctx, 'experience'),
        'The same employer and title appear more than once.', tidy(e.company) + ' — ' + tidy(role.position), {
          label: 'Remove this duplicate entry',
          apply: function (draft) { removeAtPath(draft, 'experience.' + i); }
        }));
    });
  }

  function skillsDuplicateRule(ctx, out) {
    var resume = ctx.resume;
    var seen = Object.create(null);
    (Array.isArray(resume.skills) ? resume.skills : []).forEach(function (s, i) {
      if (!s || typeof s !== 'object') return;
      (Array.isArray(s.keywords) ? s.keywords : []).forEach(function (k, j) {
        var key = tidy(plain(k)).toLowerCase();
        if (!key) return;
        if (seen[key] === undefined) { seen[key] = true; return; }
        out.push(finding('skills.duplicate', 'tip', 'skills.' + i + '.keywords.' + j,
          sectionName(ctx, 'skills'), '“' + tidy(plain(k)) + '” already appears in another skill group.', k, {
            label: 'Remove the repeated keyword',
            apply: function (draft) { setPath(draft, 'skills.' + i + '.keywords.' + j, ''); }
          }));
      });
    });
  }

  /* --- per text node --- */
  function textNodeRules(node, kind, out) {
    var text = node.clean;
    var path = node.path;
    var sec = node.section.label;

    if (kind === 'bullet') {
      if (PRONOUNS_BULLET[firstWordLower(node.text)] || findPronoun(node)) {
        out.push(finding('pronoun.personal', 'error', path, sec,
          'This bullet uses a personal pronoun. Drop it — the reader knows who you are.', text, pronounFix(node)));
      }
    }

    var passive = findPassive(text);
    if (passive) {
      out.push(finding('voice.passive', 'warn', path, sec,
        'Passive voice: “' + passive + '”. Name who did the work.', text));
    }

    for (var i = 0; i < BUZZWORD_RE.length; i++) {
      var bw = BUZZWORD_RE[i];
      var m = bw.re.exec(text);
      if (!m) continue;
      out.push(finding('buzzword', 'warn', path, sec,
        '“' + m[0] + '” is filler. Say what happened instead.', text,
        bw.fix ? {
          label: 'Replace with “' + bw.fix + '”',
          apply: function (draft) {
            var cur = plain(getPath(draft, path));
            if (cur == null) return;
            setPath(draft, path, cur.replace(bw.re, bw.fix));
          }
        } : null));
      break;
    }

    var vm = VAGUE_RE.exec(text);
    if (vm) {
      out.push(finding('metric.vague', 'warn', path, sec,
        '“' + vm[0] + '” is not a measurement. Give the figure.', text));
    }

    if (/\b(responsibilit(?:y|ies)|duties|tasks)\s+(?:that\s+)?(?:included|involved|were|included:)\b/i.test(text) ||
        /\bincluded\s+(?:the\s+)?(?:following\s+)?(?:duties|responsibilities|tasks)\b/i.test(text) ||
        /^(?:duties|responsibilities|tasks)\s*(?:included|:)/i.test(text)) {
      out.push(finding('vague.responsibilities', 'warn', path, sec,
        'Vague framing. Name the work instead of the job description.', text));
    }

    var stacked = findStackedAdjectives(text);
    if (stacked) {
      out.push(finding('adjectives.stacked', 'tip', path, sec,
        'Stacked adjectives: “' + stacked + '”. Keep the two that carry weight.', text));
    }

    if (/\s{2,}/.test(node.text) || /^\s|\s$/.test(node.text)) {
      out.push(finding('text.spacing', 'tip', path, sec,
        'Extra spaces here will print as a gap.', text, {
          label: 'Tidy the spacing',
          apply: function (draft) {
            var cur = plain(getPath(draft, path));
            if (cur == null) return;
            setPath(draft, path, cur.replace(/\s+/g, ' ').trim());
          }
        }));
    }
  }

  function firstWordLower(text) {
    return firstWord(text).toLowerCase();
  }

  function findPronoun(node) {
    var t = tokens(node.text);
    for (var i = 0; i < t.length; i++) {
      var w = t[i].low;
      if (w === 'us' && t[i].raw === 'US') continue;   /* the country, not the pronoun */
      if (PRONOUNS_BULLET[w]) return t[i].raw;
    }
    return null;
  }

  /* "I led the team" -> "Led the team". Only offered when the pronoun opens the
   * bullet and the next word is a verb; "I am a designer" has no safe rewrite. */
  function pronounFix(node) {
    var m = /^\s*([Ii]|[Ww]e)\s+([A-Za-z][A-Za-z'-]*)/.exec(node.text);
    if (!m) return null;
    if (/^(am|is|are|was|were|have|has|had|been|being|a|an|the|at|in|on|for|to|also|currently|work|worked|looking|looking)$/i.test(m[2])) return null;
    return {
      label: 'Drop the pronoun',
      apply: function (draft) {
        var cur = plain(getPath(draft, node.path));
        if (cur == null) return;
        setPath(draft, node.path, cur.replace(/^\s*(?:[Ii]|[Ww]e)\s+([A-Za-z][A-Za-z'-]*)/, function (full, word) {
          return word.charAt(0).toUpperCase() + word.slice(1);
        }));
      }
    };
  }

  function lengthRules(node, out) {
    var len = node.clean.length;
    if (len < 40) {
      out.push(finding('length.short', 'tip', node.path, node.section.label,
        'This bullet is ' + len + ' characters. It may not say enough to be worth the line.', node.clean));
    } else if (len > 220) {
      out.push(finding('length.long', 'warn', node.path, node.section.label,
        'This bullet is ' + len + ' characters and will wrap to several lines. Split it.', node.clean));
    }
  }

  function metricRules(node, out) {
    if (node.type !== 'experience' && node.type !== 'projects' && node.type !== 'volunteer') return;
    if (hasNumber(node.clean)) return;
    out.push(finding('metric.missing', 'warn', node.path, node.section.label,
      'No number in this bullet, so the size of the result is unmeasurable.', node.clean));
  }

  function openerRules(node, out) {
    var raw = node.text.replace(BULLET_TRIM, '');
    var first = firstWordLower(node.text);
    var weakOpener = null;

    if (RESPONSIBLE_RE.test(raw)) {
      out.push(finding('opener.responsible-for', 'error', node.path, node.section.label,
        '“Responsible for” describes a job, not an accomplishment.', node.clean, {
          label: 'Replace with a strong verb',
          apply: function (draft) {
            var cur = plain(getPath(draft, node.path));
            if (cur == null) return;
            setPath(draft, node.path, cur.replace(RESPONSIBLE_RE, 'Owned '));
          }
        }));
    }

    for (var i = 0; i < WEAK_OPENERS.length; i++) {
      if (WEAK_OPENERS[i].re.test(raw)) {
        weakOpener = WEAK_OPENERS[i].why;
        out.push(finding('verb.weak-opener', 'warn', node.path, node.section.label, weakOpener, node.clean));
        break;
      }
    }

    /* "Helped with…" already says the verb is weak; saying it twice is noise. */
    if (first && !isVerbForm(first) && !weakOpener && !RESPONSIBLE_RE.test(raw)) {
      var fw = firstWord(node.text);
      if (fw && !/^[0-9]/.test(fw) && !LOWERCASE_OK.test(fw) && !/^(A|An|The)$/.test(fw) && fw.length > 2) {
        out.push(finding('verb.action', 'warn', node.path, node.section.label,
          '“' + fw + '” is not an action verb. Start with something you did.', node.clean));
      }
    }

    if (first && isVerbForm(first) && !hasPastTense(node.clean) && !/ing$/.test(first)) {
      out.push(finding('verb.past-tense', 'tip', node.path, node.section.label,
        '“' + firstWord(node.text) + '” reads as an ongoing responsibility. Use the past tense for work you finished.',
        node.clean));
    }

    if (CONNECTING_OPENERS.indexOf(first) !== -1) {
      out.push(finding('opener.conjunction', 'tip', node.path, node.section.label,
        'A bullet that starts with “' + first + '” reads as a sentence, not an achievement.', node.clean));
    }

    var ch = node.clean.charAt(0);
    if (ch && /[a-z]/.test(ch) && !LOWERCASE_OK.test(node.clean)) {
      out.push(finding('capital.missing', 'tip', node.path, node.section.label,
        'This bullet starts with a lower-case letter.', node.clean, {
          label: 'Capitalize the first letter',
          apply: function (draft) {
            var cur = plain(getPath(draft, node.path));
            if (cur == null || !cur.trim()) return;
            var t = cur.trim();
            setPath(draft, node.path, t.charAt(0).toUpperCase() + t.slice(1));
          }
        }));
    }
  }

  function firstPersonRule(node, out) {
    var t = tokens(node.text);
    for (var i = 0; i < t.length; i++) {
      if (PRONOUNS_FIRST[t[i].low]) {
        out.push(finding('pronoun.first-person', 'warn', node.path, node.section.label,
          'This passage is written in the first person. Resume prose is third person.', node.clean));
        return;
      }
    }
  }

  function punctuationRule(ctx, out) {
    var withDot = [], withoutDot = [];
    ctx.bullets.forEach(function (b) {
      if (/[.!?]$/.test(b.clean)) withDot.push(b);
      else withoutDot.push(b);
    });
    /* One of each is a coincidence, not a pattern. */
    if (withDot.length < 2 || withoutDot.length < 2) return;
    var dominant = withDot.length >= withoutDot.length;
    var minority = dominant ? withoutDot : withDot;
    minority.forEach(function (b) {
      out.push(finding('punctuation.inconsistent', 'warn', b.path, b.section.label,
        dominant ? 'This bullet has no closing period while the rest of the document does.'
                 : 'This bullet ends in a period while the rest of the document does not.',
        b.clean, {
          label: dominant ? 'Add a period' : 'Remove the period',
          apply: function (draft) {
            var cur = plain(getPath(draft, b.path));
            if (cur == null) return;
            var next = dominant ? tidy(cur) + '.' : tidy(cur).replace(/[.!?]+$/, '');
            setPath(draft, b.path, next);
          }
        }));
    });
  }

  function repeatedOpenerRule(ctx, out) {
    var lists = Object.create(null);
    ctx.bullets.forEach(function (b) {
      var listKey = b.path.replace(/\.\d+$/, '');
      (lists[listKey] = lists[listKey] || []).push(b);
    });
    Object.keys(lists).forEach(function (key) {
      var list = lists[key];
      for (var i = 1; i < list.length; i++) {
        var prev = firstWordLower(list[i - 1].text);
        var cur = firstWordLower(list[i].text);
        if (!prev || prev !== cur) continue;
        if (CONNECTING_OPENERS.indexOf(cur) !== -1) continue;
        if (cur.length < 3) continue;
        out.push(finding('opener.repeated', 'tip', list[i].path, list[i].section.label,
          '“' + firstWord(list[i].text) + '” opens the bullet before it too. Vary the verbs.', list[i].clean));
      }
    });
  }

  function dateRules(ctx, resume, out) {
    /* Present vs Current (and vs "now") */
    var presentUses = Object.create(null);
    ctx.dates.forEach(function (d) {
      var kind = presentWord(d.value);
      if (!kind) return;
      (presentUses[kind] = presentUses[kind] || []).push(d);
    });
    var kinds = Object.keys(presentUses);
    if (kinds.length > 1) {
      var dominant = kinds.sort(function (a, b) {
        return presentUses[b].length - presentUses[a].length || (a < b ? -1 : 1);
      })[0];
      kinds.forEach(function (kind) {
        if (kind === dominant) return;
        presentUses[kind].forEach(function (d) {
          var target = dominant === 'now' ? 'Present' : (dominant.charAt(0).toUpperCase() + dominant.slice(1));
          out.push(finding('date.present-mixed', 'warn', d.path, d.section.label,
            'This reads “' + d.value + '” where the rest of the document reads “' + target + '”.', d.value, {
              label: 'Use “' + target + '”',
              apply: function (draft) { setPath(draft, d.path, target); }
            }));
        });
      });
    }

    /* Format consistency */
    var recognized = ctx.dates.filter(function (d) {
      var f = dateFormat(d.value);
      return f && f !== 'free' && f !== 'present';
    });
    if (recognized.length < 2) return;
    var counts = Object.create(null);
    recognized.forEach(function (d) {
      var f = dateFormat(d.value);
      counts[f] = (counts[f] || 0) + 1;
    });
    var formats = Object.keys(counts);
    if (formats.length < 2) return;
    var metaFmt = resume.meta ? META_FORMAT_MAP[tidy(resume.meta.dateFormat)] : null;
    var target = null;
    if (metaFmt && counts[metaFmt] > 0) target = metaFmt;
    else {
      var sorted = formats.slice().sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
      target = sorted[0];
    }
    recognized.forEach(function (d) {
      var f = dateFormat(d.value);
      if (f === target) return;
      out.push(finding('date.inconsistent', 'warn', d.path, d.section.label,
        'This date uses ' + f + ' while the document mostly uses ' + target + '.', d.value));
    });
  }

  function documentMetricRule(ctx, out) {
    if (!ctx.bullets.length && !ctx.prose.length) return;
    var any = ctx.textNodes.some(function (n) { return hasNumber(n.clean); });
    if (any) return;
    out.push(finding('metric.none', 'warn', '', 'Document',
      'No number appears anywhere in this document. Recruiters skim for scale — add at least one figure.', ''));
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */
  function summarize(findings) {
    var out = { total: 0, errors: 0, warnings: 0, tips: 0, byRule: {} };
    (findings || []).forEach(function (f) {
      out.total++;
      if (f.severity === 'error') out.errors++;
      else if (f.severity === 'warn') out.warnings++;
      else out.tips++;
      out.byRule[f.id] = (out.byRule[f.id] || 0) + 1;
    });
    return out;
  }

  /* Typing must never block on analysis. Hand this a resume (or a getter for
   * the live one) and the work lands on the next idle slot after the last
   * change: debounce collapses a burst of keystrokes, requestIdle keeps the
   * work off the input frame. Returns cancel(). */
  function schedule(source, onDone, opts) {
    if (typeof onDone !== 'function') return function () {};
    var wait = opts && typeof opts.debounce === 'number' ? opts.debounce : 250;
    var cancelled = false;
    var pending = null;

    function idle(fn) {
      if (U && typeof U.requestIdle === 'function') return U.requestIdle(fn, 600);
      if (global.requestIdleCallback) return global.requestIdleCallback(fn, { timeout: 600 });
      return setTimeout(fn, 32);
    }

    function work() {
      pending = null;
      if (cancelled) return;
      var resume = typeof source === 'function' ? source() : source;
      var findings = [];
      try { findings = run(resume); } catch (e) { findings = []; }
      if (!cancelled) onDone(findings, resume);
    }

    var trigger = (U && typeof U.debounce === 'function')
      ? U.debounce(function () { pending = idle(work); }, wait)
      : function () {
          if (pending != null) clearTimeout(pending);
          pending = setTimeout(function () { pending = idle(work); }, wait);
        };

    trigger();

    return function cancel() {
      cancelled = true;
      if (pending != null) {
        if (typeof pending === 'number') clearTimeout(pending);
        pending = null;
      }
      if (trigger && typeof trigger.cancel === 'function') trigger.cancel();
    };
  }

  RB.linter = {
    RULES: RULES,
    run: run,
    summarize: summarize,
    schedule: schedule,
    verbs: function () { return VERB_LIST.slice(); },
    verbGroups: function () {
      return VERB_GROUPS.map(function (g) { return { group: g.group, verbs: g.verbs.slice() }; });
    },
    isVerb: isVerbForm
  };

  /* The Check panel resolves every analysis module through RB.analysis
   * (assets/js/ui/analysis-panel.js). Without this the Linter tab reports the
   * module as missing and shows nothing. */
  RB.analysis = RB.analysis || {};
  RB.analysis.lint = run;
})(window);
