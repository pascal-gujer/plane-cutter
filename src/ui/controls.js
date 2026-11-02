/*
 * controls.js – the side panel (plane, size, material, sheet, selection, export)
 * and the workspace toolbar / status bar.  Everything is wired through
 * data-action attributes and delegated events; `update()` syncs the inputs.
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const G = PC.geometry;
  const S = PC.svg;

  const THICKNESS_PRESETS = [1.5, 2, 3, 4, 5, 6];
  const SCALE_PRESETS = [
    { label: 'Original', value: 1 },
    { label: '125 %', value: 1.25 },
    { label: '150 %', value: 1.5 },
    { label: '200 %', value: 2 },
  ];

  /** Small picture of the three parts of a template, stacked. */
  function previewSvg(t, width = 170, height = 92) {
    const gap = 6;
    let y = 0;
    const placed = [];
    for (const kind of ['wing', 'fuselage', 'tail']) {
      const pts = t.parts[kind].outline;
      const b = G.bbox(pts);
      placed.push(pts.map(([x, py]) => [x - b.cx, py - b.minY + y]));
      y += b.height + gap;
    }
    const all = G.bbox(placed.flat());
    const s = Math.min((width - 8) / all.width, (height - 8) / all.height);
    const paths = placed
      .map((pts) => `<path d="${S.pathData(pts.map(([x, py]) => [(x - all.minX) * s + 4, (py - all.minY) * s + 4]), 1)}"/>`)
      .join('');
    return `<svg class="preview" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><g fill="${t.color}" stroke="#1d2b3a" stroke-width="1" stroke-linejoin="round">${paths}</g></svg>`;
  }

  function panelHtml(app) {
    const st = app.state;
    const t = app.template();
    const cards = PC.parts
      .templates()
      .map(
        (tpl) =>
          `<button type="button" class="card${tpl.id === st.templateId ? ' selected' : ''}" data-action="template" data-id="${tpl.id}" style="--card-color:${tpl.color}">` +
          `${previewSvg(tpl)}<span class="card-name">${S.escapeXml(tpl.name)}</span>` +
          `<span class="card-meta">wingspan ${Math.round(tpl.parts.wing.span)} mm</span><span class="card-check">✓</span></button>`,
      )
      .join('');
    const sheetPresets = PC.sheet.SHEET_PRESETS.map((p) => `<option value="${p.id}">${S.escapeXml(p.name)}</option>`).join('');
    const templateOptions = PC.parts.templates().map((tpl) => `<option value="${tpl.id}">${S.escapeXml(tpl.name)}</option>`).join('');
    return `
<section class="block">
  <h2><span class="step">1</span> Pick a plane</h2>
  <div class="cards">${cards}</div>
  <label class="switch"><input type="checkbox" data-action="mix"><span>Mix parts from different planes</span></label>
  <div class="mix" id="mix-rows">
    ${PC.parts.KINDS.map((k) => `<label class="field"><span>${PC.parts.KIND_EMOJI[k]} ${PC.parts.KIND_LABEL[k]}</span><select data-action="mix-part" data-kind="${k}">${templateOptions}</select></label>`).join('')}
  </div>
  <p class="hint" id="mix-hint"></p>
</section>
<section class="block">
  <h2><span class="step">2</span> How big?</h2>
  <div class="row">
    <label class="field grow"><span>Wingspan</span><span class="unit-input"><input type="number" data-action="wingspan" min="40" max="800" step="1"><em>mm</em></span></label>
    <label class="field"><span>Scale</span><span class="unit-input"><input type="number" data-action="scale-pct" min="20" max="400" step="1"><em>%</em></span></label>
  </div>
  <input class="slider" type="range" data-action="scale-slider" min="40" max="250" step="1" aria-label="scale">
  <div class="chips">${SCALE_PRESETS.map((p) => `<button type="button" class="chip" data-action="scale-preset" data-value="${p.value}">${p.label}</button>`).join('')}</div>
  <p class="hint" id="size-hint"></p>
</section>
<section class="block">
  <h2><span class="step">3</span> Material</h2>
  <label class="field"><span>Material thickness (makes the slots this wide)</span>
    <span class="unit-input"><input type="number" data-action="param" data-name="thickness" min="0.2" max="30" step="0.1"><em>mm</em></span></label>
  <div class="chips">${THICKNESS_PRESETS.map((v) => `<button type="button" class="chip" data-action="thickness-preset" data-value="${v}">${v} mm</button>`).join('')}</div>
  <details class="advanced">
    <summary>Slot fine-tuning</summary>
    <label class="field"><span>Slot width clearance (+ loose / − tight)</span>
      <span class="unit-input"><input type="number" data-action="param" data-name="slotClearance" min="-2" max="5" step="0.05"><em>mm</em></span></label>
    <label class="field"><span>Extra slot length beyond the wing chord</span>
      <span class="unit-input"><input type="number" data-action="param" data-name="slotLengthExtra" min="-10" max="20" step="0.1"><em>mm</em></span></label>
    <label class="field"><span>Slot ends</span>
      <select data-action="param" data-name="slotEnds"><option value="square">square</option><option value="round">rounded</option></select></label>
  </details>
</section>
<section class="block add-block">
  <button type="button" class="btn btn-big btn-primary" data-action="add-plane">➕ Add plane to the sheet</button>
  <div class="row small-row">
    <span class="muted">or only the</span>
    ${PC.parts.KINDS.map((k) => `<button type="button" class="btn btn-small" data-action="add-part" data-kind="${k}">${PC.parts.KIND_EMOJI[k]} ${PC.parts.KIND_LABEL[k].toLowerCase()}</button>`).join('')}
  </div>
</section>
<section class="block" id="selection-block"></section>
<section class="block">
  <h2>📐 Sheet (your laser bed)</h2>
  <label class="field"><span>Preset</span><select data-action="sheet-preset"><option value="">custom…</option>${sheetPresets}</select></label>
  <div class="row">
    <label class="field grow"><span>Width</span><span class="unit-input"><input type="number" data-action="sheet" data-prop="width" min="20" max="3000" step="1"><em>mm</em></span></label>
    <label class="field grow"><span>Height</span><span class="unit-input"><input type="number" data-action="sheet" data-prop="height" min="20" max="3000" step="1"><em>mm</em></span></label>
  </div>
  <div class="row">
    <label class="field grow"><span>Margin</span><span class="unit-input"><input type="number" data-action="sheet" data-prop="margin" min="0" max="100" step="0.5"><em>mm</em></span></label>
    <label class="field grow"><span>Gap between parts</span><span class="unit-input"><input type="number" data-action="sheet" data-prop="gap" min="0" max="100" step="0.5"><em>mm</em></span></label>
  </div>
</section>
<section class="block">
  <h2>💾 Export for the laser</h2>
  <div class="row">
    <label class="field grow"><span>Outline colour</span><input type="color" data-action="style" data-name="cutColor"></label>
    <label class="field grow"><span>Slot colour</span><input type="color" data-action="style" data-name="innerColor"></label>
    <label class="field"><span>Line width</span><span class="unit-input"><input type="number" data-action="style" data-name="strokeWidth" min="0.01" max="2" step="0.01"><em>mm</em></span></label>
  </div>
  <div class="btn-col">
    <button type="button" class="btn btn-primary" data-action="export-sheet">⬇️ Download the whole sheet (SVG)</button>
    <button type="button" class="btn" data-action="copy-sheet">📋 Copy sheet SVG to clipboard</button>
  </div>
  <p class="hint">Single files of the plane chosen above, at the size set above:</p>
  <div class="row small-row">
    ${PC.parts.KINDS.map((k) => `<button type="button" class="btn btn-small" data-action="export-template-part" data-kind="${k}">⬇️ ${PC.parts.KIND_LABEL[k].toLowerCase()}</button>`).join('')}
    <button type="button" class="btn btn-small" data-action="export-template-all">⬇️ all three</button>
  </div>
</section>
<section class="block footer-block">
  <details><summary>⌨️ Keyboard &amp; tips</summary>
    <ul class="tips">
      <li>Drag a part to move it, drag the <b>↻</b> handle to rotate (hold <kbd>Shift</kbd> for 15° steps).</li>
      <li><kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> nudge 1 mm (<kbd>Shift</kbd>: 10 mm), <kbd>R</kbd> rotates 15°, <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Delete</kbd> removes.</li>
      <li>Slots are cut in blue before the red outlines – assign the colours to layers in your laser software.</li>
      <li>Foam or thin plywood: try a tight fit (clearance 0 mm) first and cut a test slot.</li>
      <li>Parts added together form a <b>plane</b> (the number badge). The fuselage slots always fit the wings of its plane – mix templates with <b>Mix parts</b>, or move a part with <b>Belongs to plane</b>.</li>
    </ul>
  </details>
  <button type="button" class="btn btn-small btn-ghost" data-action="reset">↺ Reset everything</button>
</section>`;
  }

  function selectionHtml(app) {
    const item = app.selectedItem();
    if (!item) {
      return `<h2>👆 Selected part</h2><p class="hint">Click a part on the sheet to move, rotate, resize or download it.</p>`;
    }
    const geo = app.geometryFor(item);
    const sheet = app.state.sheet;
    const span = PC.parts.scaleToWingspan(app.wingTemplateFor(item), item.scale);
    const siblings = sheet.items.filter((i) => i.setId === item.setId).length;
    const planeNo = PC.sheet.planeNumber(sheet, item.setId);
    return `
<h2>👆 ${S.escapeXml(geo.name)} <span class="plane-tag" title="plane ${planeNo}">${planeNo}</span></h2>
<p class="hint">${geo.bbox.width.toFixed(1)} × ${geo.bbox.height.toFixed(1)} mm · ${Math.round(item.scale * 100)} % · rotated ${item.rotation}°</p>
<div class="row small-row">
  <button type="button" class="btn btn-small" data-action="rotate" data-delta="-15" title="rotate left 15°">↺ 15°</button>
  <button type="button" class="btn btn-small" data-action="rotate" data-delta="15" title="rotate right 15°">↻ 15°</button>
  <button type="button" class="btn btn-small" data-action="rotate" data-delta="90" title="rotate 90°">↻ 90°</button>
  <button type="button" class="btn btn-small" data-action="rotate-to" data-value="0" title="reset rotation">0°</button>
</div>
<div class="row small-row">
  <button type="button" class="btn btn-small" data-action="duplicate">⧉ Duplicate</button>
  <button type="button" class="btn btn-small" data-action="export-item">⬇️ Download this part</button>
  <button type="button" class="btn btn-small btn-danger" data-action="delete">🗑 Remove</button>
</div>
${planeHtml(app, item)}${item.kind === 'fuselage' ? fitsHtml(app, item, geo) : ''}
<label class="field"><span>Wingspan of this plane${siblings > 1 ? ` (changes all ${siblings} parts of it)` : ''}</span>
  <span class="unit-input"><input type="number" data-action="item-wingspan" min="40" max="800" step="1" value="${Math.round(span)}"><em>mm</em></span></label>`;
  }

  /** "Belongs to plane" picker: the other planes that still lack a part of this kind, or a new plane. */
  function planeHtml(app, item) {
    const sheet = app.state.sheet;
    const options = PC.sheet.planeIds(sheet).map((setId) => {
      const parts = PC.sheet.planeParts(sheet, setId);
      const members = PC.parts.KINDS.filter((k) => parts[k]).map((k) => `${PC.parts.getTemplate(parts[k].templateId).name} ${PC.parts.KIND_LABEL[k].toLowerCase()}`);
      const taken = setId !== item.setId && parts[item.kind];
      const label = `Plane ${PC.sheet.planeNumber(sheet, setId)}: ${members.join(', ')}${taken ? ' – has one already' : ''}`;
      return `<option value="${setId}"${setId === item.setId ? ' selected' : ''}${taken ? ' disabled' : ''}>${S.escapeXml(label)}</option>`;
    });
    const alone = !sheet.items.some((i) => i.setId === item.setId && i !== item);
    options.push(`<option value="new"${alone ? ' disabled' : ''}>a new plane of its own</option>`);
    return `<label class="field"><span>Belongs to plane (fuselage slots fit the wings of their plane)</span><select data-action="plane">${options.join('')}</select></label>`;
  }

  /** For a fuselage: what each slot is made for – the part of its plane, or a choice while the plane has none. */
  function fitsHtml(app, item, geo) {
    const fits = PC.sheet.fitsFor(app.state.sheet, item);
    const rows = ['wing', 'tail'].map((kind) => {
      const f = fits[kind];
      const t = PC.parts.getTemplate(f.templateId);
      const label = `${PC.parts.KIND_EMOJI[kind]} ${kind === 'wing' ? 'Wing' : 'Tail'} slot`;
      const len = PC.parts.slotLength(t, kind, f.scale, app.state.params).toFixed(1);
      const part = PC.parts.KIND_LABEL[kind].toLowerCase();
      if (f.source === 'plane') return `<p class="fit">${label} fits the <b>${S.escapeXml(t.name)} ${part}</b> of this plane · ${len} mm long</p>`;
      const options = PC.parts
        .templates()
        .map((tpl) => `<option value="${tpl.id}"${tpl.id === f.templateId ? ' selected' : ''}>${S.escapeXml(tpl.name)} ${part}</option>`)
        .join('');
      return `<label class="field"><span>${label} fits (no ${part} of this plane on the sheet) · ${len} mm long</span><select data-action="item-fit" data-kind="${kind}">${options}</select></label>`;
    });
    if (geo.slotClearance != null && geo.slotClearance < PC.sheet.MIN_SLOT_CLEARANCE_MM) {
      rows.push(`<p class="fit warn">⚠️ A slot comes within ${geo.slotClearance.toFixed(1)} mm of the outline – that wall will be very thin.</p>`);
    }
    return rows.join('');
  }

  function toolbarHtml() {
    return `
<button type="button" class="btn btn-small" data-action="arrange" title="pack all parts neatly">✨ Arrange</button>
<button type="button" class="btn btn-small" data-action="grid" title="show / hide the grid">▦ Grid</button>
<span class="spacer"></span>
<span class="tool-group" id="tool-selection">
  <button type="button" class="btn btn-small" data-action="rotate" data-delta="-15" title="rotate left">↺</button>
  <button type="button" class="btn btn-small" data-action="rotate" data-delta="15" title="rotate right">↻</button>
  <button type="button" class="btn btn-small" data-action="duplicate" title="duplicate">⧉</button>
  <button type="button" class="btn btn-small btn-danger" data-action="delete" title="remove">🗑</button>
</span>
<button type="button" class="btn btn-small btn-ghost" data-action="clear" title="remove all parts">Clear sheet</button>`;
  }

  function statusHtml(app) {
    const sh = app.state.sheet;
    if (!sh.items.length) return `<span>The sheet is empty – pick a plane and press <b>Add plane to the sheet</b>.</span>`;
    const checks = PC.sheet.check(sh, app.geometryFor);
    const usage = Math.round(PC.sheet.usage(sh, app.geometryFor) * 100);
    const planes = new Set(sh.items.map((i) => i.setId)).size;
    const bits = [`<span>${sh.items.length} part${sh.items.length === 1 ? '' : 's'} · ${planes} plane${planes === 1 ? '' : 's'} · ${usage} % of the sheet used</span>`];
    if (checks.outside.length) bits.push(`<span class="warn">⚠️ ${checks.outside.length} part${checks.outside.length === 1 ? ' sticks' : 's stick'} out of the sheet margin</span>`);
    if (checks.overlapping.length) bits.push(`<span class="warn">⚠️ ${checks.overlapping.length} parts overlap</span>`);
    if (checks.tightSlots.length) {
      const n = checks.tightSlots.length;
      bits.push(`<span class="warn">⚠️ ${n === 1 ? 'a slot comes' : `${n} slots come`} within ${PC.sheet.MIN_SLOT_CLEARANCE_MM} mm of the fuselage outline</span>`);
    }
    if (checks.unmated.length) bits.push(`<span class="info">${unmatedText(sh, checks.unmated)}</span>`);
    if (!checks.outside.length && !checks.overlapping.length && !checks.tightSlots.length) bits.push(`<span class="ok">✅ ready to cut</span>`);
    return bits.join('');
  }

  /** "plane 2: no main wing on the sheet – its slot fits a Racer main wing", or a count when there are several. */
  function unmatedText(sheet, unmated) {
    if (unmated.length > 1) return `ℹ️ ${unmated.length} fuselages are without their wings on the sheet – their slots follow the fit settings`;
    const u = unmated[0];
    const fits = PC.sheet.fitsFor(sheet, sheet.items.find((i) => i.id === u.id));
    const wingName = (kind) => (kind === 'wing' ? 'main wing' : 'tail wing');
    const what = u.missing.map(wingName).join(' or ');
    const made = u.missing.map((kind) => `a ${S.escapeXml(PC.parts.getTemplate(fits[kind].templateId).name)} ${wingName(kind)}`).join(' and ');
    return `ℹ️ plane ${PC.sheet.planeNumber(sheet, u.setId)}: no ${what} on the sheet – its slot${u.missing.length > 1 ? 's fit' : ' fits'} ${made}`;
  }

  function create({ panel, toolbar, statusbar }, app) {
    panel.innerHTML = panelHtml(app);
    toolbar.innerHTML = toolbarHtml();
    const q = (sel) => panel.querySelector(sel);
    const setIfIdle = (input, value) => {
      if (!input || document.activeElement === input) return;
      input.value = value;
    };

    function update() {
      const st = app.state;
      for (const card of panel.querySelectorAll('.card')) card.classList.toggle('selected', card.dataset.id === st.templateId);
      q('[data-action="mix"]').checked = st.mix.on;
      q('#mix-rows').classList.toggle('hidden', !st.mix.on);
      for (const sel of panel.querySelectorAll('[data-action="mix-part"]')) setIfIdle(sel, st.mix[sel.dataset.kind]);
      const ids = app.planeTemplateIds();
      const tf = PC.parts.getTemplate(ids.fuselage);
      const tw = PC.parts.getTemplate(ids.wing);
      const tt = PC.parts.getTemplate(ids.tail);
      const mixed = st.mix.on && app.isMixed() && tf && tw && tt;
      q('#mix-hint').textContent = mixed ? `${tf.name} fuselage with the ${tw.name} main wing and the ${tt.name} tail wing – its slots are made to fit them.` : '';
      q('#mix-hint').classList.toggle('hidden', !mixed);
      if (tf && tw && tt) {
        const span = PC.parts.scaleToWingspan(tw, st.scale);
        setIfIdle(q('[data-action="wingspan"]'), Math.round(span));
        setIfIdle(q('[data-action="scale-pct"]'), Math.round(st.scale * 100));
        setIfIdle(q('[data-action="scale-slider"]'), Math.round(st.scale * 100));
        const fus = tf.parts.fuselage.length * st.scale;
        const wingSlot = PC.parts.slotLength(tw, 'wing', st.scale, st.params).toFixed(1);
        const tailSlot = PC.parts.slotLength(tt, 'tail', st.scale, st.params).toFixed(1);
        q('#size-hint').textContent = `${mixed ? 'Mixed plane' : tf.name}: wingspan ${Math.round(span)} mm, fuselage ${Math.round(fus)} mm long, wing slot ${wingSlot} mm, tail slot ${tailSlot} mm.`;
      }
      for (const name of ['thickness', 'slotClearance', 'slotLengthExtra', 'slotEnds']) setIfIdle(q(`[data-action="param"][data-name="${name}"]`), st.params[name]);
      for (const chip of panel.querySelectorAll('[data-action="thickness-preset"]')) chip.classList.toggle('active', Number(chip.dataset.value) === st.params.thickness);
      for (const chip of panel.querySelectorAll('[data-action="scale-preset"]')) chip.classList.toggle('active', Math.abs(Number(chip.dataset.value) - st.scale) < 1e-9);
      for (const prop of ['width', 'height', 'margin', 'gap']) setIfIdle(q(`[data-action="sheet"][data-prop="${prop}"]`), st.sheet[prop]);
      const preset = PC.sheet.SHEET_PRESETS.find((p) => p.width === st.sheet.width && p.height === st.sheet.height);
      setIfIdle(q('[data-action="sheet-preset"]'), preset ? preset.id : '');
      for (const name of ['cutColor', 'innerColor', 'strokeWidth']) setIfIdle(q(`[data-action="style"][data-name="${name}"]`), st.style[name]);
      q('#selection-block').innerHTML = selectionHtml(app);
      toolbar.querySelector('#tool-selection').classList.toggle('hidden', !app.selectedItem());
      toolbar.querySelector('[data-action="grid"]').classList.toggle('active', st.showGrid);
      statusbar.innerHTML = statusHtml(app);
    }

    function onClick(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = app.actions;
      const id = app.state.selectedId;
      const act = el.dataset.action;
      const handlers = {
        template: () => a.selectTemplate(el.dataset.id),
        'scale-preset': () => a.setScale(Number(el.dataset.value)),
        'thickness-preset': () => a.setParam('thickness', Number(el.dataset.value)),
        'add-plane': () => a.addPlane(),
        'add-part': () => a.addPlane([el.dataset.kind]),
        arrange: () => a.arrange(),
        grid: () => a.toggleGrid(),
        clear: () => {
          if (!app.state.sheet.items.length || confirm('Remove all parts from the sheet?')) a.clearSheet();
        },
        rotate: () => id !== null && a.rotateBy(id, Number(el.dataset.delta)),
        'rotate-to': () => id !== null && a.rotateItem(id, Number(el.dataset.value)),
        duplicate: () => id !== null && a.duplicateItem(id),
        delete: () => id !== null && a.deleteItem(id),
        'export-item': () => id !== null && a.exportItem(id),
        'export-sheet': () => a.exportSheet(),
        'copy-sheet': () => a.copySheet(),
        'export-template-part': () => a.exportTemplateParts([el.dataset.kind]),
        'export-template-all': () => a.exportTemplateParts(),
        reset: () => {
          if (confirm('Reset all settings and empty the sheet?')) a.resetAll();
        },
      };
      if (handlers[act]) {
        handlers[act]();
        e.preventDefault();
      }
    }

    function onInput(e, committed) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = app.actions;
      const act = el.dataset.action;
      const v = el.value;
      if (act === 'scale-slider' || (committed && act === 'scale-pct')) a.setScale(Number(v) / 100);
      else if (committed && act === 'wingspan') a.setWingspan(Number(v));
      else if (act === 'param' && (committed || el.tagName === 'SELECT')) a.setParam(el.dataset.name, v);
      else if (act === 'sheet' && committed) a.setSheet(el.dataset.prop, v);
      else if (act === 'sheet-preset') {
        if (v) a.setSheetPreset(v);
      } else if (act === 'style' && (committed || el.type === 'color')) a.setStyle(el.dataset.name, v);
      else if (act === 'item-wingspan' && committed && app.state.selectedId !== null) a.setItemWingspan(app.state.selectedId, Number(v));
      else if (act === 'mix' && committed) a.setMix(el.checked);
      else if (act === 'mix-part' && committed) a.setMixPart(el.dataset.kind, v);
      else if (act === 'plane' && committed && app.state.selectedId !== null) a.moveToPlane(app.state.selectedId, v);
      else if (act === 'item-fit' && committed && app.state.selectedId !== null) a.setItemFit(app.state.selectedId, el.dataset.kind, v);
    }

    for (const root of [panel, toolbar]) {
      root.addEventListener('click', onClick);
      root.addEventListener('input', (e) => onInput(e, false));
      root.addEventListener('change', (e) => onInput(e, true));
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
      });
    }
    app.on('change', update);
    return { update };
  }

  PC.controls = { create, previewSvg };
})();
