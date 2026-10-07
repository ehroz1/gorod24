# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only post builder for the «Город 24» Instagram account: covers and
carousel slides rendered to Canvas from the layouts in the Figma file
«Город 24» (file key `GcWLQatOr6OSPFJtd4rNNF`, page node `277:2`). Modelled
on the author's other project `ehroz1/card-maker-wemedia` (same single-file
build, PWA, drafts, export ideas), but the data model is different (per-slide
form fields per layout instead of one `//N` markup text) and the UI is
mobile-first. UI text, comments and README are in Russian — keep it that way.

No backend, no bundler, no npm dependencies. `build.py` inlines everything
(fonts, logo, photo-stack image, icons, JS, CSS) into one `index.html`, plus
`manifest.webmanifest` and `service-worker.js` next to it. The one exception
is `vendor/heic-to.js` (HEIC decoder, ~3 MB, committed as-is, not touched by
the build), which the page loads by `<script>` only when needed.

## Commands

```bash
python3 build.py                  # rebuild index.html etc. after ANY edit in src/ or brand/
pip3 install fonttools brotli     # optional: subsets fonts to woff2 (index.html ~0.8 MB instead of ~2 MB)
python3 -m http.server 8000       # serve locally (service worker / install need http)
node --check src/app.js           # quick syntax check; there is no test suite or linter
```

**Never edit `index.html`, `manifest.webmanifest` or `service-worker.js` in the
root** — they are generated. Edit `src/` / `brand/` and rebuild. Commit the
rebuilt files together with the source change (GitHub Pages serves the root).

Verification is done with Playwright against the built page (Chromium is at
`/opt/pw-browsers` in the cloud sessions): render each layout, compare with
Figma screenshots, drive the editor at phone sizes (`devices['iPhone 13']`,
`'iPhone SE'`) and at 1400×900, check `pageerror`s, export a ZIP and check
image sizes.

## Architecture

Three plain scripts concatenated into one `<script>` (shared globals, order:
`ICONS`/`BUNDLED_*` → `render.js` → `app.js`).

### `src/render.js` — pure Canvas rendering

- All coordinates are **Figma design units**: posts 1440×1800, reels
  1080×1920. Callers scale with `ctx.setTransform(k,…)`; `env.k` (device px
  per unit) is only needed for canvas shadows, which ignore the transform.
- **Text `top` = cap-height line**, not line box top: every text in the
  Figma file uses `text-box-trim` (cap → alphabetic), so Figma's `y` is the
  top of capitals and a text node's height is `cap + (lines-1)*lead`.
  `textBlock()` reproduces that (`capRatio()` measures cap height in the
  browser, `CAP_DEFAULT` is the fallback). Keep this convention when adding
  layouts — take `top`/`left`/`w`/font size/line-height/letter-spacing
  straight from `get_design_context` output.
- `LAYOUTS` is the single source of truth: `fields` (form order), `photo`,
  `shade`, `arrow` (`'on'` = shown by default), `ph` (placeholders; may be a
  function of `env`, used for «02. Заголовок» numbering) and `render`.
  16 layouts = every frame of the Figma page (page `277:2` plus the
  «Киноафиша» section `304:192`). Covers share `renderCover`
  (bottom-anchored stack: last baseline at y=1650, `gap` — 60 by default —
  between title and subtitle; `logo` overrides the logo box, e.g. the
  centred one on the Киноафиша cover). Киноафиша was built from Figma
  *metadata only* (the MCP quota ran out before `get_design_context`): font
  sizes were derived from text-box heights/widths (BravoRG 191/103/150,
  Inter 42) and match the node positions within 1px, but colours — white
  text, white pill badge with black text — are assumptions; re-check them
  against a screenshot when the quota allows.
- Photos: `drawPhotoRect` / `drawPhotoQuad` (rotated slot, `bleed` hides the
  black placeholder edge) → `drawCover` = object-fit: cover with
  `transform {zoom, x, y}`; `x/y` are design units from centre, clamped so no
  empty edges; the applied values are returned so the UI can store them.
- Decorations drawn in code, not images: background grid (`GRID`, exact line
  origins from Figma `relativeTransform`), shade gradients, arrow, polaroid
  frame, paper clip. Only `brand/photo-stack.png` and the logo are bitmaps.
- Logo is a **mask**: `brand/logo.png` is a white mark; `app.js` tints it
  white/black (`tint`) like the Figma mask+fill.
- **Brand tone** (`slide.opts.tone === 'brand'`, «Фирменный цвет»):
  every render function takes light text/arrows from `ink(slide)` and
  plates / white card backgrounds from `paper(slide)`, which return
  `BRAND_CREAM` (#FEF3BD) instead of white. Logos keep `WHITE`/`BLACK`
  (they pick the tinted asset), dark text on plates stays black. New
  layouts must use `ink()`/`paper()` rather than `WHITE` for those roles.
- **Optional lines**: fields with `optional: true` in `FIELD_INFO`
  (date, place, price, address, badge) get an on/off switch in the form;
  `slide.opts.hidden[key]` makes `fieldText()` return nothing (no text, no
  ghost) while the typed value is kept. Layouts must stack such blocks so
  the following ones move up (e.g. `renderEventCard` gives the first visible
  info line the 89 gap).
- **Extra sections** (`sections: 4` on `int-card`): `slide.opts.sections`
  (default 1, clamped by `sectionCount()`) adds «title + body» blocks with
  keys `title2/body2`, `title3/body3`… (`sectionKeys(k)`). `slideFields()`
  = layout fields + those keys (use it, not `L.fields`, when checking a
  slide's text); `baseKey()` maps `title2` → `title` for labels, size group
  and placeholders (`ph.titleN`/`ph.bodyN`). `renderInterviewCard` stacks
  the blocks with `SECTION_GAP` between them. In the form each extra block
  has a remove button (later blocks shift up) and «Ещё заголовок и текст»
  adds one and focuses its title (synchronously, so iOS opens the keyboard).
- **Alignment / vertical position** (on every layout): `slide.opts.align`
  (`left|center|right|justify`) and `slide.opts.valign` (`top|middle|bottom`),
  defaults per layout in `LAYOUTS` (`align`, `valign` — what the Figma frame
  does); `textAlign()` / `textVAlign()` resolve them. Each render function
  measures its blocks first, builds a column with `stackDown(items, 0)`
  (height) — plates, pills and the number+label row are `boxBlock(h)`
  pseudo-blocks — then `placeIn(h, regionTop, regionBottom, valign, center)`
  and draws. Regions: photo covers/cards `[LOGO_SAFE, COVER_BOTTOM]` (top =
  under the logo, middle = slide centre), white cards `[CARD_TOP,
  CARD_BOTTOM]`, reels `[REELS_TOP, REELS_BOTTOM]`; fav-card / ev-card /
  com-top / com-bottom place text inside their own strip (com-* keep the
  adaptive photo band for their default valign and fall back to it when the
  text doesn't fit the strip). `drawShadeFor()` moves the shade with the
  text (mirrored for top, a band around the text for middle). `drawBlock(…,
  align, alpha, boxW)` aligns inside `boxW` (default: the wrap width);
  justify stretches spaces except on a paragraph's last line. **With
  default opts every layout must stay pixel-identical** — render all layouts
  before/after a change and diff (that is how this was verified).
- **Logo position**: `slide.opts.logo` ∈ `LOGO_SPOTS` (tl tc tr ml mr bl bc
  br; default `L.logo`, `'tr'` if unset). `logoBox(slide, L, def)` returns
  the layout's own box untouched for the default spot, otherwise places
  `def`'s size in `L.logoFrame` (posts: `LOGO_FRAME_POST` = margins 90 /
  148 / 150; reels: the safe zone). `textRegion(slide, L)` derives the text
  region from the logo row (top → starts at `LOGO_SAFE`, bottom → ends at
  `CARD_BOTTOM`, else `CARD_TOP`…`COVER_BOTTOM`; reels have their own
  numbers) — the defaults reproduce the old fixed regions exactly.
  Strip layouts apply the same rule locally (com-top/com-bottom, fav-card,
  ev-card body); com-* pick a white logo over the photo band and black over
  the white part.
- **Bold / italic inside a field**: `slide.fmt[key] = [[len, flags], …]`
  (run lengths covering the whole text; flags 1 = bold, 2 = italic) next to
  the plain `fields[key]`. `fieldRuns()` ignores runs that don't add up to
  the text length (stale), `fieldBlock` shifts them for `withEmoji`, and
  `layout.plain` lists fields drawn in a font without bold/italic
  (kino-cover subtitle is BravoRG). `textBlock(…, runs)` wraps on
  normalized text + per-char flags and measures per style (`measureSlice`,
  `b.fonts[flags]`); lines carry `flags` and `last`; plain lines still go
  through the single `fillText` fast path.
- Empty fields render as **ghost placeholders** (alpha `GHOST_ALPHA`) when
  `env.ghost` is true (stage, thumbnails); export passes `ghost: false`.
  Overflow checks (`real()`) ignore ghosts.
- `renderSlide()` returns `{ overflow, photo }` — `photo` is the photo slot
  geometry used by the UI for hit-testing drags and placing the «Добавить
  фото» pill.
- Wrapping: whole words, break after hyphens (Figma does too), short
  «glue» words (`GLUE_WORDS`, ≤2 letters) stick to the next word.
- `FONT_STRETCH`: horizontal squeeze applied when a design font is missing
  and a fallback is used (Oswald is much wider than BravoRG), so line breaks
  stay close to the design. `app.js` sets it; with real fonts it is 1.

### Fonts

Families: `G24Title` (BravoRG), `G24Display` (Nauryz Red Keds), `G24Body`
(Inter 4.0: 400 and 700, normal and italic — `body*.ttf`, the 700 faces are
for bold/italic inside fields). `build.py` embeds `brand/fonts/title.*`
(BravoRG.otf) / `display.*` (NauryzRedKeds.ttf) — both supplied by the owner
and committed — and falls back to `fallback-title.ttf` (Oswald Light) /
`fallback-display.ttf` (Unbounded SemiBold) only if they are missing; it emits
`BUNDLED_FONTS = {title, display}` booleans (false → the app shows a «нет
шрифтов макета» note and applies `FONT_STRETCH`). Users can also upload fonts
in the app (Настройки) — stored in IndexedDB (`brand/font-title`,
`brand/font-display`), registered as `G24TitleUser`/`G24DisplayUser`, which
come first in `FONT_FAMILY`. With the real fonts every layout was compared
against the Figma screenshots and matches (line breaks differ only where
`GLUE_WORDS` deliberately moves a short word to the next line).

### `src/app.js` — UI and state

- Project: `{id, name, nameAuto, rubric, createdAt, updatedAt, slides[]}`;
  slide: `{id, layout, fields{}, fmt?{key: runs}, opts{arrow, shade, tone, hidden{}, sections, align, valign, logo}, size{title, body},
  photo: {id, zoom, x, y, start?, end?} | null}` (`start/end` — video clip). Switching layout keeps all `fields`, so
  text survives a round trip. `RUBRICS` = presets (initial slides, default
  card for «+», layouts listed first in the picker).
- **Rich fields** (`FIELD_INFO[key].rich`: body, subtitle, bodyN): a
  `contenteditable` div instead of a textarea (`buildRichField`) with
  «Ж / К / Обычный» buttons (`execCommand` bold/italic/removeFormat; the
  buttons cancel mousedown/pointerdown so selection stays, `editor._range`
  restores it if focus was lost). `readRich()` serializes the DOM to
  `{text, runs}` using **computed** font-weight/style (so `<b>`, `<strong>`,
  styled spans from Chrome/Safari all work; `<div>`/`<br>` → `\n`).
  Paste is intercepted: `htmlToRich()` parses clipboard HTML (tags, inline
  styles incl. Google Docs' `<b style="font-weight:normal">` wrapper,
  class rules from `<style>` via `CSSStyleSheet` + `matches`) and inserts
  explicit-style spans with `insertHTML`; plain text → `insertText`.
  `setRichField` stores text + `fmt`; `setField` (plain inputs) drops
  stale `fmt`. Their label row is `position: sticky` so the buttons stay
  visible above the iOS keyboard. Inside a `<div>` wrapper, not `<label>`
  (a label would forward clicks to the first button).
- **Selection popup** (touch only, `isTouch()`): the OS text-selection menu
  (Cut/Copy/Paste) can't be extended from a web page and covers the
  label-row buttons, so `placeFmtPopup()` shows a fixed «Ж · К · Обычный»
  bar (`.fmt-pop`, one global element) below a non-collapsed selection in a
  rich field — `POPUP_BELOW` leaves room for the selection handles; if it
  doesn't fit above the keyboard it goes `POPUP_ABOVE` the selection (over
  the native menu) or to the bottom of the visual viewport. Repositioned on
  `selectionchange`, panel scroll and visualViewport resize/scroll (rAF).
  Its buttons act on `pointerdown` and cancel `touchstart`/`mousedown`, so
  the tap neither clears the selection nor blurs the field; `applyFormat(…,
  fromPopup)` falls back to `editor._sel` (last non-collapsed range).
  `.rich-field { scroll-margin-bottom }` on touch keeps room below a focused
  field for the popup.
- Drafts: `localStorage['g24.drafts.v1']`, newest first, max 60,
  read-modify-write in `saveProject()` (two tabs don't clobber each other).
- **Photos live in IndexedDB** (`g24-media`/`files`, key
  `<projectId>/<photoId>`, value = Blob ≤3200px). In memory only
  `media.get(id) = {blob, prev (canvas ≤1400px), w, h}`; export decodes the
  Blob again per slide and releases it (`renderExport`) — keeps iOS Safari
  under its canvas memory limit. Decoding goes through `<img>` on purpose
  (EXIF orientation; `createImageBitmap` ignores it in some Safari versions).
  Unreferenced photos of a project are deleted when leaving the editor
  (`showHome` → `deleteProjectMedia(id, keep)`); undo snapshots may still
  reference them until then.
- **HEIC/HEIF**: `importPhoto` tries `<img>` first (Safari decodes HEIC
  natively); if that fails and `isHeicFile()` (MIME, extension or the
  `ftyp` brand — Windows often gives an empty type) says HEIC, it lazy-loads
  `vendor/heic-to.js` (`loadHeicLib`, global `HeicTo`, libheif in a Worker)
  and decodes to an `ImageBitmap` (libheif applies irot/imir, so portrait
  iPhone shots come out upright). HEIC is always re-encoded to JPEG before
  it is stored, so IndexedDB/export never need the decoder. The service
  worker caches the decoder after first use (network-first, not precached).
  Updating it: `vendor/README.md`.
- Undo: JSON snapshots of `slides` (+current), coalesced by key within
  `UNDO_COALESCE_MS` (typing, frame drags, sliders).
- Rendering is scheduled (`scheduleRender` → rAF → `renderStage` +
  debounced `renderThumbs`, which repaints only slides whose signature
  changed). Forms are rebuilt from state (`renderPanel`) only on selection /
  structural change, never while typing.
- Stage gestures (`wireStage`, pointer events): drag inside the photo slot =
  pan, two pointers = pinch zoom, wheel = zoom, touch swipe elsewhere =
  next/prev slide, tap on an empty photo slot = file picker. `settleFrame()`
  stores the clamped offsets after a gesture.
- Multi-select photos (`addPhotos`) fill photo-capable slides from the
  current one and append rubric cards for the rest.
- **Video** uses the same photo slot. `media.get(id)` for a video is
  `{kind: 'video', blob, prev: <video> (never in the DOM), w, h, duration}`;
  render.js draws the element's current frame like an image (`mediaSize`
  reads `videoWidth`). The clip lives on the slide
  (`photo.start/end`, `clipOf()` clamps it), so duplicates sharing one video
  can have different clips. Stage playback (`togglePlayback`) is an rAF loop
  (~30 fps `renderStage`) that wraps `currentTime` back to `start`;
  `renderOverlay` only touches the DOM when its key changes — rebuilding the
  play button every frame made it unclickable.
- **Video export** (`recordVideoSlide`): 1080-wide canvas →
  `captureStream(30)` + MediaRecorder (`RECORDER_TYPES`: MP4 first, WebM
  fallback), redrawing `renderSlide` every rAF while the clip plays. Audio via
  Web Audio (`audioSource` = one `createMediaElementSource` per element →
  `MediaStreamDestination`), because Safari has no `video.captureStream()`.
  Once the source node exists the element is heard only through the graph,
  so recording is silent and preview playback connects it to
  `audioCtx.destination`. `primeVideoAudio()` runs synchronously inside the
  export tap (iOS needs a gesture for AudioContext/unmuted play) and calls
  `play(); pause()` back to back — an async `.then(pause)` there used to
  land mid-recording and freeze the export on the first frame. Stop only
  `STOP_GRACE_MS` after `onstart` (earlier `stop()` gives an empty file).
  Video slides export one after another (real time), progress is weighted
  by clip length. MediaRecorder MP4 is fragmented — seeking inside it may
  not work in some players, playback does; verify exports by playing, not
  by seeking.
- Export (`openExportSheet`): Web Share with files first (on iOS that is
  «Сохранить изображения» → Photos); if Safari rejects `share()` because
  rendering took too long after the tap (`NotAllowedError`), a second button
  shares the already-built files. Also ZIP (store-only `buildZip`), single
  files, clipboard. File names are ASCII (`fileSlug` transliteration) —
  Chromium renames Cyrillic downloads to «download».

### Mobile layout (the priority)

- `<900px`: fixed editor sized to the **visual viewport** (`syncViewport` →
  `--app-h`, `--app-top`), so the iOS keyboard doesn't push the preview off
  screen. Order: topbar → stage → slide strip → panel (internal scroll).
  Warnings float over the bottom of the stage. While a field is focused,
  `.editor.typing` shrinks the stage and hides the strip.
- Inputs use 16px font (iOS won't zoom), `touch-action: manipulation`
  globally, `gesturestart` is prevented on the stage.
- Tapping the current thumbnail opens the slide menu sheet; the eye button
  opens a full-screen scroll-snap carousel viewer.
- `≥900px`: three columns (slides with hover tools + drag reorder, stage,
  panel); sheets become centered dialogs.

### Theme

App chrome only (slides are fixed brand colors). CSS variables on `:root`,
dark values duplicated in `@media (prefers-color-scheme: dark)
:root:not([data-theme="light"])` and `:root[data-theme="dark"]` — keep both in
sync. Saved choice (`g24.theme.v1`) is applied by an inline script in `<head>`.

## Assets

`brand/logo.svg` is the owner's vector logo (white mark). `app.js`
rasterizes it at ~1000px (`trimTransparent`) before tinting, so it stays
sharp in exports; `brand/pwa-icon.svg` embeds the same paths and
`pwa-icon-180.png` is rendered from it. `brand/photo-stack.png` was cut from a
0.57× Figma screenshot (the Figma MCP Starter plan ran out of calls, so the
raw image fill «фотопленка не удалять!» could not be exported): flood-filled
out of the white background and upscaled ×2. If the original fill becomes
available, replace the file; its placement is `STACK` in `render.js` (visible
bounds, not the Figma node bounds).

## Deployment

GitHub Pages from the `gh-pages` branch, which carries the same tree as the
development branch (the built `index.html` is committed). After changing
`src/`/`brand/`: rebuild, commit, and push the result to `gh-pages` too.
