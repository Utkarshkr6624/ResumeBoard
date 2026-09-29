/* Resumeboard — template presets and the design-token bridge
 *
 * Two jobs:
 *   1. A registry of named templates, each a full design-token object.
 *   2. Turning a design object into CSS custom properties on #rb-doc.
 *
 * Applying a template is a model write, so it is undoable: everything goes
 * through RB.store.update with source 'template'. Painting is a separate,
 * idempotent step that reads the validated design back out of the store and
 * only ever touches attributes and custom properties on #rb-doc. The document
 * DOM is never rebuilt.
 *
 * ASSUMPTION: assets/css/tokens.css owns the --rb-doc-* names. This file
 * writes them, it does not define them. templates.css is expected to key
 * structural differences off [data-template] and to read --rb-doc-sidebar-width
 * for the column split, rather than off any per-template JavaScript.
 */
(function (global) {
  'use strict';

  global.RB = global.RB || {};

  var U = global.RB.utils;
  var REF_PT = 10.5;          // the body size every optical size is measured against
  var DOC_SELECTOR = '#rb-doc';

  /* The model stores a colour as hex (model.validate rejects anything else),
   * so these mirror tokens.css rather than introducing new hues. */
  var PALETTE = {
    ink:      { hex: '#151a23', token: '--rb-gray-900' },
    graphite: { hex: '#232936', token: '--rb-gray-800' },
    slate:    { hex: '#4d5666', token: '--rb-gray-600' },
    indigo:   { hex: '#3a35bd', token: '--rb-accent-700' },
    blue:     { hex: '#0550ae', token: '--rb-blue-700' },
    sea:      { hex: '#026aa2', token: '--rb-blue-600' },
    pine:     { hex: '#065f46', token: '--rb-green-700' },
    forest:   { hex: '#047857', token: '--rb-green-600' },
    bronze:   { hex: '#93370d', token: '--rb-amber-700' },
    crimson:  { hex: '#912018', token: '--rb-red-700' }
  };

  /* Web-safe and system faces only — nothing is downloaded, ever.
   *
   * standardSizePt is the point size at which that face reads the same size as
   * the system face at REF_PT. Two faces at the same pt are not the same
   * size: Verdana's x-height is roughly a fifth taller than Times New Roman's,
   * which is why a single "10.5pt" would silently change the apparent density
   * of a resume when the font changes. The document size is multiplied by
   * standardSizePt / REF_PT so the page holds its proportions across faces.
   *
   * Ratios are matched against the common desktop set. A missing face falls
   * through the stack and inherits the ratio chosen for the stack's lead face.
   */
  var FONTS = {
    system: {
      label: 'System UI', category: 'sans', standardSizePt: 10.5,
      stack: '"Inter var", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    },
    helvetica: {
      label: 'Helvetica', category: 'sans', standardSizePt: 11.2,
      stack: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif'
    },
    segoe: {
      label: 'Segoe UI', category: 'sans', standardSizePt: 10.5,
      stack: '"Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif'
    },
    calibri: {
      label: 'Calibri', category: 'sans', standardSizePt: 11.2,
      stack: 'Calibri, Candara, "Segoe UI", system-ui, sans-serif'
    },
    verdana: {
      label: 'Verdana', category: 'sans', standardSizePt: 9.7,
      stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif'
    },
    tahoma: {
      label: 'Tahoma', category: 'sans', standardSizePt: 10.2,
      stack: 'Tahoma, Geneva, Verdana, sans-serif'
    },
    trebuchet: {
      label: 'Trebuchet MS', category: 'sans', standardSizePt: 10.7,
      stack: '"Trebuchet MS", "Lucida Grande", "Segoe UI", sans-serif'
    },
    georgia: {
      label: 'Georgia', category: 'serif', standardSizePt: 10.1,
      stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif'
    },
    times: {
      label: 'Times New Roman', category: 'serif', standardSizePt: 11.5,
      stack: '"Times New Roman", Times, "Liberation Serif", serif'
    },
    garamond: {
      label: 'Garamond', category: 'serif', standardSizePt: 12.8,
      stack: 'Garamond, "EB Garamond", "Adobe Garamond Pro", Baskerville, "Times New Roman", serif'
    },
    palatino: {
      label: 'Palatino', category: 'serif', standardSizePt: 11.4,
      stack: '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif'
    },
    mono: {
      label: 'Monospace', category: 'mono', standardSizePt: 10.8,
      stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    },
    courier: {
      label: 'Courier New', category: 'mono', standardSizePt: 11.3,
      stack: '"Courier New", Courier, "Liberation Mono", monospace'
    }
  };

  var BULLET_GLYPHS = { disc: '•', square: '▪', dash: '–', none: 'none' };

  /* ── The structural axes ──────────────────────────────────────────────────
   * A template is a token preset, not a stylesheet. Type, measure, rhythm and
   * colour are all numbers, and a number is all the nine original presets
   * needed — but a layout is not a number. A rail down the left, a timeline
   * through the entries, cards instead of a stack: those are arrangements, and
   * an arrangement cannot be expressed as a point size.
   *
   * So each axis is a small closed set of named shapes, declared here once,
   * validated against its set, and painted onto #rb-doc as a data attribute.
   * templates.css carries ONE generic rule per axis, keyed on the value and
   * never on [data-template]: adding a template is adding an object to the
   * array below, and a template that has never been heard of cannot grow a
   * selector of its own. Every axis defaults to the plain single-column
   * treatment, so a preset that says nothing here renders exactly as it always
   * did — which is what the original nine rely on.
   *
   * `prop` is the custom property the same value is also written as, for the
   * places a declaration can be driven by a value rather than a selector
   * (widths, padding, the tint mix).
   */
  var STRUCT_AXES = [
    { key: 'head',       attr: 'head',       prop: '--rb-doc-head',       values: ['left', 'center', 'inline', 'caps', 'triptych'], def: 'left' },
    { key: 'headBand',   attr: 'head-band',  prop: '--rb-doc-head-band',  values: ['none', 'fill', 'tint'],          def: 'none' },
    { key: 'headRules',  attr: 'head-rules', prop: '--rb-doc-head-rules', values: ['none', 'single', 'double', 'heavy'], def: 'single' },
    { key: 'sec',        attr: 'sec',        prop: '--rb-doc-sec',        values: ['plain', 'bar', 'box', 'tint'],   def: 'plain' },
    { key: 'secHead',    attr: 'sec-head',   prop: '--rb-doc-sec-head',   values: ['full', 'quiet'],                def: 'full' },
    { key: 'number',     attr: 'number',     prop: '--rb-doc-sec-number', values: ['off', 'decimal'],                def: 'off' },
    { key: 'entry',      attr: 'entry',      prop: '--rb-doc-entry',      values: ['plain', 'hair', 'box', 'rail', 'dates', 'stamp'], def: 'plain' },
    { key: 'cards',      attr: 'cards',      prop: '--rb-doc-entry-cards', values: ['off', 'on'],                   def: 'off' },
    { key: 'body',       attr: 'body',       prop: '--rb-doc-body',       values: ['flow', 'marginalia'],           def: 'flow' },
    { key: 'side',       attr: 'side',       prop: '--rb-doc-side',       values: ['top', 'bottom'],                def: 'top' },
    { key: 'ledger',     attr: 'ledger',     prop: '--rb-doc-ledger',     values: ['off', 'lines'],                 def: 'off' }
  ];

  /* Lengths a shape needs but a shape name cannot carry: how far a card is
   * inset, how wide the marginalia column runs, how much the accent bar is
   * worth. Names for the others would be a second, worse way to say it. */
  var STRUCT_LENGTHS = [
    { key: 'padPt',      prop: '--rb-doc-frame-pad', def: 6,   min: 0, max: 24 },
    { key: 'bandPadPt',  prop: '--rb-doc-band-pad',  def: 11,  min: 0, max: 40 },
    { key: 'barPt',      prop: '--rb-doc-bar-w',     def: 3,   min: 0.5, max: 12 },
    { key: 'railEm',     prop: '--rb-doc-rail-col',  def: 9,   min: 4, max: 20 },
    { key: 'dateEm',     prop: '--rb-doc-date-col',  def: 9.5, min: 5, max: 20 },
    { key: 'cardGapPt',  prop: '--rb-doc-card-gap',  def: 8,   min: 0, max: 30 },
    { key: 'railPadEm',  prop: '--rb-doc-rail-pad',  def: 1.2, min: 0, max: 4 }
  ];

  /* Read the shape a preset asked for, or the plain one it did not. */
  function structureOf(preset) {
    var asked = (preset && preset.layout && preset.layout.structure) || {};
    var out = {};
    STRUCT_AXES.forEach(function (axis) {
      var v = asked[axis.key];
      out[axis.attr] = axis.values.indexOf(v) === -1 ? axis.def : v;
    });
    return out;
  }

  function structureVars(preset) {
    var asked = (preset && preset.layout && preset.layout.structure) || {};
    var vars = {};
    STRUCT_LENGTHS.forEach(function (L) {
      var n = Number(asked[L.key]);
      if (!isFinite(n)) n = L.def;
      n = Math.min(Math.max(n, L.min), L.max);
      vars[L.prop] = n + (L.prop === '--rb-doc-rail-col' || L.prop === '--rb-doc-date-col' || L.prop === '--rb-doc-rail-pad' ? 'em' : 'pt');
    });
    return vars;
  }

  /* `summary` is the one honest line the Design panel shows under each card.
   * It has to survive contact with the rendered page: where a description
   * promised a tint, a monospaced contact line or a reordered CV and the
   * tokens did not deliver it, the card was lying.
   *
   * measureEm is the column width in ems of the body size — 1em is the type
   * size, so the value survives a change of point size. At roughly 0.5em per
   * character, 38em is about 78 characters a line, which is as much as a line
   * of resume prose should carry; a template that trades characters for pages
   * says so here instead of in the stylesheet. Deliberately NOT a design key:
   * it belongs to the template, not to something a slider can move, so it
   * never reaches resume.design. */
  var TEMPLATES = [
    {
      templateId: 'classic',
      name: 'Classic',
      summary: 'One column, system UI, uppercase rules. The safest page to send.',
      description: 'The safe default. One column, system UI, uppercase section rules. Reads well everywhere and parses cleanly by applicant tracking systems.',
      tags: ['one column', 'ATS safe', 'default'],
      fontFamily: 'system',
      baseSizePt: 11.5,
      lineHeight: 1.32,
      measureEm: 38,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 14,
      entryGapPt: 7,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'modern',
      name: 'Modern',
      summary: 'Airy, larger section headings, a colour accent you can change.',
      description: 'Airy and contemporary. More air between sections, a large section heading with no rule under it, and a colour accent that can be changed in Design.',
      tags: ['one column', 'colour accent', 'airy'],
      fontFamily: 'system',
      baseSizePt: 11,
      lineHeight: 1.44,
      measureEm: 37,
      accent: PALETTE.indigo.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 20,
      entryGapPt: 9,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'compact',
      name: 'Compact',
      summary: 'Smaller type, tighter gaps. A long career on one page.',
      description: 'Denser page for long careers. Smaller type and tighter gaps fit six or more roles on one page without crowding the edges.',
      tags: ['one column', 'dense', 'ATS safe'],
      fontFamily: 'helvetica',
      baseSizePt: 10,
      lineHeight: 1.24,
      /* Wider than the house measure, and that is the point: the characters
       * it gives up are the page it buys. Everything else here is spent on the
       * same bargain. */
      measureEm: 43,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 10,
      entryGapPt: 4,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'executive',
      name: 'Executive',
      summary: 'Georgia, wide margins, a photo slot. Built for senior roles.',
      description: 'Serif, generous margins, and room for a photograph. Built for senior roles where the summary carries the page.',
      tags: ['serif', 'one column', 'photo'],
      fontFamily: 'georgia',
      baseSizePt: 11.5,
      lineHeight: 1.4,
      measureEm: 36,
      accent: PALETTE.ink.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 16,
      entryGapPt: 9,
      marginsIn: 0.75,
      columns: 1,
      photoSlot: true,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'academic',
      name: 'Academic',
      summary: 'Times, wide margins, square bullets. A curriculum vitae.',
      description: 'A curriculum vitae. Serif throughout, wide margins, and the section order that publication and coursework lists expect.',
      tags: ['serif', 'CV', 'publications'],
      fontFamily: 'times',
      baseSizePt: 11.5,
      lineHeight: 1.4,
      measureEm: 37,
      accent: PALETTE.ink.hex,
      headingStyle: 'rule',
      ruleWeight: 1,
      sectionGapPt: 13,
      entryGapPt: 7,
      marginsIn: 0.9,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'minimal',
      name: 'Minimal',
      summary: 'No bullets, no rules, no colour. Whitespace does the work.',
      description: 'No bullets, no rules, no colour. Whitespace and type size do all the work. The quietest option on the list.',
      tags: ['one column', 'no colour', 'airy'],
      fontFamily: 'system',
      baseSizePt: 11,
      lineHeight: 1.55,
      measureEm: 35,
      accent: PALETTE.slate.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 22,
      entryGapPt: 11,
      marginsIn: 0.85,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'none',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0.01
    },
    {
      templateId: 'sidebar',
      name: 'Two column with sidebar',
      summary: 'Narrow left column for contact and skills, roles on the right.',
      description: 'A narrow left column divided by a hairline, carrying contact details, skills and languages, with the wider column taking the roles. Best on screen and on A4.',
      tags: ['two column', 'colour accent'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      accent: PALETTE.blue.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 13,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 2,
      photoSlot: true,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: {
        mode: 'sidebar',
        sidebarWidthPct: 32,
        sidebarTypes: ['summary', 'skills', 'languages', 'interests', 'certifications', 'references']
      }
    },
    {
      templateId: 'print-bw',
      name: 'Print black and white',
      summary: 'Black and white for a laser printer. Rules carry the structure.',
      description: 'Tuned for a laser printer with no colour. Rules and square bullets carry the structure instead of hue, and margins are sized to a half-inch trim.',
      tags: ['one column', 'no colour', 'print'],
      fontFamily: 'helvetica',
      baseSizePt: 11,
      lineHeight: 1.28,
      measureEm: 40,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.25,
      sectionGapPt: 11,
      entryGapPt: 5,
      marginsIn: 0.55,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'technical',
      name: 'Technical',
      summary: 'A rule under every heading, dash bullets, engineering density.',
      description: 'For engineering and data roles. A plain sans at 9.5pt, a rule under every heading, and a pine green accent.',
      tags: ['one column', 'engineering', 'ATS safe'],
      fontFamily: 'helvetica',
      baseSizePt: 10.5,
      lineHeight: 1.34,
      measureEm: 40,
      accent: PALETTE.pine.hex,
      headingStyle: 'rule',
      ruleWeight: 1,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.55,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      /* Not print-safe: print-safe replaces the accent with near-black, which
       * would leave this template with no colour at all and the accent control
       * in the panel doing nothing. css/print.css already greyscales the accent
       * on the sheet, so the green costs nothing on a mono printer. */
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    }
  ];

  /* ── The structural set ───────────────────────────────────────────────────
   * Everything above is the same page wearing different type. These are
   * different pages: a rail down the left, a line through the entries, a card
   * instead of a stack. Each one is still only a token preset — the numbers
   * here plus the shape names in `layout.structure`, which templates.css reads
   * as one generic rule per axis.
   *
   * The house rule holds for all of them: a section heading is a standalone
   * line, the reading order in the DOM is the reading order on the page, there
   * are no tables and no text boxes, and the gap between two jobs is visibly
   * wider than the gap between two bullets. A card grid and a two-column body
   * are the only two that put more than one column of text on the sheet, and
   * both are called out as such in their summary — a parser reads them, but a
   * narrow column is the reader's problem, not the parser's.
   */
  var STRUCTURAL_TEMPLATES = [
    {
      templateId: 'rail',
      name: 'Rail',
      summary: 'Narrow left rail for skills and languages. Roles run the full width beside it.',
      description: 'A 28% rail down the left edge carrying skills, languages and certifications, with a hairline between it and the roles. The summary stays in the main column, where it has room to be read.',
      tags: ['two column', 'rail', 'ATS safe'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.34,
      measureEm: 38,
      accent: PALETTE.blue.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.55,
      columns: 2,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: {
        mode: 'sidebar',
        sidebarWidthPct: 28,
        sidebarTypes: ['skills', 'languages', 'interests', 'certifications'],
        structure: { headBand: 'tint', bandPadPt: 9 }
      }
    },
    {
      templateId: 'triptych',
      name: 'Triptych',
      summary: 'The header cut into three ruled bands: name, headline, contact.',
      description: 'The identity block is split into three horizontal bands by two full-width rules — the name, the headline under it, and the contact line under that. Everything below the bands is a plain single column.',
      tags: ['one column', 'banded header', 'ATS safe'],
      fontFamily: 'system',
      baseSizePt: 12,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 15,
      entryGapPt: 7,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0.02,
      layout: { structure: { head: 'triptych' } }
    },
    {
      templateId: 'timeline',
      name: 'Timeline',
      summary: 'A line runs down the page with a node at every role. Dates stay right.',
      description: 'Each section is drawn as a timeline: a hairline down the left of the entries with a filled node at every job. The dates stay on the right of the title where an ATS and a reader both expect them.',
      tags: ['one column', 'timeline', 'ATS safe'],
      fontFamily: 'helvetica',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.indigo.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 13,
      entryGapPt: 6,
      marginsIn: 0.55,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'rail', railPadEm: 1.4 } }
    },
    {
      templateId: 'cards',
      name: 'Cards',
      summary: 'Two entries per row, each in its own hairline box. Dense and visual.',
      description: 'Entries are laid out two to a row, each in a hairline box. The DOM order is still the reading order, so a parser gets the page in sequence — but a narrow column is a visual choice, so check the parsed result before sending it to a large ATS.',
      tags: ['card grid', 'two column', 'visual only'],
      fontFamily: 'system',
      baseSizePt: 10,
      lineHeight: 1.3,
      measureEm: 40,
      accent: PALETTE.slate.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 5,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'box', cards: 'on', padPt: 7, cardGapPt: 7 } }
    },
    {
      templateId: 'ledger',
      name: 'Ledger',
      summary: 'A rule under every heading, every title and every line. An accounts page.',
      description: 'Ruled like a ledger: a rule under every section heading, under every job title, and above every bullet. Monochrome by design, because a ledger has no colour.',
      tags: ['one column', 'ruled', 'no colour'],
      fontFamily: 'helvetica',
      baseSizePt: 9.5,
      lineHeight: 1.26,
      measureEm: 42,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.5,
      sectionGapPt: 10,
      entryGapPt: 5,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { ledger: 'lines', entry: 'hair' } }
    },
    {
      templateId: 'gallery',
      name: 'Gallery',
      summary: 'Very wide margins and a short measure. The page is mostly air.',
      description: 'The page is mostly air: margins over an inch, a measure of thirty ems, and section gaps large enough to read as space rather than as a break. No bullets — the paragraphs are the work.',
      tags: ['one column', 'airy', 'no colour'],
      fontFamily: 'system',
      baseSizePt: 11,
      lineHeight: 1.6,
      measureEm: 30,
      accent: PALETTE.slate.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 26,
      entryGapPt: 13,
      marginsIn: 1.15,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'none',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0.01,
      layout: { structure: { headRules: 'none' } }
    },
    {
      templateId: 'maximalist',
      name: 'Maximalist',
      summary: 'Nine point on a wide measure. As much as the paper will honestly take.',
      description: 'Small type on a wide measure, tight leading and square bullets: the most a page can carry without becoming a wall. Read it printed before you send it.',
      tags: ['one column', 'dense', 'small type'],
      fontFamily: 'tahoma',
      baseSizePt: 9,
      lineHeight: 1.2,
      /* Deliberately past the house measure. A maximalist page is the one case
       * where the character count is the point, and the summary says so. */
      measureEm: 48,
      accent: PALETTE.graphite.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 8,
      entryGapPt: 4,
      marginsIn: 0.4,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'regent',
      name: 'Regent',
      summary: 'Palatino at twelve point on a 1.6 leading. Slow, formal, unhurried.',
      description: 'A long, formal page: Palatino, twelve point, a leading of 1.6 and margins close to an inch. The generous leading is the design — it is a document meant to be read at a desk.',
      tags: ['serif', 'one column', 'airy'],
      fontFamily: 'palatino',
      baseSizePt: 12,
      lineHeight: 1.62,
      measureEm: 34,
      accent: PALETTE.ink.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 18,
      entryGapPt: 10,
      marginsIn: 0.95,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'accentbar',
      name: 'Accent bar',
      summary: 'A bar of colour down the left of every section. No rules anywhere else.',
      description: 'A solid bar of the accent colour runs down the left edge of each section, carrying the structure instead of a rule. One column, one accent, nothing else doing any work.',
      tags: ['one column', 'colour accent', 'bars'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.indigo.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 14,
      entryGapPt: 7,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { sec: 'bar', barPt: 3 } }
    },
    {
      templateId: 'boxed',
      name: 'Boxed',
      summary: 'Every section in a bordered panel. The page reads as stacked cards.',
      description: 'Each section sits in its own bordered panel with a tinted ground, so the page reads as a stack of boxes rather than a column of text. The heading is still a line of its own inside its box.',
      tags: ['one column', 'boxed', 'tinted'],
      fontFamily: 'segoe',
      baseSizePt: 10.5,
      lineHeight: 1.34,
      measureEm: 40,
      accent: PALETTE.pine.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 10,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { sec: 'box', padPt: 7 } }
    },
    {
      templateId: 'numbered',
      name: 'Numbered',
      summary: 'Sections numbered 01, 02, 03. A contents page with one entry per line.',
      description: 'Every section heading is numbered, the way a report numbers its parts. The number is drawn by the stylesheet rather than typed into the text, so it never reaches an export — switch to another template if the numbers have to travel.',
      tags: ['one column', 'numbered', 'serif'],
      fontFamily: 'georgia',
      baseSizePt: 11,
      lineHeight: 1.42,
      measureEm: 36,
      accent: PALETTE.bronze.hex,
      headingStyle: 'rule',
      ruleWeight: 1,
      sectionGapPt: 16,
      entryGapPt: 8,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { number: 'decimal' } }
    },
    {
      templateId: 'hairline',
      name: 'Hairline',
      summary: 'A hairline between every job, nothing between anything else.',
      description: 'One hairline between one job and the next, and nothing else: no rule under the heading, no rule under the header. The dividers are grey hairlines, so they survive a mono printer.',
      tags: ['one column', 'hairlines', 'ATS safe'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.38,
      measureEm: 40,
      accent: PALETTE.slate.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 14,
      entryGapPt: 5,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'hair' } }
    },
    {
      templateId: 'centred',
      name: 'Centred',
      summary: 'Name, headline and contact all centred. Formal and symmetrical.',
      description: 'The identity block is centred on the measure and the contact run is centred under it. Times, with a rule under the heading, for a page that has to look the same in a portrait or a landscape frame.',
      tags: ['serif', 'one column', 'centred header'],
      fontFamily: 'times',
      baseSizePt: 11.5,
      lineHeight: 1.4,
      measureEm: 37,
      accent: PALETTE.ink.hex,
      headingStyle: 'rule',
      ruleWeight: 1,
      sectionGapPt: 15,
      entryGapPt: 8,
      marginsIn: 0.75,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { head: 'center' } }
    },
    {
      templateId: 'flush',
      name: 'Flush',
      summary: 'Hard left edge, no rules, no bullets, no colour. Nothing but the text.',
      description: 'A hard left edge and nothing on it: no rules under the header or the headings, no bullets, no colour. The gaps do all the work, which is the only thing a resume without rules can rely on.',
      tags: ['one column', 'no rules', 'no colour'],
      fontFamily: 'helvetica',
      baseSizePt: 11,
      lineHeight: 1.4,
      measureEm: 42,
      accent: PALETTE.ink.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 18,
      entryGapPt: 10,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'none',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { headRules: 'none' } }
    },
    {
      templateId: 'inverted',
      name: 'Inverted',
      summary: 'A filled band across the top with the name in reverse. The body is plain.',
      description: 'The header is a filled band with the name, headline and contact in reverse out of it; everything below is an ordinary single column. A mono printer drops the fill and keeps a pair of rules in its place, so the band is never load-bearing.',
      tags: ['one column', 'inverted header', 'colour accent'],
      fontFamily: 'system',
      baseSizePt: 11,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.blue.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 16,
      entryGapPt: 8,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0.01,
      layout: { structure: { headBand: 'fill', headRules: 'none', bandPadPt: 13 } }
    },
    {
      templateId: 'portrait',
      name: 'Portrait',
      summary: 'A wide rail with a photograph in it, roles in the column beside.',
      description: 'A serif CV with a 36% rail: the photograph sits at the top of it, under it the contact details, skills and languages. A4, because a rail and a photograph want the taller sheet.',
      tags: ['two column', 'photo', 'serif'],
      fontFamily: 'georgia',
      baseSizePt: 10,
      lineHeight: 1.34,
      measureEm: 38,
      accent: PALETTE.ink.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 2,
      photoSlot: true,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: {
        mode: 'sidebar',
        sidebarWidthPct: 36,
        sidebarTypes: ['summary', 'skills', 'languages', 'interests', 'certifications', 'references']
      }
    },
    {
      templateId: 'thirds',
      name: 'Two thirds',
      summary: 'A one-third reference column and a two-thirds main column, in Garamond.',
      description: 'The page splits a third to a two-thirds, reference material on the left, the work on the right, set throughout in Garamond. The narrower column is the quiet one: skills and languages, never a role.',
      tags: ['two column', 'serif', 'split'],
      fontFamily: 'garamond',
      baseSizePt: 10.5,
      lineHeight: 1.4,
      measureEm: 38,
      accent: PALETTE.slate.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.55,
      columns: 2,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      /* The summary travels into the reference column: a two-column page
       * breaks both columns at one height, and a rail holding four lines
       * against a main holding three pages leaves the first sheet empty. */
      layout: {
        mode: 'sidebar',
        sidebarWidthPct: 35,
        sidebarTypes: ['summary', 'skills', 'languages', 'interests', 'certifications']
      }
    },
    {
      templateId: 'keel',
      name: 'Keel',
      summary: 'Roles across the top, the rail anchored to the foot of the page.',
      description: 'The reference column is anchored to the bottom of the page instead of the top: the roles run the width of the sheet, and skills, languages and references sit under them at the foot of the last page.',
      tags: ['two column', 'bottom rail', 'ATS safe'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.pine.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 2,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: {
        mode: 'sidebar',
        sidebarWidthPct: 30,
        sidebarTypes: ['skills', 'languages', 'interests', 'certifications', 'references'],
        structure: { side: 'bottom' }
      }
    },
    {
      templateId: 'marginalia',
      name: 'Marginalia',
      summary: 'Section labels down the left margin, content in a wide column beside them.',
      description: 'The section heading moves out into a margin column of its own and the entries run in a wide column beside it, the way a textbook sets its chapter heads. One column of text; the heading is still a line of its own.',
      tags: ['one column', 'margin notes', 'ATS safe'],
      fontFamily: 'segoe',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      measureEm: 44,
      accent: PALETTE.graphite.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 16,
      entryGapPt: 8,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      /* 11.5em is the width of the longest word the section labels can hold —
       * "PROFESSIONAL" is the one that breaks, and a heading broken mid-word in
       * a margin column is worse than no margin column. */
      layout: { structure: { body: 'marginalia', railEm: 11.5 } }
    },
    {
      templateId: 'terminal',
      name: 'Terminal',
      summary: 'Courier throughout, ruled like a printout. For a systems or data CV.',
      description: 'Set in Courier New end to end, with a rule under every heading, the way a printout or a commit log reads. Monospace has a wide measure on purpose: the columns line up without a table.',
      tags: ['monospace', 'one column', 'ruled'],
      fontFamily: 'courier',
      baseSizePt: 9.5,
      lineHeight: 1.3,
      measureEm: 44,
      accent: PALETTE.pine.hex,
      headingStyle: 'rule',
      ruleWeight: 1,
      sectionGapPt: 10,
      entryGapPt: 5,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { headRules: 'heavy' } }
    },
    {
      templateId: 'banner',
      name: 'Banner',
      summary: 'Each section on its own tinted band with an accent edge.',
      description: 'Every section sits on a band of its own: a faint tint with a heavier edge of the accent down the left. The bands are the section structure, so the headings carry no rule at all.',
      tags: ['one column', 'banded', 'tinted'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.36,
      measureEm: 38,
      accent: PALETTE.indigo.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 10,
      entryGapPt: 7,
      marginsIn: 0.55,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { sec: 'tint', padPt: 8, bandPadPt: 8 } }
    },
    {
      templateId: 'letterpress',
      name: 'Letterpress',
      summary: 'Tracked-out capitals on a double rule. Set like a title page.',
      description: 'The name and every heading are set in tracked-out capitals over a double rule, in Garamond, with wide margins. A title page rather than a form: quiet, wide, and expensive-looking in print.',
      tags: ['serif', 'caps', 'wide margins'],
      fontFamily: 'garamond',
      baseSizePt: 11,
      lineHeight: 1.42,
      measureEm: 36,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 15,
      /* No bullets, so the gap between one paragraph and the next is 0.5em —
       * the entry gap has to clear that by a wide margin or a job and a claim
       * inside it read as the same thing. */
      entryGapPt: 13,
      marginsIn: 0.8,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'none',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0.06,
      layout: { structure: { headRules: 'double' } }
    },
    {
      templateId: 'folio',
      name: 'Folio',
      summary: 'Dates in a hanging left gutter, the entry set against them.',
      description: 'The dates drop into a hanging gutter on the left of every entry, and the title and its bullets are set in a column against it, the way a book page carries its sidenotes. The DOM order is unchanged.',
      tags: ['serif', 'date gutter', 'ATS safe'],
      fontFamily: 'palatino',
      baseSizePt: 11,
      lineHeight: 1.42,
      measureEm: 42,
      accent: PALETTE.ink.hex,
      headingStyle: 'rule',
      ruleWeight: 0.75,
      sectionGapPt: 14,
      entryGapPt: 7,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'dates', dateEm: 9.5 } }
    },
    {
      templateId: 'stamped',
      name: 'Stamped',
      summary: 'The date stamped above the title of every job, like a docket.',
      description: 'Each job is stamped: the date range sits on its own line above the title, in small grey, and the title is the biggest thing in the block. It reads as a sequence of dockets rather than a list of paragraphs.',
      tags: ['one column', 'docket', 'ATS safe'],
      fontFamily: 'helvetica',
      baseSizePt: 10,
      lineHeight: 1.3,
      measureEm: 42,
      accent: PALETTE.bronze.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 11,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0.01,
      layout: { structure: { entry: 'stamp' } }
    }
  ];

  /* ── The job set ─────────────────────────────────────────────────────────
   * Named for the work rather than for the arrangement: a page a ward sister
   * or a hiring foreman expects to recognise, not a page that is merely
   * arranged differently. The differences are still the tokens and the shape
   * table — no selector anywhere in templates.css names one of these ids.
   *
   * Two of the shapes used most here were added with it, because the job
   * versions needed them and nothing else did: a head whose name and headline
   * share one baseline (`head: 'inline'`, how a trade or agency CV reads), a
   * name set in capitals (`head: 'caps'`, the Swiss and the terminal), and
   * section headings dropped to one quiet line (`secHead: 'quiet'`).
   */
  var JOB_TEMPLATES = [
    {
      templateId: 'clinical',
      name: 'Clinical',
      summary: 'Georgia in blue, open leading. The page a ward or a clinic expects.',
      description: 'For clinical and allied health roles. A serif at an open leading, blue section headings on a hairline, and margins wide enough to carry a reference list. No photo: most clinical employers in North America and the UK do not expect one, and a page that opens on a face reads as a different document from the one they asked for.',
      tags: ['clinical', 'serif', 'one column'],
      fontFamily: 'georgia',
      baseSizePt: 11.4,
      lineHeight: 1.45,
      measureEm: 37,
      accent: PALETTE.blue.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.75,
      sectionGapPt: 17,
      entryGapPt: 9,
      marginsIn: 0.75,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'legal',
      name: 'Legal',
      summary: 'Times under a heavy rule. Structure you can see from across a desk.',
      description: 'For associates, paralegals and in-house counsel. Rules-forward on purpose: a legal CV is read for structure before it is read for content, so the rule under every heading is nearly three times the weight of a hairline. Times at 10.5pt, half-inch margins and no colour, which is what a firm that will not accept a document with fills in it needs.',
      tags: ['legal', 'serif', 'print safe'],
      fontFamily: 'times',
      baseSizePt: 10.5,
      lineHeight: 1.3,
      measureEm: 40,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      /* 2.4pt of token becomes a 1.44pt rule, and the heading carries it at
       * 1.8x. A hairline under a Times cap is decoration; this is a division. */
      ruleWeight: 2.4,
      sectionGapPt: 12,
      entryGapPt: 5,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'hospitality',
      name: 'Hospitality',
      summary: 'A centred name in Palatino with a photograph. A4.',
      description: 'For front of house, events and hotel roles, where a photograph and a centred name block are still expected in much of the world. A warm old-style serif at an open leading, a dash bullet so a season reads as a season, and A4 because a European hospitality CV is nearly always a fourth sheet. The centred header is a convention, not a preference.',
      tags: ['hospitality', 'serif', 'photo'],
      fontFamily: 'palatino',
      baseSizePt: 10.6,
      lineHeight: 1.48,
      measureEm: 34,
      accent: PALETTE.bronze.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 19,
      entryGapPt: 10,
      marginsIn: 0.85,
      columns: 1,
      photoSlot: true,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { head: 'center', headRules: 'none' } }
    },
    {
      templateId: 'trade',
      name: 'Trade',
      summary: 'Verdana, square bullets, and the trade on the same line as the name.',
      description: 'For electricians, welders, HVAC technicians and the apprenticeships attached to them. The trade goes beside the name so a foreman reads the qualification in one pass instead of looking for it. Verdana is the plainest face on a Windows machine and the least likely to be substituted when a site office prints a pile of them, square bullets survive a scuffed print, and 11pt of it is a page you can read on a clipboard in a plant room.',
      tags: ['trade', 'sans', 'one column'],
      fontFamily: 'verdana',
      baseSizePt: 11.4,
      lineHeight: 1.28,
      measureEm: 41,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.6,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { head: 'inline', entry: 'stamp' } }
    },
    {
      templateId: 'civic',
      name: 'Public sector',
      summary: 'The years in a left gutter, Arial metrics, no colour. A form, filled in.',
      description: 'For government, civil service and public body roles, where an application is screened against a published criteria list and read by someone who did not write it. The dates drop into a hanging gutter on the left of every job, the way a service record is laid out; the face is Arial, which is what a public body has had since 1994; and there is no colour anywhere for a monochrome intake system to lose.',
      tags: ['public sector', 'ATS safe', 'print safe'],
      fontFamily: 'helvetica',
      baseSizePt: 10,
      lineHeight: 1.34,
      measureEm: 42,
      accent: PALETTE.slate.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 13,
      entryGapPt: 6,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'dates', dateEm: 9 } }
    },
    {
      templateId: 'agency',
      name: 'Creative agency',
      summary: 'A short measure, and the discipline on the same line as the name.',
      description: 'For studios, agencies and in-house creative teams. The measure is 32 ems so a project reference reads as a headline rather than a line of grey, the discipline sits beside the name, and the gap between entries is large enough that a hiring director can find the one studio they remember without reading the rest.',
      tags: ['creative', 'one column', 'narrow measure'],
      fontFamily: 'helvetica',
      baseSizePt: 10.5,
      lineHeight: 1.44,
      measureEm: 32,
      accent: PALETTE.indigo.hex,
      headingStyle: 'title',
      ruleWeight: 0.75,
      sectionGapPt: 19,
      entryGapPt: 10,
      marginsIn: 0.8,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { head: 'inline' } }
    },
    {
      templateId: 'finance',
      name: 'Finance',
      summary: 'Garamond under ruled headings, tabular dates. Built for figures.',
      description: 'For analyst, accounting and treasury roles. Garamond sets smaller than it looks at the same point size, which is what buys rows of figures; the dates are tabular, so a ten-year timeline lines up in a column; and a heavier rule under a title-case heading keeps a dense page legible without spending a second colour on it.',
      tags: ['finance', 'serif', 'dense'],
      fontFamily: 'garamond',
      baseSizePt: 9.4,
      lineHeight: 1.3,
      measureEm: 41,
      accent: PALETTE.graphite.hex,
      headingStyle: 'rule',
      ruleWeight: 1.6,
      sectionGapPt: 11,
      entryGapPt: 5,
      marginsIn: 0.5,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { head: 'inline', headRules: 'none' } }
    },
    {
      templateId: 'nonprofit',
      name: 'Nonprofit',
      summary: 'Verdana in green, an open leading, and room for the mission.',
      description: 'For mission-led work, where the argument matters as much as the history. An open leading, a green accent used three times on the page, and a summary with room to be read rather than skimmed. Dash bullets, so a season of volunteering does not sit on the page looking like a paid role.',
      tags: ['nonprofit', 'one column', 'airy'],
      fontFamily: 'verdana',
      baseSizePt: 11.8,
      lineHeight: 1.5,
      measureEm: 36,
      accent: PALETTE.pine.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 21,
      entryGapPt: 11,
      marginsIn: 0.8,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'dash',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0
    },
    {
      templateId: 'research',
      name: 'Research',
      summary: 'A small dense serif for a page that is half a publication list.',
      description: 'For postdocs, research scientists and anyone whose CV is mostly papers. Times at 9.5pt with a 42 em measure and 4pt between jobs, which is what gets twenty years, four grants and a publication list onto two pages without borrowing a second column. Print-safe, because the copy desk that sets the reprint is monochrome.',
      tags: ['research', 'serif', 'dense'],
      fontFamily: 'times',
      baseSizePt: 9.5,
      lineHeight: 1.26,
      measureEm: 42,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.75,
      sectionGapPt: 10,
      entryGapPt: 4,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { head: 'inline', headRules: 'none' } }
    },
    {
      templateId: 'teaching',
      name: 'Teaching',
      summary: 'Palatino under a rule, with the room a school CV needs for classes taught.',
      description: 'For classroom, teaching-assistant and education roles, where a list of subjects and a list of classes both have to fit. An old-style serif at 11.5pt with a 1.5 leading, a 1pt rule under a title-case heading, and entry gaps wide enough that a term teaching four classes reads as four lines rather than one block.',
      tags: ['teaching', 'serif', 'airy'],
      fontFamily: 'palatino',
      baseSizePt: 10.6,
      lineHeight: 1.5,
      measureEm: 37,
      accent: PALETTE.slate.hex,
      headingStyle: 'rule',
      ruleWeight: 1.4,
      sectionGapPt: 20,
      entryGapPt: 10,
      marginsIn: 0.85,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'retail',
      name: 'Retail',
      summary: 'A colour band across the top with the name and a photo on it.',
      description: 'For retail and store management, where the CV is read in a pile and the name has to survive being glanced at rather than read. A filled band carries the name, the headline and the photograph, and the type below it is a plain 11.5pt page. The band is a background, not a text box: nothing in the text layer changes, and a mono printer drops the fill and leaves a pair of rules in its place.',
      tags: ['retail', 'photo', 'bold'],
      fontFamily: 'tahoma',
      baseSizePt: 11.3,
      lineHeight: 1.34,
      measureEm: 38,
      accent: PALETTE.bronze.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.5,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.55,
      columns: 1,
      photoSlot: true,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { headBand: 'fill', headRules: 'none', bandPadPt: 12 } }
    },
    {
      templateId: 'logistics',
      name: 'Logistics',
      summary: 'Small Verdana, square bullets, tabular dates. An operations sheet.',
      description: 'For dispatch, warehousing and transport roles, where a CV carries route lists, licence classes, delivery volumes and depot histories. Verdana sets large for its point size, which is what keeps all of that legible at 10pt on a printed sheet, and a 36 em measure holds a ninety-character line inside the eye. Upright, square and uncoloured: it is a working document.',
      tags: ['logistics', 'dense', 'print safe'],
      fontFamily: 'verdana',
      baseSizePt: 10.8,
      lineHeight: 1.24,
      measureEm: 36,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 11,
      entryGapPt: 5,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'entry',
      name: 'Entry level',
      summary: 'Larger type, more air, no photo. A first CV that is easy to read.',
      description: 'For a first or second job, where the page is short and every line has to be read rather than skimmed. The body is 12pt on a 1.5 leading, entries sit 12pt apart, and there is no photograph: a school, a careers adviser or an internship board sees a page with room to write on it, which is the thing that page has to do.',
      tags: ['entry level', 'one column', 'airy'],
      fontFamily: 'system',
      baseSizePt: 12,
      lineHeight: 1.5,
      measureEm: 36,
      accent: PALETTE.ink.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 24,
      entryGapPt: 12,
      marginsIn: 0.9,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { headRules: 'none' } }
    },
    {
      templateId: 'career-change',
      name: 'Career changer',
      summary: 'A 32 em column inside 1.1in margins, and a summary that gets read.',
      description: 'For someone crossing fields, where the summary has to do the work the history cannot. The measure is narrow enough that a line is fifty-eight characters, the margins are the widest in the set, and the eye lands on the summary first. No photo, and no attempt to hide how long the run before the relevant years was — a panel is reading for the reason you changed, not the decade before it.',
      tags: ['career changer', 'narrow measure', 'airy'],
      fontFamily: 'helvetica',
      baseSizePt: 11,
      lineHeight: 1.55,
      measureEm: 32,
      accent: PALETTE.sea.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.75,
      sectionGapPt: 22,
      entryGapPt: 11,
      marginsIn: 1.1,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0
    },
    {
      templateId: 'euro-cv',
      name: 'European CV',
      summary: 'Photograph, A4, and the dates packed tight enough to stay on one page.',
      description: 'The continental CV: a photograph, a full address block, dense date ranges, languages and a civil-status line, on A4. 10pt at a 1.24 leading and a 40 em measure are what let the extra sections a European CV carries still fit one sheet, which is the format most of those employers expect to open. Use this one only where a photo is wanted; everywhere else it is one less thing to argue about.',
      tags: ['European CV', 'photo', 'A4'],
      fontFamily: 'helvetica',
      baseSizePt: 10,
      lineHeight: 1.24,
      measureEm: 40,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 9,
      entryGapPt: 4,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: true,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0
    },
    {
      templateId: 'swiss',
      name: 'Swiss',
      summary: 'A rigid grid, capitals everywhere, a hairline. Helvetica doing nothing clever.',
      description: 'For posts where the design brief is the design: Swiss and international roles, and anyone who wants a page that is obviously a grid. The name and every section heading are capitals, the leading is tight at 1.22, the measure runs the full width of an A4 sheet, and the only thing on the page carrying colour is the type. Nothing is centred, nothing is boxed, nothing is a picture.',
      tags: ['Swiss', 'sans', 'caps'],
      fontFamily: 'helvetica',
      baseSizePt: 10.5,
      lineHeight: 1.22,
      /* 44 ems is 7in of text on a sheet 7.37in wide: the measure is the page. */
      measureEm: 44,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1,
      sectionGapPt: 11,
      entryGapPt: 5,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { head: 'caps' } }
    },
    {
      templateId: 'oneline',
      name: 'Single line',
      summary: 'Section headings set as one quiet line, right on top of their content.',
      description: 'The plainest page in the set. A heading is set at body size in a muted uppercase, with no rule under it and almost no space between it and what it introduces, so a section reads as one block with a label on top. The only structure on the page is the type and the gap; nothing is boxed, banded, tinted or reversed.',
      tags: ['minimal', 'one column', 'quiet'],
      fontFamily: 'system',
      baseSizePt: 11,
      lineHeight: 1.5,
      measureEm: 37,
      accent: PALETTE.slate.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.5,
      sectionGapPt: 15,
      entryGapPt: 8,
      marginsIn: 0.75,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { secHead: 'quiet', headRules: 'none' } }
    },
    {
      templateId: 'block',
      name: 'Accent block',
      summary: 'Every section on a block of colour, under a filled header band.',
      description: 'For applications that are read by a person before anything is parsed. The identity block sits on a solid accent band that runs to the edge of the sheet and every section below it sits on a tinted panel of its own, so the page is a stack of colour rather than a column of text. Both grounds are backgrounds, not text boxes: the text layer is unchanged, and a monochrome print loses the fills and keeps the rules.',
      tags: ['bold', 'colour accent', 'one column'],
      fontFamily: 'system',
      baseSizePt: 10.5,
      lineHeight: 1.38,
      measureEm: 38,
      accent: PALETTE.indigo.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.25,
      sectionGapPt: 12,
      entryGapPt: 7,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { headBand: 'fill', sec: 'tint', padPt: 8, bandPadPt: 12 } }
    },
    {
      templateId: 'monochrome',
      name: 'Monochrome',
      summary: 'Near-black on white under 1.2pt rules. No hue anywhere on the page.',
      description: 'A black-and-white document that is not the print-safe one. Tahoma with a 1.2pt rule under a title-case heading, an ink accent that never moves off grey-black, and a mark under every section: structure that survives a photocopier two generations old, which eats anything lighter than a rule. Nothing here depends on a colour to be understood.',
      tags: ['monochrome', 'print safe', 'no colour'],
      fontFamily: 'tahoma',
      baseSizePt: 10.8,
      lineHeight: 1.4,
      measureEm: 40,
      accent: PALETTE.ink.hex,
      headingStyle: 'rule',
      ruleWeight: 2,
      sectionGapPt: 15,
      entryGapPt: 8,
      marginsIn: 0.7,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0
    },
    {
      templateId: 'dense',
      name: 'High density',
      summary: '9pt on a 50 em measure with the years in a gutter. A career on a page.',
      description: 'For a thirty-year career that will not fit on one page at 11pt. 9pt on a 50 em measure at a 1.16 leading, 3pt between jobs, a third of an inch of margin and the dates dropped into a hanging gutter so they cost no horizontal room. Roughly twice the content of the compact template on A4. Read it on a screen or at 100%: this is not a page to print at 60%.',
      tags: ['dense', 'high density', 'A4'],
      fontFamily: 'system',
      baseSizePt: 9,
      lineHeight: 1.16,
      measureEm: 50,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.6,
      sectionGapPt: 7,
      entryGapPt: 3,
      marginsIn: 0.35,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { entry: 'dates', dateEm: 8 } }
    },
    {
      templateId: 'wide',
      name: 'Wide measure',
      summary: 'The text runs the width of the sheet. 46 ems of line, and no rules.',
      description: 'For a long, narrative career where the section labels are the index. The measure is 46 ems inside 0.45in margins, so a line runs almost the whole width of the sheet — about seventy-six characters, past what comfortable prose wants and as wide as a résumé can honestly be. No rule under the header and none under the headings: on a page this wide the only thing that would break the line of text is another line of text.',
      tags: ['wide measure', 'one column', 'no rules'],
      fontFamily: 'system',
      baseSizePt: 11.5,
      lineHeight: 1.45,
      measureEm: 46,
      accent: PALETTE.graphite.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 16,
      entryGapPt: 8,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { headRules: 'none' } }
    },
    {
      templateId: 'narrow',
      name: 'Narrow measure',
      summary: 'A 26 em column centred on the page. Nothing on it but type.',
      description: 'The narrowest measure in the set, for a writer, a curator or a researcher who wants a page that reads like a column of print rather than a form. 26 ems at 11.5pt on a 1.65 leading, centred, which leaves more than an inch of white on each side of every line and one page of honest white at the foot. A centred header on top of it, because a column wants a masthead.',
      tags: ['narrow measure', 'serif', 'airy'],
      fontFamily: 'georgia',
      baseSizePt: 11.5,
      lineHeight: 1.65,
      measureEm: 26,
      accent: PALETTE.forest.hex,
      headingStyle: 'title',
      ruleWeight: 0.5,
      sectionGapPt: 22,
      entryGapPt: 11,
      marginsIn: 1.15,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: false,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { head: 'center', headRules: 'none' } }
    },
    {
      templateId: 'archive',
      name: 'Archive',
      summary: 'Garamond with numbered sections, set like a finding aid.',
      description: 'For archivists, records managers, cataloguers and historians, whose CV is a finding aid and should look like one. Garamond at a 12pt optical size, a thin rule down the left of every section, sections numbered 01, 02, 03 in a pale figure beside the label, square bullets, and print-safe throughout, because the reading room this is written for has a photocopier and nothing else. The numbers are drawn by the stylesheet, so they never reach the text layer.',
      tags: ['archival', 'serif', 'numbered'],
      fontFamily: 'garamond',
      baseSizePt: 9.4,
      lineHeight: 1.34,
      measureEm: 46,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.6,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { number: 'decimal', sec: 'bar', barPt: 2, headRules: 'none' } }
    },
    {
      templateId: 'counsel',
      name: 'Counsel',
      summary: 'A classical Garamond CV: centred name, photograph, A4, ruled.',
      description: 'For bar admissions, clerkships and in-house counsel, where the CV is read by a panel expecting a formal document rather than a personal one. A classical serif at a 12pt optical size, a centred name block with the photograph beside it, a rule under every heading, and A4. The education and honours sections get the air a panel expects them to be given, on a page that is otherwise dense with matter.',
      tags: ['legal', 'serif', 'photo'],
      fontFamily: 'garamond',
      baseSizePt: 9.4,
      lineHeight: 1.4,
      measureEm: 36,
      accent: PALETTE.ink.hex,
      headingStyle: 'rule',
      ruleWeight: 1.2,
      sectionGapPt: 14,
      entryGapPt: 7,
      marginsIn: 0.9,
      columns: 1,
      photoSlot: true,
      bulletGlyph: 'square',
      printSafe: false,
      pageSize: 'A4',
      letterSpacing: 0,
      layout: { structure: { head: 'center' } }
    },
    {
      templateId: 'monospace',
      name: 'Monospace',
      summary: 'A screen monospace with a hairline between every job.',
      description: 'For systems, infrastructure and data work, where a monospaced page is a claim about how you read. Consolas or its equivalent at 10.5pt on a 48 em measure, a hairline between every job and nothing else, and no colour to soften it. It costs characters per line: a sentence of prose needs a wider measure here than anywhere else in the set, and that is the trade the summary is making.',
      tags: ['monospace', 'technical', 'dense'],
      fontFamily: 'mono',
      baseSizePt: 9.7,
      lineHeight: 1.3,
      measureEm: 48,
      accent: PALETTE.graphite.hex,
      headingStyle: 'uppercase',
      ruleWeight: 0.75,
      sectionGapPt: 12,
      entryGapPt: 6,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'disc',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { entry: 'hair', headRules: 'none' } }
    },
    {
      templateId: 'compliance',
      name: 'Compliance',
      summary: 'A thick bar down every section and a double rule under the header.',
      description: 'For quality, compliance and regulatory roles, where a CV is evidence and the reader is looking for the certificate behind each claim. A five-point bar runs down the left of every section, a double rule closes the header, and the page itself is upright, square-bulleted and uncoloured — the layout of a controlled document rather than a piece of self-promotion.',
      tags: ['compliance', 'one column', 'print safe'],
      fontFamily: 'system',
      baseSizePt: 10,
      lineHeight: 1.28,
      measureEm: 45,
      accent: PALETTE.ink.hex,
      headingStyle: 'uppercase',
      ruleWeight: 1.8,
      sectionGapPt: 10,
      entryGapPt: 4,
      marginsIn: 0.45,
      columns: 1,
      photoSlot: false,
      bulletGlyph: 'square',
      printSafe: true,
      pageSize: 'Letter',
      letterSpacing: 0,
      layout: { structure: { sec: 'bar', barPt: 5, headRules: 'double' } }
    }
  ];

  /* Registered as extra batches rather than spliced into the literal above: the
   * registry is one list with three provenances, and a new template lands at
   * the end of it either way. */
  TEMPLATES = TEMPLATES.concat(STRUCTURAL_TEMPLATES, JOB_TEMPLATES);

  /* design.templateId is free text and an imported resume carries whatever its
   author typed, so the lookup table must not answer from the prototype chain:
   BY_ID['toString'] would resolve to a function and every consumer would then
   read `preset.layout.mode` off Object.prototype. */
  var BY_ID = Object.create(null);
  TEMPLATES.forEach(function (t) { BY_ID[t.templateId] = t; });

  /* Only these keys are written to resume.design. model.validate drops
   * anything else, so preset metadata (name, tags, layout) stays here. */
  var DESIGN_KEYS = [
    'templateId', 'fontFamily', 'baseSizePt', 'lineHeight', 'accent', 'headingStyle',
    'ruleWeight', 'sectionGapPt', 'entryGapPt', 'marginsIn', 'columns', 'photoSlot',
    'bulletGlyph', 'printSafe', 'pageSize', 'letterSpacing'
  ];

  var HEADING_STYLES = [
    { value: 'uppercase', label: 'Uppercase' },
    { value: 'title', label: 'Title case' },
    { value: 'rule', label: 'Rule under the heading' }
  ];

  var PAGE_SIZES = [
    { value: 'Letter', label: 'US Letter' },
    { value: 'A4', label: 'A4' }
  ];

  function clone(t) {
    if (!t) return null;
    var out = Object.assign({}, t);
    if (t.layout) {
      out.layout = Object.assign({}, t.layout, { sidebarTypes: (t.layout.sidebarTypes || []).slice() });
      /* A clone that shares the shape table can be written through by a caller
       * and corrupt the preset behind it. */
      if (t.layout.structure) out.layout.structure = Object.assign({}, t.layout.structure);
    }
    return out;
  }

  function all() { return TEMPLATES.map(clone); }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    return clone(BY_ID[id] || null);
  }

  /* Internal, non-cloning lookup for the painter. */
  function raw(id) { return (typeof id === 'string' && BY_ID[id]) ? BY_ID[id] : null; }

  function fontOf(key) { return FONTS[key] || FONTS.system; }

  function sizePt(design) {
    var base = Number(design && design.baseSizePt);
    if (!isFinite(base) || base <= 0) base = REF_PT;
    return base * (fontOf(design && design.fontFamily).standardSizePt / REF_PT);
  }

  function designOf(preset) {
    var out = {};
    DESIGN_KEYS.forEach(function (k) {
      if (preset[k] !== undefined) out[k] = preset[k];
    });
    return out;
  }

  function docVars(design, preset) {
    var d = design || {};
    var p = preset || raw(d.templateId) || raw('classic');
    var layout = (p && p.layout) || null;
    var bullet = BULLET_GLYPHS[d.bulletGlyph] || BULLET_GLYPHS.disc;
    var measure = Number(p && p.measureEm);
    var vars = {
      '--rb-doc-font': fontOf(d.fontFamily).stack,
      '--rb-doc-size': sizePt(d).toFixed(2) + 'pt',
      '--rb-doc-leading': String(Number(d.lineHeight) || 1.32),
      '--rb-doc-measure': (isFinite(measure) && measure > 0 ? measure : 38) + 'em',
      '--rb-doc-accent': d.accent || PALETTE.graphite.hex,
      '--rb-doc-heading-style': d.headingStyle || 'uppercase',
      '--rb-doc-rule': ((Number(d.ruleWeight) || 1) * 0.6).toFixed(2) + 'pt',
      '--rb-doc-section-gap': (Number(d.sectionGapPt) || 0) + 'pt',
      '--rb-doc-entry-gap': (Number(d.entryGapPt) || 0) + 'pt',
      '--rb-doc-margin': (Number(d.marginsIn) || 0.6) + 'in',
      '--rb-doc-tracking': (Number(d.letterSpacing) || 0) + 'em',
      '--rb-doc-bullet': bullet === 'none' ? 'none' : '"' + bullet + '"',
      '--rb-doc-columns': String(d.columns === 2 ? 2 : 1),
      '--rb-doc-page-size': d.pageSize === 'A4' ? 'A4' : 'Letter',
      '--rb-doc-photo-slot': d.photoSlot ? 'block' : 'none',
      '--rb-doc-print-safe': d.printSafe ? '1' : '0',
      '--rb-doc-sidebar-width': layout && layout.mode === 'sidebar'
        ? (layout.sidebarWidthPct || 32) + '%'
        : '0%'
    };
    /* The shape a preset asked for, painted as lengths as well as attributes
     * so a rule can size a box from the same source the attribute names. */
    var lengths = structureVars(p);
    for (var L in lengths) {
      if (Object.prototype.hasOwnProperty.call(lengths, L)) vars[L] = lengths[L];
    }
    return vars;
  }

  function docEl() {
    if (U && typeof U.qs === 'function') return U.qs(DOC_SELECTOR);
    return global.document ? global.document.querySelector(DOC_SELECTOR) : null;
  }

  var lastPaint = '';

  function paint(design) {
    var doc = docEl();
    if (!doc || !design) return false;
    var preset = raw(design.templateId);
    var vars = docVars(design, preset);
    var shapes = structureOf(preset);
    var templateId = preset ? preset.templateId : (design.templateId || 'classic');
    var signature = templateId + '|' + JSON.stringify(vars) + '|' + JSON.stringify(shapes);
    if (signature === lastPaint) return true;
    lastPaint = signature;
    doc.setAttribute('data-template', templateId);
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) doc.style.setProperty(k, vars[k]);
    }
    /* The shapes go on as attributes, always all of them, so the document
     * describes its own layout to anyone reading it and templates.css never
     * has to know a template's name. */
    STRUCT_AXES.forEach(function (axis) {
      doc.setAttribute('data-struct-' + axis.attr, shapes[axis.attr]);
    });
    return true;
  }

  function warn(message) {
    if (global.RB && global.RB.ui && typeof global.RB.ui.toast === 'function') {
      global.RB.ui.toast(message, { tone: 'error' });
    }
  }

  function announce(message) {
    if (U && typeof U.announce === 'function') U.announce(message);
  }

  function applyPreset(preset) {
    var store = global.RB.store;
    if (!store || typeof store.update !== 'function') {
      warn('The document is still loading. Try again in a moment.');
      return null;
    }
    store.update(function (draft) {
      draft.design = Object.assign({}, draft.design, designOf(preset));
      return true;
    }, { source: 'template', coalesce: false });

    var design = (store.get() || {}).design;
    if (design) paint(design);
    announce('Template set to ' + preset.name + '.');
    return preset.templateId;
  }

  /* Always resolves to the applied templateId, or null if it could not be
   * applied. Waiting on the store is the only async case. */
  function apply(id) {
    var preset = raw(id);
    if (!preset) {
      warn('There is no template called "' + id + '".');
      return Promise.resolve(null);
    }
    var store = global.RB.store;
    if (store && typeof store.isReady === 'function' && !store.isReady() && typeof store.whenReady === 'function') {
      return store.whenReady().then(function () { return applyPreset(preset); });
    }
    return Promise.resolve(applyPreset(preset));
  }

  function fontList() {
    return Object.keys(FONTS).map(function (key) {
      var f = FONTS[key];
      return {
        key: key, label: f.label, category: f.category, stack: f.stack,
        standardSizePt: f.standardSizePt, opticalScale: f.standardSizePt / REF_PT
      };
    });
  }

  function options(values, unit) {
    return values.map(function (v) {
      return { value: v, label: unit ? v + unit : String(v) };
    });
  }

  function accentList() {
    return Object.keys(PALETTE).map(function (key) {
      return { value: PALETTE[key].hex, label: key.charAt(0).toUpperCase() + key.slice(1), token: PALETTE[key].token };
    });
  }

  function bulletList() {
    return Object.keys(BULLET_GLYPHS).map(function (key) {
      return { value: key, label: key.charAt(0).toUpperCase() + key.slice(1), glyph: BULLET_GLYPHS[key] };
    });
  }

  /* The design-token catalogue the Design panel builds its controls from.
   * Every value here is inside the range model.validate accepts, so nothing
   * offered to the user can be rejected on save. baseSizePt starts at 9
   * because that is the floor in model.validate: 8 and 8.5 were listed here,
   * every one of them came back as 9, and the control snapped under the user's
   * finger with nothing saying why. */
  function tokenPresets() {
    return {
      templates: all(),
      fonts: fontList(),
      referenceSizePt: REF_PT,
      sizes: options([9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16]),
      lineHeights: options([1.1, 1.2, 1.32, 1.4, 1.5, 1.6]),
      sectionGaps: options([6, 10, 14, 18, 24, 32]),
      entryGaps: options([3, 5, 7, 9, 12]),
      margins: options([0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2], 'in'),
      letterSpacings: options([0, 0.01, 0.02, 0.04]),
      headingStyles: HEADING_STYLES.slice(),
      bulletGlyphs: bulletList(),
      accents: accentList(),
      pageSizes: PAGE_SIZES.slice(),
      columns: [{ value: 1, label: 'One column' }, { value: 2, label: 'Two columns' }],
      photoSlots: [{ value: false, label: 'No photo' }, { value: true, label: 'Photo slot' }],
      printSafe: [{ value: false, label: 'Colour allowed' }, { value: true, label: 'Black and white' }]
    };
  }

  function currentDesign() {
    var store = global.RB.store;
    var state = store && typeof store.get === 'function' ? store.get() : null;
    return (state && state.design) || (global.RB.model && global.RB.model.DEFAULT_DESIGN) || null;
  }

  if (global.RB.bus && typeof global.RB.bus.on === 'function') {
    global.RB.bus.on('change', function (payload) {
      var state = payload && payload.state;
      if (state && state.design) paint(state.design);
    });
  }

  if (global.RB.store) {
    if (typeof global.RB.store.isReady === 'function' && global.RB.store.isReady()) paint(currentDesign());
    else if (typeof global.RB.store.whenReady === 'function') {
      global.RB.store.whenReady().then(function (state) {
        if (state && state.design) paint(state.design);
      });
    }
  }

  global.RB.templates = {
    all: all,
    get: get,
    apply: apply,
    tokenPresets: tokenPresets,
    docVars: docVars,
    paint: paint,
    fonts: FONTS
  };
})(window);
