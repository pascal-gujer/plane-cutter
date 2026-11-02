/*
 * svg.js – tiny string builders for SVG output (export) – no DOM needed.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
  }

  function num(v, decimals = 3) {
    const r = Number(v.toFixed(decimals));
    return Object.is(r, -0) ? '0' : String(r);
  }

  /** Closed polygon -> path data. */
  function pathData(points, decimals = 3) {
    if (!points.length) return '';
    let d = `M${num(points[0][0], decimals)} ${num(points[0][1], decimals)}`;
    for (let i = 1; i < points.length; i++) d += `L${num(points[i][0], decimals)} ${num(points[i][1], decimals)}`;
    return `${d}Z`;
  }

  function attrs(obj) {
    return Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
      .join('');
  }

  function el(tag, attributes = {}, children = '') {
    const inner = Array.isArray(children) ? children.join('') : children;
    return inner ? `<${tag}${attrs(attributes)}>${inner}</${tag}>` : `<${tag}${attrs(attributes)}/>`;
  }

  /** Complete SVG document in millimetres (1 user unit = 1 mm). */
  function document({ width, height, title, desc, body, minX = 0, minY = 0 }) {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(width)}mm" height="${num(height)}mm" ` +
      `viewBox="${num(minX)} ${num(minY)} ${num(width)} ${num(height)}">\n` +
      (title ? `  <title>${escapeXml(title)}</title>\n` : '') +
      (desc ? `  <desc>${escapeXml(desc)}</desc>\n` : '') +
      body +
      `</svg>\n`
    );
  }

  PC.svg = { escapeXml, num, pathData, el, attrs, document };
})();
