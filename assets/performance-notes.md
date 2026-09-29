# Resumeboard — performance audit

Every number below was measured in headless Chromium against
`http://localhost:8099/index.html`, served by `npx --yes http-server -p 8099 -c-1`
from the project root. Bytes come off the wire, the vitals come from
`PerformanceObserver` inside the page, and long tasks come from a
`devtools.timeline` trace as well as the `longtask` API. The script that
produces all of it is `test/qa-perf.js`.

```bash
cd "E:/resuma builder"
npx --yes http-server -p 8099 -c-1
RB_PLAYWRIGHT=/path/to/playwright node test/qa-perf.js
```

Last run: 2026-09-29, 1440x900 cold profile, Chromium 153.0.8010.12
(Playwright 1.63.0), Node 24, Windows.

---

## Verdict

| Target | Measured | |
|---|---|---|
| LCP < 1500ms | **412–424ms** across runs | PASS |
| CLS < 0.02 | **0.0008** | PASS (was 0.154) |
| No third-party requests | **0** | PASS |
| No long task > 50ms during interaction | **0** across load, template switching, panel switching, and a full session | PASS |
| — | one 54–62ms task at ~50ms into ~1 cold boot in 3 | reported below |
| Typing, 30 chars into a `data-bind` node | median **0.5ms**/keystroke, worst **2.9ms** | PASS |
| Template switch, all 9 | worst **19.4ms**, DOM not rebuilt | PASS |
| First-load JS | **290 KB gzip**, 45 requests | over weight, see F1 |

`19/19 budgets met` on the last run.

---

## What was fixed

### F1 — CRITICAL, fixed — the inlined landing content collapsed the editor to zero height

`index.html` inlines the landing prose as `#rb-marketing`, a static child of
`<body>`. `app.css` made `<body>` a `display: grid` with
`grid-template-rows: auto minmax(0, 1fr) auto`, `height: 100dvh`,
`overflow: hidden`, and pinned only `#rb-topbar`, `#rb-shell` and
`#rb-marquee` to rows 1–3.

`#rb-marketing` had no `grid-row`, no CSS rule at all, and no `grid-template-*`
in any stylesheet. It auto-placed into an **implicit fourth row** whose `auto`
track sized to its content — 7,210px. With free space negative,
`minmax(0, 1fr)` resolved to its minimum of 0 and **the whole editor
collapsed**.

REPRO, before the fix:

```js
document.querySelector('#rb-shell').getBoundingClientRect().height   // 0
document.querySelector('#rb-marketing').getBoundingClientRect().height // 7210.5
window.scrollTo(0, 2000); window.scrollY                              // 0 — unreachable
```

The app was invisible: only the topbar and a 131px sliver of toolstrip
rendered, with the marketing text painted over the top of it. CLS was
**0.1539**. Nothing logged to the console, which is why it survived a
"boots with zero errors" check.

Fix, in `assets/css/app.css` only: the document scrolls, and the shell
occupies exactly one screen of it. `<body>` becomes block flow, the topbar
becomes `position: sticky` (which is what `landing.css:33` already assumes —
it reserves `--rb-topbar-h` as `scroll-margin-top`), and `#rb-shell` is
sized `calc(100dvh - var(--rb-chrome-h))` from a new `--rb-chrome-h` token.

After: shell 847px, rail 296x847, stage 762x847, document 693x1056,
panel 380x847, and the page scrolls to the landing content.

`--rb-chrome-h` is the topbar's box, reserved because the topbar is a
sibling and the shell has to size itself from it. On phones `ui/chrome.js`
*swaps* `.rb-topbar__inner` out and `.rb-topbar__mobile` in at the same
760px breakpoint — one bar, not two — so the phone value is
`--rb-subbar-h + 1px`. Reserving both bars left a 52px empty band under the
real one; `assets/css/polish-fixes.css` §1 carries the same correction and
now agrees with app.css.

### F2 — HIGH, fixed — the rail and panel tracks were zero-width until they mounted

`ui/rail.js` sizes the expanded rail by its content (294px at the longest
default label, "PROFESSIONAL SUMMARY") and `ui/panel.js` sets
`width: var(--rb-panel-w)` inline when it mounts. Both live in `auto` grid
tracks, so both tracks are **0px at first paint** and the editing column
slides sideways when they arrive.

Measured shifts, at 1440x900:

| t | element | value |
|---|---|---|
| 121ms | `#rb-page-frame` 782.5px → 876px wide | 0.0758 |
| 145ms | `#rb-main` x 1 → 293.7 | 0.1884 |
| 117ms | `#rb-page-frame` 635px → 764px wide | 0.0596 |

Fix, in `app.css`: a `min-width` floor on each, both scoped so they cannot
disturb the states that size themselves.

```css
@media (min-width: 761px) {
  body #rb-rail:not([data-collapsed="true"]) { min-width: 296px; }
}
@media (min-width: 900px) {
  body #rb-panel:not([data-collapsed="true"]) { min-width: var(--rb-panel-w); }
}
```

A `min-width` floor rather than a fixed track, because a fixed track breaks
the two things that resize themselves: `rail.js` collapses to 64px
(`min-width` would override its `width`), and below 760px the rail is an
absolutely positioned drawer. `min-width` also leaves a longer renamed
section label free to grow the rail exactly as it does today.

Pinning the rail track to the `--rb-rail-w` token (232px) was tried and
rejected: it fits the box but truncates "PROFESSIONAL SUMMARY" to
"PROFESSIONAL…".

**CLS 0.1539 → 0.0008.** The only shift left is 0.0008, worth 5px of the
panel's scroll container settling.

---

## Remaining work

### F3 — first-load JS is 290 KB gzip, and every byte of it is render-blocking

`index.html` loads 35 classic `<script src>` tags at the end of `<body>`,
with no `defer` and no lazy loading. Measured on the wire:

| | raw | gzip -9 |
|---|---:|---:|
| JS (35 files) | 1,036,000 | **290 KB** |
| CSS (8 files) | 206,804 | 53.6 KB |
| document | 40,252 | 11.1 KB |
| **first load** | **1,307,697** | **354.8 KB** |

Largest first-load files: `analysis/ats.js` 20.0KB, `ui/forms.js` 16.2KB,
`analysis/linter.js` 15.8KB, `analysis/jdmatch.js` 15.0KB,
`ui/importer.js` 12.8KB, `ui/analysis-panel.js` 12.8KB,
`ui/commandbar.js` 12.7KB, `analysis/score.js` 12.2KB,
`export/pdf.js` 11.8KB, `export/docx.js` 11.3KB, `ui/rail.js` 10.1KB.

The whole `import/` and `export/` tree (126 KB raw) and the three analysis
engines (49 KB gzip) are reachable only from a click. Nothing about them is
needed to paint the app.

Three strategies, measured as medians of 5 cold loads, by rewriting the
document in flight with Playwright — same origin, same server, nothing
changed but the tags:

| | FCP | DCL | load | LCP | raw bytes/load |
|---|---:|---:|---:|---:|---:|
| as shipped | 108ms | 108ms | 118ms | 392ms | 1,301,792 |
| `defer` on all 35 | **80ms** | 93ms | 108ms | 380ms | 1,302,002 |
| `defer` + drop analysis/import/export/importer/commandbar/onboarding/analysis-panel | 104ms | **89ms** | **99ms** | **136ms** | **663,409** |

So `defer` alone is a free 26% off FCP with no behaviour change, and
deferring the seven unreachable modules on top of that cuts **LCP by 65%
and the bytes by half**.

**Not implemented.** It needs `index.html` plus a runtime loader that
injects those files on first use, and the loader has to be right or the
Check panel and Import/Export arrive as `undefined` in a click that appears
to do nothing. LCP already passes its target by 3.6x, `index.html` is being
edited by another agent right now, and a half-built lazy path is worse than
a heavy one. The numbers above are the recipe; the call belongs to whoever
owns `index.html`.

### F4 — one 54–62ms task at boot in roughly one cold boot in three

`PerformanceObserver({type:'longtask'})`, six cold profiles each:

| strategy | runs with a >50ms task | TBT |
|---|---:|---:|
| as shipped | 1 of 6 (56ms) | 6ms |
| as shipped (earlier batch) | 2 of 6 (62ms, 55ms) | 12ms, 5ms |
| `defer` on all 35 | **0 of 6** | 0ms |

The task lands at t≈40–56ms, which is the parser running 35 scripts back to
back. A full trace of the worst one:

```
RunTask 75.9ms
  Layout 59.2ms
  UpdateLayoutTree 10.0ms
  Paint 4.9ms
  v8.parseOnBackground 2.7ms  assets/js/import/text.js
```

`addInitScript` that removed `#rb-marketing` changed total layout from
49.8ms to 58.7ms, i.e. the landing prose is not the cost — the shell's own
build and measurement is. Script parse is 20.2ms across 35 files and compile
is 0.5ms, so this is execution, not parsing. Same root cause as F3 and the
same fix.

Reported rather than gated: the release target is "no long task over 50ms
**during interaction**", and this one is at boot, is not reproducible on
every run, and is a weight problem rather than a scheduling defect.
`test/qa-perf.js` reports the count either way.

### F5 — not fixed, and why: a 25px sideways page scroll from a tooltip

Found while measuring F1, and **already fixed by another agent** in
`assets/css/polish-fixes.css` §4 during this audit. Recording it because
the check is in `test/qa-perf.js` and the failure mode is worth naming:

```js
document.querySelector('#rb-panel').scrollWidth   // 404
document.querySelector('#rb-panel').clientWidth   // 379
document.documentElement.scrollWidth              // 1465 vs innerWidth 1440
```

`base.css:360` positions every tooltip `left: 50%; transform: translateX(-50%);
white-space: nowrap`, always above its trigger, always centred. The last
ghost icon button in the panel head has `scrollWidth` 64 against a 32px box,
so its invisible, `opacity: 0` pseudo-element pushed 25px past the panel.
An absolutely positioned box still contributes to scrollable overflow even at
`opacity: 0`, so a tooltip that is never shown was creating a scrollbar for
the whole page.

It was invisible before F1 because `body { overflow: hidden }` clipped it.
F1 made the page scroll, which made a pre-existing overflow visible — worth
saying plainly, since the audit found it and the fix is what made it visible.
`polish-fixes.css` resolves it by making tips wrap and anchor to the near
edge per surface.

---

## Measured, and correct — worth keeping

- **No third-party requests.** Zero, from a request interceptor over a full
  load, and zero on `/templates/index.html` too. No `fetch`, no
  `XMLHttpRequest`, no `@font-face`, no `url()` pointing off-origin anywhere
  in `assets/`.
- **No web fonts.** All 14 stacks in `templates.js` are system or web-safe
  faces, so nothing is downloaded and there is no FOUT-driven shift.
- **Typing never blocks.** 30 characters into `#rb-doc [data-bind]`:
  median 0.5ms, worst 2.9ms, no long task, with and without a panel mounted
  (0.3–0.8ms/char). `store.js` coalesces keystrokes into one undo entry and
  `linter.js` runs its analysis on `requestIdleCallback` behind a debounce,
  exactly as `AGENTS.md` requires.
- **Template switching never rebuilds the DOM.** All nine templates applied,
  worst 19.4ms (`sidebar`), and `#rb-doc` held at **170 nodes** across a full
  nine-template sweep. Only the `data-template` attribute and the design
  custom properties move, as the DOM contract requires.
- **Panel switches are cheap.** Click-to-painted: Edit 8.9ms, Check 13.7ms,
  Design 18.1ms, Import 7.7ms. Nothing near a long task.
- **A full session has no long task at all.** Sample resume loaded, all four
  panels opened, 30 characters typed with a panel mounted: 0 tasks > 50ms from
  both the trace and the `longtask` API.
- **The app lays out where it has to.** 1440x900: topbar 1440x53, shell
  1440x847, rail 296x847, stage 762x847, document 693x1056, panel 380x847,
  stage scrolls internally, no sideways scroll.
- **360px works.** Topbar 45 + shell 695 = 740, exactly the viewport. Rail is
  an absolute drawer, panel is a fixed bottom sheet, document 326px wide, no
  horizontal scroll.
- **Print is clean.** Under `media: print` the topbar, rail, panel and
  `#rb-marketing` are all `display: none` and `#rb-doc` is `block`.
- **The heaviest static page is light.** `/templates/index.html`: 4 requests,
  96,178 raw bytes, CLS 0, no external requests.

## Corrections to the previous audit

The previous version of this file was written before `index.html` existed and
measured nothing in a browser. Three of its findings did not survive:

- **F2 (photo class) is stale.** `renderer.js` emits no element matching
  `.rb-doc-photo` or `.rbf-photo` in the rendered document; the class names
  it cited do not appear in the current output.
- **F7 (rich-text sanitize per keystroke) is unreachable.**
  `document.querySelectorAll('#rb-doc [data-rich]').length` is **0** with the
  sample resume loaded. `renderer.js` contains no `data-rich` output, so
  `binder.readValue()`'s `sanitizeHtml(innerHTML)` path never runs. Worth
  re-checking if rich fields are ever rendered.
- **F1's arithmetic was wrong** in a load-bearing way: it assumed `import/`
  and `export/` were lazy. They are not. They load eagerly and are 126 KB of
  the 1.3 MB first load.

## Not covered

- **CPU throttling.** Every number is from an unthrottled desktop Chromium on
  localhost. A mid-range phone will be several times slower on the boot
  layout (F4), and the 290 KB first load (F3) costs real time on a slow
  connection in a way it does not here. Run under `Network.emulateNetworkConditions`
  and `Emulation.setCPUThrottlingRate` before trusting F3 or F4 on mobile.
- **Cold cache vs warm.** Every load here is a cold profile with an empty
  HTTP cache, which is the honest case. The service worker is registered but
  not exercised; `sw.js` needs its own pass on a second visit.
- **Print-to-PDF timing.** Verified that print CSS resolves correctly, not
  that `export/pdf.js` is fast. It renders through a print pipeline and was
  not on the hot path of anything measured here.
- **`file://`.** Everything above is over `http://localhost:8099`, because
  service workers, `fetch` and `localStorage` partitioning all need a real
  origin. `file://` still works for the app, but none of these numbers
  should be read as covering it.
