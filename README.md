# Plane Cutter ✈️

[![Build and deploy](https://github.com/pascal-gujer/plane-cutter/actions/workflows/pages.yml/badge.svg)](https://github.com/pascal-gujer/plane-cutter/actions/workflows/pages.yml)

Turns scanned foam-glider templates (the thin printed-foam planes you push
together from three parts) into **laser-cut SVG files**: a fuselage with the two
wing slots, the main wing and the tail wing – at any size and for any material
thickness – plus a little placing editor to arrange parts on your laser bed.

The whole app is **one standalone HTML file**.

- **Use it online:** <https://pascal-gujer.github.io/plane-cutter/>
- **Or download it:** [plane-cutter.html](https://pascal-gujer.github.io/plane-cutter/plane-cutter.html)
  and open it in any browser – no server or internet needed.

The site is built from `main` by GitHub Actions ([workflow](.github/workflows/pages.yml)):
tests, build, deploy. Developers build the same file locally with `npm run build`
(`dist/plane-cutter.html`).

## Using the app

1. **Pick a plane** – Camo, Racer or Spitfire (the three scanned templates). Switch on
   *Mix parts from different planes* to take the fuselage, main wing and tail wing from
   different templates – the fuselage slots are then made to fit the wings you chose.
2. **How big?** – wingspan in mm, or a scale in % (100 % = the scanned toy).
3. **Material** – the thickness of the sheet you cut from. The fuselage slots are
   made exactly this wide (plus an optional clearance). Their length follows the
   wing's root chord at the chosen size, so wing and slot always match.
4. **Add plane to the sheet** (or only one part). Drag parts around, rotate them
   with the pink handle or the buttons, duplicate, remove. *Arrange* nests all
   parts using their real outlines (biggest first, four orientations, keeping the
   layout as low as possible), and new parts are dropped into the first spot
   where their outline fits. The status line warns when parts stick out or
   overlap – also judged by the real outlines, so parts may sit as close as their
   shapes allow.
5. **Sheet** – set your laser bed size (presets or custom), the safety margin and
   the gap kept between parts by *Arrange* and when adding parts.
6. **Export** – download the whole sheet as one SVG, or single parts. Outlines are
   red, slots are blue (both configurable) so you can give them separate layers
   / cut order in your laser software. 1 user unit = 1 mm, no transforms, no fills.

**Planes and slots.** Parts added together form a *plane* (the number badge on each
part). A plane holds at most one fuselage, one main wing and one tail wing, and the
fuselage's slots are always made for the wing and tail of its plane – whatever template
they come from, at their own size. *Belongs to plane* on a selected part moves it into
another plane (only planes that still lack that kind of part are offered) or into a new
one; the slots follow at once. While a plane has no wing on the sheet, the fuselage keeps
a *fits* choice (the wing it was created with, changeable in the panel), so you can cut a
fuselage alone for wings you already have. The status line warns when a slot comes within
2 mm of the outline, and the file name of such a fuselage says what it fits
(`camo-fuselage-fits-racer-wing-100pct-3mm.svg`).

Settings and the sheet are remembered in the browser (local storage).

## Project layout

```
templates/            the A4 scans (PDF, 1:1, 300 dpi) – one per plane
tools/
  trace-config.js     per-template settings for the tracer (thresholds, flips, hints)
  trace-templates.js  scans -> src/data/templates.js   (node, needs pdftoppm)
  build.js            bundles src/ into dist/plane-cutter.html
  serve.js            tiny dev server (node tools/serve.js, then /src/index.html)
  test.js             sanity checks for the core modules (node tools/test.js)
src/
  index.html          development page (loads the scripts below one by one)
  styles.css
  data/templates.js   GENERATED – outlines (mm) + slot positions of every template
  lib/geometry.js     points, bounding boxes, transforms, slot shapes
  lib/svg.js          SVG string helpers
  core/parts.js       template + size + material  ->  part geometry (outline + slots)
  core/sheet.js       the sheet: planes (which wing fits which fuselage), raster nesting (Arrange, auto-placement), overlap / bounds / slot checks
  core/exporter.js    SVG files for the laser (sheet or single part)
  ui/app.js           state, actions, persistence
  ui/editor.js        the SVG placing editor (drag, rotate, keyboard)
  ui/controls.js      side panel, toolbar, status bar
  ui/files.js         downloads, clipboard, toasts
  ui/main.js          bootstrap
dist/plane-cutter.html  the standalone build
build/                  scratch: rendered scans, debug overlays (safe to delete)
```

Every source file is a plain script that adds one module to the
`globalThis.PlaneCutter` namespace (`PC.geometry`, `PC.parts`, `PC.sheet`, …).
No bundler, no dependencies: the builder just inlines the files in the order
listed in `src/index.html`. The core modules also run in node (see `tools/test.js`).

## Commands

```
npm run build        # -> dist/plane-cutter.html
npm run serve        # dev server on http://localhost:8765/src/index.html
npm test             # core sanity checks
npm run trace        # re-trace all scans -> src/data/templates.js
npm run trace:debug  # same, plus build/debug/<id>-trace.png overlays
node tools/trace-templates.js --only racer --debug
```

Requirements: node ≥ 22; `pdftoppm` (poppler) only for tracing.

Every push to `main` runs the tests, builds `dist/plane-cutter.html` and deploys it to
GitHub Pages (`.github/workflows/pages.yml`); the badge at the top shows the last run.

## How the templates were traced

`tools/trace-templates.js` reads each scan and finds the three parts:

1. The scanner lid is pure white, so **printed pixels** (saturated colour or
   black) are the parts. Very light, faintly tinted print (e.g. the white-blue
   nose of Camo) is added when it forms a big enough area. White print that
   reaches the edge is a problem: it is nearly as bright as the lid. Narrow,
   deep white slits bounded by the part on both sides (the "spinner" fade on
   the noses of Camo and Spitfire) are filled automatically; for wide white
   areas at an edge a `paleRegions` rectangle in `trace-config.js` tells the
   tracer to include everything up to lid brightness (Camo's canopy fade), and
   where the print is as bright as the lid right up to the edge a `fillPolygons`
   polygon draws the edge by hand (Spitfire's white band).
2. Printed white areas inside a part (stars, letters) are filled, the outer
   boundary is traced, smoothed and simplified to ~0.1 mm.
3. Wings are left/right symmetric, the fuselage is not – that is how the parts
   get their roles. Wings are then made exactly symmetric by averaging both halves.
4. The **slots** are the white streaks where the lid shows through the slit.
   Their lit core is grown across the slit's shadow to get the centre line and
   walked along the axis to get the ends. The scan values (`scanLength`,
   `scanWidth`) are kept for reference; the app derives the real slot size from
   the wing chord and the material thickness.
5. Every part is centred, the fuselage is rotated so the main-wing slot is
   horizontal (the tail slot keeps its angle relative to it – the designed
   decalage), and flipped where configured so all planes face the same way.

Run `npm run trace:debug` and look at `build/debug/<id>-trace.png`: magenta =
traced outline, cyan = measured slots, yellow = slot cores, orange = rejected
white streaks, green = `paleRegions`.

### Adding a new template

1. Scan the three parts flat on A4 at 300 dpi (1:1), save as `templates/airplane_<id>.pdf`.
2. Add an entry to `templates` in `tools/trace-config.js` (id, name, file, colour; set
   `fuselage.flipY` if the fin points down in the scan).
3. `npm run trace:debug`, check the overlay (pixels added by the slit filler are
   tinted green), add a `paleRegions` rectangle or a `fillPolygons` polygon if an
   edge is nibbled by white print, re-run, then `npm run build`.

## Laser notes

- Slots are rectangles `thickness + clearance` wide; choose *rounded* ends if
  your material tends to crack at corners (the straight part keeps its length).
- Kerf: a 0.1–0.2 mm kerf makes slots slightly wider – start with clearance 0
  for foam and a test cut for plywood.
- The scanned toys have slots ~2 mm wide, i.e. the original foam is about 2 mm thick.

## Ideas for later

- Multi-select and group move, snap to grid, zoom / pan in the editor
- Assembled preview (wing through the fuselage) and a "print paper template" mode
- Decorations: engrave layer with names / drawings on the parts
- DXF export
