/* Resumeboard — Microsoft Word (.docx) export
 *
 * A .docx is a ZIP of WordprocessingML parts, so this file is two things:
 * a ZIP writer (local file headers + central directory, deflate-raw through
 * RB.utils.deflate, CRC through RB.utils.crc32) and a WordprocessingML emitter.
 * No libraries, no network, runs from file://.
 */
(function (global) {
  'use strict';

  var U = global.RB && global.RB.utils;
  if (!U) return;
  var model = global.RB.model;

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  var REL = {
    officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    appProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
    styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
  };
  var CT = {
    styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
    appProps: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
  };

  /* styles.xml takes literal hex; a document package has no token indirection.
   * Only the accent comes from the model. */
  var META_HEX = '595959';
  var LINK_HEX = '0563C1';

  var FONTS = {
    system: 'Calibri', sans: 'Calibri', calibri: 'Calibri', grotesk: 'Calibri',
    serif: 'Cambria', georgia: 'Cambria', cambria: 'Cambria', editorial: 'Cambria',
    mono: 'Consolas', consolas: 'Consolas', code: 'Consolas'
  };
  var BULLETS = { disc: '•', square: '▪', dash: '–', none: '' };
  var PAGE = { Letter: [12240, 15840], A4: [11906, 16838] };
  var IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg' };
  var EMU_PER_INCH = 914400;
  var PHOTO_INCHES = 1.15;

  // ---------------------------------------------------------------- XML text

  /* XML 1.0 forbids most C0 controls outright; Word rejects the whole part. */
  var ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(ILLEGAL_XML, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };

  function decodeEntity(token) {
    var body = token.slice(1, -1);
    if (body.charAt(0) === '#') {
      var hexish = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      var code = hexish ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
    }
    var named = NAMED_ENTITIES[body.toLowerCase()];
    return named == null ? token : named;
  }

  function hex(value) {
    var s = String(value == null ? '' : value).trim();
    if (!U.isValidHexColor(s)) return '000000';
    s = s.replace('#', '').toUpperCase();
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return s;
  }

  function pickFont(value) {
    return FONTS[String(value || '').toLowerCase()] || FONTS.system;
  }

  function trim(value) {
    return String(value == null ? '' : value).trim();
  }

  // -------------------------------------------------------------- run / para

  /* Child order inside w:rPr and w:pPr is fixed by the OOXML schema. Word
   * tolerates deviations; Google Docs and validators do not. */
  function rPr(o) {
    if (!o) return '';
    var s = '';
    if (o.style) s += '<w:rStyle w:val="' + esc(o.style) + '"/>';
    if (o.bold) s += '<w:b/>';
    if (o.italic) s += '<w:i/>';
    if (o.strike) s += '<w:strike/>';
    if (o.underline) s += '<w:u w:val="single"/>';
    return s ? '<w:rPr>' + s + '</w:rPr>' : '';
  }

  function pPr(o) {
    if (!o) return '';
    var s = '<w:pPr>';
    if (o.style) s += '<w:pStyle w:val="' + esc(o.style) + '"/>';
    if (o.bidi) s += '<w:bidi/>';
    if (o.before != null || o.after != null) {
      s += '<w:spacing';
      if (o.before != null) s += ' w:before="' + Math.max(0, Math.round(o.before)) + '"';
      if (o.after != null) s += ' w:after="' + Math.max(0, Math.round(o.after)) + '"';
      s += '/>';
    }
    if (o.left != null) s += '<w:ind w:left="' + Math.max(0, Math.round(o.left)) + '"/>';
    if (o.jc) s += '<w:jc w:val="' + esc(o.jc) + '"/>';
    return s + '</w:pPr>';
  }

  function run(text, o) {
    return '<w:r>' + rPr(o) + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }

  function brk() { return '<w:r><w:br/></w:r>'; }

  function para(content, o) {
    var inner = Array.isArray(content) ? content.filter(Boolean).join('') : (content || '');
    return '<w:p>' + pPr(o) + inner + '</w:p>';
  }

  /* A model field, not a string: it may carry the inline HTML the binder is
   * allowed to produce, so it goes through runsFromHtml. A value with no tag
   * and no entity in it short-circuits to a single run and behaves exactly
   * like a plain run. */
  function textRun(value, o) {
    var t = trim(value);
    return t ? runsXml(t, o) : '';
  }

  /* textRun trims, which eats the space a label relies on ("Skills: Figma" would
   * become "Skills:Figma"). Use this when the leading or trailing space is
   * part of the design. */
  function rawRun(value, o) {
    return value ? runsXml(value, o) : '';
  }

  // ------------------------------------------------- inline HTML -> w:r runs

  /* Model fields hold inline HTML (RB.utils.textToHtml output), not plain
   * text. Only the formatting the editor is allowed to produce is honoured;
   * any other tag is dropped but the text it wrapped is kept. */
  var INLINE = {
    b: { bold: true }, strong: { bold: true },
    i: { italic: true }, em: { italic: true }, cite: { italic: true },
    u: { underline: true }, ins: { underline: true },
    s: { strike: true }, strike: { strike: true }, del: { strike: true },
    span: {}, a: {}
  };

  function mergeOpts(base, stack) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    stack.forEach(function (level) {
      Object.keys(level).forEach(function (k) {
        if (level[k]) out[k] = level[k];
        else delete out[k];
      });
    });
    return out;
  }

  var INLINE_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?>|&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

  function runsFromHtml(value, base) {
    var text = value == null ? '' : String(value);
    if (!text) return [];
    if (text.indexOf('<') === -1 && text.indexOf('&') === -1) return [run(text, base)];

    var out = [], tags = [], stack = [], buf = '', at = 0, m;
    INLINE_RE.lastIndex = 0;
    function flush() {
      if (buf) { out.push(run(buf, mergeOpts(base, stack))); buf = ''; }
    }
    while ((m = INLINE_RE.exec(text)) !== null) {
      buf += text.slice(at, m.index);
      at = INLINE_RE.lastIndex;
      if (m[0].charAt(0) === '<') {
        var closing = m[0].charAt(1) === '/';
        var tag = m[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(INLINE, tag)) continue;
        if (tag === 'br') {
          if (closing) continue;
          flush();
          out.push(brk());
          continue;
        }
        flush();
        if (closing) {
          for (var i = stack.length - 1; i >= 0; i--) {
            if (tags[i] === tag) { stack.length = i; tags.length = i; break; }
          }
        } else {
          tags.push(tag);
          stack.push(INLINE[tag]);
        }
      } else {
        buf += decodeEntity(m[0]);
      }
    }
    buf += text.slice(at);
    flush();
    return out;
  }

  function runsXml(value, base) { return runsFromHtml(value, base).join(''); }

  /* A blank line starts a new Word paragraph; a single newline is a line
   * break inside one. An empty value yields no paragraph at all. */
  function textPara(value, opts, base) {
    if (!trim(value)) return '';
    return String(value).split(/\r?\n[ \t]*\r?\n/)
      .map(trim)
      .filter(Boolean)
      .map(function (block) {
        var runs = [];
        block.split(/\r?\n/).forEach(function (line, i) {
          if (i) runs.push(brk());
          runs = runs.concat(runsFromHtml(line, base));
        });
        return para(runs, opts);
      })
      .join('');
  }

  function entryTitle(value, base) {
    if (!trim(value)) return '';
    return para(runsXml(value, base), { style: 'EntryTitle' });
  }

  // ------------------------------------------------------------------- rels

  function Rels() {
    this.items = [
      { id: 'rId1', type: REL.styles, target: 'styles.xml' },
      { id: 'rId2', type: REL.numbering, target: 'numbering.xml' }
    ];
    this.next = 10;
  }

  Rels.prototype.add = function (type, target, mode) {
    var id = 'rId' + (this.next++);
    this.items.push({ id: id, type: type, target: target, mode: mode || null });
    return id;
  };

  /* A relationship target is an XML attribute: strip anything that could
   * break out of it or inject a header into a mailto: link. */
  function relTarget(value) {
    return esc(String(value || '').replace(/[\u0000-\u0020<>"]/g, ''));
  }

  Rels.prototype.xml = function () {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
    this.items.forEach(function (item) {
      out.push('<Relationship Id="' + item.id + '" Type="' + item.type + '" Target="' + relTarget(item.target) + '"' +
        (item.mode ? ' TargetMode="' + item.mode + '"' : '') + '/>');
    });
    out.push('</Relationships>');
    return out.join('');
  };

  // -------------------------------------------------------------- numbering

  function numberingXml(design) {
    var known = Object.prototype.hasOwnProperty.call(BULLETS, design.bulletGlyph);
    var glyph = known ? BULLETS[design.bulletGlyph] : BULLETS.disc;
    var fmt = design.bulletGlyph === 'none' ? 'none' : 'bullet';
    var font = fmt === 'none' ? null : 'Arial';
    var levels = [0, 1, 2].map(function (i) {
      return '<w:lvl w:ilvl="' + i + '">' +
        '<w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/>' +
        '<w:lvlText w:val="' + esc(glyph) + '"/><w:lvlJc w:val="left"/>' +
        '<w:pPr><w:ind w:left="' + (360 + i * 360) + '" w:hanging="180"/></w:pPr>' +
        (font ? '<w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:cs="' + font + '" w:hint="default"/></w:rPr>' : '') +
        '</w:lvl>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>' + levels + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '</w:numbering>';
  }

  // ----------------------------------------------------------------- styles

  function stylesXml(design) {
    var font = pickFont(design.fontFamily);
    var basePt = U.clamp(Number(design.baseSizePt) || 10.5, 7.5, 14);
    var half = function (pt) { return Math.max(12, Math.round(pt * 2)); };
    var line = Math.round(U.clamp(Number(design.lineHeight) || 1.32, 1.05, 2) * 240);
    var accent = hex(design.accent);
    var caps = design.headingStyle === 'uppercase' ? '<w:caps/>' : '';
    var rule = design.headingStyle === 'rule'
      ? '<w:pBdr><w:bottom w:val="single" w:sz="' + Math.max(2, Math.round((design.ruleWeight || 1) * 8)) +
        '" w:space="2" w:color="' + accent + '"/></w:pBdr>'
      : '';
    var tracking = design.letterSpacing
      ? '<w:spacing w:val="' + Math.round(design.letterSpacing * 20) + '"/>'
      : '';
    var sectionBefore = Math.max(0, Math.round((design.sectionGapPt || 0) * 20));
    var entryBefore = Math.max(0, Math.round((design.entryGapPt || 0) * 20));

    var docDefaults =
      '<w:docDefaults>' +
      '<w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:cs="' + font + '"/>' +
      '<w:sz w:val="' + half(basePt) + '"/><w:szCs w:val="' + half(basePt) + '"/>' +
      '<w:lang w:val="' + esc(U.LOCALE.lang) + '"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr>' + (U.LOCALE.rtl ? '<w:bidi/>' : '') +
      '<w:spacing w:after="60" w:line="' + line + '" w:lineRule="auto"/>' +
      '</w:pPr></w:pPrDefault>' +
      '</w:docDefaults>';

    function style(id, name, o) {
      return '<w:style w:type="' + o.type + '"' + (o.def ? ' w:default="1"' : '') + ' w:styleId="' + id + '">' +
        '<w:name w:val="' + esc(name) + '"/>' +
        (o.basedOn ? '<w:basedOn w:val="' + o.basedOn + '"/>' : '') +
        (o.next ? '<w:next w:val="' + o.next + '"/>' : '') +
        (o.type === 'paragraph' ? '<w:qFormat/>' : '') +
        (o.p || '') + (o.r || '') + '</w:style>';
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      docDefaults +
      style('Normal', 'Normal', {
        type: 'paragraph', def: true,
        p: '<w:pPr><w:spacing w:after="60" w:line="' + line + '" w:lineRule="auto"/></w:pPr>'
      }) +
      style('Title', 'Title', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="20"/><w:jc w:val="center"/></w:pPr>',
        r: '<w:rPr><w:b/>' + caps + '<w:color w:val="' + accent + '"/>' + tracking +
          '<w:sz w:val="' + half(basePt * 1.6) + '"/><w:szCs w:val="' + half(basePt * 1.6) + '"/></w:rPr>'
      }) +
      style('Subtitle', 'Subtitle', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="40"/><w:jc w:val="center"/></w:pPr>',
        r: '<w:rPr><w:color w:val="' + accent + '"/><w:sz w:val="' + half(basePt + 1.5) +
          '"/><w:szCs w:val="' + half(basePt + 1.5) + '"/></w:rPr>'
      }) +
      style('Heading1', 'heading 1', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:keepNext/>' + rule + '<w:spacing w:before="' + sectionBefore + '" w:after="70"/>' +
          '<w:outlineLvl w:val="0"/></w:pPr>',
        r: '<w:rPr><w:b/>' + caps + '<w:color w:val="' + accent + '"/>' + tracking +
          '<w:sz w:val="' + half(basePt + 1) + '"/><w:szCs w:val="' + half(basePt + 1) + '"/></w:rPr>'
      }) +
      style('ListParagraph', 'List Paragraph', {
        type: 'paragraph', basedOn: 'Normal',
        p: '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' +
          '<w:spacing w:after="40"/><w:ind w:left="360" w:hanging="180"/>' +
          '<w:contextualSpacing/><w:jc w:val="left"/></w:pPr>'
      }) +
      style('EntryTitle', 'Entry Title', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:keepNext/><w:spacing w:before="' + entryBefore + '" w:after="0"/></w:pPr>',
        r: '<w:rPr><w:b/><w:color w:val="' + accent + '"/></w:rPr>'
      }) +
      style('RoleLine', 'Role Line', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/></w:pPr>',
        r: '<w:rPr><w:b/></w:rPr>'
      }) +
      style('MetaLine', 'Meta Line', {
        type: 'paragraph', basedOn: 'Normal', next: 'Normal',
        p: '<w:pPr><w:spacing w:before="0" w:after="40"/></w:pPr>',
        r: '<w:rPr><w:color w:val="' + META_HEX + '"/><w:sz w:val="' + half(basePt - 1) +
          '"/><w:szCs w:val="' + half(basePt - 1) + '"/></w:rPr>'
      }) +
      style('Hyperlink', 'Hyperlink', {
        type: 'character',
        r: '<w:rPr><w:color w:val="' + LINK_HEX + '"/><w:u w:val="single"/></w:rPr>'
      }) +
      '</w:styles>';
  }

  // ------------------------------------------------------------------ image

  function beU16(bytes, at) { return (bytes[at] << 8) | bytes[at + 1]; }
  function beU32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  }

  /* Declared pixel size stops Word stretching a photo. Only SOF markers are
   * read; EXIF orientation is out of scope. */
  function imageSize(bytes, ext) {
    if (ext === 'png' && bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
        bytes[2] === 0x4E && bytes[3] === 0x47) {
      return { w: beU32(bytes, 16), h: beU32(bytes, 20) };
    }
    if (ext !== 'jpg') return null;
    var at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xFF) { at++; continue; }
      var marker = bytes[at + 1];
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { at += 2; continue; }
      var isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      var size = beU16(bytes, at + 2);
      if (isSof) return { w: beU16(bytes, at + 7), h: beU16(bytes, at + 5) };
      at += 2 + size;
    }
    return null;
  }

  function photoDrawing(dataUrl, ctx) {
    var m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!m || !IMAGE_MIME[m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()]) return '';
    var ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();

    var bytes;
    try { bytes = U.base64ToBytes(m[2]); } catch (e) { return ''; }
    var size = bytes && bytes.length ? imageSize(bytes, ext) : null;
    if (!size || !(size.w > 0) || !(size.h > 0)) return '';

    /* A truncated or malformed header must never reach the part as a NaN
     * extent; clamp the ratio to something a portrait or landscape can be. */
    var ratio = U.clamp(size.h / size.w, 0.25, 4);
    var cx = Math.round(PHOTO_INCHES * EMU_PER_INCH);
    var cy = Math.max(1, Math.round(cx * ratio));
    var target = 'media/photo.' + ext;
    var rid = ctx.rels.add(REL.image, target);
    ctx.media.push({ name: 'word/' + target, ext: ext, data: bytes });

    return para(
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:docPr id="1" name="Photo" descr=""/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="photo.' + ext + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
      { jc: 'right', before: 0, after: 80 }
    );
  }

  // ------------------------------------------------------------ text pieces

  function link(runs, url, ctx) {
    var safe = model.safeUrl(url);
    if (!safe) return runs;
    return '<w:hyperlink r:id="' + ctx.rels.add(REL.hyperlink, safe, 'External') + '">' + runs + '</w:hyperlink>';
  }

  function mailLink(value, ctx) {
    var addr = trim(value).replace(/[\s\u0000-\u001F]/g, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return textRun(value, null);
    return '<w:hyperlink r:id="' + ctx.rels.add(REL.hyperlink, 'mailto:' + addr, 'External') + '">' +
      run(addr, { style: 'Hyperlink' }) + '</w:hyperlink>';
  }

  function dateRange(start, end, current) {
    var from = trim(start);
    var to = current ? 'Present' : trim(end);
    if (from && to) return from + ' – ' + to;
    return from || to || '';
  }

  function joinMeta(parts) {
    return parts.map(trim).filter(Boolean).join(' · ');
  }

  function metaPara(parts) {
    var text = joinMeta(parts);
    return text ? para(textRun(text, null), { style: 'MetaLine' }) : '';
  }

  function labelledLine(label, value) {
    var text = trim(value);
    return text ? para(run(label, { bold: true }) + run(text, null), { style: 'MetaLine' }) : '';
  }

  /* Users paste their own bullets, glyphs and all. Word adds its own marker
   * from the ListParagraph style, so a pasted "•" would show twice. A leading
   * dash or digit only counts when a space follows, so "-5% margin" survives. */
  var LEAD_MARK = /^(?:[\s*•▪‣⁓·]+|[-–—+]\s+|\d{1,2}[.)]\s+)/;

  function stripLeadMarks(value) {
    return String(value == null ? '' : value)
      .split(/\r?\n/)
      .map(function (line) { return line.replace(LEAD_MARK, ''); })
      .join('\n');
  }

  function bullets(items) {
    return (items || [])
      .map(function (item) { return textPara(stripLeadMarks(item), { style: 'ListParagraph' }); })
      .filter(Boolean)
      .join('');
  }

  function commaList(items) {
    return (items || []).map(trim).filter(Boolean).join(', ');
  }

  function visibleEntries(resume, type) {
    return model.sectionEntries(resume, type).filter(function (entry) {
      return entry && entry.visible !== false && !model.isBlankEntry(entry);
    });
  }

  // ------------------------------------------------------- section renderers

  function renderSummary(resume) {
    return textPara((resume.basics || {}).summary, null);
  }

  function renderExperience(resume, ctx) {
    return visibleEntries(resume, 'experience').map(function (entry) {
      var company = trim(entry.company);
      if (entry.companyEntity) {
        company += (company && !/,\s*$/.test(company) ? ', ' : '') + trim(entry.companyEntity);
      }
      var out = entryTitle(company);

      var roles = (entry.roles || []).filter(function (r) { return r && r.visible !== false; });
      if (!roles.length) return out + metaPara([entry.location, entry.url]);

      roles.forEach(function (role, i) {
        out += metaPara(i === 0
          ? [entry.location, dateRange(role.start, role.end, role.current), entry.url]
          : [dateRange(role.start, role.end, role.current)]);
        if (trim(role.position)) out += para(textRun(role.position, null), { style: 'RoleLine' });
        out += textPara(role.summary, null);
        out += bullets(role.highlights);
        out += labelledLine('Skills: ', commaList(role.skills));
      });
      return out;
    }).join('');
  }

  function renderEducation(resume) {
    return visibleEntries(resume, 'education').map(function (entry) {
      var institution = trim(entry.institution);
      var headline = joinMeta([entry.studyType, entry.area]) || institution || 'Education';
      var out = entryTitle(headline);
      out += metaPara([
        headline === institution ? '' : institution,
        dateRange(entry.start, entry.end, false),
        entry.score,
        entry.url
      ]);
      out += labelledLine('Coursework: ', commaList(entry.courses));
      return out;
    }).join('');
  }

  function renderSkills(resume) {
    return visibleEntries(resume, 'skills').map(function (entry) {
      var keywords = commaList(entry.keywords);
      if (!trim(entry.label)) return para(textRun(keywords, null), null);
      return para(textRun(entry.label, { bold: true }) + textRun(keywords ? ': ' + keywords : '', null), null);
    }).join('');
  }

  function renderProjects(resume) {
    return visibleEntries(resume, 'projects').map(function (entry) {
      var out = entryTitle(entry.name);
      out += metaPara([dateRange(entry.start, entry.end, entry.current), entry.url]);
      out += textPara(entry.summary, null);
      out += bullets(entry.highlights);
      out += labelledLine('Keywords: ', commaList(entry.keywords));
      return out;
    }).join('');
  }

  function renderCertifications(resume) {
    return visibleEntries(resume, 'certifications').map(function (entry) {
      return entryTitle(entry.name) +
        metaPara([entry.issuer, entry.date, entry.credentialId, entry.url]);
    }).join('');
  }

  function renderPublications(resume) {
    return visibleEntries(resume, 'publications').map(function (entry) {
      return entryTitle(entry.title, { italic: true }) +
        metaPara([entry.authors, entry.venue, entry.date, entry.doi, entry.url]);
    }).join('');
  }

  function renderAwards(resume) {
    return visibleEntries(resume, 'awards').map(function (entry) {
      return entryTitle(entry.title) + metaPara([entry.awarder, entry.date]);
    }).join('');
  }

  function renderVolunteer(resume) {
    return visibleEntries(resume, 'volunteer').map(function (entry) {
      /* Organisation first, the way the plain-text and Markdown exporters write
       * it, so all three read the same and a round-trip keeps the two apart. */
      var out = entryTitle(entry.organization || entry.role);
      out += metaPara([entry.organization ? entry.role : '', entry.location, dateRange(entry.start, entry.end, entry.current)]);
      out += bullets(entry.highlights);
      return out;
    }).join('');
  }

  function renderLanguages(resume) {
    return visibleEntries(resume, 'languages').map(function (entry) {
      var suffix = trim(entry.fluency);
      return para(textRun(entry.language, { bold: true }) + rawRun(suffix ? ' — ' + suffix : '', null), null);
    }).join('');
  }

  function renderInterests(resume) {
    var labels = visibleEntries(resume, 'interests').map(function (e) { return trim(e.label); }).filter(Boolean);
    return labels.length ? para(textRun(labels.join(', '), null), null) : '';
  }

  function renderReferences(resume) {
    return visibleEntries(resume, 'references').map(function (entry) {
      return entryTitle(entry.name) + metaPara([entry.label, entry.contact]);
    }).join('');
  }

  function renderCoursework(resume) {
    return visibleEntries(resume, 'coursework').map(function (entry) {
      return entryTitle(entry.name) + metaPara([entry.institution, entry.date, entry.url]);
    }).join('');
  }

  function renderPresentations(resume) {
    return visibleEntries(resume, 'presentations').map(function (entry) {
      var out = entryTitle(entry.title);
      out += metaPara([entry.event, entry.location, entry.date, entry.url]);
      out += bullets(entry.highlights);
      return out;
    }).join('');
  }

  function renderCustom(resume) {
    return visibleEntries(resume, 'custom').map(function (entry) {
      var subs = (entry.entries || []).filter(function (x) { return x && !model.isBlankEntry(x); });
      if (!subs.length) return textPara(entry.label, null);
      return subs.map(function (sub) {
        return entryTitle(sub.title) +
          metaPara([sub.org, dateRange(sub.start, sub.end, false)]) +
          textPara(sub.text, null);
      }).join('');
    }).join('');
  }

  var RENDERERS = {
    summary: renderSummary,
    experience: renderExperience,
    education: renderEducation,
    skills: renderSkills,
    projects: renderProjects,
    certifications: renderCertifications,
    publications: renderPublications,
    awards: renderAwards,
    volunteer: renderVolunteer,
    languages: renderLanguages,
    interests: renderInterests,
    references: renderReferences,
    coursework: renderCoursework,
    presentations: renderPresentations,
    custom: renderCustom
  };

  /* Sections drive order and visibility. A list that somehow lost its section
   * record (an older import) is appended rather than silently dropped. */
  function sectionPlan(resume) {
    var seen = {};
    var plan = model.orderedSections(resume).filter(function (sec) {
      if (!sec) return false;
      /* Marked before the visibility test, not after. A hidden section is
       * still a section: if it did not claim its type here, the fallback below
       * would see the type as unclaimed and put the hidden entries back. */
      if (seen[sec.type]) return false;
      seen[sec.type] = true;
      return sec.visible !== false;
    });
    model.SECTION_TYPES.forEach(function (def) {
      if (seen[def.type] || def.type === 'summary') return;
      if (!visibleEntries(resume, def.type).length) return;
      plan.push({ type: def.type, label: def.defaultLabel, order: 1e9 });
    });
    return plan;
  }

  // ------------------------------------------------------------ header / body

  /* The model stores the network as a lowercase key; a reader wants the name
   * the platform actually uses. Matches the plain-text and Markdown exporters. */
  var NETWORK_NAME = {
    linkedin: 'LinkedIn', github: 'GitHub', gitlab: 'GitLab', x: 'X', twitter: 'X',
    medium: 'Medium', dribbble: 'Dribbble', behance: 'Behance', youtube: 'YouTube',
    stackoverflow: 'Stack Overflow', dev: 'DEV'
  };

  function networkName(value) {
    var key = trim(value).toLowerCase();
    return NETWORK_NAME[key] || (key ? U.titleCase(key) : '');
  }

  function contactLine(resume, ctx) {
    var b = resume.basics || {};
    var loc = b.location || {};
    /* The same two parts, in the same order, joined the same way, as the page
     * and the text export. The country code is not part of it: a contact line
     * is a place someone recognises, not a postal address, and joining it with
     * the line's own middot reads as three separators in a row. */
    var place = [loc.city, loc.region].map(trim).filter(Boolean).join(', ');
    var parts = [
      b.email ? mailLink(b.email, ctx) : '',
      textRun(b.phone, null),
      b.url ? link(textRun(b.url, { style: 'Hyperlink' }), b.url, ctx) : '',
      textRun(place, null)
    ];
    (b.profiles || []).forEach(function (profile) {
      if (!profile) return;
      var handle = trim(profile.label);
      var net = networkName(profile.network);
      /* Two profiles often share one handle; without the network name the line
       * reads "alexrivera · alexrivera". */
      var label = handle && net && handle.toLowerCase() !== net.toLowerCase()
        ? net + ': ' + handle
        : (handle || net);
      if (!label && !profile.url) return;
      parts.push(profile.url
        ? link(textRun(label || profile.url, { style: 'Hyperlink' }), profile.url, ctx)
        : textRun(label, null));
    });
    var runs = [];
    parts.filter(Boolean).forEach(function (p, i) {
      if (i) runs.push(run(' · ', null));
      runs.push(p);
    });
    return runs.length ? para(runs, { style: 'MetaLine', jc: 'center' }) : '';
  }

  function hasVisibleText(xml) {
    return trim(String(xml || '').replace(/<[^>]*>/g, '')) !== '';
  }

  function sectionProperties(design) {
    var page = PAGE[design.pageSize] || PAGE.Letter;
    var margin = Math.round(U.clamp(Number(design.marginsIn) || 0.6, 0.2, 1.5) * 1440);
    var cols = design.columns === 2 ? 2 : 1;
    return '<w:sectPr>' +
      '<w:pgSz w:w="' + page[0] + '" w:h="' + page[1] + '"/>' +
      '<w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin +
      '" w:left="' + margin + '" w:header="576" w:footer="576" w:gutter="0"/>' +
      '<w:cols w:space="425" w:num="' + cols + '"' + (cols === 2 ? ' w:equalWidth="1"' : '') + '/>' +
      (U.LOCALE.rtl ? '<w:bidi/>' : '') +
      '</w:sectPr>';
  }

  function documentXml(resume, ctx) {
    var b = resume.basics || {};
    var body = [];

    if (ctx.design.photoSlot && b.photo) {
      var photo = photoDrawing(b.photo, ctx);
      if (photo) body.push(photo);
    }
    if (trim(b.name)) body.push(para(textRun(b.name, null), { style: 'Title' }));
    if (trim(b.label)) body.push(para(textRun(b.label, null), { style: 'Subtitle' }));
    var contact = contactLine(resume, ctx);
    if (contact) body.push(contact);

    sectionPlan(resume).forEach(function (sec) {
      var render = RENDERERS[sec.type];
      if (!render) return;
      var content = render(resume, ctx);
      if (!hasVisibleText(content)) return;
      body.push(para(textRun(sec.label, null), { style: 'Heading1' }));
      body.push(content);
    });

    if (!body.length) {
      body.push(para(textRun('This resume is empty.', { italic: true }), { jc: 'center' }));
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document ' +
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
      '><w:body>' + body.join('') + sectionProperties(ctx.design) + '</w:body></w:document>';
  }

  // ---------------------------------------------------------------- docProps

  function corePropsXml(resume) {
    var b = resume.basics || {};
    var meta = resume.meta || {};
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties ' +
      'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(trim(meta.title) || trim(b.label) || trim(b.name) || 'Resume') + '</dc:title>' +
      '<dc:subject>' + esc(trim(b.label)) + '</dc:subject>' +
      '<dc:creator>' + esc(trim(b.name) || 'Resume') + '</dc:creator>' +
      '<cp:keywords>' + esc([trim(meta.targetRole), trim(meta.targetCompany)].filter(Boolean).join(', ')) + '</cp:keywords>' +
      '<cp:lastModifiedBy>Resumeboard</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + esc(meta.createdAt || now) + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + esc(meta.updatedAt || now) + '</dcterms:modified>' +
      '<cp:revision>1</cp:revision>' +
      '</cp:coreProperties>';
  }

  function appPropsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties ' +
      'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Resumeboard</Application>' +
      '<DocSecurity>0</DocSecurity>' +
      '<ScaleCrop>false</ScaleCrop>' +
      '<Company></Company>' +
      '<LinksUpToDate>false</LinksUpToDate>' +
      '<SharedDoc>false</SharedDoc>' +
      '<HyperlinksChanged>false</HyperlinksChanged>' +
      '<AppVersion>1.0000</AppVersion>' +
      '</Properties>';
  }

  function contentTypesXml(mediaExts) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>'];
    mediaExts.forEach(function (ext) {
      out.push('<Default Extension="' + esc(ext) + '" ContentType="' + IMAGE_MIME[ext] + '"/>');
    });
    out.push('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>');
    out.push('<Override PartName="/word/styles.xml" ContentType="' + CT.styles + '"/>');
    out.push('<Override PartName="/word/numbering.xml" ContentType="' + CT.numbering + '"/>');
    out.push('<Override PartName="/docProps/core.xml" ContentType="' + CT.coreProps + '"/>');
    out.push('<Override PartName="/docProps/app.xml" ContentType="' + CT.appProps + '"/>');
    out.push('</Types>');
    return out.join('');
  }

  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + REL.officeDocument + '" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="' + REL.coreProps + '" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="' + REL.appProps + '" Target="docProps/app.xml"/>' +
      '</Relationships>';
  }

  // --------------------------------------------------------------------- ZIP

  function ByteList() {
    this.parts = [];
    this.size = 0;
  }
  ByteList.prototype.push = function (bytes) {
    this.parts.push(bytes);
    this.size += bytes.length;
    return this;
  };
  ByteList.prototype.u16 = function (v) {
    v = v & 0xFFFF;
    return this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]));
  };
  ByteList.prototype.u32 = function (v) {
    v = v >>> 0;
    return this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
  };
  ByteList.prototype.toBytes = function () {
    var out = new Uint8Array(this.size), at = 0;
    for (var i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], at);
      at += this.parts[i].length;
    }
    return out;
  };

  function dosStamp(d) {
    if (d.getFullYear() < 1980) return { time: 0, date: 33 };
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /* Bit 11 of the general-purpose flags marks names as UTF-8, which matters as
   * soon as a part path carries a non-ASCII character. Sizes are known before
   * the header is written, so no data descriptors are needed. */
  function buildZip(entries) {
    var stamp = dosStamp(new Date());
    return Promise.all(entries.map(function (entry) {
      return U.deflate(entry.data).then(function (zipped) {
        var useDeflate = zipped && zipped.length > 0 && zipped.length < entry.data.length;
        return {
          name: entry.name,
          method: useDeflate ? 8 : 0,
          data: useDeflate ? zipped : entry.data,
          raw: entry.data,
          crc: U.crc32(entry.data)
        };
      });
    })).then(function (files) {
      var out = new ByteList(), central = new ByteList();
      files.forEach(function (file) {
        var nameBytes = U.utf8(file.name);
        file.offset = out.size;
        out.u32(0x04034B50).u16(20).u16(0x0800).u16(file.method)
          .u16(stamp.time).u16(stamp.date)
          .u32(file.crc).u32(file.data.length).u32(file.raw.length)
          .u16(nameBytes.length).u16(0)
          .push(nameBytes).push(file.data);

        central.u32(0x02014B50).u16(20).u16(20).u16(0x0800).u16(file.method)
          .u16(stamp.time).u16(stamp.date)
          .u32(file.crc).u32(file.data.length).u32(file.raw.length)
          .u16(nameBytes.length).u16(0).u16(0)
          .u16(0).u16(0).u32(0)
          .u32(file.offset).push(nameBytes);
      });
      var cdOffset = out.size;
      out.push(central.toBytes());
      out.u32(0x06054B50).u16(0).u16(0)
        .u16(files.length).u16(files.length)
        .u32(central.size).u32(cdOffset).u16(0);
      return out.toBytes();
    });
  }

  // ------------------------------------------------------------------- build

  function buildParts(resume) {
    var ctx = {
      resume: resume,
      design: Object.assign({}, model.DEFAULT_DESIGN, resume.design || {}),
      rels: new Rels(),
      media: []
    };
    var parts = [];
    var byName = {};

    function add(name, value) {
      var part = { name: name, data: U.utf8(value) };
      parts.push(part);
      byName[name] = part;
      return part;
    }

    add('[Content_Types].xml', '');
    add('_rels/.rels', rootRelsXml());
    add('word/styles.xml', stylesXml(ctx.design));
    add('word/numbering.xml', numberingXml(ctx.design));
    add('docProps/core.xml', corePropsXml(resume));
    add('docProps/app.xml', appPropsXml());
    /* document.xml renders last among the XML parts: rendering is what
     * discovers the hyperlinks and the photo, so the rels and the content
     * types below depend on it. */
    add('word/document.xml', documentXml(resume, ctx));
    add('word/_rels/document.xml.rels', ctx.rels.xml());

    var exts = [];
    ctx.media.forEach(function (media) {
      if (exts.indexOf(media.ext) === -1) exts.push(media.ext);
      parts.push({ name: media.name, data: media.data });
    });
    byName['[Content_Types].xml'].data = U.utf8(contentTypesXml(exts));
    return parts;
  }

  function resolveResume(resume) {
    if (resume && typeof resume === 'object') return resume;
    var store = global.RB.store;
    var current = store && typeof store.get === 'function' ? store.get() : null;
    return current && typeof current === 'object' ? current : null;
  }

  function docxFilename(resume) {
    var b = resume.basics || {};
    var meta = resume.meta || {};
    /* A resume with no name is titled "Untitled resume", so a plain append
     * would hand the user "untitled-resume-resume.docx". */
    var slug = U.slugify(trim(b.name) || trim(meta.title) || '').replace(/(^|-)resume$/, '');
    return (slug ? slug + '-' : '') + 'resume.docx';
  }

  /* Promise<Blob> of a complete .docx package. */
  function docxBlob(resume) {
    var data = resolveResume(resume);
    if (!data) {
      return Promise.reject(new Error('No resume to export yet. Add your name and a role first.'));
    }
    try {
      return buildZip(buildParts(data)).then(function (bytes) {
        return new Blob([bytes], { type: DOCX_MIME });
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* Resolves to the saved filename, or false after saying why not. Never
   * rejects: this is called straight from a click handler. */
  function docxDownload(resume) {
    var data = resolveResume(resume);
    if (!data) {
      toast('There is no resume to export yet. Add your name and a role first.', 'warn');
      return Promise.resolve(false);
    }
    var filename = docxFilename(data);
    return docxBlob(data).then(function (blob) {
      U.download(filename, blob, DOCX_MIME);
      U.announce('Downloaded ' + filename);
      if (model.isBlankResume(data)) toast('Exported, but this resume is still empty.', 'warn');
      return filename;
    }).catch(function (err) {
      toast('Could not build the Word file (' + (err && err.message ? err.message : 'unknown error') +
        '). Try the PDF export instead.', 'error');
      return false;
    });
  }

  function toast(message, tone) {
    var ui = global.RB.ui;
    if (ui && typeof ui.toast === 'function') ui.toast(message, { tone: tone || 'info' });
  }

  global.RB.exporters = global.RB.exporters || {};
  global.RB.exporters.DOCX_MIME = DOCX_MIME;
  global.RB.exporters.docxBlob = docxBlob;
  global.RB.exporters.docxDownload = docxDownload;
})(window);
