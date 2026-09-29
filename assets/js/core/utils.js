/* Resumeboard — shared helpers
 * Loaded before every other module. Attaches to window.RB.utils.
 */
(function (global) {
  'use strict';

  var doc = global.document;

  function uid(prefix) {
    var n = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    return prefix ? prefix + '_' + n : n;
  }

  function clamp(n, min, max) { return n < min ? min : (n > max ? max : n); }

  function debounce(fn, wait) {
    var t = null;
    var wrapped = function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, wait);
    };
    wrapped.cancel = function () { if (t) { clearTimeout(t); t = null; } };
    wrapped.flush = function () { if (t) { clearTimeout(t); t = null; fn.call(this); } };
    return wrapped;
  }

  function throttle(fn, wait) {
    var last = 0, timer = null, pendingArgs = null;
    return function () {
      var now = Date.now(), self = this;
      pendingArgs = arguments;
      var remaining = wait - (now - last);
      if (remaining <= 0) {
        if (timer) { clearTimeout(timer); timer = null; }
        last = now;
        fn.apply(self, pendingArgs);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null; last = Date.now();
          fn.apply(self, pendingArgs);
        }, remaining);
      }
    };
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Only the inline formatting an editor is allowed to produce. Anything else
   * is stripped rather than escaped, so pasted Word/Google-Docs markup
   * degrades to clean text instead of exploding into nested spans. */
  var ALLOWED_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, BR: 1, SPAN: 1, A: 1 };

  /* Markup arrives as code, not as text, unless it is parsed somewhere that
   * cannot run it. `innerHTML` on a detached div still starts the fetch behind
   * `<img src=x>` and still runs its onerror, so a detached parse is not
   * enough. A DOMParser document has no browsing context: no script runs and
   * no subresource loads, which makes the parse itself inert. */
  function parseInert(html) {
    return new global.DOMParser().parseFromString(String(html), 'text/html').body;
  }

  function sanitizeHtml(html) {
    if (html == null) return '';
    var str = String(html);
    if (!/[<&]/.test(str)) return str;

    var holder = parseInert(str);
    var walker = doc.createTreeWalker(holder, global.NodeFilter.SHOW_ELEMENT, null, false);
    var doomed = [];
    var node;
    while ((node = walker.nextNode())) {
      var name = node.nodeName.toUpperCase();
      if (!ALLOWED_TAGS[name]) { doomed.push(node); continue; }
      if (name === 'A') {
        var href = node.getAttribute('href') || '';
        if (/^\s*(?:javascript|data|vbscript):/i.test(href)) { doomed.push(node); continue; }
        /* An anchor used to keep every attribute it arrived with, so an
         * onclick pasted or imported alongside the link survived sanitising and
         * fired the moment the field was written back with innerHTML. */
        for (var a = node.attributes.length - 1; a >= 0; a--) {
          if (node.attributes[a].name !== 'href') node.removeAttribute(a);
        }
        node.setAttribute('rel', 'noopener noreferrer');
        node.setAttribute('target', '_blank');
      } else {
        for (var i = node.attributes.length - 1; i >= 0; i--) {
          var attr = node.attributes[i].name;
          if (attr !== 'href') node.removeAttribute(attr);
        }
      }
    }
    doomed.forEach(function (n) {
      if (n.parentNode) n.parentNode.replaceChild(doc.createTextNode(n.textContent || ''), n);
    });
    return holder.innerHTML;
  }

  /* Plain text -> sanitized inline HTML, escaping first. Used when a field is
   * set programmatically (import, template apply, share link) so a value can
   * never arrive pre-poisoned. */
  function textToHtml(text) {
    if (text == null) return '';
    var parts = String(text).split(/\n/);
    return parts.map(escapeHtml).join('<br>');
  }

  /* Sanitized inline HTML -> plain text. */
  function htmlToText(html) {
    if (html == null) return '';
    var str = String(html);
    if (!/[<&]/.test(str)) return str;
    var holder = parseInert(sanitizeHtml(str));
    holder.querySelectorAll('br').forEach(function (br) { br.replaceWith('\n'); });
    var blockish = holder.querySelectorAll('p,div,li');
    blockish.forEach(function (n) { n.appendChild(doc.createTextNode('\n')); });
    var text = holder.textContent || '';
    return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val == null || val === false) return;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key === 'dataset') Object.keys(val).forEach(function (d) { node.dataset[d] = val[d]; });
        else if (key.slice(0, 2) === 'on' && typeof val === 'function') node.addEventListener(key.slice(2), val);
        else if (val === true) node.setAttribute(key, '');
        else node.setAttribute(key, val);
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    });
    return node;
  }

  function frag(children) {
    var f = doc.createDocumentFragment();
    (children || []).forEach(function (c) { if (c) f.appendChild(c); });
    return f;
  }

  function qs(sel, root) { return (root || doc).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function on(root, type, selector, handler) {
    if (!root) return function () {};
    if (!selector) {
      root.addEventListener(type, handler);
      return function () { root.removeEventListener(type, handler); };
    }
    var listener = function (ev) {
      var target = ev.target.closest(selector);
      if (target && root.contains(target)) handler.call(target, ev, target);
    };
    root.addEventListener(type, listener);
    return function () { root.removeEventListener(type, listener); };
  }

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    doc.body.appendChild(a);
    a.click();
    setTimeout(function () {
      doc.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      try { doc.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
      catch (err) { reject(err); }
      finally { doc.body.removeChild(ta); }
    });
  }

  function readFile(accept) {
    return new Promise(function (resolve, reject) {
      var input = doc.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.cssText = 'position:fixed;left:-9999px';
      doc.body.appendChild(input);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        doc.body.removeChild(input);
        if (!file) return reject(new Error('no file'));
        resolve(file);
      }, { once: true });
      input.click();
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  function bytesToBase64(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var chunk = 0x8000;
    var out = '';
    for (var i = 0; i < view.length; i += chunk) {
      out += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function base64ToBytes(b64) {
    var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    var binary = atob(clean);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function toBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return base64ToBytes(s);
  }

  /* Native deflate. Chrome 80+, Firefox 113+, Safari 16.4+.
   * Used for share links and for real .docx / .docx reading. */
  var canCompress = typeof global.CompressionStream === 'function' && typeof global.DecompressionStream === 'function';

  function streamThrough(bytes, Ctor) {
    var stream = new Blob([bytes]).stream().pipeThrough(new Ctor('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function deflate(bytes) {
    if (!canCompress) return Promise.resolve(bytes);
    return streamThrough(bytes, global.CompressionStream);
  }

  function inflate(bytes) {
    if (!canCompress) return Promise.reject(new Error('unsupported'));
    return streamThrough(bytes, global.DecompressionStream);
  }

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function slugify(str) {
    return String(str || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'resume';
  }

  function titleCase(str) {
    return String(str || '').replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); });
  }

  function pluralize(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function formatDate(value, style) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    var d = value;
    if (typeof value === 'number') d = new Date(value);
    if (!(d instanceof Date) || isNaN(d.getTime())) return String(value);
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var short = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    switch (style || 'MMM YYYY') {
      case 'MM/YYYY': return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
      case 'MMMM YYYY': return months[d.getMonth()] + ' ' + d.getFullYear();
      case 'YYYY': return String(d.getFullYear());
      default: return short[d.getMonth()] + ' ' + d.getFullYear();
    }
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function relativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  /* Where the user is, for locale-correct date formats and photo rules.
   * Uses the browser locale only — no network call, no IP lookup, ever. */
  var LOCALE = (function () {
    var parts;
    try { parts = new Intl.DateTimeFormat().resolvedOptions(); } catch (e) { parts = {}; }
    var lang = parts.locale || 'en-US';
    var region = (lang.split('-')[1] || 'US').toUpperCase();
    var PHOTO_REGIONS = ['DE','AT','CH','JP','IN','CN','RU','BR','ES','PT','PL','UA','TR','KR','AR','MX','ID','PH','VN','TH','CZ','GR','HU','RO','HR','SI','BG','RS','LT','LV','EE','SK','IL','AE','SA','EG','ZA','NG','KE','MY','BD','LK','NP'];
    return {
      lang: lang,
      region: region,
      isMetric: (function () { try { return new Intl.NumberFormat().format(1234.5).indexOf(',') > -1; } catch (e) { return false; } })(),
      prefersPhoto: PHOTO_REGIONS.indexOf(region) !== -1,
      rtl: /^(ar|he|fa|ur|ps|sd|ug|yi|dv|ku)/.test(lang),
      dateFormat: 'MMM YYYY'
    };
  })();

  function requestIdle(fn, timeout) {
    if (typeof global.requestIdleCallback === 'function') {
      return global.requestIdleCallback(fn, { timeout: timeout || 200 });
    }
    return setTimeout(fn, 1);
  }

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isMac() {
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  }

  function hotkey(event, key, mods) {
    mods = mods || {};
    var want = { ctrl: !!mods.ctrl, meta: !!mods.meta, shift: !!mods.shift, alt: !!mods.alt };
    var has = {
      ctrl: event.ctrlKey, meta: event.metaKey,
      shift: event.shiftKey, alt: event.altKey
    };
    if (want.ctrl !== has.ctrl || want.meta !== has.meta || want.shift !== has.shift || want.alt !== has.alt) return false;
    return event.key.toLowerCase() === key.toLowerCase();
  }

  /* A11y: announce without stealing focus. */
  function announce(message) {
    var region = qs('#rb-live-region');
    if (!region) {
      region = el('div', { id: 'rb-live-region', class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
      doc.body.appendChild(region);
    }
    region.textContent = '';
    setTimeout(function () { region.textContent = message; }, 30);
  }

  function focusableIn(root) {
    return qsa('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]', root)
      .filter(function (n) { return n.offsetParent !== null || n === doc.activeElement; });
  }

  function trapFocus(container, event) {
    var items = focusableIn(container);
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function contrast(hex) {
    var m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    /* #abc is what isValidHexColor — and therefore model.validate, and
     * therefore an imported or shared resume — accepts for an accent, so a
     * colour the model calls legal must not read here as unparseable. */
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var toLin = function (c) {
      c = parseInt(c, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    var L = 0.2126 * toLin(h.slice(0, 2)) + 0.7152 * toLin(h.slice(2, 4)) + 0.0722 * toLin(h.slice(4, 6));
    return { l: L, ratio: function (other) {
      var o = contrast(other);
      if (!o) return null;
      var a = Math.max(L, o.l), b = Math.min(L, o.l);
      return (a + 0.05) / (b + 0.05);
    }};
  }

  function isValidHexColor(value) {
    return /^#([a-f\d]{3}|[a-f\d]{6})$/i.test(String(value || '').trim());
  }

  global.RB = global.RB || {};
  global.RB.utils = {
    uid: uid, clamp: clamp, debounce: debounce, throttle: throttle,
    escapeHtml: escapeHtml, sanitizeHtml: sanitizeHtml, textToHtml: textToHtml, htmlToText: htmlToText,
    el: el, frag: frag, qs: qs, qsa: qsa, on: on,
    download: download, copyText: copyText,
    readFile: readFile, readAsText: readAsText, readAsArrayBuffer: readAsArrayBuffer, readAsDataURL: readAsDataURL,
    bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes, toBase64Url: toBase64Url, fromBase64Url: fromBase64Url,
    deflate: deflate, inflate: inflate, canCompress: canCompress,
    crc32: crc32, utf8: utf8,
    slugify: slugify, titleCase: titleCase, pluralize: pluralize,
    formatDate: formatDate, todayISO: todayISO, relativeTime: relativeTime,
    LOCALE: LOCALE, requestIdle: requestIdle, prefersReducedMotion: prefersReducedMotion, isMac: isMac, hotkey: hotkey,
    announce: announce, trapFocus: trapFocus, focusableIn: focusableIn,
    contrast: contrast, isValidHexColor: isValidHexColor
  };
})(window);
