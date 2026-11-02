#!/usr/bin/env node
'use strict';
/*
 * test.js – sanity checks for the core modules (no browser needed).
 *   node tools/test.js
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
for (const f of ['src/data/templates.js', 'src/lib/geometry.js', 'src/lib/svg.js', 'src/core/parts.js', 'src/core/sheet.js', 'src/core/exporter.js']) {
  require(path.join(ROOT, f));
}
const PC = globalThis.PlaneCutter;
const G = PC.geometry;
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// templates
ok(PC.templates.length === 3, 'three templates');
for (const t of PC.templates) {
  for (const kind of PC.parts.KINDS) {
    const p = t.parts[kind];
    ok(p.outline.length >= 40, `${t.id} ${kind} has a real outline`);
    const b = G.bbox(p.outline);
    ok(Math.abs(b.cx) < 0.01 && Math.abs(b.cy) < 0.01, `${t.id} ${kind} is centred`);
  }
  ok(t.parts.fuselage.slots.length === 2, `${t.id} has two slots`);
  ok(t.parts.wing.span > t.parts.tail.span, `${t.id} main wing is wider than the tail`);
  ok(t.parts.wing.span > 150 && t.parts.wing.span < 220, `${t.id} wingspan plausible (${t.parts.wing.span})`);
  ok(Math.abs(t.parts.fuselage.slots[0].angle) < 0.01, `${t.id} wing slot is horizontal`);
  // slots are consistent with the wings
  for (const slot of t.parts.fuselage.slots) {
    const chord = t.parts[slot.for].rootChord;
    ok(Math.abs(slot.scanLength - chord) < 4, `${t.id} ${slot.for} slot length ${slot.scanLength} ~ chord ${chord}`);
    ok(slot.scanWidth > 1 && slot.scanWidth < 4, `${t.id} ${slot.for} slot width plausible`);
  }
}

// outlines have no slits: white print at the edge (the "spinner" fade on a nose) once left
// narrow, deep notches in the fuselage outlines.  Scan the outline with lines every 0.5 mm in
// both directions; a line that enters the part, leaves it and enters it again within 5 mm
// marks a notch, and a notch that persists over 4 mm of lines is a slit.
function slitsIn(outline) {
  const b = G.bbox(outline);
  const slits = [];
  for (const dir of ['x', 'y']) {
    const [lo, hi] = dir === 'x' ? [b.minX, b.maxX] : [b.minY, b.maxY];
    let run = 0;
    for (let c = lo + 0.25; c < hi; c += 0.5) {
      const hits = [];
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const p = outline[(i + 1) % outline.length];
        const [a1, a2] = dir === 'x' ? [a[0], a[1]] : [a[1], a[0]];
        const [p1, p2] = dir === 'x' ? [p[0], p[1]] : [p[1], p[0]];
        if (a1 === p1 || c < Math.min(a1, p1) || c >= Math.max(a1, p1)) continue;
        hits.push(a2 + ((c - a1) * (p2 - a2)) / (p1 - a1));
      }
      hits.sort((u, v) => u - v);
      let notch = false;
      for (let k = 1; k + 1 < hits.length; k += 2) if (hits[k + 1] - hits[k] < 5) notch = true;
      run = notch ? run + 0.5 : 0;
      if (run >= 4) slits.push(`${dir}=${c.toFixed(1)}`);
    }
  }
  return slits;
}
for (const t of PC.templates) {
  for (const kind of PC.parts.KINDS) {
    const slits = slitsIn(t.parts[kind].outline);
    ok(slits.length === 0, `${t.id} ${kind} outline has no slits (${slits.join(', ')})`);
  }
}
// ... and the test itself sees the old notch: a 3.7 x 9 mm slit cut into a 40 x 10 mm plate
const plate = [[0, 0], [40, 0], [40, 10], [0, 10], [0, 7], [9, 7], [9, 3.3], [0, 3.3]];
ok(slitsIn(plate).length > 0, 'slit detector finds a 3.7 x 9 mm slit');

// part geometry: slots lie inside the fuselage, width follows the material
for (const t of PC.templates) {
  for (const scale of [0.6, 1, 1.8]) {
    const fus = PC.parts.buildPart(t, 'fuselage', scale, { thickness: 3, slotClearance: 0.2, slotLengthExtra: 0.5 });
    ok(fus.cutouts.length === 2, 'fuselage has two cutouts');
    for (const [i, cut] of fus.cutouts.entries()) {
      for (const pt of cut) ok(G.pointInPolygon(pt, fus.outline), `${t.id} slot ${i} corner inside the outline at scale ${scale}`);
      const slot = t.parts.fuselage.slots[i];
      const chord = t.parts[slot.for].rootChord;
      const b = G.bbox(G.transformPoints(cut, { rotation: -slot.angle }));
      ok(Math.abs(b.height - 3.2) < 1e-6, `slot width = thickness + clearance (${b.height})`);
      ok(Math.abs(b.width - (chord * scale + 0.5)) < 1e-6, `slot length = chord * scale + extra (${b.width})`);
    }
    const round = PC.parts.buildPart(t, 'fuselage', scale, { thickness: 3, slotClearance: 0.2, slotLengthExtra: 0.5, slotEnds: 'round' });
    const rb = G.bbox(G.transformPoints(round.cutouts[0], { rotation: -t.parts.fuselage.slots[0].angle }));
    ok(Math.abs(rb.width - (t.parts.wing.rootChord * scale + 0.5 + 3.2)) < 1e-6, 'round slot is longer by its width');
  }
  const wing = PC.parts.buildPart(t, 'wing', 1.5);
  ok(Math.abs(wing.bbox.width - t.parts.wing.span * 1.5) < 0.05, 'wing scales');
}

// sheet presets: unique ids, sane sizes, Snapmaker 2.0 series present
const presetIds = PC.sheet.SHEET_PRESETS.map((p) => p.id);
ok(new Set(presetIds).size === presetIds.length, 'preset ids are unique');
ok(PC.sheet.SHEET_PRESETS.every((p) => p.width >= 100 && p.height >= 100 && p.name.includes(`${p.width} × ${p.height}`)), 'preset names state their real size');
for (const [id, w, h] of [['snapmaker-a150', 160, 160], ['snapmaker-a250', 230, 250], ['snapmaker-a350', 320, 350]]) {
  const p = PC.sheet.SHEET_PRESETS.find((x) => x.id === id);
  ok(p && p.width === w && p.height === h, `${id} is ${w} x ${h}`);
}
const a350 = PC.sheet.createSheet({ width: 320, height: 350, margin: 5, gap: 4 });
PC.sheet.addPlane(a350, 'camo', 1, (item) => PC.parts.buildPart(PC.parts.getTemplate(item.templateId), item.kind, item.scale, {}));
ok(PC.sheet.check(a350, (item) => PC.parts.buildPart(PC.parts.getTemplate(item.templateId), item.kind, item.scale, {})).outside.length === 0, 'a plane fits the A350 bed');

// sheet: placing, packing, checks, export
const params = { thickness: 3, slotClearance: 0.2, slotLengthExtra: 0.5, slotEnds: 'square' };
const geometryFor = (item) => PC.parts.buildPart(PC.parts.getTemplate(item.templateId), item.kind, item.scale, params);
const sheet = PC.sheet.createSheet({ width: 300, height: 200, margin: 5, gap: 4 });
const items = PC.sheet.addPlane(sheet, 'camo', 1, geometryFor);
ok(items.length === 3 && sheet.items.length === 3, 'plane adds three parts');
let chk = PC.sheet.check(sheet, geometryFor);
ok(chk.outside.length === 0 && chk.overlapping.length === 0, `one plane fits a 300x200 sheet without overlap (${JSON.stringify(chk)})`);
PC.sheet.addPlane(sheet, 'racer', 1, geometryFor);
sheet.items[1].rotation = 82; // a user-rotated part must not wreck the packing
PC.sheet.arrange(sheet, geometryFor);
chk = PC.sheet.check(sheet, geometryFor);
ok(chk.overlapping.length === 0, 'arranged parts do not overlap');
ok(chk.outside.length === 0, `two planes fit a 300x200 sheet after arranging (${JSON.stringify(chk)})`);
ok(sheet.items.every((it) => it.rotation % 90 === 0), 'arrange uses quarter-turn orientations');
const small = PC.sheet.createSheet({ width: 100, height: 100 });
PC.sheet.addPlane(small, 'spitfire', 1, geometryFor);
ok(PC.sheet.check(small, geometryFor).outside.length === 2, 'parts that do not fit are reported (fuselage + wing)');
const dup = PC.sheet.duplicateItem(sheet, items[1].id, geometryFor);
ok(dup && dup.setId !== items[1].setId && dup.id !== items[1].id, 'a duplicate starts a plane of its own');
PC.sheet.removeItem(sheet, dup.id);
ok(sheet.items.length === 6, 'remove works');
const u = PC.sheet.usage(sheet, geometryFor);
ok(u > 0.2 && u < 0.9, `usage plausible (${u.toFixed(2)})`);

const svg = PC.exporter.sheetSvg(sheet, geometryFor, { cutColor: '#ff0000', innerColor: '#0000ff', strokeWidth: 0.1 });
ok(svg.startsWith('<?xml'), 'svg header');
ok(svg.includes('width="300mm" height="200mm" viewBox="0 0 300 200"'), 'sheet size in mm');
ok((svg.match(/<path /g) || []).length === 6 + 4, 'six outlines and four slots');
ok(!svg.includes('transform='), 'transforms are baked in');
ok(svg.indexOf('inner-cut') < svg.indexOf('outer-cut'), 'inner cuts come first');
const part = PC.exporter.partSvg(geometryFor(items[0]));
ok(/width="[\d.]+mm" height="[\d.]+mm" viewBox="0 0/.test(part), 'single part svg has mm size and a 0 0 viewBox');
ok(PC.exporter.partFilename(geometryFor(items[0])) === 'camo-fuselage-100pct-3mm.svg', 'filename');
// numbers in the output never exceed 3 decimals
ok(!/\d\.\d{4,}/.test(svg), 'coordinates rounded to 3 decimals');

// polygon overlap: real outlines, not bounding boxes
{
  const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const A = square(0, 0, 10);
  ok(!G.polygonsOverlap(A, square(20, 0, 10)), 'separate squares do not overlap');
  ok(!G.polygonsOverlap(A, square(20, 0, 10), 5) && G.polygonsOverlap(A, square(20, 0, 10), 11), 'gap counts as overlap only when the outlines come closer than it');
  ok(G.polygonsOverlap(A, square(5, 5, 10)), 'crossing squares overlap');
  ok(G.polygonsOverlap(A, square(2, 2, 3)) && G.polygonsOverlap(square(2, 2, 3), A), 'a square inside another overlaps (both ways)');
  ok(G.polygonsOverlap(A, square(10, 0, 10), 0.01), 'touching squares count as overlapping');
  const L = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]];
  const inNotch = square(12, 12, 16);
  ok(G.boxesOverlap(G.bbox(L), G.bbox(inNotch)), 'L and the square in its notch have overlapping boxes');
  ok(!G.polygonsOverlap(L, inNotch) && !G.polygonsOverlap(inNotch, L), '... but the shapes do not overlap');
  ok(G.polygonsOverlap(L, inNotch, 3), '... unless a 3 mm gap is required (they are 2 mm apart)');
  ok(G.segmentDistance([0, 0], [10, 0], [5, 3], [5, 8]) === 3 && G.segmentDistance([0, 0], [10, 0], [5, -3], [5, 8]) === 0, 'segment distance');
}

// sheet check: a tail wing may tuck under the nose of a fuselage although the boxes overlap
{
  const sh = PC.sheet.createSheet({ width: 400, height: 300, margin: 0, gap: 0 });
  const fus = PC.sheet.addItem(sh, { templateId: 'camo', kind: 'fuselage' }, geometryFor);
  const tail = PC.sheet.addItem(sh, { templateId: 'camo', kind: 'tail' }, geometryFor);
  fus.x = 200;
  fus.y = 150;
  fus.rotation = 0;
  tail.rotation = 0;
  tail.x = fus.x - 55; // above the slim nose, where the box is mostly empty
  let boxesOverlapBeforeShapes = 0;
  let lastFree = null;
  for (let y = fus.y - 60; y < fus.y + 60; y += 0.5) {
    tail.y = y;
    const result = PC.sheet.check(sh, geometryFor);
    if (result.overlapping.length) break;
    lastFree = y;
    if (G.boxesOverlap(PC.sheet.itemBounds(fus, geometryFor(fus)), PC.sheet.itemBounds(tail, geometryFor(tail)))) boxesOverlapBeforeShapes++;
  }
  ok(lastFree !== null && boxesOverlapBeforeShapes >= 16, `tail can move at least 8 mm into the fuselage box before the shapes touch (${boxesOverlapBeforeShapes * 0.5} mm)`);
  tail.y = lastFree;
  ok(PC.sheet.check(sh, geometryFor).overlapping.length === 0 && PC.sheet.itemsOverlap(fus, geometryFor(fus), tail, geometryFor(tail)) === false, 'last free position is reported free');
  tail.y = lastFree + 0.5;
  const hit = PC.sheet.check(sh, geometryFor).overlapping;
  ok(hit.length === 2 && hit.includes(fus.id) && hit.includes(tail.id), 'one step further both parts are reported overlapping');
  // speed: a full check with two planes nestled together stays well under a frame
  PC.sheet.addPlane(sh, 'spitfire', 1, geometryFor);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) PC.sheet.check(sh, geometryFor);
  const ms = (Date.now() - t0) / 20;
  ok(ms < 15, `check is fast (${ms.toFixed(1)} ms for ${sh.items.length} parts)`);
}

// nesting: Arrange and auto-placement work with the real outlines
{
  // a square goes into the notch of an L when it cannot sit beside it
  const shapes = {
    L: [[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]],
    square: [[0, 0], [30, 0], [30, 30], [0, 30]],
  };
  const shapeFor = (item) => ({ outline: shapes[item.kind], cutouts: [], bbox: G.bbox(shapes[item.kind]), color: '#000' });
  const narrow = PC.sheet.createSheet({ width: 100, height: 150, margin: 5, gap: 2 });
  narrow.items.push({ id: 1, setId: 1, templateId: 'x', kind: 'square', scale: 1, x: 0, y: 0, rotation: 0 });
  narrow.items.push({ id: 2, setId: 1, templateId: 'x', kind: 'L', scale: 1, x: 0, y: 0, rotation: 0 });
  PC.sheet.arrange(narrow, shapeFor);
  const L = narrow.items.find((i) => i.kind === 'L');
  const sq = narrow.items.find((i) => i.kind === 'square');
  const lBox = PC.sheet.itemBounds(L, shapeFor(L));
  const sBox = PC.sheet.itemBounds(sq, shapeFor(sq));
  ok(L.rotation === 0 && Math.abs(lBox.minX - 5) < 1e-6 && Math.abs(lBox.minY - 5) < 1e-6, 'the big L sits in the top-left corner');
  ok(G.boxesOverlap(lBox, sBox), 'the square is nested inside the L box');
  ok(sBox.minX >= 27 - 1e-6 && sBox.minY >= 27 - 1e-6 && sBox.maxX <= 65 + 1e-6, `... in its notch, keeping the 2 mm gap (${sBox.minX}, ${sBox.minY})`);
  ok(PC.sheet.check(narrow, shapeFor).overlapping.length === 0 && !G.polygonsOverlap(PC.sheet.placedOutline(L, shapeFor(L)), PC.sheet.placedOutline(sq, shapeFor(sq)), 2), 'nested shapes keep their distance');

  // a whole plane stays flat and low, and the gap is kept between every pair
  const one = PC.sheet.createSheet({ width: 300, height: 200, margin: 5, gap: 4 });
  PC.sheet.addPlane(one, 'camo', 1, geometryFor);
  PC.sheet.arrange(one, geometryFor);
  const bottoms = one.items.map((it) => PC.sheet.itemBounds(it, geometryFor(it)).maxY);
  ok(Math.max(...bottoms) < 95, `one plane is nested into a band lower than 90 mm (${Math.max(...bottoms).toFixed(1)})`);
  ok(one.items.every((it) => it.rotation === 0 || it.rotation === 180), 'all three parts lie flat');
  const two = PC.sheet.createSheet({ width: 300, height: 200, margin: 5, gap: 4 });
  PC.sheet.addPlane(two, 'camo', 1, geometryFor);
  PC.sheet.addPlane(two, 'racer', 1, geometryFor);
  const t0 = Date.now();
  PC.sheet.arrange(two, geometryFor);
  const arrangeMs = Date.now() - t0;
  ok(arrangeMs < 250, `arranging two planes is quick (${arrangeMs} ms)`);
  const placed = two.items.map((it) => PC.sheet.placedOutline(it, geometryFor(it)));
  let closest = true;
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) if (G.polygonsOverlap(placed[i], placed[j], 4)) closest = false;
  ok(closest, 'arranged parts keep the 4 mm gap to each other');
  ok(PC.sheet.check(two, geometryFor).outside.length === 0, 'two arranged planes stay inside the sheet');

  // auto-placement: a duplicate lands clear of everything, with the gap (there is room under one plane)
  const dupe = PC.sheet.duplicateItem(one, one.items[0].id, geometryFor);
  const dupeOutline = PC.sheet.placedOutline(dupe, geometryFor(dupe));
  ok(one.items.filter((it) => it !== dupe).every((it) => !G.polygonsOverlap(dupeOutline, PC.sheet.placedOutline(it, geometryFor(it)), 4)), 'a duplicate is placed with the gap to all parts');
  ok(!dupe.placedOutside && PC.sheet.check(one, geometryFor).overlapping.length === 0, 'and it is on the sheet without overlaps');
  const full = PC.sheet.duplicateItem(two, two.items.find((it) => it.kind === 'fuselage').id, geometryFor);
  ok(full.placedOutside === true, 'when nothing fits the part is dropped at the centre and marked');
}

// mixed planes: fuselage slots follow the wing and tail of their plane
{
  const camo = PC.parts.getTemplate('camo');
  const racer = PC.parts.getTemplate('racer');
  const spit = PC.parts.getTemplate('spitfire');
  const extra = params.slotLengthExtra;
  /** straight length of the i-th slot (square ends): its longest edge */
  const slotLen = (geo, i) => {
    const c = geo.cutouts[i];
    let best = 0;
    for (let k = 0; k < c.length; k++) {
      const p = c[k];
      const q = c[(k + 1) % c.length];
      best = Math.max(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return best;
  };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const own = PC.parts.buildPart(camo, 'fuselage', 1, params);
  const mixed = PC.parts.buildPart(camo, 'fuselage', 1, params, { wing: { template: racer, scale: 1 }, tail: { template: spit, scale: 1 } });
  ok(near(slotLen(own, 0), camo.parts.wing.rootChord + extra), 'own wing slot = own root chord + extra');
  ok(near(slotLen(mixed, 0), racer.parts.wing.rootChord + extra), 'mixed wing slot = Racer root chord + extra');
  ok(near(slotLen(mixed, 1), spit.parts.tail.rootChord + extra), 'mixed tail slot = Spitfire tail chord + extra');
  ok(mixed.fits.wing.templateId === 'racer' && mixed.fits.tail.templateId === 'spitfire' && own.fits.wing.templateId === 'camo', 'a geometry says what it fits');
  const bigWing = PC.parts.buildPart(camo, 'fuselage', 1, params, { wing: { template: racer, scale: 1.5 } });
  ok(near(slotLen(bigWing, 0), racer.parts.wing.rootChord * 1.5 + extra), "the slot follows the wing's own scale");
  ok(near(slotLen(bigWing, 1), camo.parts.tail.rootChord + extra), 'a missing mate means the own part');
  ok(own.slotClearance > PC.sheet.MIN_SLOT_CLEARANCE_MM && mixed.slotClearance > PC.sheet.MIN_SLOT_CLEARANCE_MM, `slots keep clear of the outline (${own.slotClearance.toFixed(1)} / ${mixed.slotClearance.toFixed(1)} mm)`);
  for (const t of PC.templates) {
    const g = PC.parts.buildPart(t, 'fuselage', 1, params);
    ok(g.slotClearance > PC.sheet.MIN_SLOT_CLEARANCE_MM, `${t.id}: own slots are clear of the outline (${g.slotClearance.toFixed(1)} mm)`);
  }
  const thick = PC.parts.buildPart(racer, 'fuselage', 1, { ...params, thickness: 30 });
  ok(thick.slotClearance < PC.sheet.MIN_SLOT_CLEARANCE_MM, `a 30 mm wide slot in the Racer fuselage is flagged (${thick.slotClearance.toFixed(1)} mm)`);
  ok(PC.exporter.partFilename(mixed) === 'camo-fuselage-fits-racer-wing-spitfire-tail-100pct-3mm.svg', 'the file name says what the fuselage fits');
  ok(PC.exporter.partFilename(own) === 'camo-fuselage-100pct-3mm.svg', 'a plain fuselage keeps its file name');

  // on a sheet the mates come from the plane
  const sh = PC.sheet.createSheet({ width: 400, height: 300, margin: 5, gap: 4 });
  const geoFor = (item) => {
    const f = PC.sheet.fitsFor(sh, item);
    const mate = (x) => ({ template: PC.parts.getTemplate(x.templateId), scale: x.scale });
    return PC.parts.buildPart(PC.parts.getTemplate(item.templateId), item.kind, item.scale, params, item.kind === 'fuselage' ? { wing: mate(f.wing), tail: mate(f.tail) } : null);
  };
  const [fus, wing, tail] = PC.sheet.addPlane(sh, { fuselage: 'camo', wing: 'racer', tail: 'spitfire' }, 1, geoFor);
  ok(fus.templateId === 'camo' && wing.templateId === 'racer' && tail.templateId === 'spitfire' && fus.setId === wing.setId && wing.setId === tail.setId, 'a mixed plane is one set of three');
  ok(fus.fits.wing === 'racer' && fus.fits.tail === 'spitfire' && !wing.fits, 'the fuselage remembers what it was made for');
  let f = PC.sheet.fitsFor(sh, fus);
  ok(f.wing.source === 'plane' && f.wing.itemId === wing.id && f.tail.source === 'plane' && f.tail.itemId === tail.id, 'the slots fit the parts of the plane');
  ok(near(slotLen(geoFor(fus), 0), racer.parts.wing.rootChord + extra), 'sheet geometry uses the Racer wing');
  ok(PC.sheet.check(sh, geoFor).unmated.length === 0, 'a complete plane is not reported');
  // the wing leaves for a plane of its own: the fuselage falls back to its choice (still Racer)
  ok(PC.sheet.moveToPlane(sh, wing.id, 'new') === wing && wing.setId !== fus.setId, 'a wing can leave to a plane of its own');
  f = PC.sheet.fitsFor(sh, fus);
  ok(f.wing.source === 'choice' && f.wing.templateId === 'racer' && f.tail.source === 'plane', 'without a wing on the sheet the remembered choice applies');
  const unmated = PC.sheet.check(sh, geoFor).unmated;
  ok(unmated.length === 1 && unmated[0].id === fus.id && unmated[0].missing.join() === 'wing', 'check reports the missing wing');
  // a second plane: a wing cannot move into a plane that already has one
  const [fus2, wing2] = PC.sheet.addPlane(sh, 'camo', 1, geoFor, ['fuselage', 'wing']);
  ok(PC.sheet.moveToPlane(sh, wing.id, fus2.setId) === null && wing.setId !== fus2.setId, 'a plane holds one main wing only');
  ok(PC.sheet.moveToPlane(sh, wing2.id, fus.setId) === wing2 && wing2.setId === fus.setId, 'a wing may join a plane that has none');
  f = PC.sheet.fitsFor(sh, fus);
  ok(f.wing.source === 'plane' && f.wing.templateId === 'camo', 'the fuselage now fits the Camo wing that joined');
  ok(near(slotLen(geoFor(fus), 0), camo.parts.wing.rootChord + extra), 'and its slot changed with it');
  ok(PC.sheet.moveToPlane(sh, fus2.id, 'new') === fus2 && PC.sheet.planeIds(sh).length === 3, 'a lone part moved to "new" just stays alone');
  ok(PC.sheet.planeNumber(sh, fus.setId) === 1 && PC.sheet.planeNumber(sh, wing.setId) === 2 && PC.sheet.planeNumber(sh, fus2.setId) === 3, 'planes are numbered 1, 2, 3 in order');
  // duplicate: a plane of its own, keeping what the slots fit
  const copy = PC.sheet.duplicateItem(sh, fus.id, geoFor);
  ok(copy.setId !== fus.setId && copy.fits.wing === 'camo' && copy.fits.tail === 'spitfire', 'a duplicated fuselage starts its own plane and keeps what it fits');
  ok(PC.sheet.check(sh, geoFor).tightSlots.length === 0, 'no slot is too close to an outline');
  // repairing saved sheets: two wings in one plane are split apart
  const old = PC.sheet.createSheet({});
  old.items.push({ id: 1, setId: 1, templateId: 'camo', kind: 'fuselage', scale: 1, x: 0, y: 0, rotation: 0 });
  old.items.push({ id: 2, setId: 1, templateId: 'camo', kind: 'wing', scale: 1, x: 0, y: 0, rotation: 0 });
  old.items.push({ id: 3, setId: 1, templateId: 'racer', kind: 'wing', scale: 1, x: 0, y: 0, rotation: 0 });
  ok(PC.sheet.normalizePlanes(old) === 1 && old.items[2].setId !== 1 && old.items[1].setId === 1 && old.nextId === 4 && old.nextSetId > old.items[2].setId, 'loading splits a plane with two wings');
  ok(PC.sheet.normalizePlanes(old) === 0, 'a repaired sheet stays as it is');
}

console.log(`ok – ${checks} checks passed`);
