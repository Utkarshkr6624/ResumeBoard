/* Resumeboard — asset stamp
 *
 * Why this exists
 * ---------------
 * Every local stylesheet and script is referenced with a `?v=` stamp, because
 * a browser caches `file://` assets hard enough that a plain refresh will
 * happily run the previous build. That fix then created a second problem:
 * every time an asset changed, the stamp had to change too, and forgetting it
 * is invisible. It fails silently — the page looks fine, the old code is
 * running, and the only symptom is "my fix did not work".
 *
 * So the stamp is derived, not remembered. This script hashes the bytes of
 * every asset the site actually references and writes that hash into every
 * page. Change a file, run it, and every page moves together. No stamp is ever
 * hand-edited.
 *
 *   node tools/stamp.js          recompute and write
 *   node tools/stamp.js --check  verify only; exits 1 if stale (use in CI)
 *
 * Plain Node, no dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ASSET_DIRS = ['assets'];
const ASSET_EXT = /\.(css|js|json|webmanifest|svg|png|ico|woff2?)$/i;
const HTML_EXT = /\.html$/i;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function htmlFiles() {
  return walk(ROOT, []).filter(f => HTML_EXT.test(f) && !f.includes(`${path.sep}.git${path.sep}`));
}

function assetFiles() {
  const out = [];
  for (const d of ASSET_DIRS) walk(path.join(ROOT, d), out);
  return out.filter(f => ASSET_EXT.test(f)).sort();
}

/* The hash covers the bytes and the path of every asset. Path matters: moving
 * a file without changing its contents is still a change a browser must see. */
function fingerprint(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(ROOT, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 10);
}

const QUERY = /(\?v=)[a-z0-9]+/g;
const GUARD = /var ID = '[a-z0-9]+';/;

function currentStamp(files) {
  // Any asset the pages reference must exist, or the stamp is meaningless.
  const missing = [];
  for (const html of htmlFiles()) {
    const s = fs.readFileSync(html, 'utf8');
    const re = /(?:href|src)="((?:assets\/|\.\.\/assets\/|\.\/assets\/)[^"?#]+\.[a-z0-9]+)(?:\?v=[a-z0-9]+)?"/g;
    let m;
    while ((m = re.exec(s))) {
      const target = path.resolve(path.dirname(html), m[1]);
      if (!fs.existsSync(target)) missing.push(path.relative(ROOT, html) + ' -> ' + m[1]);
    }
  }
  return { stamp: fingerprint(files), missing };
}

function write(stamp) {
  let changed = 0;
  for (const f of htmlFiles()) {
    const before = fs.readFileSync(f, 'utf8');
    let after = before.replace(QUERY, `$1${stamp}`);
    after = after.replace(/var ID = '[a-z0-9]+';/, `var ID = '${stamp}';`);
    if (after !== before) { fs.writeFileSync(f, after, 'utf8'); changed += 1; }
  }
  return changed;
}

function readStamp() {
  const f = path.join(ROOT, 'index.html');
  if (!fs.existsSync(f)) return null;
  const m = /(\?v=)([a-z0-9]+)/.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[2] : null;
}

function main() {
  const check = process.argv.includes('--check');
  const assets = assetFiles();
  const { stamp, missing } = currentStamp(assets);
  const onDisk = readStamp();

  if (missing.length) {
    console.error('These files are referenced but do not exist:');
    missing.forEach(m => console.error('  ' + m));
    process.exitCode = 1;
    if (!check) return;
  }

  if (check) {
    if (onDisk === stamp) {
      console.log(`stamp is current (${stamp}) across ${htmlFiles().length} pages, ${assets.length} assets`);
    } else {
      console.error(`STALE. Pages say "${onDisk}", the assets hash to "${stamp}".`);
      console.error('Run:  node tools/stamp.js');
      process.exitCode = 1;
    }
    return;
  }

  if (onDisk === stamp && !missing.length) {
    console.log(`stamp already current: ${stamp} (${assets.length} assets, ${htmlFiles().length} pages)`);
    return;
  }
  const changed = write(stamp);
  console.log(`stamped ${stamp} — ${changed} of ${htmlFiles().length} pages updated, ${assets.length} assets hashed`);
}

main();
