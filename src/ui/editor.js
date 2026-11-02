/*
 * editor.js – the sheet editor: an SVG canvas in millimetres where parts can be
 * selected, dragged, rotated (handle or keyboard) and inspected.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const G = PC.geometry;
  const S = PC.svg;
  const VIEW_MARGIN = 12; // mm of breathing room around the sheet

  function createEditor(svg, app) {
    let drag = null; // { kind: 'move'|'rotate', id, ... }

    const toSheet = (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      return { x: p.x, y: p.y };
    };

    function render() {
      const st = app.state;
      const sheet = st.sheet;
      const checks = PC.sheet.check(sheet, app.geometryFor);
      const outside = new Set(checks.outside);
      const overlapping = new Set(checks.overlapping);
      const tight = new Set(checks.tightSlots);
      svg.setAttribute('viewBox', `${-VIEW_MARGIN} ${-VIEW_MARGIN} ${sheet.width + 2 * VIEW_MARGIN} ${sheet.height + 2 * VIEW_MARGIN}`);

      const parts = [];
      parts.push(
        `<defs><pattern id="grid10" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#9cc9e6" stroke-width="0.25"/></pattern>` +
          `<pattern id="grid50" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#grid10)"/><path d="M50 0H0V50" fill="none" stroke="#6fb3dc" stroke-width="0.45"/></pattern></defs>`,
      );
      parts.push(`<rect class="sheet-shadow" x="1.5" y="2" width="${sheet.width}" height="${sheet.height}" rx="2"/>`);
      parts.push(`<rect class="sheet-bg" x="0" y="0" width="${sheet.width}" height="${sheet.height}" rx="1"/>`);
      if (st.showGrid) parts.push(`<rect class="sheet-grid" x="0" y="0" width="${sheet.width}" height="${sheet.height}" fill="url(#grid50)"/>`);
      if (sheet.margin > 0) {
        parts.push(
          `<rect class="sheet-margin" x="${sheet.margin}" y="${sheet.margin}" width="${Math.max(0, sheet.width - 2 * sheet.margin)}" height="${Math.max(0, sheet.height - 2 * sheet.margin)}"/>`,
        );
      }
      parts.push(`<text class="sheet-size" x="${sheet.width / 2}" y="${sheet.height + 6.5}">${sheet.width} × ${sheet.height} mm</text>`);

      let selectionOverlay = '';
      for (const item of sheet.items) {
        const geo = app.geometryFor(item);
        const cls = ['item', item.id === st.selectedId ? 'selected' : '', outside.has(item.id) ? 'outside' : '', overlapping.has(item.id) ? 'overlapping' : '']
          .filter(Boolean)
          .join(' ');
        const transform = `translate(${S.num(item.x)} ${S.num(item.y)}) rotate(${S.num(item.rotation)})`;
        const cutouts = geo.cutouts.map((c) => `<path class="cutout${tight.has(item.id) ? ' tight' : ''}" d="${S.pathData(c, 2)}"/>`).join('');
        // plane number badge at the part's centroid, kept upright whatever the rotation
        const planeNo = PC.sheet.planeNumber(sheet, item.setId);
        const [bx, by] = G.polygonCentroid(geo.outline);
        const badge = `<g class="badge" transform="translate(${S.num(bx)} ${S.num(by)}) rotate(${S.num(-item.rotation)})"><circle r="3.4"/><text y="1.4">${planeNo}</text></g>`;
        parts.push(
          `<g class="${cls}" data-id="${item.id}" transform="${transform}" style="--part-color:${geo.color}">` +
            `<title>${S.escapeXml(`${PC.parts.describe(geo)} · plane ${planeNo}`)} – drag to move, use the handle to rotate</title>` +
            `<path class="outline" d="${S.pathData(geo.outline, 2)}"/>${cutouts}${badge}</g>`,
        );
        if (item.id === st.selectedId) {
          const box = geo.bbox;
          const handleY = box.minY - 9;
          selectionOverlay =
            `<g class="selection" transform="${transform}">` +
            `<rect class="sel-box" x="${S.num(box.minX - 1.5)}" y="${S.num(box.minY - 1.5)}" width="${S.num(box.width + 3)}" height="${S.num(box.height + 3)}" rx="1.5"/>` +
            `<line class="sel-stem" x1="${S.num(box.cx)}" y1="${S.num(box.minY - 1.5)}" x2="${S.num(box.cx)}" y2="${S.num(handleY + 3)}"/>` +
            `<circle class="rotate-handle" data-id="${item.id}" cx="${S.num(box.cx)}" cy="${S.num(handleY)}" r="3.2"><title>Drag to rotate (hold Shift for 15° steps)</title></circle>` +
            `<text class="rotate-glyph" x="${S.num(box.cx)}" y="${S.num(handleY + 1.1)}">↻</text>` +
            `</g>`;
        }
      }
      parts.push(selectionOverlay);
      svg.innerHTML = parts.join('');
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      const handle = e.target.closest('.rotate-handle');
      const itemEl = e.target.closest('.item');
      const p = toSheet(e);
      if (handle) {
        const id = Number(handle.dataset.id);
        const item = app.state.sheet.items.find((i) => i.id === id);
        if (!item) return;
        const a0 = (Math.atan2(p.y - item.y, p.x - item.x) * 180) / Math.PI;
        drag = { kind: 'rotate', id, startAngle: a0, startRotation: item.rotation };
      } else if (itemEl) {
        const id = Number(itemEl.dataset.id);
        const item = app.state.sheet.items.find((i) => i.id === id);
        if (!item) return;
        if (app.state.selectedId !== id) app.actions.select(id);
        drag = { kind: 'move', id, dx: item.x - p.x, dy: item.y - p.y, moved: false };
      } else {
        if (app.state.selectedId !== null) app.actions.select(null);
        return;
      }
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!drag) return;
      const p = toSheet(e);
      if (drag.kind === 'move') {
        drag.moved = true;
        app.actions.moveItem(drag.id, p.x + drag.dx, p.y + drag.dy, true);
      } else {
        const item = app.state.sheet.items.find((i) => i.id === drag.id);
        if (!item) return;
        const a = (Math.atan2(p.y - item.y, p.x - item.x) * 180) / Math.PI;
        let rot = drag.startRotation + (a - drag.startAngle);
        const step = e.shiftKey ? 15 : 1;
        rot = Math.round(rot / step) * step;
        app.actions.rotateItem(drag.id, rot, true);
      }
    }

    function onPointerUp(e) {
      if (!drag) return;
      const item = app.state.sheet.items.find((i) => i.id === drag.id);
      if (item) {
        if (drag.kind === 'move') app.actions.moveItem(drag.id, item.x, item.y);
        else app.actions.rotateItem(drag.id, item.rotation);
      }
      drag = null;
      svg.classList.remove('dragging');
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    }

    function onKeyDown(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
      const id = app.state.selectedId;
      if (id === null) return;
      const big = e.shiftKey ? 10 : 1;
      const map = {
        ArrowLeft: () => app.actions.nudge(id, -big, 0),
        ArrowRight: () => app.actions.nudge(id, big, 0),
        ArrowUp: () => app.actions.nudge(id, 0, -big),
        ArrowDown: () => app.actions.nudge(id, 0, big),
        r: () => app.actions.rotateBy(id, e.shiftKey ? -15 : 15),
        R: () => app.actions.rotateBy(id, -15),
        Delete: () => app.actions.deleteItem(id),
        Backspace: () => app.actions.deleteItem(id),
        Escape: () => app.actions.select(null),
        d: () => (e.metaKey || e.ctrlKey ? app.actions.duplicateItem(id) : null),
      };
      const fn = map[e.key];
      if (fn) {
        fn();
        e.preventDefault();
      }
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onKeyDown);
    app.on('change', render);
    return { render };
  }

  PC.editor = { createEditor };
})();
