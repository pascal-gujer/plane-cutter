/*
 * geometry.js – small 2D helpers shared by the generator, the editor and the exporter.
 * Points are [x, y] arrays in millimetres, y grows downwards (SVG convention).
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const DEG = Math.PI / 180;

  function round(v, decimals = 3) {
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  }

  function bbox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function unionBbox(boxes) {
    const pts = [];
    for (const b of boxes) pts.push([b.minX, b.minY], [b.maxX, b.maxY]);
    return pts.length ? bbox(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 };
  }

  /** scale, then rotate (degrees, clockwise on screen), then translate. */
  function transformPoints(points, { scale = 1, rotation = 0, x = 0, y = 0 } = {}) {
    const c = Math.cos(rotation * DEG);
    const s = Math.sin(rotation * DEG);
    return points.map(([px, py]) => {
      const sx = px * scale;
      const sy = py * scale;
      return [x + sx * c - sy * s, y + sx * s + sy * c];
    });
  }

  function scalePoints(points, scale) {
    return points.map(([x, y]) => [x * scale, y * scale]);
  }

  /** Axis-aligned rectangle polygon rotated by angleDeg around its centre. */
  function rectangle(cx, cy, length, width, angleDeg = 0) {
    const pts = [
      [-length / 2, -width / 2],
      [length / 2, -width / 2],
      [length / 2, width / 2],
      [-length / 2, width / 2],
    ];
    return transformPoints(pts, { rotation: angleDeg, x: cx, y: cy });
  }

  /** Slot with semicircular ends; `length` is the total length including the round ends. */
  function stadium(cx, cy, length, width, angleDeg = 0, segments = 8) {
    const r = width / 2;
    const half = Math.max(0, length / 2 - r);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / segments; // right cap, top to bottom
      pts.push([half + r * Math.cos(a), r * Math.sin(a)]);
    }
    for (let i = 0; i <= segments; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / segments; // left cap, bottom to top
      pts.push([-half + r * Math.cos(a), r * Math.sin(a)]);
    }
    return transformPoints(pts, { rotation: angleDeg, x: cx, y: cy });
  }

  function polygonArea(points) {
    let a = 0;
    for (let i = 0, n = points.length; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  /** Area centroid of a simple polygon (the bounding-box centre for a degenerate one). */
  function polygonCentroid(points) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, n = points.length; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      const cross = p[0] * q[1] - q[0] * p[1];
      a += cross;
      cx += (p[0] + q[0]) * cross;
      cy += (p[1] + q[1]) * cross;
    }
    if (Math.abs(a) < 1e-9) {
      const b = bbox(points);
      return [b.cx, b.cy];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  /** Ray casting point-in-polygon. */
  function pointInPolygon([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  function boxesOverlap(a, b, gap = 0) {
    return a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;
  }

  // --- segments -------------------------------------------------------------

  /** Sign of the turn p -> q -> r (> 0 counter-clockwise in y-up terms, 0 collinear). */
  function orient(p, q, r) {
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  }

  function onSegment(p, a, b) {
    return (
      Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9
    );
  }

  /** True when the closed segments a1-a2 and b1-b2 share at least one point (touching counts). */
  function segmentsIntersect(a1, a2, b1, b2) {
    const o1 = orient(a1, a2, b1);
    const o2 = orient(a1, a2, b2);
    const o3 = orient(b1, b2, a1);
    const o4 = orient(b1, b2, a2);
    if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    if (o1 === 0 && onSegment(b1, a1, a2)) return true;
    if (o2 === 0 && onSegment(b2, a1, a2)) return true;
    if (o3 === 0 && onSegment(a1, b1, b2)) return true;
    if (o4 === 0 && onSegment(a2, b1, b2)) return true;
    return false;
  }

  function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    const ex = a[0] + t * dx - p[0];
    const ey = a[1] + t * dy - p[1];
    return Math.sqrt(ex * ex + ey * ey);
  }

  /** Shortest distance between two segments (0 when they intersect). */
  function segmentDistance(a1, a2, b1, b2) {
    if (segmentsIntersect(a1, a2, b1, b2)) return 0;
    return Math.min(pointSegmentDistance(a1, b1, b2), pointSegmentDistance(a2, b1, b2), pointSegmentDistance(b1, a1, a2), pointSegmentDistance(b2, a1, a2));
  }

  // --- polygons -------------------------------------------------------------

  /**
   * True when two simple polygons overlap: one lies inside the other, their edges cross, or
   * (with gap > 0) their outlines come closer than `gap`.  Edges are pruned by bounding box,
   * so outlines with a few hundred points are cheap to compare.
   */
  function polygonsOverlap(a, b, gap = 0) {
    if (a.length < 3 || b.length < 3) return false;
    const ba = bbox(a);
    const bb = bbox(b);
    if (!boxesOverlap(ba, bb, gap)) return false;
    if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
    const nb = b.length;
    const eb = new Float64Array(nb * 4); // per edge of b: minX, minY, maxX, maxY
    for (let j = 0; j < nb; j++) {
      const q1 = b[j];
      const q2 = b[(j + 1) % nb];
      eb[j * 4] = Math.min(q1[0], q2[0]) - gap;
      eb[j * 4 + 1] = Math.min(q1[1], q2[1]) - gap;
      eb[j * 4 + 2] = Math.max(q1[0], q2[0]) + gap;
      eb[j * 4 + 3] = Math.max(q1[1], q2[1]) + gap;
    }
    const na = a.length;
    for (let i = 0; i < na; i++) {
      const p1 = a[i];
      const p2 = a[(i + 1) % na];
      const minX = Math.min(p1[0], p2[0]);
      const minY = Math.min(p1[1], p2[1]);
      const maxX = Math.max(p1[0], p2[0]);
      const maxY = Math.max(p1[1], p2[1]);
      if (maxX < bb.minX - gap || minX > bb.maxX + gap || maxY < bb.minY - gap || minY > bb.maxY + gap) continue;
      for (let j = 0; j < nb; j++) {
        const k = j * 4;
        if (maxX < eb[k] || minX > eb[k + 2] || maxY < eb[k + 1] || minY > eb[k + 3]) continue;
        const q1 = b[j];
        const q2 = b[(j + 1) % nb];
        if (gap > 0 ? segmentDistance(p1, p2, q1, q2) < gap : segmentsIntersect(p1, p2, q1, q2)) return true;
      }
    }
    return false;
  }

  /**
   * Smallest distance between the edges of `inner` and the edges of `outer` while `inner`
   * lies completely inside `outer`; 0 as soon as a vertex of `inner` is outside or on the
   * edge.  Used to see how thin the wall next to a slot gets.
   */
  function polygonClearance(inner, outer) {
    if (inner.length < 3 || outer.length < 3) return 0;
    for (const p of inner) if (!pointInPolygon(p, outer)) return 0;
    let best = Infinity;
    const ni = inner.length;
    const no = outer.length;
    for (let i = 0; i < ni; i++) {
      const p1 = inner[i];
      const p2 = inner[(i + 1) % ni];
      const ax0 = Math.min(p1[0], p2[0]);
      const ay0 = Math.min(p1[1], p2[1]);
      const ax1 = Math.max(p1[0], p2[0]);
      const ay1 = Math.max(p1[1], p2[1]);
      for (let j = 0; j < no; j++) {
        const q1 = outer[j];
        const q2 = outer[(j + 1) % no];
        // edges whose boxes are farther apart than the best distance so far cannot improve it
        if (Math.min(q1[0], q2[0]) - ax1 >= best || ax0 - Math.max(q1[0], q2[0]) >= best) continue;
        if (Math.min(q1[1], q2[1]) - ay1 >= best || ay0 - Math.max(q1[1], q2[1]) >= best) continue;
        const d = segmentDistance(p1, p2, q1, q2);
        if (d < best) best = d;
      }
    }
    return best;
  }

  function boxInside(inner, outer, margin = 0, eps = 1e-6) {
    return (
      inner.minX >= outer.minX + margin - eps &&
      inner.minY >= outer.minY + margin - eps &&
      inner.maxX <= outer.maxX - margin + eps &&
      inner.maxY <= outer.maxY - margin + eps
    );
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  PC.geometry = {
    DEG,
    round,
    bbox,
    unionBbox,
    transformPoints,
    scalePoints,
    rectangle,
    stadium,
    polygonArea,
    polygonCentroid,
    pointInPolygon,
    boxesOverlap,
    boxInside,
    segmentsIntersect,
    segmentDistance,
    polygonsOverlap,
    polygonClearance,
    clamp,
  };
})();
