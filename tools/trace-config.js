'use strict';

/*
 * Per-template settings for tools/trace-templates.js.
 *
 * Every template is one A4 scan (PDF) of the three foam parts laid flat: the
 * main wing, the fuselage (with the two wing slots) and the tail wing.  Scans
 * are assumed to be 1:1, so millimetres = pixels * 25.4 / dpi.
 *
 * Orientation flags let us present every plane the same way (nose to the
 * left, fin up).  The parts are flat sheets, so mirroring an outline is the
 * same physical part – it only changes how it is displayed.
 *
 * Pixel coordinates below refer to the scan rendered at `dpi` (see the
 * build/debug/<id>-trace.png overlays, they are at the same resolution).
 *
 * Hints for white print at a part edge (it is nearly as bright as the lid):
 *   paleRegions  – rectangles {x, y, w, h}; inside, everything up to regionMaxValue is part
 *   fillPolygons – polygons [[x, y], ...]; inside is part, full stop
 */
module.exports = {
  // Resolution at which the PDFs are rasterised for tracing.
  dpi: 300,

  // Pixel classification (0..255 RGB scans, sat = max(r,g,b) - min(r,g,b)).
  thresholds: {
    // "strict" part pixels: printed colour or black print
    minSaturation: 45, // sat >= this  => printed colour
    maxDark: 140, // max <= this     => black print
    // "pale" part pixels: very light print with a faint tint (e.g. the white-blue nose of Camo).
    // The scanner lid is pure white (253..255) and its shadows are neutral grey, so a faint
    // tint is what separates pale print from the background.
    paleMinValue: 236,
    paleMaxValue: 251,
    paleMinSaturation: 4,
    paleOpenRadiusPx: 5, // only pale areas thicker than ~2*this count (thin ones are blur around colour print)
    minPaleAreaPx: 1500, // ... and bigger than this (small ones are dust or blur that survived the opening)
    // Inside `paleRegions` (see templates below) everything up to this value is part.  The lid
    // reads 253 where it is lifted next to a part, so the boundary with the lid is then moved
    // inwards by looseErodePx – the strict mask also stops that far short of the lid.
    regionMaxValue: 253,
    looseErodePx: 5,
    // slot core: the scanner lid seen through a slit (also matches printed white – removed by size)
    litMaxSaturation: 40,
    litMinValue: 170,
    // growing a slot core across its shadow stops at printed pixels:
    vividMinSaturation: 110, // saturated print
    blackMaxValue: 80, // black print (slot shadows are brighter than this)
    lightPrintMinValue: 190, // pale print (sky blue, pale yellow) is bright AND
    lightPrintMinSaturation: 45, // ... at least a little saturated
    gapTolerancePx: 6, // blurred transition pixels we may step over while growing
    // walking along the slot: the lid seen through the slit is (nearly) pure white
    brightMinValue: 250,
    brightMaxSaturation: 100,
    // the scanner lid itself: pure white (255, 253 where the lid is lifted next to a part).
    // White print on the foam is mostly a little darker (240..252) – see whitePrint below
    // and paleRegions.
    lidMinValue: 253,
  },

  geometry: {
    closeRadiusPx: 2, // morphological closing to seal tiny gaps in the outline
    minPartAreaPx: 20000, // blobs smaller than this are dust / print artefacts
    smoothWindowPx: 4, // moving average half-window along the traced boundary
    simplifyTolerancePx: 1.2, // Douglas-Peucker tolerance (1.2 px ~ 0.1 mm at 300 dpi)
    slot: {
      bigWhiteErodePx: 8, // printed white areas thicker than ~2*this are not slot cores
      bigWhiteMarginPx: 11,
      minRunPx: 40, // a slot core contains horizontal runs at least this long
      minWidthPx: 4, // the lit core of a slot is a thin, long, white streak ...
      maxWidthPx: 40,
      minLengthPx: 90,
      minAspect: 5,
      maxAngleDeg: 30, // ... roughly along the fuselage axis ...
      edgeMarginPx: 12, // ... and well inside the fuselage
      maxHalfWidthPx: 50, // how far the core may grow across its shadow on each side
      lengthSlackMm: 3, // the slot may be this much longer than the wing's root chord
      mergeDistancePx: 8, // fragments of one slot: same axis line ...
      mergeAngleDeg: 3,
      mergeGapPx: 80, // ... with at most this gap between them
    },
    // White print that reaches the outline (the "spinner" fade on a nose) is nearly as bright
    // as the lid, so it is missing from the part mask and leaves a slit in the outline.  A gap
    // is filled when it is bounded by the same part on both sides (across rows or columns),
    // narrow, deep (shallow dents are real outline features) and made of print white rather
    // than lid white.  The fill then grows into the slightly darker non-lid pixels at the very
    // tip of the slit, which the lips of the slit do not bound.
    whitePrint: {
      maxSlitWidthPx: 60, // ~5 mm
      minSlitDepthPx: 60, // ~5 mm
      minPrintFraction: 0.6, // share of gap pixels darker than the lid (lidMinValue)
      tipGrowPx: 12, // ~1 mm
    },
    wingSymmetryStepMm: 0.25, // sampling step used to make wings exactly symmetric
    outputDecimals: 3,
  },

  templates: [
    {
      id: 'camo',
      name: 'Camo',
      file: 'templates/airplane_camo.pdf',
      color: '#5aa843',
      // Scanned upside down (fin pointing down) – mirror so the fin points up.
      fuselage: { flipX: false, flipY: true },
      // The canopy glass fades from light blue to white right at the top edge of the fuselage
      // (bottom edge in the scan, px 940..1300 x 1300..1410).  A wide fade like that cannot be
      // told from the lid by colour, so inside this rectangle everything but the lid is part.
      paleRegions: [{ x: 940, y: 1300, w: 360, h: 110 }],
    },
    {
      id: 'racer',
      name: 'Racer',
      file: 'templates/airplane_racer.pdf',
      color: '#ff7a3d',
      fuselage: { flipX: false, flipY: false },
      paleRegions: [],
    },
    {
      id: 'spitfire',
      name: 'Spitfire',
      file: 'templates/airplane_spitfire.pdf',
      color: '#ef4e4e',
      fuselage: { flipX: false, flipY: false },
      paleRegions: [],
      // The white band with "W 0 1" reaches the bottom edge of the fuselage.  Its lower 1.5 mm
      // are printed as bright as the lid (254..255), so no rule can find the edge there: this
      // polygon (px) continues the bottom edge of the neighbouring print across the band.
      fillPolygons: [
        [
          [1695, 1170],
          [1892, 1170],
          [1892, 1279],
          [1695, 1273],
        ],
      ],
    },
  ],
};
