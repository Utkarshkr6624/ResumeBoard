# Resumeboard — build contract (read this before writing any code)

## What we are building

A best-in-class resume builder web app. **Pure static**: vanilla HTML, CSS, and
JavaScript. No frameworks, no build step, no bundler, no npm at runtime, no
backend, no analytics, no third-party requests. It must run from `file://` and
from any static host (GitHub Pages, Netlify, S3).

## HARD CONSTRAINTS — violating any of these breaks the project

1. **Classic scripts only. NEVER use `import` / `export` / `type="module"`.**
   ES modules are blocked by CORS on `file://`. Every file attaches itself to a
   single global namespace: `window.RB`.
2. **No dependencies.** No jQuery, no React, no pdf.js, no JSZip. Everything is
   hand-written. The only vendor code allowed is a lazily-loaded pdf.js from a
   CDN, and only on the PDF-import path (and only after explicit user action).
3. **No network calls** except: lazy pdf.js on PDF import, and a manifest icon.
   Nothing phones home. No fonts from a CDN. No analytics.
4. **No `alert()`, `confirm()`, or `prompt()`.** Use `RB.ui.toast()` and
   `RB.ui.modal()`.
5. **Never write to the resume model directly.** Every mutation goes through
   `RB.store.update(draft => { ... })` or `RB.store.setField(path, value)`.
6. **Only edit the files you are assigned.** Other agents own the other files,
   concurrently. Touching a file you do not own will be silently overwritten.
7. **No TypeScript, no JSX, no `.ts` files, no bundler config.**
8. **Every input needs a label or an `aria-label`.** Every icon-only button needs
   `aria-label` and a `data-tip` tooltip. Accessibility is a release gate.
9. **Never `innerHTML` untrusted content.** Use `RB.utils.textToHtml()` to
   escape model text, and `RB.utils.el()` to build nodes.
10. **Comment only what is non-obvious** — a constraint, a tradeoff, a gotcha.
    Do not narrate what the code plainly does.

## Already written (DO NOT MODIFY — treat as given)

- `assets/css/tokens.css`   — design tokens. Read these, never hardcode colors.
- `assets/css/base.css`     — reset + shared UI primitives (buttons, inputs,
                              badges, modals, toasts, popovers, tabs).
- `assets/js/core/idb.js`   — `RB.idb` (IndexedDB + localStorage fallback)
- `assets/js/core/events.js`— `RB.bus` (pub/sub)
- `assets/js/core/utils.js` — `RB.utils` (see API below)
- `assets/js/core/model.js` — `RB.model` (data model + pure ops + validation)
- `assets/js/core/store.js` — `RB.store` (the single write path)

## The API you build on

### `RB.utils`
`uid(prefix)`, `clamp(n,min,max)`, `debounce(fn,ms)` (has `.cancel()`),
`throttle(fn,ms)`, `escapeHtml(s)`, `sanitizeHtml(html)`,
`textToHtml(text)` (escape text → safe inline HTML), `htmlToText(html)`,
`el(tag, attrs, children)` (attrs supports `class,text,html,dataset,on<Event>,`
any attribute; `true` renders a bare attribute), `frag(children)`,
`qs(sel,root)`, `qsa(sel,root)`, `on(root,type,sel,handler)` (delegated),
`download(filename, content, mime)`, `copyText(text)`,
`readFile(accept)`, `readAsText(file)`, `readAsArrayBuffer(file)`,
`readAsDataURL(file)`, `bytesToBase64(bytes)`, `base64ToBytes(b64)`,
`toBase64Url(bytes)`, `fromBase64Url(s)`, `deflate(bytes)`,
`inflate(bytes)`, `canCompress` (boolean), `crc32(bytes)`, `utf8(str)`,
`slugify(s)`, `titleCase(s)`, `pluralize(n,one,many)`, `formatDate(v,style)`,
`todayISO()`, `relativeTime(ts)`, `LOCALE` (see below), `requestIdle(fn,timeout)`,
`prefersReducedMotion()`, `isMac()`, `hotkey(event,key,{ctrl,meta,shift,alt})`,
`announce(msg)` (screen-reader announcement), `trapFocus(container,event)`,
`focusableIn(root)`, `contrast(hex)` (→ `{l, ratio(other)}`),
`isValidHexColor(v)`, `clamp`.

`RB.utils.LOCALE` → `{ lang, region, isMetric, prefersPhoto, rtl, dateFormat }`.
Use it for locale-correct date formats, page size, and photo defaults.
**Never do an IP geolocation lookup.**

### `RB.bus`
`RB.bus.on(name, fn)` → returns `off()`; `.once(name, fn)`; `.off(name, fn)`;
`RB.bus.emit(name, payload)`.

**Canonical event names** — subscribe to these, never invent new ones:
- `change` — `{ state, source, options }` fires after every store write.
  `source` is one of `field|update|undo|redo|replace|reset|sample|import|share|design|template`.
- `selection` — `{ path, entryType, entryId, roleId }` when the user focuses a
  node on the resume.
- `section:focus` — `{ sectionId, type }`
- `panel:open` — `{ panelId }` / `panel:close`
- `toast` — `{ message, tone, action }`

### `RB.model`
`SECTION_TYPES` (array of `{type,label,defaultLabel,single?,hasMany?,icon}`),
`typeMeta(type)`, `emptyResume()`, `sampleResume()`, `blankEntry(type)`,
`blankSection(type,order)`, `isBlankEntry(e)`, `isBlankResume(r)`,
`orderedSections(r)`, `sectionEntries(r,type)`, `findEntry(r,type,id)`,
`addSection(r,type,atOrder?)`, `removeSection(r,sectionId)`,
`addEntry(r,type,index?)`, `duplicateEntry(r,type,id)`,
`removeEntry(r,type,id)`, `moveEntry(r,type,id,delta)`,
`moveSection(r,sectionId,delta)`, `normalizeOrders(r)`,
`getPath(obj,path)`, `setPath(obj,path,value)`, `validate(resume)`,
`migrate(resume)`, `deepClone(v)`, `safeUrl(v)`, `RENDER_VERSION`,
`DEFAULT_DESIGN`.

**Read the model source if unsure.** The schema is documented there.

### `RB.store`
`load()` → Promise, `get()` → current resume, `isReady()`, `whenReady()`,
`update(mutator, opts)` where `opts = { source, coalesce, coalesceKey }`
(mutator returns `false` to bail), `undo()`, `redo()`, `canUndo()`, `canRedo()`,
`replace(nextResume, opts)`, `reset()`, `loadSample()`,
`setField(path, value, opts)`, `getField(path)`, `persistNow()`.

`path` is dot-indexed: `"basics.name"`, `"experience.0.roles.1.position"`,
`"design.accent"`.

### `RB.ui` (owned by another agent — assume it exists, use it)
`RB.ui.toast(message, { tone: 'info'|'success'|'error'|'warn', action: { label, onClick }, duration })` → returns a dismiss fn
`RB.ui.confirm({ title, message, confirmLabel, tone })` → Promise<boolean>
`RB.ui.prompt({ title, label, value, placeholder, confirmLabel })` → Promise<string|null>
`RB.ui.modal({ title, body: HTMLElement|string, actions: [{label,onClick,tone,primary}], wide })` → `{ close() }`
`RB.ui.popover(anchorEl, contentEl, { align, side })` → `{ close() }`
`RB.ui.icon(name, { size, className })` → SVG element. Icons are named, see `RB.icons`.

### `RB.icons` (owned by another agent)
`RB.icons.get(name)` returns an SVG markup string from a named set. Use these
names where relevant: `plus, trash, copy, chevron-down, chevron-up, chevron-right,
chevron-left, eye, eye-off, download, upload, share, undo, redo, check, x, alert,
info, settings, user, briefcase, cap, spark, cube, badge, book, trophy, heart,
globe, star, quote, list, mic, sun, moon, monitor, search, command, panel,
file-text, printer, save, link, bold, italic, underline, palette, type, layout,
grip, external, more-horizontal, zap, shield, target, wand, clock, lock,
refresh, arrow-left, arrow-right, check-circle, alert-circle, help, filter,
sort, maximize, minus`.

## THE DOM CONTRACT

`index.html` provides this skeleton. **You do not create index.html.** You
create CSS/JS that populates these containers. Never assume an element exists —
guard with `RB.utils.qs('#id')` and bail if null.

```
<a class="skip-link" href="#rb-main">Skip to resume</a>

<header id="rb-topbar" class="rb-topbar"></header>

<div id="rb-shell" class="rb-shell">
  <aside id="rb-rail" class="rb-rail" aria-label="Resume sections"></aside>
  <main id="rb-main" class="rb-main" tabindex="-1">
    <div id="rb-toolstrip" class="rb-toolstrip"></div>
    <div id="rb-stage" class="rb-stage">
      <div id="rb-page-frame" class="rb-page-frame">
        <div id="rb-doc" class="rb-doc"></div>
      </div>
    </div>
    <div id="rb-statusbar" class="rb-statusbar"></div>
  </main>
  <aside id="rb-panel" class="rb-panel" aria-label="Editing panel"></aside>
</div>

<footer id="rb-marquee" class="rb-marquee"></footer>

<div id="rb-overlay-root"></div>
<div id="rb-toasts" class="rb-toasts" aria-live="polite"></div>
```

### The resume document

`#rb-doc` is the **rendered resume itself, and it is also the editing surface**.
Inline editing on the document is the primary interaction — a form wizard is not.
Each editable node carries:

```html
<div class="rb-field" data-bind="experience.0.roles.1.position"
     contenteditable="plaintext-only" spellcheck="true"></div>
```

`data-bind` is a dot path into the resume. That is the whole contract between
the renderer, the binder, the linter, and the form panel.

Template selection is a single attribute on `#rb-doc`: `data-template="classic"`.
Changing templates must NOT rebuild the DOM — only swap that attribute and the
design CSS custom properties on `#rb-doc`.

## Module registration contract

Modules self-register. `index.html` loads every `<script>` in dependency order.

```js
// Panel modules
RB.panels.register('design', { title: 'Design', icon: 'palette', mount: function (el) { ... } });

// Rail / left nav — if you own it
RB.rail.register(...)

// Anything you need to clean up on re-render
RB.lifecycle.on('unmount', function () { ... })
```

**A module's `mount(el)` is called every time its panel tab becomes visible and
`el` is a fresh, empty container.** Mount must be idempotent-safe: build the UI
fresh each time, and unsubscribe anything you subscribe. Never assume `mount`
runs once.

## Quality bar

This is meant to be the best resume builder on the web. Hold the line:

- **Design:** restrained, editorial, confident. Generous whitespace. Real
  hierarchy. No gradients-for-fun, no glassmorphism, no neon. Dark mode is a
  first-class peer of light mode, not an afterthought. Micro-interactions under
  200ms, easing `cubic-bezier(0.16,1,0.3,1)`. Nothing moves under
  `prefers-reduced-motion`.
- **Copy:** plain, direct, second person, no exclamation marks, no marketing
  voice. "Saved to this browser." not "Your masterpiece awaits!"
- **Empty states:** every surface that can be empty says what to do next and
  offers the action inline.
- **Errors:** never a bare stack trace. Catch, explain in one sentence, offer a
  next step.
- **Performance:** typing must never lag. Never run analysis synchronously in
  the input handler — debounce to `requestIdleCallback`.
- **Mobile:** the app must be usable at 360px. The rail collapses to a drawer,
  the panel becomes a bottom sheet.
- Print is a first-class output, not an afterthought.

## Verification before you report done

```bash
cd "E:/resuma builder"
node -e "new Function(require('fs').readFileSync('YOUR_FILE','utf8'))" && echo OK
```

That is a syntax check. Also re-read your own file once for: leaked
`console.log`, unused variables, `alert`/`confirm`, ES module syntax, hardcoded
colors that exist as tokens, and missing aria labels.
