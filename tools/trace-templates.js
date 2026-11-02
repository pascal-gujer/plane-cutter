#!/usr/bin/env node
'use strict';

/*
 * trace-templates.js
 * ==================
 * Turns the scanned foam-glider templates (templates/*.pdf, scanned 1:1 on A4)
 * into vector outlines in millimetres plus the positions of the wing slots in
 * the fuselage.  The result is written to src/data/templates.js and is the
 * only input the app needs.
 *
 *   node tools/trace-templates.js             trace every template in trace-config.js
 *   node tools/trace-templates.js --debug     also write build/debug/<id>-trace.png overlays
 *   node tools/trace-templates.js --only racer
 *
 * Requirements: node >= 22 and `pdftoppm` (poppler) on the PATH.
 *
 * Pipeline per template
 *   1. render the PDF to a PPM bitmap at CONFIG.dpi (pdftoppm)
 *   2. classify pixels: colourful or dark = printed foam (part); faintly tinted
 *      very light pixels = pale print; the white lid and its neutral grey
 *      shadows = background.  Inside configured `paleRegions` everything but
 *      the lid counts as part (for neutral white print at an edge), and
 *      configured `fillPolygons` are part no matter what (for white print that
 *      is as bright as the lid right up to the edge).
 *   3. seal tiny gaps (morphological closing), fill the white areas that are
 *      printed on the parts (stars, letters, ...) – they are not cut-outs – and
 *      fill narrow, deep slits of white print that reach the outline (the
 *      "spinner" fade on a nose), see CONFIG.geometry.whitePrint
 *   4. connected components -> the three largest blobs are the three parts
 *   5. trace the outer boundary of every blob (crack following), smooth it and
 *      simplify it (Douglas-Peucker)
 *   6. roles: wings are left/right symmetric, the fuselage is not; the larger
 *      wing is the main wing
 *   7. slots: thin, long, white streaks inside the fuselage (the lid seen
 *      through the slit), grown across their shadow to find the centre line
 *      and walked along their axis to find the ends
 *   8. normalise the orientation: fuselage with its wing slot horizontal, wings
 *      with their span horizontal and made exactly left/right symmetric
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const CONFIG = require('./trace-config.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'src', 'data', 'templates.js');
const MM_PER_PX = 25.4 / CONFIG.dpi;
const toDeg = (r) => (r * 180) / Math.PI;
const toRad = (d) => (d * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Raster input / output
// ---------------------------------------------------------------------------

/** Renders page 1 of a PDF to build/scans/<id>-<dpi>.ppm (cached) and loads it. */
function renderScan(pdfFile, id) {
  const dir = path.join(ROOT, 'build', 'scans');
  fs.mkdirSync(dir, { recursive: true });
  const prefix = path.join(dir, `${id}-${CONFIG.dpi}`);
  const ppm = `${prefix}.ppm`;
  const stale = !fs.existsSync(ppm) || fs.statSync(ppm).mtimeMs < fs.statSync(pdfFile).mtimeMs;
  if (stale) {
    execFileSync('pdftoppm', ['-r', String(CONFIG.dpi), '-singlefile', '-f', '1', '-l', '1', pdfFile, prefix], {
      stdio: 'inherit',
    });
  }
  return readPPM(ppm);
}

/** Minimal binary PPM (P6, 8 bit) reader. Returns { w, h, rgb }. */
function readPPM(file) {
  const buf = fs.readFileSync(file);
  const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  const tokens = [];
  let pos = 0;
  while (tokens.length < 4) {
    while (pos < buf.length && isWs(buf[pos])) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    const start = pos;
    while (pos < buf.length && !isWs(buf[pos])) pos++;
    tokens.push(buf.toString('ascii', start, pos));
  }
  pos++;
  if (tokens[0] !== 'P6' || tokens[3] !== '255') throw new Error(`Unsupported PPM header in ${file}`);
  const w = Number(tokens[1]);
  const h = Number(tokens[2]);
  return { w, h, rgb: buf.subarray(pos, pos + w * h * 3) };
}

const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) : makeCrc32();
function makeCrc32() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
}

/** Writes an 8-bit RGB PNG using node's built-in zlib (no dependencies). */
function writePNG(file, w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Pixel classification
// ---------------------------------------------------------------------------

function pixelAt(img, x, y) {
  const p = (y * img.w + x) * 3;
  const r = img.rgb[p];
  const g = img.rgb[p + 1];
  const b = img.rgb[p + 2];
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  return { r, g, b, mx, mn, sat: mx - mn };
}

/**
 * Splits the scan into masks:
 *   strict  – printed colour / black print
 *   pale    – faintly tinted, very light print (candidate part pixels, filtered by size later)
 *   loose   – inside paleRegions: everything up to regionMaxValue (print white and the lid
 *             where it is lifted next to the part – partMask trims the latter)
 *   lit     – clearly white pixels (lid seen through a slit, printed white)
 *   bright  – brighter than regionMaxValue (the lid, or print as bright as the lid)
 *   region  – inside any paleRegion rectangle
 *   polygon – inside any fillPolygon (forced part)
 */
function classify(img, t, paleRegions, fillPolygons = []) {
  const { w, h, rgb } = img;
  const n = w * h;
  const strict = new Uint8Array(n);
  const pale = new Uint8Array(n);
  const loose = new Uint8Array(n);
  const lit = new Uint8Array(n);
  const bright = new Uint8Array(n);
  const region = new Uint8Array(n);
  const polygon = new Uint8Array(n);
  for (const r of paleRegions) {
    const [rx, ry, rw, rh] = Array.isArray(r) ? r : [r.x, r.y, r.w, r.h];
    for (let y = Math.max(0, ry); y < Math.min(h, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(w, rx + rw); x++) region[y * w + x] = 1;
    }
  }
  for (const pts of fillPolygons) rasterizePolygon(polygon, w, h, pts);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const sat = mx - mn;
    if (sat >= t.minSaturation || mx <= t.maxDark) strict[i] = 1;
    else if (mn >= t.paleMinValue && mn <= t.paleMaxValue && sat >= t.paleMinSaturation) pale[i] = 1;
    if (mn > t.regionMaxValue) bright[i] = 1;
    else if (region[i]) loose[i] = 1;
    if (sat <= t.litMaxSaturation && mn >= t.litMinValue) lit[i] = 1;
  }
  return { strict, pale, loose, lit, bright, region, polygon };
}

/** Sets the pixels inside a polygon (array of [x, y], px) – even-odd scanline fill. */
function rasterizePolygon(mask, w, h, pts) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay === by || yc < Math.min(ay, by) || yc >= Math.max(ay, by)) continue;
      xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(w - 1, Math.round(xs[k + 1]) - 1);
      for (let x = xa; x <= xb; x++) mask[y * w + x] = 1;
    }
  }
}

/**
 * Part mask = strict print + pale print areas that are thick and big enough + hinted
 * regions + fill polygons.
 *
 * In a hinted region the print white and the lid differ by a level or two, and print white
 * can even reach lid brightness in specks, so: take everything up to regionMaxValue, add
 * what the lid cannot reach (the lid is flooded from the page border: through lid-bright
 * pixels outside the rectangle, through anything that is not part inside it), then move the
 * boundary with the lid inwards by looseErodePx – the strict mask also stops that far short
 * of the lid, so the outline does not step where the region begins or ends (the rectangle's
 * own edges are not a boundary).
 */
function partMask(masks, w, h, t) {
  const n = w * h;
  const open = (m, r) => dilate(erode(m, w, h, r), w, h, r);
  const thickPale = open(andNot(masks.pale, masks.strict), t.paleOpenRadiusPx);
  const loose0 = open(masks.loose, 2);
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) wall[i] = masks.region[i] ? masks.strict[i] | loose0[i] : masks.bright[i] ^ 1;
  const solid = invert(reachableFromBorder(wall, w, h));
  for (let i = 0; i < n; i++) solid[i] |= masks.region[i] ^ 1;
  const loose = andNot(and(erode(solid, w, h, t.looseErodePx), masks.region), masks.strict);
  const extra = new Uint8Array(n);
  for (let i = 0; i < n; i++) extra[i] = thickPale[i] | loose[i];
  const { labels, comps } = labelComponents(extra, w, h);
  const keep = new Uint8Array(comps.length + 1);
  for (const c of comps) if (c.area >= t.minPaleAreaPx) keep[c.id] = 1;
  const part = new Uint8Array(n);
  for (let i = 0; i < n; i++) part[i] = masks.strict[i] | keep[labels[i]] | masks.polygon[i];
  return part;
}

// ---------------------------------------------------------------------------
// Binary image helpers (masks are Uint8Array of 0/1, row-major, w * h)
// ---------------------------------------------------------------------------

/** Binary dilation with a (2r+1)x(2r+1) square, separable sliding window. */
function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let cnt = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w && mask[row + x + r]) cnt++;
      if (x - r - 1 >= 0 && mask[row + x - r - 1]) cnt--;
      if (x >= 0) tmp[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) cnt++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) cnt--;
      if (y >= 0) out[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

function invert(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

const erode = (mask, w, h, r) => (r <= 0 ? mask : invert(dilate(invert(mask), w, h, r)));
const close = (mask, w, h, r) => erode(dilate(mask, w, h, r), w, h, r);

function and(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

function andNot(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & (b[i] ^ 1);
  return out;
}

/** Keeps only pixels that belong to a horizontal run of at least minRun set pixels. */
function keepLongRuns(mask, w, h, minRun) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!mask[row + x]) { x++; continue; }
      let e = x;
      while (e < w && mask[row + e]) e++;
      if (e - x >= minRun) out.fill(1, row + x, row + e);
      x = e;
    }
  }
  return out;
}

/** Background pixels that are 4-connected to the image border (everything else is "inside" a part). */
function reachableFromBorder(fg, w, h) {
  const reach = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => {
    if (!fg[i] && !reach[i]) {
      reach[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return reach;
}

/**
 * Fills slits of white print in the part mask (see CONFIG.geometry.whitePrint):
 *   1. background runs along rows (and, separately, columns) that are bounded by the same
 *      part on both ends and at most maxSlitWidthPx long are slit candidates;
 *   2. a connected patch of candidates is a slit when it is at least minSlitDepthPx deep
 *      (its extent across the runs) and mostly darker than the lid, i.e. print white;
 *   3. from the filled slit the part grows (up to tipGrowPx) into pixels that are not lid
 *      white – the rounded tip of the slit, which has no lips to bound it.
 * Returns the mask of added pixels; `filled` is updated in place.
 */
function fillWhiteSlits(img, filled, w, h, t, cfg) {
  const n = w * h;
  const { rgb } = img;
  const { labels } = labelComponents(filled, w, h);
  const notLid = (i) => {
    const p = i * 3;
    return Math.min(rgb[p], rgb[p + 1], rgb[p + 2]) < t.lidMinValue;
  };
  // 1. bounded runs; `along` = 'x' scans rows, 'y' scans columns
  const boundedRuns = (along) => {
    const cand = new Uint8Array(n);
    const outer = along === 'x' ? h : w;
    const inner = along === 'x' ? w : h;
    const idx = along === 'x' ? (o, k) => o * w + k : (o, k) => k * w + o;
    for (let o = 0; o < outer; o++) {
      let lastLabel = 0;
      let gapStart = -1;
      for (let k = 0; k < inner; k++) {
        const l = labels[idx(o, k)];
        if (l) {
          if (gapStart >= 0 && l === lastLabel && k - gapStart <= cfg.maxSlitWidthPx) {
            for (let g = gapStart; g < k; g++) cand[idx(o, g)] = 1;
          }
          lastLabel = l;
          gapStart = -1;
        } else if (gapStart < 0) gapStart = k;
      }
    }
    return cand;
  };
  // 2. deep, print-white patches only
  const added = new Uint8Array(n);
  for (const along of ['x', 'y']) {
    const cand = boundedRuns(along);
    const patches = labelComponents(cand, w, h);
    const printPx = new Int32Array(patches.comps.length + 1);
    for (let i = 0; i < n; i++) if (patches.labels[i] && notLid(i)) printPx[patches.labels[i]]++;
    const keep = new Uint8Array(patches.comps.length + 1);
    for (const c of patches.comps) {
      const depth = along === 'x' ? c.maxY - c.minY + 1 : c.maxX - c.minX + 1;
      if (depth >= cfg.minSlitDepthPx && printPx[c.id] >= cfg.minPrintFraction * c.area) keep[c.id] = 1;
    }
    for (let i = 0; i < n; i++) if (keep[patches.labels[i]]) { added[i] = 1; filled[i] = 1; }
  }
  // 3. grow into non-lid pixels around the filled slits (breadth first, 4-connected)
  let frontier = [];
  for (let i = 0; i < n; i++) if (added[i]) frontier.push(i);
  for (let d = 0; d < cfg.tipGrowPx && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || filled[j] || !notLid(j)) continue;
        filled[j] = 1;
        added[j] = 1;
        next.push(j);
      }
    }
    frontier = next;
  }
  return added;
}

/** 8-connected component labelling. Returns { labels: Int32Array, comps: [{id, area, minX.., touchesBorder}] }. */
function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length + 1;
    const c = { id, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, touchesBorder: false };
    let sp = 0;
    labels[start] = id;
    stack[sp++] = start;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      c.area++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.touchesBorder = true;
      const x0 = x > 0;
      const x1 = x < w - 1;
      const y0 = y > 0;
      const y1 = y < h - 1;
      if (x0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y0 && mask[i - w] && !labels[i - w]) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y1 && mask[i + w] && !labels[i + w]) { labels[i + w] = id; stack[sp++] = i + w; }
      if (x0 && y0 && mask[i - w - 1] && !labels[i - w - 1]) { labels[i - w - 1] = id; stack[sp++] = i - w - 1; }
      if (x1 && y0 && mask[i - w + 1] && !labels[i - w + 1]) { labels[i - w + 1] = id; stack[sp++] = i - w + 1; }
      if (x0 && y1 && mask[i + w - 1] && !labels[i + w - 1]) { labels[i + w - 1] = id; stack[sp++] = i + w - 1; }
      if (x1 && y1 && mask[i + w + 1] && !labels[i + w + 1]) { labels[i + w + 1] = id; stack[sp++] = i + w + 1; }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/**
 * Principal-axis statistics of one labelled blob: centre of its oriented box,
 * orientation (radians, direction of the long axis) and extents along/across it.
 */
function blobStats(labels, w, id, c) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * w + x] !== id) continue;
      n++;
      sx += x + 0.5;
      sy += y + 0.5;
    }
  }
  const cx = sx / n;
  const cy = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * w + x] !== id) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * w + x] !== id) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }
  const um = 0.5 * (umin + umax);
  const vm = 0.5 * (vmin + vmax);
  return {
    n,
    cx: cx + um * ca - vm * sa,
    cy: cy + um * sa + vm * ca,
    centroidX: cx,
    centroidY: cy,
    angle,
    length: umax - umin,
    width: vmax - vmin,
  };
}

/**
 * Outer boundary of one labelled blob as a closed polygon of pixel corners.
 * "Crack following": every part pixel contributes its free sides as directed
 * edges running clockwise (screen coordinates) around the pixel, then the
 * edges are chained.  At pixels that only touch diagonally we turn left, which
 * keeps the loop consistent with the 8-connected labelling.
 */
function traceOutline(labels, w, h, id, c) {
  const W1 = w + 1;
  const edges = new Map();
  const addEdge = (from, to, dir) => {
    let list = edges.get(from);
    if (!list) edges.set(from, (list = []));
    list.push({ to, dir, used: false });
  };
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      const i = y * w + x;
      if (labels[i] !== id) continue;
      const tl = y * W1 + x;
      const tr = tl + 1;
      const bl = tl + W1;
      const br = bl + 1;
      if (y === 0 || labels[i - w] !== id) addEdge(tl, tr, 0);
      if (x === w - 1 || labels[i + 1] !== id) addEdge(tr, br, 1);
      if (y === h - 1 || labels[i + w] !== id) addEdge(br, bl, 2);
      if (x === 0 || labels[i - 1] !== id) addEdge(bl, tl, 3);
    }
  }
  let best = null;
  for (const [startV, list] of edges) {
    for (const e0 of list) {
      if (e0.used) continue;
      const loop = [];
      let v = startV;
      let e = e0;
      while (e && !e.used) {
        e.used = true;
        loop.push([v % W1, Math.floor(v / W1)]);
        v = e.to;
        const cands = edges.get(v);
        if (!cands) break;
        if (cands.length === 1) {
          e = cands[0];
        } else {
          const leftDir = (e.dir + 3) % 4;
          e = cands.find((k) => !k.used && k.dir === leftDir) || cands.find((k) => !k.used) || cands[0];
        }
      }
      if (!best || loop.length > best.length) best = loop;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Polygon helpers (points are [x, y] arrays)
// ---------------------------------------------------------------------------

/** Moving average along a closed polygon, window = 2k + 1 vertices. */
function smoothClosed(pts, k) {
  const n = pts.length;
  if (k <= 0 || n < 2 * k + 1) return pts.slice();
  const win = 2 * k + 1;
  const out = new Array(n);
  let sx = 0;
  let sy = 0;
  for (let j = -k; j <= k; j++) {
    const p = pts[(j + n) % n];
    sx += p[0];
    sy += p[1];
  }
  for (let i = 0; i < n; i++) {
    out[i] = [sx / win, sy / win];
    const add = pts[(i + k + 1) % n];
    const rem = pts[(i - k + n) % n];
    sx += add[0] - rem[0];
    sy += add[1] - rem[1];
  }
  return out;
}

function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return Math.sqrt(ex * ex + ey * ey);
}

/** Iterative Douglas-Peucker for an open polyline. */
function simplifyOpen(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegmentDistance(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas-Peucker for a closed polygon: split at the vertex farthest from vertex 0. */
function simplifyClosed(pts, eps) {
  let far = 0;
  let maxD = -1;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[0][0];
    const dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > maxD) { maxD = d; far = i; }
  }
  const a = simplifyOpen(pts.slice(0, far + 1), eps);
  const b = simplifyOpen(pts.slice(far).concat([pts[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function bboxOf(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function rotatePoint([x, y], angle, cx = 0, cy = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Signed area (shoelace); positive = clockwise on screen (y down). */
function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** y-coordinates where the vertical line x = x0 crosses the polygon edges. */
function verticalCrossings(poly, x0) {
  const ys = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % n];
    if (ax === bx) continue;
    if ((x0 >= ax && x0 < bx) || (x0 >= bx && x0 < ax)) ys.push(ay + ((x0 - ax) * (by - ay)) / (bx - ax));
  }
  return ys;
}

/** Height of the polygon (top to bottom) at x = x0, or null when outside. */
function chordAt(poly, x0) {
  const ys = verticalCrossings(poly, x0);
  if (ys.length < 2) return null;
  return Math.max(...ys) - Math.min(...ys);
}

/** Rotates a polygon so its principal axis is horizontal (small rotation) and centres it. */
function normaliseOrientation(poly, angle) {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  const rotated = poly.map((p) => rotatePoint(p, -a));
  const bb = bboxOf(rotated);
  return rotated.map(([x, y]) => [x - (bb.minX + bb.maxX) / 2, y - (bb.minY + bb.maxY) / 2]);
}

/**
 * Makes an x-monotone, roughly left/right symmetric outline (a wing) exactly
 * symmetric around a vertical axis by averaging the two halves.  The axis is
 * searched around the bounding-box centre so a slightly off-centre scan does
 * not smear the shape.  Returns { outline, asymmetryRms, axisShift }.
 */
function symmetrize(poly, step, searchRange = 2) {
  const bb = bboxOf(poly);
  const edgesAt = (x) => {
    const ys = verticalCrossings(poly, x);
    return ys.length >= 2 ? [Math.min(...ys), Math.max(...ys)] : null;
  };
  const halfSpan0 = bb.width / 2;
  const mismatch = (cx) => {
    let sum = 0;
    let cnt = 0;
    for (let d = step; d < halfSpan0 - 1; d += step) {
      const l = edgesAt(cx - d);
      const r = edgesAt(cx + d);
      if (!l || !r) continue;
      sum += (l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2;
      cnt += 2;
    }
    return cnt ? Math.sqrt(sum / cnt) : Infinity;
  };
  const mid = (bb.minX + bb.maxX) / 2;
  let bestCx = mid;
  let bestErr = mismatch(mid);
  const asymmetryRms = bestErr;
  for (let shift = -searchRange; shift <= searchRange; shift += step / 5) {
    const err = mismatch(mid + shift);
    if (err < bestErr) { bestErr = err; bestCx = mid + shift; }
  }
  const half = Math.min(bestCx - bb.minX, bb.maxX - bestCx);
  const top = [];
  const bottom = [];
  for (let d = 0; d < half - step / 2; d += step) {
    const l = edgesAt(bestCx - d);
    const r = edgesAt(bestCx + d);
    if (!l || !r) continue;
    top.push([d, (l[0] + r[0]) / 2]);
    bottom.push([d, (l[1] + r[1]) / 2]);
  }
  const leftTip = poly.reduce((m, p) => (p[0] < m[0] ? p : m), poly[0]);
  const rightTip = poly.reduce((m, p) => (p[0] > m[0] ? p : m), poly[0]);
  const tipY = (leftTip[1] + rightTip[1]) / 2;
  const outline = [];
  for (const [d, t] of top) outline.push([bestCx + d, t]); // top edge, centre -> right tip
  outline.push([bestCx + half, tipY]);
  for (let i = bottom.length - 1; i >= 0; i--) outline.push([bestCx + bottom[i][0], bottom[i][1]]); // bottom, back to centre
  for (let i = 0; i < bottom.length; i++) outline.push([bestCx - bottom[i][0], bottom[i][1]]); // bottom, centre -> left tip
  outline.push([bestCx - half, tipY]);
  for (let i = top.length - 1; i >= 0; i--) outline.push([bestCx - top[i][0], top[i][1]]); // top, back to centre
  return { outline, asymmetryRms, axisShift: bestCx - mid, minMismatch: bestErr };
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** True for pixels that are not printed: the white lid seen through a slit and the slit's shadow. */
function makeInteriorTest(img, t) {
  return (x, y) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
    const p = pixelAt(img, x, y);
    if (p.sat >= t.vividMinSaturation) return false; // saturated print
    if (p.mx <= t.blackMaxValue) return false; // black print
    if (p.mx >= t.lightPrintMinValue && p.sat >= t.lightPrintMinSaturation) return false; // pale print
    return true;
  };
}

/** True for pixels that are (nearly) lid white – what we see through a slit, possibly tinted. */
function makeBrightTest(img, t) {
  return (x, y) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
    const p = pixelAt(img, x, y);
    return p.mx >= t.brightMinValue && p.sat <= t.brightMaxSaturation;
  };
}

/**
 * Measures a slot from its lit core:
 *  - across the slot: grow the core over its shadow until printed pixels are
 *    reached (median over many positions) -> real width and centre line
 *  - along the slot: walk from the core centre in both directions while there
 *    are still lid-white pixels within a few px of the axis -> both ends
 * `maxLength` bounds the walk (the slot cannot be much longer than the wing chord).
 * Returns null when the core is not a usable slot.
 */
function measureSlot(img, core, t, slotCfg, maxLength) {
  const isInterior = makeInteriorTest(img, t);
  const isBright = makeBrightTest(img, t);
  const u = [Math.cos(core.angle), Math.sin(core.angle)];
  const v = [-u[1], u[0]];
  const walk = (px, py, dir, limit, test) => {
    let last = 0;
    let gap = 0;
    for (let d = 1; d <= limit; d++) {
      if (test(px + dir[0] * d, py + dir[1] * d)) {
        last = d;
        gap = 0;
      } else if (++gap > t.gapTolerancePx) {
        break;
      }
    }
    return last;
  };
  const interiorAt = (x, y) => isInterior(Math.round(x), Math.round(y));
  // across
  const lo = [];
  const hi = [];
  const samples = 40;
  const margin = Math.min(core.length * 0.15, 30);
  for (let i = 0; i < samples; i++) {
    const along = -core.length / 2 + margin + ((core.length - 2 * margin) * i) / (samples - 1);
    const px = core.cx + u[0] * along;
    const py = core.cy + u[1] * along;
    if (!interiorAt(px, py)) continue;
    hi.push(walk(px, py, v, slotCfg.maxHalfWidthPx, interiorAt));
    lo.push(walk(px, py, [-v[0], -v[1]], slotCfg.maxHalfWidthPx, interiorAt));
  }
  if (lo.length < samples / 4) return null;
  const median = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const mlo = median(lo);
  const mhi = median(hi);
  const offset = (mhi - mlo) / 2;
  const width = mlo + mhi + 1;
  const cx = core.cx + v[0] * offset;
  const cy = core.cy + v[1] * offset;
  // along: a "bright column" = a lid-white pixel within +-4 px across the axis
  const brightColumn = (x, y) => {
    for (let k = -4; k <= 4; k++) if (isBright(Math.round(x + v[0] * k), Math.round(y + v[1] * k))) return true;
    return false;
  };
  const limit = Math.ceil(maxLength);
  let fwd = walk(core.cx, core.cy, u, limit, brightColumn);
  let back = walk(core.cx, core.cy, [-u[0], -u[1]], limit, brightColumn);
  fwd = Math.max(fwd, core.length / 2);
  back = Math.max(back, core.length / 2);
  if (fwd + back > maxLength) {
    // the walk ran into printed white next to the slot – trim the longer side
    if (fwd > back) fwd = Math.max(core.length / 2, maxLength - back);
    else back = Math.max(core.length / 2, maxLength - fwd);
  }
  const shift = (fwd - back) / 2;
  return {
    cx: cx + u[0] * shift,
    cy: cy + u[1] * shift,
    angle: core.angle,
    width,
    length: fwd + back + 1,
    core,
  };
}

/** Collapses slot candidates that lie on the same axis line (fragments of one slit). */
function mergeCollinear(slots, cfg) {
  const out = [];
  for (const s of slots.slice().sort((a, b) => b.length - a.length)) {
    const u = [Math.cos(s.angle), Math.sin(s.angle)];
    const v = [-u[1], u[0]];
    const m = out.find((o) => {
      const dx = o.cx - s.cx;
      const dy = o.cy - s.cy;
      const across = Math.abs(dx * v[0] + dy * v[1]);
      const along = Math.abs(dx * u[0] + dy * u[1]);
      let da = toDeg(o.angle - s.angle);
      while (da > 90) da -= 180;
      while (da < -90) da += 180;
      return across <= cfg.mergeDistancePx && Math.abs(da) <= cfg.mergeAngleDeg && along <= (o.length + s.length) / 2 + cfg.mergeGapPx;
    });
    if (!m) {
      out.push({ ...s, parts: [s] });
      continue;
    }
    // union of the two extents along the longer one's axis
    const uu = [Math.cos(m.angle), Math.sin(m.angle)];
    const proj = (q) => (q.cx - m.cx) * uu[0] + (q.cy - m.cy) * uu[1];
    const lo = Math.min(-m.length / 2, proj(s) - s.length / 2);
    const hi = Math.max(m.length / 2, proj(s) + s.length / 2);
    const mid = (lo + hi) / 2;
    m.cx += uu[0] * mid;
    m.cy += uu[1] * mid;
    m.length = hi - lo;
    m.parts.push(s);
  }
  return out;
}

/** True when the slot box, grown by `margin`, lies completely inside the blob. */
function slotInsideBlob(slot, labels, w, h, id, margin) {
  const u = [Math.cos(slot.angle), Math.sin(slot.angle)];
  const v = [-u[1], u[0]];
  const L = slot.length / 2 + margin;
  const W = slot.width / 2 + margin;
  for (let i = 0; i <= 10; i++) {
    const a = -L + (2 * L * i) / 10;
    for (const b of [-W, W]) {
      const x = Math.round(slot.cx + u[0] * a + v[0] * b);
      const y = Math.round(slot.cy + u[1] * a + v[1] * b);
      if (x < 0 || y < 0 || x >= w || y >= h || labels[y * w + x] !== id) return false;
    }
  }
  for (const a of [-L, L]) {
    const x = Math.round(slot.cx + u[0] * a);
    const y = Math.round(slot.cy + u[1] * a);
    if (x < 0 || y < 0 || x >= w || y >= h || labels[y * w + x] !== id) return false;
  }
  return true;
}

/**
 * Finds the two wing slots of the fuselage blob.
 * `chords` = [wingChord, tailChord] in px, used to bound the slot length.
 */
function findSlots(img, filled, lit, labels, fuselage, t, G, chords, log) {
  const { w, h } = img;
  const S = G.slot;
  const litInside = and(filled, lit);
  const big = dilate(erode(litInside, w, h, S.bigWhiteErodePx), w, h, S.bigWhiteMarginPx);
  const coreMask = keepLongRuns(andNot(litInside, big), w, h, S.minRunPx);
  const cores = labelComponents(coreMask, w, h);
  const maxLength = Math.max(...chords) + S.lengthSlackMm / MM_PER_PX;
  const candidates = [];
  const rejected = [];
  for (const hc of cores.comps) {
    if (hc.area < S.minWidthPx * S.minLengthPx * 0.5) continue;
    const st = blobStats(cores.labels, w, hc.id, hc);
    const inside = labels[Math.round(st.centroidY) * w + Math.round(st.centroidX)] === fuselage.comp.id;
    if (!inside) continue;
    const aspect = st.length / Math.max(st.width, 1);
    let rel = toDeg(st.angle - fuselage.stats.angle);
    while (rel > 90) rel -= 180;
    while (rel < -90) rel += 180;
    const shapeOk =
      st.width >= S.minWidthPx && st.width <= S.maxWidthPx && st.length >= S.minLengthPx && aspect >= S.minAspect && Math.abs(rel) <= S.maxAngleDeg;
    const slot = shapeOk ? measureSlot(img, st, t, S, maxLength) : null;
    const insideOk = slot ? slotInsideBlob(slot, labels, w, h, fuselage.comp.id, S.edgeMarginPx) : false;
    const desc =
      `white streak ${round(st.length * MM_PER_PX, 1)} x ${round(st.width * MM_PER_PX, 2)} mm, aspect ${round(aspect, 1)}, ${round(rel, 1)} deg, ` +
      `at (${Math.round(st.centroidX)}, ${Math.round(st.centroidY)}) px`;
    if (slot && insideOk) {
      candidates.push({ ...slot, relAngleDeg: rel });
      log(`  ${desc}  -> slot ${round(slot.length * MM_PER_PX, 1)} x ${round(slot.width * MM_PER_PX, 2)} mm`);
    } else {
      rejected.push(st);
      log(`  ${desc}  (${!shapeOk ? 'not slot shaped' : !slot ? 'growth failed' : 'too close to the edge'})`);
    }
  }
  const merged = mergeCollinear(candidates, S).sort((a, b) => b.length - a.length);
  return { slots: merged, rejected, coreMask };
}

// ---------------------------------------------------------------------------
// Debug drawing
// ---------------------------------------------------------------------------

function drawLine(rgb, w, h, a, b, color) {
  let x0 = Math.round(a[0]);
  let y0 = Math.round(a[1]);
  const x1 = Math.round(b[0]);
  const y1 = Math.round(b[1]);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < w && y0 < h) {
      const p = (y0 * w + x0) * 3;
      rgb[p] = color[0];
      rgb[p + 1] = color[1];
      rgb[p + 2] = color[2];
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawPolygon(rgb, w, h, pts, color, thick = 1) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    for (let t = 0; t < thick; t++) drawLine(rgb, w, h, [a[0] + t, a[1]], [b[0] + t, b[1]], color);
  }
}

function drawBox(rgb, w, h, s, color, thick) {
  const u = [Math.cos(s.angle), Math.sin(s.angle)];
  const v = [-u[1], u[0]];
  const corner = (su, sv) => [
    s.cx + (su * s.length * u[0]) / 2 + (sv * s.width * v[0]) / 2,
    s.cy + (su * s.length * u[1]) / 2 + (sv * s.width * v[1]) / 2,
  ];
  drawPolygon(rgb, w, h, [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], color, thick);
}

// ---------------------------------------------------------------------------
// Per-template processing
// ---------------------------------------------------------------------------

function round(v, d = CONFIG.geometry.outputDecimals) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function traceTemplate(tpl, opts = {}) {
  const G = CONFIG.geometry;
  const T = CONFIG.thresholds;
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const pdfFile = path.join(ROOT, tpl.file);
  log(`\n=== ${tpl.name} (${tpl.file})`);
  const img = renderScan(pdfFile, tpl.id);
  const { w, h } = img;
  log(`scan ${w}x${h} px at ${CONFIG.dpi} dpi  (${round(w * MM_PER_PX, 1)} x ${round(h * MM_PER_PX, 1)} mm)`);

  // 2.-4. masks and components
  const masks = classify(img, T, tpl.paleRegions || [], tpl.fillPolygons || []);
  const lit = masks.lit;
  const closed = close(partMask(masks, w, h, T), w, h, G.closeRadiusPx);
  const filled = invert(reachableFromBorder(closed, w, h));
  const slitFill = fillWhiteSlits(img, filled, w, h, T, G.whitePrint);
  const { labels, comps } = labelComponents(filled, w, h);
  {
    let n = 0;
    for (let i = 0; i < w * h; i++) n += slitFill[i];
    if (n) log(`white print: filled ${n} px of slits in the outlines (${round(n * MM_PER_PX * MM_PER_PX, 1)} mm²)`);
  }
  const parts = comps.filter((c) => !c.touchesBorder && c.area >= G.minPartAreaPx).sort((a, b) => b.area - a.area);
  log(`${comps.length} blobs, ${parts.length} large enough`);
  if (parts.length < 3) throw new Error(`${tpl.id}: expected 3 parts, found ${parts.length}`);
  if (parts.length > 3) log(`warning: ${parts.length} large blobs, using the 3 largest (areas: ${parts.map((c) => c.area).join(', ')})`);

  // 5. outlines + 6. roles
  const blobs = parts.slice(0, 3).map((c) => {
    const stats = blobStats(labels, w, c.id, c);
    const raw = traceOutline(labels, w, h, c.id, c);
    const pxOutline = simplifyClosed(smoothClosed(raw, G.smoothWindowPx), G.simplifyTolerancePx);
    const sym = symmetrize(normaliseOrientation(pxOutline, stats.angle), 3 /* px */, 20);
    return { comp: c, stats, pxOutline, rawLength: raw.length, asymmetryPx: sym.minMismatch };
  });
  blobs.sort((a, b) => b.asymmetryPx - a.asymmetryPx);
  const fuselage = blobs[0];
  const [wing, tail] = blobs.slice(1).sort((a, b) => b.comp.area - a.comp.area);
  fuselage.role = 'fuselage';
  wing.role = 'wing';
  tail.role = 'tail';
  for (const b of [fuselage, wing, tail]) {
    log(
      `${b.role.padEnd(8)} area ${b.comp.area} px, boundary ${b.rawLength} -> ${b.pxOutline.length} pts, ` +
        `${round(b.stats.length * MM_PER_PX, 1)} x ${round(b.stats.width * MM_PER_PX, 1)} mm, axis ${round(toDeg(b.stats.angle), 2)} deg, ` +
        `asymmetry ${round(b.asymmetryPx * MM_PER_PX, 2)} mm`,
    );
  }
  if (fuselage.asymmetryPx < 2 * Math.max(wing.asymmetryPx, tail.asymmetryPx)) {
    log('warning: the fuselage is not clearly less symmetric than the wings – check the roles in the debug overlay');
  }

  // wings: orientation, centring, symmetry (in mm)
  const mm = (pts) => pts.map(([x, y]) => [x * MM_PER_PX, y * MM_PER_PX]);
  const normaliseWing = (blob) => {
    const outline0 = normaliseOrientation(mm(blob.pxOutline), blob.stats.angle);
    const sym = symmetrize(outline0, G.wingSymmetryStepMm);
    let outline = simplifyClosed(sym.outline, 0.02);
    const bb = bboxOf(outline);
    outline = outline.map(([x, y]) => [x - (bb.minX + bb.maxX) / 2, y - (bb.minY + bb.maxY) / 2]);
    const rootChord = chordAt(outline, 0);
    log(
      `${blob.role.padEnd(8)} symmetrised: asymmetry ${round(sym.asymmetryRms, 2)} mm rms, axis shift ${round(sym.axisShift, 2)} mm, ` +
        `span ${round(bb.width, 1)} mm, root chord ${round(rootChord, 1)} mm, ${outline.length} pts`,
    );
    return { outline, span: bb.width, rootChord, asymmetryRms: sym.asymmetryRms };
  };
  const wingN = normaliseWing(wing);
  const tailN = normaliseWing(tail);

  // 7. slots
  const chords = [wingN.rootChord / MM_PER_PX, tailN.rootChord / MM_PER_PX];
  const { slots, rejected } = findSlots(img, filled, lit, labels, fuselage, T, G, chords, log);
  if (slots.length < 2) throw new Error(`${tpl.id}: found ${slots.length} slot(s) in the fuselage, expected 2 – see --debug overlay`);
  if (slots.length > 2) log(`warning: ${slots.length} slot candidates, keeping the two longest`);
  let [wingSlot, tailSlot] = slots.slice(0, 2);
  // assign by best chord match (wing slot ~ wing chord, tail slot ~ tail chord)
  const errA = Math.abs(wingSlot.length - chords[0]) + Math.abs(tailSlot.length - chords[1]);
  const errB = Math.abs(tailSlot.length - chords[0]) + Math.abs(wingSlot.length - chords[1]);
  if (errB < errA) [wingSlot, tailSlot] = [tailSlot, wingSlot];
  for (const [name, s, chord] of [['wing', wingSlot, chords[0]], ['tail', tailSlot, chords[1]]]) {
    log(
      `${name} slot ${round(s.length * MM_PER_PX, 1)} x ${round(s.width * MM_PER_PX, 2)} mm at (${round(s.cx * MM_PER_PX, 1)}, ${round(
        s.cy * MM_PER_PX,
        1,
      )}) mm, ${round(s.relAngleDeg, 2)} deg to the fuselage axis  (root chord ${round(chord * MM_PER_PX, 1)} mm)`,
    );
  }

  if (opts.debug) {
    const dir = path.join(ROOT, 'build', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const rgb = Buffer.from(img.rgb);
    for (let i = 0, p = 0; i < w * h; i++, p += 3) {
      if (!slitFill[i]) continue;
      rgb[p] = Math.round(rgb[p] * 0.4); // green tint: pixels added by the slit fill
      rgb[p + 2] = Math.round(rgb[p + 2] * 0.4);
    }
    for (const region of tpl.paleRegions || []) {
      const [rx, ry, rw, rh] = Array.isArray(region) ? region : [region.x, region.y, region.w, region.h];
      drawPolygon(rgb, w, h, [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]], [0, 180, 0], 2);
    }
    for (const pts of tpl.fillPolygons || []) drawPolygon(rgb, w, h, pts, [0, 120, 0], 2);
    for (const blob of blobs) drawPolygon(rgb, w, h, blob.pxOutline, [255, 0, 255], 3);
    for (const st of rejected) drawBox(rgb, w, h, st, [255, 140, 0], 1);
    for (const s of [wingSlot, tailSlot]) {
      for (const p of s.parts || [s]) drawBox(rgb, w, h, p.core, [255, 230, 0], 1);
      drawBox(rgb, w, h, s, [0, 200, 255], 2);
    }
    const file = path.join(dir, `${tpl.id}-trace.png`);
    writePNG(file, w, h, rgb);
    log(`debug overlay -> ${path.relative(ROOT, file)}`);
  }

  // 8. fuselage: rotate so the wing slot is horizontal, flip, centre
  const flipX = Boolean(tpl.fuselage && tpl.fuselage.flipX);
  const flipY = Boolean(tpl.fuselage && tpl.fuselage.flipY);
  const flip = ([x, y]) => [flipX ? -x : x, flipY ? -y : y];
  let fOutline = mm(fuselage.pxOutline)
    .map((p) => rotatePoint(p, -wingSlot.angle))
    .map(flip);
  let fSlots = [wingSlot, tailSlot].map((s, i) => {
    const [x, y] = flip(rotatePoint([s.cx * MM_PER_PX, s.cy * MM_PER_PX], -wingSlot.angle));
    let angle = toDeg(s.angle - wingSlot.angle);
    if (flipX !== flipY) angle = -angle;
    return { for: i === 0 ? 'wing' : 'tail', x, y, angle, length: s.length * MM_PER_PX, width: s.width * MM_PER_PX };
  });
  const fb = bboxOf(fOutline);
  const fcx = (fb.minX + fb.maxX) / 2;
  const fcy = (fb.minY + fb.maxY) / 2;
  fOutline = fOutline.map(([x, y]) => [x - fcx, y - fcy]);
  fSlots = fSlots.map((s) => ({ ...s, x: s.x - fcx, y: s.y - fcy }));

  const fmt = (pts) => pts.map(([x, y]) => [round(x), round(y)]);
  const cw = (pts) => (signedArea(pts) < 0 ? pts.slice().reverse() : pts);
  return {
    id: tpl.id,
    name: tpl.name,
    color: tpl.color,
    source: tpl.file,
    units: 'mm',
    scan: { dpi: CONFIG.dpi, mmPerPx: round(MM_PER_PX, 6) },
    parts: {
      fuselage: {
        name: 'Fuselage',
        outline: fmt(cw(fOutline)),
        length: round(fb.width, 2),
        height: round(fb.height, 2),
        slots: fSlots.map((s) => ({
          for: s.for,
          x: round(s.x),
          y: round(s.y),
          angle: round(s.angle, 2),
          scanLength: round(s.length, 2),
          scanWidth: round(s.width, 2),
        })),
      },
      wing: {
        name: 'Main wing',
        outline: fmt(cw(wingN.outline)),
        span: round(wingN.span, 2),
        rootChord: round(wingN.rootChord, 2),
        asymmetryRms: round(wingN.asymmetryRms, 2),
      },
      tail: {
        name: 'Tail wing',
        outline: fmt(cw(tailN.outline)),
        span: round(tailN.span, 2),
        rootChord: round(tailN.rootChord, 2),
        asymmetryRms: round(tailN.asymmetryRms, 2),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeTemplates(all) {
  const json = JSON.stringify(all, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]');
  const out =
    `/* GENERATED FILE – do not edit by hand.\n` +
    ` * Created by tools/trace-templates.js from the scans in templates/ on ${new Date().toISOString()}.\n` +
    ` * Coordinates are millimetres, y grows downwards (SVG convention); every part is centred on its bounding box.\n` +
    ` */\n` +
    `(function () {\n  'use strict';\n  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});\n` +
    `  PC.templates = ${json.replace(/\n/g, '\n  ')};\n})();\n`;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  return out.length;
}

function readExistingTemplates() {
  if (!fs.existsSync(OUT_FILE)) return [];
  const src = fs.readFileSync(OUT_FILE, 'utf8');
  const m = src.match(/PC\.templates = (\[[\s\S]*\]);/);
  return m ? JSON.parse(m[1]) : [];
}

function main() {
  const args = process.argv.slice(2);
  const debug = args.includes('--debug');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const todo = CONFIG.templates.filter((t) => !only || t.id === only);
  if (!todo.length) throw new Error(`no template with id "${only}"`);
  const results = todo.map((t) => traceTemplate(t, { debug }));
  const existing = only ? readExistingTemplates().filter((t) => t.id !== only) : [];
  const order = (id) => CONFIG.templates.findIndex((t) => t.id === id);
  const all = existing.concat(results).sort((a, b) => order(a.id) - order(b.id));
  const bytes = writeTemplates(all);
  console.log(`\nwrote ${path.relative(ROOT, OUT_FILE)} (${all.length} templates, ${(bytes / 1024).toFixed(0)} kB)`);
}

module.exports = {
  CONFIG,
  MM_PER_PX,
  readPPM,
  writePNG,
  classify,
  rasterizePolygon,
  partMask,
  dilate,
  erode,
  close,
  labelComponents,
  blobStats,
  traceOutline,
  smoothClosed,
  simplifyClosed,
  symmetrize,
  measureSlot,
  findSlots,
  drawLine,
  drawPolygon,
  drawBox,
  invert,
  and,
  andNot,
  keepLongRuns,
  reachableFromBorder,
  fillWhiteSlits,
  bboxOf,
  normaliseOrientation,
  traceTemplate,
};

if (require.main === module) main();
