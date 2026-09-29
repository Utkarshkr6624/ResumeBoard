/* Resumeboard — pre-deploy gate
 *
 * One command, run before every upload:
 *
 *   node tools/deploy.js
 *
 * Exit 0 means the build is safe to ship. Exit 1 means something is wrong and
 * the number at the top of the output says what. It is deliberately static —
 * no browser, no dependencies — so it runs in a second and cannot be skipped
 * for being slow.
 *
 * The most important check is the first. A stale asset stamp is invisible from
 * the outside: the page looks correct and quietly runs the previous build, so
 * "I fixed it" and "it is still broken" are indistinguishable. Everything else
 * here has a visible symptom; that one does not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tools']);

let failures = 0;
let warnings = 0;
const notes = [];

function fail(group, message) {
  failures++;
  notes.push(['FAIL', group, message]);
}
function warn(group, message) {
  warnings++;
  notes.push(['warn', group, message]);
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ALL = walk(ROOT, []);
const PAGES = ALL.filter(f => /\.html$/i.test(f) && !f.includes(`${path.sep}tools${path.sep}`));
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const read = f => fs.readFileSync(f, 'utf8');

/* ------------------------------------------------------------------ 1 */
function checkStamp() {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, 'stamp.js'), '--check'], { encoding: 'utf8' });
  } catch (e) {
    const msg = ((e.stdout || '') + (e.stderr || '')).trim().split('\n')[0];
    fail('assets', msg || 'stamp check failed');
    return;
  }
  const stamp = (/: ([a-z0-9]{6,})\b/.exec(out) || [])[1];
  notes.push(['ok', 'assets', stamp ? `stamp current (${stamp})` : 'stamp current']);
}

/* ------------------------------------------------------------------ 2 */
function checkAssets() {
  const missing = [];
  const re = /(?:href|src)="((?:\.{1,2}\/)*assets\/[^"?#]+)(?:\?v=[a-z0-9]+)?"/g;
  for (const f of PAGES) {
    const s = read(f);
    let m;
    while ((m = re.exec(s))) {
      const t = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(t)) missing.push(`${rel(f)} -> ${m[1]}`);
    }
  }
  if (missing.length) {
    fail('assets', `${missing.length} referenced file(s) missing, first: ${missing[0]}`);
    for (const m of missing.slice(0, 8)) notes.push(['  ', 'assets', m]);
  } else {
    notes.push(['ok', 'assets', 'every referenced file exists']);
  }
}

/* ------------------------------------------------------------------ 3 */
function checkLinks() {
  let dead = 0, missingAnchor = 0;
  const ids = new Map();
  for (const f of PAGES) {
    const s = read(f);
    ids.set(f, new Set([...s.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])));
  }
  for (const f of PAGES) {
    const s = read(f);
    for (const m of s.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const h = m[1];
      if (/^(https?:|mailto:|tel:|data:|\/\/)/i.test(h)) continue;
      if (h.startsWith('#')) {
        /* The editor's deep links (#start, #template=x) are payloads read by
         * boot.js, not element anchors. Only a bare #something is an anchor. */
        if (h.length > 1 && !/^#(start|template=|example=|p=|r=|build)/i.test(h) && !ids.get(f).has(h.slice(1))) {
          missingAnchor++;
          fail('links', `${rel(f)} -> ${h} (no such id)`);
        }
        continue;
      }
      const [rawPath, frag] = h.split('#');
      const pathPart = rawPath.split('?')[0];
      if (!pathPart) continue;
      const t = path.resolve(path.dirname(f), pathPart);
      if (!fs.existsSync(t)) { dead++; if (dead <= 8) fail('links', `${rel(f)} -> ${h}`); continue; }
      const isPayload = /^#?(start|template=|example=|p=|r=|build)/i.test(frag || '');
      if (frag && !isPayload && t.endsWith('.html') && ids.has(t) && !ids.get(t).has(frag)) {
        missingAnchor++;
        if (missingAnchor <= 8) fail('links', `${rel(f)} -> ${h} (no such id on target)`);
      }
    }
  }
  if (!dead && !missingAnchor) notes.push(['ok', 'links', 'every internal link and anchor resolves']);
}

/* ------------------------------------------------------------------ 4 */
function checkMeta() {
  let bad = 0;
  for (const f of PAGES) {
    const s = read(f);
    const name = rel(f);
    /* The editor's h1 IS the resume's name field, built by the renderer at
     * runtime. The page is noindex, so a static second h1 would be wrong. */
    const isApp = /editor\.html$/.test(name);
    const h1 = (s.match(/<h1[\s>]/g) || []).length;
    if (h1 !== 1 && !(isApp && h1 === 0)) { fail('seo', `${name}: ${h1} h1 (expected 1)`); bad++; }
    const title = (/<title>([^<]*)<\/title>/.exec(s) || [])[1] || '';
    if (!title) { fail('seo', `${name}: no title`); bad++; }
    else if (title.length > 60) { fail('seo', `${name}: title ${title.length} chars (max 60)`); bad++; }
    const desc = (/<meta name="description" content="([^"]*)"/.exec(s) || [])[1] || '';
    if (!desc) { fail('seo', `${name}: no meta description`); bad++; }
    else if (desc.length < 120 || desc.length > 165) { warn('seo', `${name}: description ${desc.length} chars`); }
    if (!/<link rel="canonical"/.test(s)) { fail('seo', `${name}: no canonical`); bad++; }
  }
  if (!bad) notes.push(['ok', 'seo', 'one h1, a title, a description and a canonical on every page']);
}

/* ------------------------------------------------------------------ 5 */
function checkSitemap() {
  const sm = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(sm)) { fail('sitemap', 'sitemap.xml is missing'); return; }
  const s = read(sm);
  const locs = [...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const host = locs.length ? new URL(locs[0]).origin : '';
  let wrong = 0;
  for (const u of locs) {
    if (new URL(u).origin !== host) { wrong++; continue; }
    const p = u.slice(host.length).replace(/^\//, '') || 'index.html';
    if (!fs.existsSync(path.join(ROOT, p))) { wrong++; fail('sitemap', `listed but missing: ${u}`); }
  }
  if (!wrong) notes.push(['ok', 'sitemap', `${locs.length} URLs, all resolve`]);

  const robots = path.join(ROOT, 'robots.txt');
  if (!fs.existsSync(robots)) fail('robots', 'robots.txt is missing');
  else if (!/Sitemap:\s*https?:\/\//i.test(read(robots))) fail('robots', 'robots.txt does not point at the sitemap');
  else notes.push(['ok', 'robots', 'points at the sitemap']);
}

/* ------------------------------------------------------------------ 6 */
function checkCode() {
  const js = ALL.filter(f => /\.js$/i.test(f));
  let bad = 0;
  for (const f of js) {
    const s = read(f);
    if (/^\s*(import|export)\s/m.test(s) && !/require\(|module\.exports/.test(s)) {
      fail('code', `${rel(f)}: ES module syntax`); bad++;
    }
    if (/[^.\w]console\.log\(/.test(s) && !f.includes(path.sep + 'tools' + path.sep)) {
      fail('code', `${rel(f)}: console.log left in`); bad++;
    }
    if (/\bdebugger\b/.test(s)) { fail('code', `${rel(f)}: debugger`); bad++; }
  }
  if (!bad) notes.push(['ok', 'code', `${js.length} scripts: no modules, no stray debug`]);
}

/* ------------------------------------------------------------------ 7 */
function checkRules() {
  /* The product rules, asserted in the markup rather than at runtime. A
   * missing reset guard means a reload keeps the session, which is the one
   * behaviour the owner has restated more than once. */
  const missing = PAGES.filter(f => !/reset-guard\.js/.test(read(f)) && !f.endsWith('404.html'));
  if (missing.length) fail('rules', `${missing.length} page(s) without the reload guard, first: ${rel(missing[0])}`);
  else notes.push(['ok', 'rules', 'the reload guard is on every page']);
}

/* ------------------------------------------------------------------ */
function size() {
  let bytes = 0, count = 0;
  for (const f of ALL) { bytes += fs.statSync(f).size; count++; }
  return { bytes, count };
}

function main() {
  const t0 = Date.now();
  checkStamp();
  checkAssets();
  checkLinks();
  checkMeta();
  checkSitemap();
  checkCode();
  checkRules();

  const s = size();
  const mb = (s.bytes / 1048576).toFixed(1);

  const W = 68;
  console.log('');
  for (const [level, group, msg] of notes) {
    const mark = level === 'ok' ? '  ok  ' : level === 'FAIL' ? ' FAIL ' : level === 'warn' ? ' warn ' : '      ';
    console.log(`[${mark}] ${group.padEnd(9)} ${msg}`);
  }
  console.log('');
  console.log('  ' + '-'.repeat(W));
  console.log(`  ${PAGES.length} pages · ${s.count} files · ${mb} MB`);
  console.log(`  ${failures} failures, ${warnings} warnings · ${Date.now() - t0} ms`);
  console.log('  ' + '-'.repeat(W));

  if (failures) {
    console.log('');
    console.log('  NOT READY TO SHIP. Fix the failures above, then run:');
    console.log('    node tools/stamp.js   &&   node tools/deploy.js');
    console.log('');
    process.exit(1);
  }
  console.log('');
  console.log('  READY. Upload the folder — everything except .git — to your host over HTTPS.');
  console.log('');
}

main();
