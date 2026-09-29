/* Resumeboard — .docx reader
 * No libraries and no build step. The ZIP central directory is parsed by hand,
 * then word/document.xml is inflated with the platform DecompressionStream
 * (RB.utils.inflate is preferred when it is available). A small XML walk pulls
 * the text out in document order and records bold/italic runs.
 *
 * Rejects with a sentence the caller can show as-is (errors are flagged
 * userFacing) — never a raw stack trace.
 */
(function (global) {
  'use strict';

  var MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

  var MSG = {
    notDocx: 'That file is not a .docx. Word 2007 and later files are .docx.',
    legacyDoc: 'That is an older .doc file. Open it in Word, save a copy as .docx, then import that copy.',
    noBody: 'That file is a zip archive, but it has no word/document.xml. It is probably not a Word document.',
    damaged: 'The .docx file appears to be damaged. Open it in Word and save a fresh copy, then import that.',
    encrypted: 'The .docx file is password protected. Remove the password in Word, save a copy, then import that copy.',
    unsupported: 'This browser cannot unpack .docx files. Open the app in a current version of Chrome, Edge, Firefox, or Safari.',
    tooLarge: 'That document is too large to import. Import a smaller .docx.',
    empty: 'No text was found in this .docx.'
  };

  function fail(message) {
    var err = new Error(message);
    err.userFacing = true;
    return err;
  }

  /* ---------- bytes ---------- */

  function u16(v, o) { return v[o] | (v[o + 1] << 8); }

  function u32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }

  /* ZIP64 fields stay far below 2^53 for any document a browser can hold. */
  function u64(v, o) { return u32(v, o) + u32(v, o + 4) * 4294967296; }

  function toBytes(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return null;
  }

  function decodeXml(bytes) {
    try {
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
      if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      throw fail(MSG.damaged);
    }
  }

  /* ---------- ZIP central directory ---------- */

  var SIG_EOCD = 0x06054b50;
  var SIG_EOCD64 = 0x06064b50;
  var SIG_EOCD64_LOC = 0x07064b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;
  var FLAG_ENCRYPTED = 0x0001;
  var METHOD_STORE = 0;
  var METHOD_DEFLATE = 8;

  function readCentralDirectory(bytes) {
    var size = bytes.length;
    if (size < 22) throw fail(MSG.notDocx);

    /* The EOCD sits at the very end, behind a comment of up to 64 KiB. */
    var eocd = -1;
    var floor = Math.max(0, size - 22 - 0xffff);
    for (var i = size - 22; i >= floor; i--) {
      if (u32(bytes, i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw fail(MSG.notDocx);

    var count = u16(bytes, eocd + 10);
    var offset = u32(bytes, eocd + 16);

    if (count === 0xffff || offset === 0xffffffff) {
      var loc = eocd - 20;
      if (loc < 0 || u32(bytes, loc) !== SIG_EOCD64_LOC) throw fail(MSG.damaged);
      var rec = u64(bytes, loc + 8);
      if (rec < 0 || rec + 56 > size || u32(bytes, rec) !== SIG_EOCD64) throw fail(MSG.damaged);
      count = u64(bytes, rec + 32);
      offset = u64(bytes, rec + 48);
    }

    /* Null prototype: a zip may legitimately contain an entry called
     * "constructor" or "toString". */
    var entries = Object.create(null);
    var p = offset;
    for (var n = 0; n < count; n++) {
      if (p < 0 || p + 46 > size || u32(bytes, p) !== SIG_CENTRAL) throw fail(MSG.damaged);
      var flags = u16(bytes, p + 8);
      var method = u16(bytes, p + 10);
      var csize = u32(bytes, p + 20);
      var usize = u32(bytes, p + 24);
      var nameLen = u16(bytes, p + 28);
      var extraLen = u16(bytes, p + 30);
      var commentLen = u16(bytes, p + 32);
      var local = u32(bytes, p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > size) throw fail(MSG.damaged);
      var name = decodeName(bytes, p + 46, nameLen);
      if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
        readZip64Extra(bytes, p + 46 + nameLen, extraLen, function (slot, value) {
          if (slot === 0 && usize === 0xffffffff) usize = value;
          else if (slot === 1 && csize === 0xffffffff) csize = value;
          else if (slot === 2 && local === 0xffffffff) local = value;
        });
      }
      entries[name] = { name: name, flags: flags, method: method, csize: csize, usize: usize, local: local };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* ZIP64 extended information, field id 0x0001. Only the fields that were
   * stored as 0xffffffff are actually present, in a fixed order. */
  function readZip64Extra(bytes, start, len, assign) {
    var end = start + len;
    var p = start;
    while (p + 4 <= end) {
      var id = u16(bytes, p);
      var size = u16(bytes, p + 2);
      if (p + 4 + size > end) return;
      if (id === 0x0001) {
        var q = p + 4;
        for (var slot = 0; slot < 3; slot++) {
          if (q + 8 > end) return;
          assign(slot, u64(bytes, q));
          q += 8;
        }
        return;
      }
      p += 4 + size;
    }
  }

  function decodeName(bytes, start, len) {
    var slice = bytes.subarray(start, start + len);
    if (len >= 3 && slice[0] === 0xEF && slice[1] === 0xBB && slice[2] === 0xBF) slice = slice.subarray(3);
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(slice);
    } catch (e) {
      var out = '';
      for (var i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
      return out;
    }
  }

  /* Sizes come from the central directory, not the local header, because a
   * streamed entry leaves its local header sizes at zero. */
  function entryData(bytes, entry) {
    if (entry.flags & FLAG_ENCRYPTED) throw fail(MSG.encrypted);
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) throw fail(MSG.damaged);
    var o = entry.local;
    if (o < 0 || o + 30 > bytes.length || u32(bytes, o) !== SIG_LOCAL) throw fail(MSG.damaged);
    var start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    if (start + entry.csize > bytes.length) throw fail(MSG.damaged);
    return bytes.subarray(start, start + entry.csize);
  }

  function inflateRaw(bytes, cap) {
    var limit = cap || MAX_DOCUMENT_BYTES;
    if (typeof global.DecompressionStream !== 'function') {
      var u = global.RB && global.RB.utils;
      if (u && typeof u.inflate === 'function' && u.canCompress) return u.inflate(bytes);
      return Promise.reject(fail(MSG.unsupported));
    }
    return inflateCapped(bytes, limit);
  }

  /* Inflates while measuring, and gives up the moment the output passes the
   * cap. The uncompressed size in the central directory is a claim the file
   * makes about itself, so a zip bomb that understates it gets all of itself
   * inflated into memory before any size check runs. RB.utils.inflate() has the
   * same shape — it reads the stream to the end — so this deliberately does not
   * go through it. Reading in chunks bounds the peak to the cap plus a chunk. */
  function inflateCapped(bytes, cap) {
    var stream;
    try {
      stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
    } catch (e) {
      return Promise.reject(fail(MSG.damaged));
    }
    if (!global.Response || typeof stream.getReader !== 'function') {
      return new global.Response(stream).arrayBuffer().then(function (buf) {
        var out = new Uint8Array(buf);
        return out.length > cap ? Promise.reject(fail(MSG.tooLarge)) : out;
      }).catch(function (err) {
        if (err && err.userFacing) throw err;
        throw fail(MSG.damaged);
      });
    }
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total);
          for (var i = 0, at = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
          return out;
        }
        total += r.value.length;
        if (total > cap) {
          try { reader.cancel(); } catch (e) { /* the stream is already closing */ }
          throw fail(MSG.tooLarge);
        }
        chunks.push(r.value);
        return step();
      });
    }
    return step().catch(function (err) {
      if (err && err.userFacing) throw err;
      throw fail(MSG.damaged);
    });
  }

  /* A side file we can live without (styles.xml, the rels) must never fail
   * the import — it only degrades bold/italic inheritance and link targets.
   * It also gets a much smaller ceiling than the document body: a 12 MB font
   * table helps nobody here, and refusing it early costs only styling. */
  var MAX_SIDE_BYTES = 4 * 1024 * 1024;
  function readOptional(bytes, entry) {
    if (!entry || entry.usize > MAX_SIDE_BYTES) return Promise.resolve(null);
    try {
      var raw = entryData(bytes, entry);
      return (entry.method === METHOD_STORE ? Promise.resolve(raw) : inflateRaw(raw, MAX_SIDE_BYTES))
        .then(function (buf) { return buf.length > MAX_SIDE_BYTES ? null : decodeXml(buf); })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* ---------- XML ---------- */

  /* `body` starts one character after the "<", so a close tag arrives as
   * "/w:p" and an open tag as "w:p ...". */
  var NAME_RE = /^\/?\s*([A-Za-z_:][-\w:.]*)/;
  var ATTR_RE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  var ENTITY_RE = /&(#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g;
  var PFX_SCAN = /xmlns:([A-Za-z_][-\w.]*)\s*=\s*(['"])([^'"]*)\2/g;
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(str) {
    if (str.indexOf('&') < 0) return str;
    return str.replace(ENTITY_RE, function (match, body) {
      if (body.charAt(0) === '#') {
        var code = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try { return String.fromCodePoint(code); } catch (e) { return match; }
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
    });
  }

  function tagEnd(xml, from) {
    var quote = 0;
    for (var i = from + 1; i < xml.length; i++) {
      var c = xml.charCodeAt(i);
      if (quote) { if (c === quote) quote = 0; }
      else if (c === 34 || c === 39) quote = c;
      else if (c === 62) return i;
    }
    return -1;
  }

  function attrsOf(body) {
    var out = {};
    if (!body) return out;
    ATTR_RE.lastIndex = 0;
    var m;
    while ((m = ATTR_RE.exec(body)) !== null) {
      if (m[1].indexOf('xmlns') === 0) continue;
      out[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return out;
  }

  /* Streaming walk. Tokens are ('open', name, attrsSource, null),
   * ('close', name, null, null) or ('text', text, null, isCData).
   * A self-closing tag emits an open immediately followed by a close. */
  function parseXml(xml, onToken) {
    var i = 0;
    var n = xml.length;
    while (i < n) {
      var lt = xml.indexOf('<', i);
      if (lt < 0) { onToken('text', xml.slice(i), null, false); break; }
      if (lt > i) onToken('text', xml.slice(i, lt), null, false);
      var next = xml.charCodeAt(lt + 1);
      if (next === 33) { /* ! — comment, CDATA or a bare declaration */
        if (xml.startsWith('<!--', lt)) {
          var end = xml.indexOf('-->', lt + 4);
          i = end < 0 ? n : end + 3;
        } else if (xml.startsWith('<![CDATA[', lt)) {
          var cd = xml.indexOf(']]>', lt + 9);
          if (cd < 0) { onToken('text', xml.slice(lt + 9), null, true); break; }
          onToken('text', xml.slice(lt + 9, cd), null, true);
          i = cd + 3;
        } else {
          var bang = xml.indexOf('>', lt);
          i = bang < 0 ? n : bang + 1;
        }
        continue;
      }
      if (next === 63) { /* ? — the XML declaration or a PI */
        var q = xml.indexOf('?>', lt);
        i = q < 0 ? n : q + 2;
        continue;
      }
      var gt = tagEnd(xml, lt);
      if (gt < 0) { i = n; break; }
      var body = xml.slice(lt + 1, gt);
      i = gt + 1;
      var m = NAME_RE.exec(body);
      if (!m) continue;
      if (body.charAt(0) === '/') {
        onToken('close', m[1], null, null);
      } else if (body.charAt(body.length - 1) === '/') {
        onToken('open', m[1], body, null);
        onToken('close', m[1], null, null);
      } else {
        onToken('open', m[1], body, null);
      }
    }
  }

  /* OOXML producers are free to pick their own prefixes, so resolve the ones
   * bound to the WordprocessingML and relationships namespaces. */
  function namespacePrefix(xml, test, fallback) {
    PFX_SCAN.lastIndex = 0;
    var m;
    var head = xml.length > 8192 ? xml.slice(0, 8192) : xml;
    while ((m = PFX_SCAN.exec(head)) !== null) {
      if (test(m[3])) return m[1];
    }
    return fallback;
  }

  function isWordml(ns) { return /wordprocessingml/.test(ns) && /main$/.test(ns); }
  function isRelationships(ns) { return /relationships/.test(ns); }

  /* ---------- styles and relationships ---------- */

  function toggleVal(val) {
    if (val == null) return true;
    var v = String(val).toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off');
  }

  /* styleId -> { basedOn, bold, italic, numbered }. Headings in real resumes are
   * almost always styled rather than directly bolded, so this is what makes
   * run-level bold detection work on a Word-authored file. Numbering lives on
   * the paragraph style just as often, and without it every bullet comes back
   * as an unlabelled line. */
  function parseStyles(xml, P) {
    var STYLE = P + ':style', BASED_ON = P + ':basedOn', B = P + ':b', I = P + ':i', VAL = P + ':val', ID = P + ':styleId';
    var NUMPR = P + ':numPr';
    var styles = Object.create(null);
    var current = null;
    parseXml(xml, function (type, name, body) {
      if (type === 'text') return;
      if (name === STYLE) {
        if (type === 'close') { current = null; return; }
        var id = attrsOf(body)[ID];
        if (id) { current = { basedOn: null, bold: null, italic: null, numbered: false }; styles[id] = current; }
        return;
      }
      if (!current || type === 'close') return;
      var value = attrsOf(body)[VAL];
      if (name === BASED_ON) current.basedOn = value || null;
      else if (name === B && current.bold === null) current.bold = toggleVal(value);
      else if (name === I && current.italic === null) current.italic = toggleVal(value);
      else if (name === NUMPR) current.numbered = true;
    });
    return styles;
  }

  function makeStyleResolver(styles) {
    var cache = Object.create(null);
    return function (id) {
      if (!id || !styles) return { bold: null, italic: null, numbered: false };
      if (cache[id]) return cache[id];
      var chain = [];
      var cursor = id;
      var guard = 0;
      while (cursor && styles[cursor] && guard++ < 8) {
        chain.push(styles[cursor]);
        cursor = styles[cursor].basedOn;
      }
      /* chain[0] is the style itself and wins: in OOXML a derived style
       * overrides what it inherits, including with an explicit w:val="0". */
      var out = { bold: null, italic: null, numbered: false };
      for (var i = 0; i < chain.length; i++) {
        if (out.bold === null) out.bold = chain[i].bold;
        if (out.italic === null) out.italic = chain[i].italic;
        if (chain[i].numbered) out.numbered = true;
      }
      cache[id] = out;
      return out;
    };
  }

  function parseRels(xml) {
    var map = Object.create(null);
    parseXml(xml, function (type, name, body) {
      if (type !== 'open' || name !== 'Relationship') return;
      var a = attrsOf(body);
      if (!a.Id || !a.Target || a.TargetMode !== 'External') return;
      var target = a.Target;
      try { target = decodeURIComponent(target); } catch (e) { /* keep the raw target */ }
      map[a.Id] = target;
    });
    return map;
  }

  /* ---------- document walk ---------- */

  function blankParagraph() {
    return {
      index: 0, text: '', runs: [], bold: false, italic: false,
      list: false, table: false, row: 0, cell: 0, links: []
    };
  }

  function joined(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) out += list[i].text;
    return out;
  }

  function extractParagraphs(xml, rels, styles) {
    var P = namespacePrefix(xml, isWordml, 'w');
    var R = namespacePrefix(xml, isRelationships, 'r');
    var P_P = P + ':p', P_R = P + ':r', P_RPR = P + ':rPr', P_T = P + ':t', P_TAB = P + ':tab';
    var P_B = P + ':b', P_BCS = P + ':bCs', P_I = P + ':i', P_ICS = P + ':iCs';
    var P_BR = P + ':br', P_CR = P + ':cr', P_NBH = P + ':noBreakHyphen';
    var P_PPR = P + ':pPr', P_NUMPR = P + ':numPr', P_PSTYLE = P + ':pStyle', P_RSTYLE = P + ':rStyle';
    var P_VAL = P + ':val', P_TBL = P + ':tbl', P_TR = P + ':tr', P_TC = P + ':tc';
    var P_LINK = P + ':hyperlink', R_ID = R + ':id';
    var FALLBACK = 'mc:Fallback';

    var resolveStyle = makeStyleResolver(styles);
    var paragraphs = [];
    var stack = [];
    var recorded = [];
    var cur = null;
    var runs = [];
    var rPrScopes = [];
    var tables = [];
    var links = [];
    var captureT = 0;
    var skipAt = -1;
    var paraStyle = null, paraBold = null, paraItalic = null;

    function parentIs(name) {
      return stack.length > 1 && stack[stack.length - 2] === name;
    }

    function liveText() {
      return cur ? joined(cur.runs) + joined(runs) : '';
    }

    function closeRun() {
      var r = runs.pop();
      if (!r || !cur) return;
      var bold = r.bold, italic = r.italic;
      if (r.style) {
        var cs = resolveStyle(r.style);
        if (cs.bold !== null) bold = cs.bold;
        if (cs.italic !== null) italic = cs.italic;
      }
      if (r.boldSet) bold = r.bold;
      if (r.italicSet) italic = r.italic;
      if (r.text) cur.runs.push({ text: r.text, bold: bold === true, italic: italic === true });
    }

    function openRun() {
      var base = { bold: null, italic: null };
      if (paraStyle) {
        var ps = resolveStyle(paraStyle);
        base.bold = ps.bold;
        base.italic = ps.italic;
      }
      if (base.bold === null) base.bold = paraBold;
      if (base.italic === null) base.italic = paraItalic;
      runs.push({
        text: '', bold: base.bold, italic: base.italic,
        boldSet: false, italicSet: false, style: null
      });
    }

    function addRunText(str) {
      if (cur && runs.length) runs[runs.length - 1].text += str;
    }

    function endParagraph() {
      while (runs.length) closeRun();
      if (!cur) return;
      var text = joined(cur.runs).replace(/\s+$/, '');
      if (text.trim()) {
        var allBold = true, allItalic = true;
        for (var i = 0; i < cur.runs.length; i++) {
          if (!cur.runs[i].text) continue;
          if (!cur.runs[i].bold) allBold = false;
          if (!cur.runs[i].italic) allItalic = false;
        }
        cur.text = text;
        cur.bold = allBold;
        cur.italic = allItalic;
        paragraphs.push(cur);
      }
      cur = null;
    }

    function startParagraph() {
      endParagraph();
      cur = blankParagraph();
      cur.index = paragraphs.length;
      paraStyle = null;
      paraBold = null;
      paraItalic = null;
      var frame = tables[tables.length - 1];
      if (frame) { cur.table = true; cur.row = frame.row; cur.cell = frame.cell; }
    }

    function applyToggle(which, value) {
      var scope = rPrScopes[rPrScopes.length - 1];
      if (scope === 'run' && runs.length) {
        var r = runs[runs.length - 1];
        r[which] = value;
        r[which + 'Set'] = true;
      } else if (scope === 'para') {
        if (which === 'bold') paraBold = value;
        else paraItalic = value;
      }
    }

    parseXml(xml, function (type, name, body, isCData) {
      if (type === 'text') {
        if (captureT > 0 && skipAt < 0 && cur && runs.length) {
          var chunk = isCData ? String(name) : decodeEntities(String(name));
          if (chunk) runs[runs.length - 1].text += chunk;
        }
        return;
      }

      var attrs = null;
      if (type === 'open' && (name === P_B || name === P_BCS || name === P_I || name === P_ICS ||
          name === P_PSTYLE || name === P_RSTYLE || name === P_LINK)) {
        attrs = attrsOf(body);
      }

      if (type === 'close') {
        if (recorded.pop()) {
          if (name === P_P) endParagraph();
          else if (name === P_R) closeRun();
          else if (name === P_RPR) rPrScopes.pop();
          else if (name === P_T) { if (captureT > 0) captureT--; }
          else if (name === P_TBL) tables.pop();
          else if (name === P_LINK) {
            var link = links.pop();
            if (link && link.url && cur) cur.links.push({ url: link.url, text: liveText().slice(link.offset) });
          }
        }
        stack.pop();
        if (skipAt >= 0 && stack.length <= skipAt) skipAt = -1;
        return;
      }

      stack.push(name);
      if (name === FALLBACK) {
        /* AlternateContent duplicates the same textbox in mc:Choice and
         * mc:Fallback; taking both would duplicate every line. */
        skipAt = stack.length - 1;
        recorded.push(0);
        return;
      }
      if (skipAt >= 0) { recorded.push(0); return; }
      recorded.push(1);

      switch (name) {
        case P_P: startParagraph(); break;
        case P_NUMPR: if (cur) cur.list = true; break;
        case P_PSTYLE:
          paraStyle = attrs ? attrs[P_VAL] || null : null;
          /* Word puts the list marker on the paragraph style, so a resume
           * whose bullets are all "List Paragraph" would otherwise arrive as
           * unlabelled lines and merge into one paragraph. */
          if (cur && paraStyle && !cur.list) {
            var paraStyleDef = resolveStyle(paraStyle);
            if (paraStyleDef && paraStyleDef.numbered) cur.list = true;
          }
          break;
        case P_RPR: rPrScopes.push(parentIs(P_R) ? 'run' : (parentIs(P_PPR) ? 'para' : 'other')); break;
        case P_RSTYLE: if (attrs && runs.length) runs[runs.length - 1].style = attrs[P_VAL] || null; break;
        case P_B: case P_BCS: if (attrs) applyToggle('bold', toggleVal(attrs[P_VAL])); break;
        case P_I: case P_ICS: if (attrs) applyToggle('italic', toggleVal(attrs[P_VAL])); break;
        case P_R: openRun(); break;
        case P_T: captureT++; break;
        /* w:tab is also a tab-stop definition inside w:tabs, and only the
         * one directly inside a run is a real character. */
        case P_TAB: if (parentIs(P_R)) addRunText('\t'); break;
        case P_BR: case P_CR: addRunText('\n'); break;
        case P_NBH: addRunText('-'); break;
        case P_TBL: tables.push({ row: 0, cell: 0 }); break;
        case P_TR: if (tables.length) { tables[tables.length - 1].row++; tables[tables.length - 1].cell = 0; } break;
        case P_TC: if (tables.length) tables[tables.length - 1].cell++; break;
        case P_LINK: {
          var rid = attrs ? attrs[R_ID] : null;
          links.push({ url: rid && rels ? rels[rid] || null : null, offset: liveText().length });
          break;
        }
        default: break;
      }
    });

    endParagraph();
    return paragraphs;
  }

  function toPlainText(paragraphs) {
    var lines = [];
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i];
      var parts = p.text.split('\n');
      for (var j = 0; j < parts.length; j++) {
        var line = parts[j].replace(/[ \t]+$/, '');
        if (!line) continue;
        lines.push(p.list && j === 0 ? '• ' + line : line);
      }
    }
    return lines.join('\n').trim();
  }

  /* ---------- public API ---------- */

  /* Resolves with { text, paragraphs }. `input` is an ArrayBuffer (or any
   * ArrayBuffer view) holding the whole .docx. */
  function docxText(input) {
    var bytes = toBytes(input);
    if (!bytes) return Promise.reject(fail(MSG.notDocx));

    /* Legacy .doc and .xls are OLE2 compound files, not zips. Naming that is
     * far more useful than "invalid file". */
    if (bytes.length >= 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {
      return Promise.reject(fail(MSG.legacyDoc));
    }

    var entries;
    try {
      entries = readCentralDirectory(bytes);
    } catch (err) {
      return Promise.reject(err);
    }

    var doc = entries['word/document.xml'];
    if (!doc) return Promise.reject(fail(MSG.noBody));
    if (doc.usize > MAX_DOCUMENT_BYTES) return Promise.reject(fail(MSG.tooLarge));

    var body;
    try {
      body = doc.method === METHOD_STORE ? Promise.resolve(entryData(bytes, doc)) : inflateRaw(entryData(bytes, doc));
    } catch (err) {
      return Promise.reject(err);
    }

    return Promise.all([
      body,
      readOptional(bytes, entries['word/_rels/document.xml.rels']),
      readOptional(bytes, entries['word/styles.xml'])
    ]).then(function (parts) {
      if (parts[0].length > MAX_DOCUMENT_BYTES) throw fail(MSG.tooLarge);
      var xml = decodeXml(parts[0]);
      if (!/<[A-Za-z_:]/.test(xml)) throw fail(MSG.damaged);
      var stylesXml = parts[2];
      var paragraphs = extractParagraphs(
        xml,
        parts[1] ? parseRels(parts[1]) : null,
        stylesXml ? parseStyles(stylesXml, namespacePrefix(stylesXml, isWordml, 'w')) : null
      );
      var text = toPlainText(paragraphs);
      if (!text) throw fail(MSG.empty);
      return { text: text, paragraphs: paragraphs };
    });
  }

  function isDocx(input) {
    var bytes = toBytes(input);
    if (!bytes || bytes.length < 4) return false;
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) return false;
    try {
      return !!readCentralDirectory(bytes)['word/document.xml'];
    } catch (e) {
      return false;
    }
  }

  global.RB = global.RB || {};
  var importer = global.RB.importer = global.RB.importer || {};
  importer.isDocx = isDocx;
  importer.docxText = docxText;
  importer.MESSAGES = MSG;
})(typeof window !== 'undefined' ? window : this);
