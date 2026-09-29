/* Resumeboard — share links
 *
 * A resume travels as `#r=<payload>` in the location fragment. Fragments are
 * never sent to a server, so a shared link cannot leak a resume through
 * request logs, referrers, or an analytics script.
 *
 * Payload: `2z.<crc32hex>.<base64url>` (deflate-raw) or `2u.<crc32hex>.<base64url>`
 * (plain UTF-8). The first character is the wire format version, the second says
 * whether the bytes are deflated, and the third field is a CRC32 of the
 * *uncompressed* bytes. A reader that does not know the version must refuse the
 * payload rather than guess.
 *
 * The checksum is not decoration. Deflate carries no integrity check of its
 * own, and a single mangled character in a link used to survive the trip
 * through JSON.parse() and validate() often enough to open a garbled resume
 * with no warning at all. Version 1 payloads are still read, but they are
 * unverified, which is exactly why nothing new is written in that shape.
 *
 * encode() and decode() are asynchronous because RB.utils.deflate runs on
 * CompressionStream/DecompressionStream. Callers must await them.
 * decodeSync() covers the plain (uncompressed) form for callers that cannot.
 */
(function (global) {
  'use strict';

  var FORMAT_VERSION = '2';
  var WIRE = /^2([zu])\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/;
  /* Version 1 had no checksum. It is still read so links made by older builds
   * and by the example pages keep working, but nothing writes them any more. */
  var LEGACY_WIRE = /^1([zu])\.([A-Za-z0-9_-]+)$/;
  var HASH_KEY = 'r';

  /* Guards a hostile or truncated link from becoming a memory problem. Real
   * resumes are a few KB of JSON; 1 MiB is far past any legitimate resume. */
  var MAX_RAW_BYTES = 1048576;
  var MAX_PAYLOAD_CHARS = Math.ceil(MAX_RAW_BYTES * 4 / 3) + 8;

  /* Past roughly this length a URL stops working in some browsers and mail
   * clients. Callers check RB.share.MAX_URL_CHARS before offering a link. */
  var MAX_URL_CHARS = 30000;

  /* A photo is a base64 data URL, routinely hundreds of KB. It does not
   * belong in a link. Stripped unless the caller explicitly opts in. */
  var PHOTO_BUDGET = 60000;

  var inFlight = null;

  function requireDeps() {
    var RB = global.RB || {};
    if (!RB.utils || !RB.model) throw new Error('Share links need the core modules loaded first.');
    return RB;
  }

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /* model.validate() is a sanitiser first and a gate second: it repairs almost
   * anything into a valid resume, so passing its check alone would let a
   * corrupt payload silently blank the document. Require the payload to look
   * like a resume before trusting it. */
  function looksLikeResume(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var declared = typeof value.schemaVersion === 'number' || typeof value.$schema === 'string';
    if (!declared) return false;
    var hasBasics = value.basics && typeof value.basics === 'object' && !Array.isArray(value.basics);
    return hasBasics || Array.isArray(value.sections);
  }

  function validatedResume(value) {
    var RB = requireDeps();
    var result = RB.model.validate(RB.model.migrate(value));
    if (!result || !result.ok || (result.errors && result.errors.length)) {
      throw fail('invalid', 'This resume did not pass validation, so it was not opened.');
    }
    return result.resume;
  }

  function bytesToResume(bytes, expectedCrc) {
    if (!bytes || !bytes.length) throw fail('empty', 'This link has no resume in it.');
    if (bytes.length > MAX_RAW_BYTES) throw fail('too-large', 'This link is too large to be a resume.');
    /* Checked before parsing so a damaged link is never mistaken for content. */
    if (expectedCrc != null) {
      var actual = checksumOf(bytes);
      if (actual !== expectedCrc) throw fail('corrupt', 'This link is damaged and cannot be read.');
    }
    var text = new global.TextDecoder().decode(bytes);
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw fail('corrupt', 'This link is damaged and cannot be read.');
    }
    if (!looksLikeResume(parsed)) throw fail('invalid', 'This link does not contain a resume.');
    return validatedResume(parsed);
  }

  function checksumOf(bytes) {
    var v = requireDeps().utils.crc32(bytes);
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function payloadToResume(payload) {
    var text = String(payload || '').trim();
    if (text.length > MAX_PAYLOAD_CHARS) throw fail('too-large', 'This link is too large to be a resume.');

    var match = WIRE.exec(text);
    var legacy = match ? null : LEGACY_WIRE.exec(text);
    if (!match && !legacy) throw fail('malformed', 'This is not a share link.');

    var mode = (match || legacy)[1];
    var b64 = (match || legacy)[match ? 3 : 2];
    var crc = match ? match[2] : null;

    var u = requireDeps().utils;
    var bytes;
    try {
      bytes = u.fromBase64Url(b64);
    } catch (e) {
      throw fail('corrupt', 'This link is damaged and cannot be read.');
    }

    if (mode === 'u') return bytesToResume(bytes, crc);
    if (!u.canCompress) throw fail('unsupported', 'This browser cannot open compressed share links.');
    return u.inflate(bytes).then(function (raw) {
      return bytesToResume(raw, crc);
    }, function () {
      throw fail('corrupt', 'This link is damaged and cannot be read.');
    });
  }

  function encode(resume, opts) {
    opts = opts || {};
    var u = requireDeps().utils;

    return Promise.resolve().then(function () {
      if (!resume || typeof resume !== 'object') throw fail('invalid', 'There is no resume to share yet.');

      var clean = validatedResume(resume);
      var photo = clean.basics.photo;
      clean.basics.photo = (opts.includePhoto === true && typeof photo === 'string' && photo.length <= PHOTO_BUDGET) ? photo : null;

      var raw = u.utf8(JSON.stringify(clean));
      var crc = checksumOf(raw);
      if (!u.canCompress) return { mode: 'u', b64: u.toBase64Url(raw), crc: crc };

      return u.deflate(raw).then(function (packed) {
        /* deflate can expand short or incompressible input; plain wins then. */
        return packed && packed.length < raw.length
          ? { mode: 'z', b64: u.toBase64Url(packed), crc: crc }
          : { mode: 'u', b64: u.toBase64Url(raw), crc: crc };
      });
    }).then(function (part) {
      return FORMAT_VERSION + part.mode + '.' + part.crc + '.' + part.b64;
    });
  }

  function decode(payload) {
    return Promise.resolve().then(function () { return payloadToResume(payload); });
  }

  /* Only the uncompressed form is synchronous; a compressed payload needs a
   * stream, which cannot be read synchronously. */
  function decodeSync(payload) {
    var text = String(payload || '').trim();
    var match = WIRE.exec(text) || LEGACY_WIRE.exec(text);
    if (!match) throw fail('malformed', 'This is not a share link.');
    if (match[1] !== 'u') throw fail('async', 'This link is compressed and must be opened with decode().');
    return payloadToResume(match[0]);
  }

  function baseUrl() {
    var href = global.location && global.location.href;
    if (!href) return '';
    return href.split('#')[0];
  }

  function url(resume, opts) {
    return encode(resume, opts).then(function (payload) {
      return baseUrl() + '#' + HASH_KEY + '=' + payload;
    });
  }

  function hashValue(hash, key) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    var found = null;
    raw.split('&').some(function (pair) {
      var eq = pair.indexOf('=');
      if (eq === -1) return false;
      if (pair.slice(0, eq) !== key) return false;
      found = pair.slice(eq + 1);
      return true;
    });
    if (found == null) return null;
    try { return decodeURIComponent(found); } catch (e) { return found; }
  }

  function clearHash() {
    if (!global.location) return;
    var kept = (global.location.hash || '').replace(/^#/, '').split('&').filter(function (pair) {
      return pair && pair.split('=')[0] !== HASH_KEY;
    });
    var next = baseUrl() + (kept.length ? '#' + kept.join('&') : '');
    try {
      /* replaceState, not `location.hash = ''`: clearing must not create a
       * history entry the back button would then walk into. */
      global.history.replaceState(null, '', next);
    } catch (e) {
      if (kept.length) global.location.hash = kept.join('&');
    }
  }

  function payloadInLocation() {
    return hashValue(global.location && global.location.hash, HASH_KEY);
  }

  function askBeforeReplace(countsAsData) {
    if (!countsAsData) return Promise.resolve(true);
    var ui = global.RB && global.RB.ui;
    if (!ui || typeof ui.confirm !== 'function') return Promise.resolve(true);
    return ui.confirm({
      title: 'Open the shared resume?',
      message: 'This link carries a resume. It replaces what is in this browser. The current one stays in your undo history.',
      confirmLabel: 'Open it',
      tone: 'danger'
    }).catch(function () { return false; });
  }

  /* Resolves to the loaded resume, or null when the hash holds nothing usable.
   * Refuses to touch the store on any failure and says why in a toast. */
  function runRead(opts) {
    var payload = payloadInLocation();
    if (!payload) return Promise.resolve(null);

    var store = global.RB && global.RB.store;
    var ready = store && typeof store.whenReady === 'function' ? store.whenReady() : Promise.resolve();
    var ui = global.RB && global.RB.ui;

    return ready.then(function () {
      return decode(payload);
    }).then(function (resume) {
      var current = store ? store.get() : null;
      var hasWork = current && typeof global.RB.model.isBlankResume === 'function' && !global.RB.model.isBlankResume(current);
      return askBeforeReplace(opts.prompt !== false && hasWork).then(function (yes) {
        if (!yes) {
          if (ui && typeof ui.toast === 'function') ui.toast('Kept the resume in this browser. Clear the link to stop asking.', { tone: 'info' });
          return null;
        }
        /* No store means nothing was opened. Hand the resume back and leave
         * the hash alone rather than claim a load that did not happen. */
        if (!store || typeof store.replace !== 'function') return resume;

        store.replace(resume, { source: 'share' });
        if (opts.clear !== false) clearHash();
        if (ui && typeof ui.toast === 'function') {
          ui.toast('Opened the resume from the link.', { tone: 'success' });
        }
        return resume;
      });
    }).catch(function (err) {
      /* The hash stays put on failure: it is the user's only copy of the
       * source link, and a later build may be able to read what this one
       * could not. */
      if (ui && typeof ui.toast === 'function') {
        ui.toast((err && err.message) || 'This link could not be opened.', {
          tone: 'error',
          action: { label: 'Copy link', onClick: function () { if (global.RB.utils) global.RB.utils.copyText(global.location.href); } }
        });
      }
      return null;
    });
  }

  /* Auto-boot and an explicit call can land in the same tick. One read in
   * flight at a time, so a link is never applied twice. */
  function readFromLocation(opts) {
    if (inFlight) return inFlight;
    inFlight = runRead(opts || {}).then(function (result) {
      inFlight = null;
      return result;
    }, function (err) {
      inFlight = null;
      throw err;
    });
    return inFlight;
  }

  function scheduleBoot() {
    var RB = global.RB || {};
    if (typeof RB.onBoot === 'function') { RB.onBoot(function () { readFromLocation(); }); return; }
    if (RB.store && typeof RB.store.whenReady === 'function') { RB.store.whenReady().then(function () { readFromLocation(); }); return; }
    global.addEventListener('DOMContentLoaded', function () { readFromLocation(); });
  }

  global.RB = global.RB || {};
  global.RB.share = {
    FORMAT_VERSION: FORMAT_VERSION,
    MAX_URL_CHARS: MAX_URL_CHARS,
    MAX_RAW_BYTES: MAX_RAW_BYTES,
    encode: encode,
    decode: decode,
    decodeSync: decodeSync,
    url: url,
    readFromLocation: readFromLocation,
    clearHash: clearHash
  };

  /* Opening a link pasted into the address bar fires hashchange without a
   * reload, so the same check has to run there too. */
  global.addEventListener('hashchange', function () {
    if (payloadInLocation()) readFromLocation();
  });

  scheduleBoot();
})(window);
