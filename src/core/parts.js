/*
 * parts.js – turns a traced template plus the user's parameters into cuttable geometry.
 *
 * A "part geometry" is { kind, name, color, outline, cutouts, bbox, scale, params, fits, slotClearance }:
 *   outline       – closed polygon in mm, centred on the origin (bounding-box centre)
 *   cutouts       – closed polygons in mm (the wing slots of the fuselage), same coordinates
 *   fits          – fuselage only: which wing and tail the slots are made for,
 *                   { wing: { templateId, scale }, tail: { templateId, scale } }
 *   slotClearance – fuselage only: the smallest distance from a slot to the outline (mm)
 * The fuselage slots are derived at build time: their length follows the root chord of the
 * wing that goes into them (at that wing's scale), their width follows the material
 * thickness – not the scan.  The wing may come from another template than the fuselage.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const G = PC.geometry;

  const KINDS = ['fuselage', 'wing', 'tail'];
  const KIND_LABEL = { fuselage: 'Fuselage', wing: 'Main wing', tail: 'Tail wing' };
  const KIND_EMOJI = { fuselage: '🚀', wing: '🪽', tail: '🪶' };

  const DEFAULT_PARAMS = {
    thickness: 3, // mm – material thickness = slot width
    slotClearance: 0.2, // mm added to the slot width so the wing slides in
    slotLengthExtra: 0.5, // mm added to the slot length beyond the wing's root chord
    slotEnds: 'square', // 'square' | 'round'
  };

  function templates() {
    return PC.templates || [];
  }

  function getTemplate(id) {
    return templates().find((t) => t.id === id) || null;
  }

  function wingspanToScale(template, wingspan) {
    return wingspan / template.parts.wing.span;
  }

  function scaleToWingspan(template, scale) {
    return template.parts.wing.span * scale;
  }

  function partName(template, kind) {
    return `${template.name} – ${KIND_LABEL[kind]}`;
  }

  /** The { template, scale } that goes into a slot: the given mate, else the fuselage's own part. */
  function mateOf(template, scale, mates, kind) {
    const m = mates && mates[kind];
    return m && m.template ? { template: m.template, scale: m.scale ?? scale } : { template, scale };
  }

  /** Straight length of a slot for the wing/tail `kind` of `template` at `scale` (without round ends). */
  function slotLength(template, kind, scale, params = {}) {
    const p = { ...DEFAULT_PARAMS, ...params };
    return template.parts[kind].rootChord * scale + p.slotLengthExtra;
  }

  /**
   * Slot polygon for one fuselage slot.  `mate` = { template, scale } of the wing (or tail)
   * that goes into it; its root chord at its scale sets the slot length.
   */
  function slotPolygon(template, slot, scale, params, mate = null) {
    const kind = slot.for === 'tail' ? 'tail' : 'wing';
    const m = mate || { template, scale };
    const width = params.thickness + params.slotClearance;
    const straight = slotLength(m.template, kind, m.scale, params);
    const cx = slot.x * scale;
    const cy = slot.y * scale;
    if (params.slotEnds === 'round') return G.stadium(cx, cy, straight + width, width, slot.angle, 8);
    return G.rectangle(cx, cy, straight, width, slot.angle);
  }

  /**
   * Builds the geometry of one part.  `scale` is a factor (1 = size of the scanned toy).
   * For a fuselage, `mates` says which wing and tail go into its slots:
   * { wing: { template, scale }, tail: { template, scale } } – a missing entry means the
   * fuselage's own template at its own scale.
   */
  function buildPart(template, kind, scale = 1, params = {}, mates = null) {
    const p = { ...DEFAULT_PARAMS, ...params };
    const src = template.parts[kind];
    if (!src) throw new Error(`template ${template.id} has no part "${kind}"`);
    const outline = G.scalePoints(src.outline, scale);
    const geo = {
      templateId: template.id,
      kind,
      name: partName(template, kind),
      color: template.color,
      scale,
      params: p,
      outline,
      cutouts: [],
      bbox: G.bbox(outline),
      fits: null,
      slotClearance: null,
    };
    if (kind === 'fuselage') {
      const wing = mateOf(template, scale, mates, 'wing');
      const tail = mateOf(template, scale, mates, 'tail');
      geo.cutouts = src.slots.map((slot) => slotPolygon(template, slot, scale, p, slot.for === 'tail' ? tail : wing));
      geo.fits = { wing: { templateId: wing.template.id, scale: wing.scale }, tail: { templateId: tail.template.id, scale: tail.scale } };
      geo.slotClearance = geo.cutouts.reduce((min, c) => Math.min(min, G.polygonClearance(c, outline)), Infinity);
    }
    return geo;
  }

  /** All three parts of a plane from one template. */
  function buildPlane(template, scale = 1, params = {}) {
    return KINDS.map((kind) => buildPart(template, kind, scale, params));
  }

  /** Human readable summary of a geometry, e.g. "Camo – Fuselage · 178 × 48 mm". */
  function describe(geo) {
    return `${geo.name} · ${geo.bbox.width.toFixed(0)} × ${geo.bbox.height.toFixed(0)} mm`;
  }

  PC.parts = {
    KINDS,
    KIND_LABEL,
    KIND_EMOJI,
    DEFAULT_PARAMS,
    templates,
    getTemplate,
    wingspanToScale,
    scaleToWingspan,
    partName,
    slotLength,
    buildPart,
    buildPlane,
    slotPolygon,
    describe,
  };
})();
