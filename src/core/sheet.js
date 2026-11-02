/*
 * sheet.js – the artwork sheet: a rectangle in mm with placed parts on it.
 *
 * sheet = { width, height, margin, gap, items: [item], nextId, nextSetId }
 * item  = { id, setId, templateId, kind, scale, x, y, rotation, fits? }
 *   x, y     – position of the part's bounding-box centre on the sheet (mm, from the top-left)
 *   rotation – degrees, clockwise on screen
 *   setId    – the parts of one plane share a set: at most one fuselage, one main wing and
 *              one tail wing, which may come from different templates (see "planes" below)
 *   fits     – fuselage only: { wing: templateId, tail: templateId } its slots are made for
 *              while its plane has no such part on the sheet
 *
 * This module is pure data + functions; it receives a `geometryFor(item)` callback
 * (see parts.js) so it never has to know about material parameters itself.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const G = PC.geometry;

  // width x height in mm = the machine's X x Y work area
  const SHEET_PRESETS = [
    { id: 'a4', name: 'A4 (297 × 210)', width: 297, height: 210 },
    { id: 'a3', name: 'A3 (420 × 297)', width: 420, height: 297 },
    { id: 'snapmaker-a150', name: 'Snapmaker 2.0 A150 (160 × 160)', width: 160, height: 160 },
    { id: 'snapmaker-a250', name: 'Snapmaker 2.0 A250 (230 × 250)', width: 230, height: 250 },
    { id: 'snapmaker-a350', name: 'Snapmaker 2.0 A350 (320 × 350)', width: 320, height: 350 },
    { id: 'k40', name: 'K40 (300 × 200)', width: 300, height: 200 },
    { id: 'm400', name: '400 × 300', width: 400, height: 300 },
    { id: 'm600', name: '600 × 400', width: 600, height: 400 },
    { id: 'glowforge', name: 'Glowforge (495 × 279)', width: 495, height: 279 },
    { id: 'xtool', name: 'xTool D1 (430 × 390)', width: 430, height: 390 },
  ];

  function createSheet({ width = 300, height = 200, margin = 5, gap = 4 } = {}) {
    return { width, height, margin, gap, items: [], nextId: 1, nextSetId: 1 };
  }

  // --- planes ---------------------------------------------------------------
  // A plane is the set of items sharing a setId.  The fuselage's slots fit the wing and
  // tail of its plane.  While the plane has no such part on the sheet, the fuselage's own
  // `fits` choice applies, and failing that its own template.

  /** Set ids of the planes on the sheet, in the order they are numbered in the UI (1, 2, 3, …). */
  function planeIds(sheet) {
    return [...new Set(sheet.items.map((it) => it.setId))].sort((a, b) => a - b);
  }

  function planeNumber(sheet, setId) {
    return planeIds(sheet).indexOf(setId) + 1;
  }

  /** The parts of one plane by kind: { fuselage, wing, tail } (absent kinds are missing). */
  function planeParts(sheet, setId) {
    const parts = {};
    for (const it of sheet.items) if (it.setId === setId && !parts[it.kind]) parts[it.kind] = it;
    return parts;
  }

  /**
   * Which wing and tail a fuselage's slots are made for:
   * { wing: { templateId, scale, source, itemId? }, tail: … } where source is 'plane' (the
   * part of its plane on the sheet), 'choice' (the item's `fits`) or 'own' (its template).
   */
  function fitsFor(sheet, item) {
    const parts = planeParts(sheet, item.setId);
    const result = {};
    for (const kind of ['wing', 'tail']) {
      const mate = parts[kind];
      const choice = item.fits && item.fits[kind];
      if (mate) result[kind] = { templateId: mate.templateId, scale: mate.scale, source: 'plane', itemId: mate.id };
      else if (choice && PC.parts.getTemplate(choice)) result[kind] = { templateId: choice, scale: item.scale, source: 'choice' };
      else result[kind] = { templateId: item.templateId, scale: item.scale, source: 'own' };
    }
    return result;
  }

  /** The template ids a fuselage's slots currently fit, as a `fits` value. */
  function fitTemplateIds(sheet, item) {
    const f = fitsFor(sheet, item);
    return { wing: f.wing.templateId, tail: f.tail.templateId };
  }

  /**
   * Moves a part into another plane (`target` = setId, or 'new' for a plane of its own).
   * Returns the item, or null when that plane already has a part of this kind.
   */
  function moveToPlane(sheet, id, target) {
    const item = sheet.items.find((it) => it.id === id);
    if (!item) return null;
    if (target === 'new') {
      if (sheet.items.some((it) => it.setId === item.setId && it !== item)) item.setId = sheet.nextSetId++;
      return item;
    }
    const setId = Number(target);
    if (setId === item.setId) return item;
    if (sheet.items.some((it) => it.setId === setId && it.kind === item.kind)) return null;
    item.setId = setId;
    return item;
  }

  /**
   * Repairs a sheet loaded from storage: every plane holds at most one part of each kind
   * (extra parts get a plane of their own) and the id counters are ahead of all ids.
   * Returns the number of parts that were moved.
   */
  function normalizePlanes(sheet) {
    let maxId = 0;
    let maxSet = 0;
    for (const it of sheet.items) {
      maxId = Math.max(maxId, it.id);
      maxSet = Math.max(maxSet, it.setId);
    }
    sheet.nextId = Math.max(sheet.nextId || 1, maxId + 1);
    sheet.nextSetId = Math.max(sheet.nextSetId || 1, maxSet + 1);
    let moved = 0;
    const seen = new Set();
    for (const it of sheet.items) {
      if (seen.has(`${it.setId}|${it.kind}`)) {
        it.setId = sheet.nextSetId++;
        moved++;
      }
      seen.add(`${it.setId}|${it.kind}`);
    }
    return moved;
  }

  /** Outline of a placed item in sheet coordinates. */
  function placedOutline(item, geo) {
    return G.transformPoints(geo.outline, { rotation: item.rotation, x: item.x, y: item.y });
  }

  function placedCutouts(item, geo) {
    return geo.cutouts.map((c) => G.transformPoints(c, { rotation: item.rotation, x: item.x, y: item.y }));
  }

  function itemBounds(item, geo) {
    return G.bbox(placedOutline(item, geo));
  }

  /** Bounding box the part would have at (0,0) with the given rotation. */
  function rotatedBox(geo, rotation) {
    return G.bbox(G.transformPoints(geo.outline, { rotation }));
  }

  function usableRect(sheet) {
    return { minX: sheet.margin, minY: sheet.margin, maxX: sheet.width - sheet.margin, maxY: sheet.height - sheet.margin };
  }

  // --- placing parts: raster nesting ---------------------------------------------------
  //
  // Parts are rasterised on a grid of NEST_CELL mm: a cell is set when the outline touches
  // it, so two parts whose cells are disjoint can never overlap.  The usable area keeps a
  // bit-packed occupancy map of the placed parts, and a new part goes to the first cell
  // position (rows from the top, left to right) where its mask, grown by the gap, hits
  // nothing.  That is bottom-left nesting on the real outlines: a tail wing slides under a
  // fuselage, a fuselage turned nose-to-tail tucks against another one.
  const NEST_CELL = 0.5; // mm
  const ORIENTATIONS = [0, 90, 180, 270]; // tried by arrange(), in this order

  /** The gap in cells – at least one empty cell, so parts never touch. */
  function gapCells(sheet) {
    return Math.max(1, Math.ceil(sheet.gap / NEST_CELL - 1e-9));
  }

  /** Cells touched by a polygon; the mask origin is the cell that holds the polygon's bbox corner. */
  function rasterize(outline, cell = NEST_CELL) {
    const b = G.bbox(outline);
    const ox = Math.floor(b.minX / cell + 1e-9);
    const oy = Math.floor(b.minY / cell + 1e-9);
    const mw = Math.max(1, Math.floor(b.maxX / cell - 1e-9) - ox + 1);
    const mh = Math.max(1, Math.floor(b.maxY / cell - 1e-9) - oy + 1);
    const cells = new Uint8Array(mw * mh);
    const mark = (x, y) => {
      const i = G.clamp(Math.floor(x / cell) - ox, 0, mw - 1);
      const j = G.clamp(Math.floor(y / cell) - oy, 0, mh - 1);
      cells[j * mw + i] = 1;
    };
    const n = outline.length;
    // boundary: walk every edge in half-cell steps
    for (let e = 0; e < n; e++) {
      const [x1, y1] = outline[e];
      const [x2, y2] = outline[(e + 1) % n];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cell / 2)));
      for (let k = 0; k <= steps; k++) mark(x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps);
    }
    // interior: a scanline through the centre of every cell row
    for (let j = 0; j < mh; j++) {
      const yc = (oy + j + 0.5) * cell;
      const xs = [];
      for (let e = 0; e < n; e++) {
        const [ax, ay] = outline[e];
        const [bx, by] = outline[(e + 1) % n];
        if (ay === by || yc < Math.min(ay, by) || yc >= Math.max(ay, by)) continue;
        xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = G.clamp(Math.floor(xs[k] / cell) - ox, 0, mw - 1);
        const c1 = G.clamp(Math.floor(xs[k + 1] / cell) - ox, 0, mw - 1);
        cells.fill(1, j * mw + c0, j * mw + c1 + 1);
      }
    }
    return { ox, oy, mw, mh, cells };
  }

  /** The mask grown by k cells in every direction (square); its origin moves by -k. */
  function grow(mask, k) {
    if (k <= 0) return mask;
    const mw = mask.mw + 2 * k;
    const mh = mask.mh + 2 * k;
    const tmp = new Uint8Array(mw * mh);
    for (let j = 0; j < mask.mh; j++) {
      const src = j * mask.mw;
      const dst = (j + k) * mw;
      let count = 0;
      for (let i = 0; i < mw; i++) {
        if (i < mask.mw && mask.cells[src + i]) count++;
        const out = i - 2 * k - 1;
        if (out >= 0 && out < mask.mw && mask.cells[src + out]) count--;
        if (count > 0) tmp[dst + i] = 1;
      }
    }
    const cells = new Uint8Array(mw * mh);
    for (let i = 0; i < mw; i++) {
      let count = 0;
      for (let j = -k; j < mh; j++) {
        if (j + k < mh && tmp[(j + k) * mw + i]) count++;
        if (j - k - 1 >= 0 && tmp[(j - k - 1) * mw + i]) count--;
        if (j >= 0 && count > 0) cells[j * mw + i] = 1;
      }
    }
    return { ox: mask.ox - k, oy: mask.oy - k, mw, mh, cells };
  }

  /** Mask rows as bit sets (bit i of word w = column 32 w + i), in all 32 bit-shifted variants. */
  function packRows(mask) {
    const words = (mask.mw >> 5) + 2;
    const rows = [];
    for (let j = 0; j < mask.mh; j++) {
      const row = new Uint32Array(words);
      for (let i = 0; i < mask.mw; i++) if (mask.cells[j * mask.mw + i]) row[i >> 5] |= 1 << (i & 31);
      rows.push(row);
    }
    const shifted = [rows];
    for (let s = 1; s < 32; s++) {
      shifted.push(
        rows.map((row) => {
          const out = new Uint32Array(words);
          for (let w = 0; w < words; w++) out[w] = ((row[w] << s) | (w > 0 ? row[w - 1] >>> (32 - s) : 0)) >>> 0;
          return out;
        }),
      );
    }
    return { mw: mask.mw, mh: mask.mh, words, shifted };
  }

  function createOccupancy(width, height) {
    const words = (width >> 5) + 2;
    const rows = [];
    for (let j = 0; j < height; j++) {
      const row = new Uint32Array(words);
      for (let i = width; i < words * 32; i++) row[i >> 5] |= 1 << (i & 31); // beyond the grid counts as occupied
      rows.push(row);
    }
    return { width, height, words, rows };
  }

  /** Marks the mask with its cell (0,0) at (x, y); cells outside the grid are dropped. */
  function occupy(occ, mask, x, y) {
    for (let j = 0; j < mask.mh; j++) {
      const oy = y + j;
      if (oy < 0 || oy >= occ.height) continue;
      const row = occ.rows[oy];
      for (let i = 0; i < mask.mw; i++) {
        const ox = x + i;
        if (ox < 0 || ox >= occ.width || !mask.cells[j * mask.mw + i]) continue;
        row[ox >> 5] |= 1 << (ox & 31);
      }
    }
  }

  /**
   * True when the packed mask with its cell (0,0) at (x, y) (both >= 0) hits an occupied
   * cell.  Rows are visited in a strided order (every 8th, then the ones in between):
   * occupied cells come in big patches, so a collision deep inside a tall mask shows up
   * after a few rows instead of hundreds.
   */
  function collides(occ, packed, x, y) {
    const rows = packed.shifted[x & 31];
    const w0 = x >> 5;
    for (let r = 0; r < 8; r++) {
      for (let j = r; j < packed.mh; j += 8) {
        const orow = occ.rows[y + j];
        const mrow = rows[j];
        if (!orow) return true;
        for (let w = 0; w < packed.words; w++) {
          if (mrow[w] && (w0 + w >= occ.words || orow[w0 + w] & mrow[w])) return true;
        }
      }
    }
    return false;
  }

  /** Occupancy map of the usable area (padded by k cells) with the given placed outlines marked. */
  function occupancyOf(sheet, outlines, k) {
    const area = usableRect(sheet);
    const W = Math.max(0, Math.floor((area.maxX - area.minX) / NEST_CELL + 1e-9));
    const H = Math.max(0, Math.floor((area.maxY - area.minY) / NEST_CELL + 1e-9));
    const occ = createOccupancy(W + 2 * k, H + 2 * k);
    for (const outline of outlines) {
      const m = rasterize(outline.map(([x, y]) => [x - area.minX, y - area.minY]));
      occupy(occ, m, m.ox + k, m.oy + k);
    }
    return occ;
  }

  /**
   * Top-most, then left-most position for an outline (already rotated) that keeps the
   * gap to everything in `occ`.  Returns the cell position, the mask and the translation
   * (x, y) the item needs, or null when the part does not fit.
   */
  function bestSpot(occ, sheet, outline, k) {
    const area = usableRect(sheet);
    const W = occ.width - 2 * k;
    const H = occ.height - 2 * k;
    const mask = rasterize(outline);
    if (mask.mw > W || mask.mh > H) return null;
    const packed = packRows(grow(mask, k));
    for (let y = 0; y + mask.mh <= H; y++) {
      for (let x = 0; x + mask.mw <= W; x++) {
        if (collides(occ, packed, x, y)) continue;
        return { cx: x, cy: y, mask, x: area.minX + (x - mask.ox) * NEST_CELL, y: area.minY + (y - mask.oy) * NEST_CELL };
      }
    }
    return null;
  }

  /**
   * First free spot (rows from the top, left to right) where a part with the given
   * rotation fits inside the margins and keeps the gap to `otherOutlines` (placed outlines).
   */
  function findFreeSpot(sheet, geo, rotation, otherOutlines = []) {
    const k = gapCells(sheet);
    const occ = occupancyOf(sheet, otherOutlines, k);
    const spot = bestSpot(occ, sheet, G.transformPoints(geo.outline, { rotation }), k);
    return spot ? { x: spot.x, y: spot.y } : null;
  }

  function allOutlines(sheet, geometryFor, except = null) {
    return sheet.items.filter((it) => it !== except).map((it) => placedOutline(it, geometryFor(it)));
  }

  /**
   * Adds one part; returns the item.  Falls back to the sheet centre when nothing fits.
   * `fits` (fuselage only) = { wing: templateId, tail: templateId } the slots are made for
   * while the plane has no such part on the sheet.
   */
  function addItem(sheet, { templateId, kind, scale = 1, setId = null, rotation = 0, fits = null }, geometryFor) {
    const item = { id: sheet.nextId++, setId: setId ?? sheet.nextSetId++, templateId, kind, scale, x: 0, y: 0, rotation };
    if (fits && kind === 'fuselage') item.fits = { ...fits };
    const geo = geometryFor(item);
    const spot = findFreeSpot(sheet, geo, rotation, allOutlines(sheet, geometryFor));
    if (spot) {
      item.x = spot.x;
      item.y = spot.y;
    } else {
      item.x = sheet.width / 2;
      item.y = sheet.height / 2;
      item.placedOutside = true;
    }
    sheet.items.push(item);
    return item;
  }

  /**
   * Adds the parts of a plane as one set; returns the items.  `spec` is a template id (all
   * parts from that template) or { fuselage, wing, tail } template ids for a mixed plane.
   * The fuselage remembers the wing and tail it was made for (`fits`), so its slots stay
   * right even when those parts are removed from the sheet later.
   */
  function addPlane(sheet, spec, scale, geometryFor, kinds = PC.parts.KINDS) {
    const ids = typeof spec === 'string' ? { fuselage: spec, wing: spec, tail: spec } : { ...spec };
    const setId = sheet.nextSetId++;
    return kinds.map((kind) =>
      addItem(sheet, { templateId: ids[kind], kind, scale, setId, fits: kind === 'fuselage' ? { wing: ids.wing, tail: ids.tail } : null }, geometryFor),
    );
  }

  function removeItem(sheet, id) {
    sheet.items = sheet.items.filter((it) => it.id !== id);
  }

  /** Copies a part into a plane of its own (a plane holds one part of each kind); a fuselage keeps what its slots fit. */
  function duplicateItem(sheet, id, geometryFor) {
    const src = sheet.items.find((it) => it.id === id);
    if (!src) return null;
    const fits = src.kind === 'fuselage' ? fitTemplateIds(sheet, src) : null;
    return addItem(sheet, { templateId: src.templateId, kind: src.kind, scale: src.scale, rotation: src.rotation, fits }, geometryFor);
  }

  function setScale(sheet, setId, scale) {
    for (const it of sheet.items) if (it.setId === setId) it.scale = scale;
  }

  /**
   * Nests all items, biggest part first.  Every part is tried in four orientations
   * (0/90/180/270°) at its top-most, left-most free position; the orientation that keeps
   * the layout lowest wins (a flat wing under a flat fuselage rather than parts standing
   * upright in the first row), then the higher, then the further left position.  Parts
   * that fit nowhere are lined up below the sheet, where check() flags them.
   */
  function arrange(sheet, geometryFor) {
    const k = gapCells(sheet);
    const occ = occupancyOf(sheet, [], k);
    const entries = sheet.items
      .map((item) => ({ item, geo: geometryFor(item) }))
      .sort((a, b) => G.polygonArea(b.geo.outline) - G.polygonArea(a.geo.outline));
    const leftovers = [];
    let layoutBottom = 0; // lowest occupied cell row so far
    for (const e of entries) {
      let best = null;
      for (const rotation of ORIENTATIONS) {
        const spot = bestSpot(occ, sheet, G.transformPoints(e.geo.outline, { rotation }), k);
        if (!spot) continue;
        const height = Math.max(layoutBottom, spot.cy + spot.mask.mh);
        const better =
          !best || height < best.height || (height === best.height && (spot.cy < best.cy || (spot.cy === best.cy && spot.cx < best.cx)));
        if (better) best = { ...spot, rotation, height };
      }
      if (!best) {
        leftovers.push(e);
        continue;
      }
      e.item.rotation = best.rotation;
      e.item.x = best.x;
      e.item.y = best.y;
      delete e.item.placedOutside;
      occupy(occ, best.mask, best.cx + k, best.cy + k);
      layoutBottom = best.height;
    }
    let x = usableRect(sheet).minX;
    for (const e of leftovers) {
      const box = rotatedBox(e.geo, 0);
      e.item.rotation = 0;
      e.item.x = x - box.minX;
      e.item.y = sheet.height + sheet.gap - box.minY;
      e.item.placedOutside = true;
      x += box.width + sheet.gap;
    }
  }

  // Outlines closer than this count as overlapping (touching parts would be cut as one).
  const TOUCH_MM = 0.01;

  /** True when the two placed parts really overlap (their outlines, not their bounding boxes). */
  function itemsOverlap(a, geoA, b, geoB) {
    const boxA = itemBounds(a, geoA);
    const boxB = itemBounds(b, geoB);
    if (!G.boxesOverlap(boxA, boxB, TOUCH_MM)) return false;
    return G.polygonsOverlap(placedOutline(a, geoA), placedOutline(b, geoB), TOUCH_MM);
  }

  // A slot closer to the outline than this leaves too thin a wall next to it (mm).
  const MIN_SLOT_CLEARANCE_MM = 2;

  /**
   * Items that stick out of the usable area or overlap another item.  The sheet is a
   * rectangle, so the bounding box of the placed outline decides "outside"; overlaps are
   * decided by the outlines themselves, so parts may sit as close as their shapes allow.
   * Also lists fuselages whose slots come too close to their outline (`tightSlots`) and
   * fuselages whose plane lacks the wing or tail the slots are made for
   * (`unmated`: { id, setId, missing: ['wing' | 'tail', …] }).
   */
  function check(sheet, geometryFor) {
    const area = usableRect(sheet);
    const placed = sheet.items.map((item) => {
      const outline = placedOutline(item, geometryFor(item));
      return { item, outline, box: G.bbox(outline) };
    });
    const outside = placed.filter((p) => !G.boxInside(p.box, area)).map((p) => p.item.id);
    const overlapping = new Set();
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (!G.boxesOverlap(placed[i].box, placed[j].box, TOUCH_MM)) continue;
        if (G.polygonsOverlap(placed[i].outline, placed[j].outline, TOUCH_MM)) {
          overlapping.add(placed[i].item.id);
          overlapping.add(placed[j].item.id);
        }
      }
    }
    const tightSlots = [];
    const unmated = [];
    for (const p of placed) {
      if (p.item.kind !== 'fuselage') continue;
      const geo = geometryFor(p.item);
      if (geo.slotClearance != null && geo.slotClearance < MIN_SLOT_CLEARANCE_MM) tightSlots.push(p.item.id);
      const fits = fitsFor(sheet, p.item);
      const missing = ['wing', 'tail'].filter((kind) => fits[kind].source !== 'plane');
      if (missing.length) unmated.push({ id: p.item.id, setId: p.item.setId, missing });
    }
    return { outside, overlapping: [...overlapping], tightSlots, unmated };
  }

  /** Fraction of the sheet covered by part bounding boxes (rough usage indicator). */
  function usage(sheet, geometryFor) {
    const total = sheet.width * sheet.height;
    if (!total) return 0;
    const used = sheet.items.reduce((sum, item) => sum + G.polygonArea(geometryFor(item).outline), 0);
    return used / total;
  }

  PC.sheet = {
    SHEET_PRESETS,
    MIN_SLOT_CLEARANCE_MM,
    createSheet,
    planeIds,
    planeNumber,
    planeParts,
    fitsFor,
    fitTemplateIds,
    moveToPlane,
    normalizePlanes,
    placedOutline,
    placedCutouts,
    itemBounds,
    rotatedBox,
    usableRect,
    findFreeSpot,
    addItem,
    addPlane,
    removeItem,
    duplicateItem,
    setScale,
    arrange,
    rasterize,
    itemsOverlap,
    check,
    usage,
  };
})();
