/*
 * app.js – application state, actions and persistence.
 *
 * The UI modules (controls.js, editor.js) only talk to `PC.app`:
 *   app.state            – plain data (see defaultState)
 *   app.geometryFor(item) – cached part geometry for a placed item
 *   app.actions.*        – every mutation goes through here; each one saves and emits 'change'
 *   app.on('change', fn) – re-render hook
 */
(function () {
  'use strict';
  const PC = (globalThis.PlaneCutter = globalThis.PlaneCutter || {});
  const STORAGE_KEY = 'plane-cutter-state-v1';

  function defaultState() {
    return {
      templateId: (PC.templates[0] || {}).id,
      // mixing parts of different planes: when `on`, "Add plane" takes each part from these templates
      mix: { on: false, fuselage: (PC.templates[0] || {}).id, wing: (PC.templates[0] || {}).id, tail: (PC.templates[0] || {}).id },
      scale: 1,
      params: { ...PC.parts.DEFAULT_PARAMS },
      style: { ...PC.exporter.DEFAULT_STYLE },
      sheet: PC.sheet.createSheet({ width: 300, height: 200, margin: 5, gap: 4 }),
      selectedId: null,
      showGrid: true,
    };
  }

  const listeners = { change: [] };
  const app = {
    state: defaultState(),
    cache: new Map(),
    on(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    emit(event, detail) {
      for (const fn of listeners[event] || []) fn(detail);
    },
  };

  /** { wing: { template, scale }, tail: … } that go into the slots of a fuselage item, from its plane. */
  function matesFor(item) {
    const fits = PC.sheet.fitsFor(app.state.sheet, item);
    const mate = (f) => ({ template: PC.parts.getTemplate(f.templateId), scale: f.scale });
    return { wing: mate(fits.wing), tail: mate(fits.tail), fits };
  }

  function geometryFor(item) {
    const p = app.state.params;
    let key = `${item.templateId}|${item.kind}|${item.scale}|${p.thickness}|${p.slotClearance}|${p.slotLengthExtra}|${p.slotEnds}`;
    let mates = null;
    if (item.kind === 'fuselage') {
      mates = matesFor(item);
      key += `|w:${mates.fits.wing.templateId}@${mates.fits.wing.scale}|t:${mates.fits.tail.templateId}@${mates.fits.tail.scale}`;
    }
    let geo = app.cache.get(key);
    if (!geo) {
      geo = PC.parts.buildPart(PC.parts.getTemplate(item.templateId), item.kind, item.scale, p, mates);
      app.cache.set(key, geo);
    }
    return geo;
  }
  app.geometryFor = geometryFor;

  /** The wing a plane's wingspan refers to: the wing of the item's plane, else what its fuselage fits, else its own template. */
  function wingTemplateFor(item) {
    const parts = PC.sheet.planeParts(app.state.sheet, item.setId);
    if (parts.wing) return PC.parts.getTemplate(parts.wing.templateId);
    if (item.kind === 'fuselage') return PC.parts.getTemplate(PC.sheet.fitsFor(app.state.sheet, item).wing.templateId);
    return PC.parts.getTemplate(item.templateId);
  }
  app.wingTemplateFor = wingTemplateFor;

  function save() {
    try {
      const { sheet, templateId, mix, scale, params, style, showGrid } = app.state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sheet, templateId, mix, scale, params, style, showGrid }));
    } catch (e) {
      /* private mode etc. – ignore */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const base = defaultState();
      app.state = {
        ...base,
        ...saved,
        params: { ...base.params, ...(saved.params || {}) },
        style: { ...base.style, ...(saved.style || {}) },
        sheet: { ...base.sheet, ...(saved.sheet || {}) },
        mix: { ...base.mix, ...(saved.mix || {}) },
        selectedId: null,
      };
      // drop items whose template no longer exists, and fit choices that point at a missing template
      app.state.sheet.items = (app.state.sheet.items || []).filter((it) => PC.parts.getTemplate(it.templateId));
      for (const it of app.state.sheet.items) {
        if (!it.fits) continue;
        for (const kind of ['wing', 'tail']) if (!PC.parts.getTemplate(it.fits[kind])) delete it.fits[kind];
      }
      PC.sheet.normalizePlanes(app.state.sheet);
      if (!PC.parts.getTemplate(app.state.templateId)) app.state.templateId = base.templateId;
      for (const kind of PC.parts.KINDS) if (!PC.parts.getTemplate(app.state.mix[kind])) app.state.mix[kind] = app.state.templateId;
    } catch (e) {
      app.state = defaultState();
    }
  }

  function changed(what) {
    save();
    app.emit('change', what);
  }

  const selectedItem = () => app.state.sheet.items.find((it) => it.id === app.state.selectedId) || null;
  app.selectedItem = selectedItem;
  app.template = () => PC.parts.getTemplate(app.state.templateId);
  /** What "Add plane" adds: a template id, or { fuselage, wing, tail } template ids when mixing. */
  app.planeSpec = () => {
    const m = app.state.mix;
    return m.on ? { fuselage: m.fuselage, wing: m.wing, tail: m.tail } : app.state.templateId;
  };
  /** Template ids of the parts "Add plane" would add, by kind. */
  app.planeTemplateIds = () => {
    const spec = app.planeSpec();
    return typeof spec === 'string' ? { fuselage: spec, wing: spec, tail: spec } : spec;
  };
  /** The wing the size step refers to. */
  app.wingTemplate = () => PC.parts.getTemplate(app.planeTemplateIds().wing) || app.template();
  app.isMixed = () => {
    const ids = app.planeTemplateIds();
    return ids.wing !== ids.fuselage || ids.tail !== ids.fuselage;
  };

  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  app.actions = {
    /** Picks the base plane; the mix pickers start from it again. */
    selectTemplate(id) {
      if (!PC.parts.getTemplate(id)) return;
      app.state.templateId = id;
      for (const kind of PC.parts.KINDS) app.state.mix[kind] = id;
      changed('template');
    },
    setMix(on) {
      app.state.mix.on = !!on;
      changed('template');
    },
    setMixPart(kind, id) {
      if (!PC.parts.KINDS.includes(kind) || !PC.parts.getTemplate(id)) return;
      app.state.mix[kind] = id;
      changed('template');
    },
    setScale(scale) {
      app.state.scale = PC.geometry.clamp(num(scale, 1), 0.2, 4);
      changed('scale');
    },
    setWingspan(mm) {
      const t = app.wingTemplate();
      if (!t) return;
      app.actions.setScale(PC.parts.wingspanToScale(t, num(mm, t.parts.wing.span)));
    },
    setParam(name, value) {
      const p = app.state.params;
      if (name === 'slotEnds') p.slotEnds = value === 'round' ? 'round' : 'square';
      else if (name === 'thickness') p.thickness = PC.geometry.clamp(num(value, p.thickness), 0.2, 30);
      else if (name === 'slotClearance') p.slotClearance = PC.geometry.clamp(num(value, p.slotClearance), -2, 5);
      else if (name === 'slotLengthExtra') p.slotLengthExtra = PC.geometry.clamp(num(value, p.slotLengthExtra), -10, 20);
      app.cache.clear();
      changed('params');
    },
    setStyle(name, value) {
      const s = app.state.style;
      if (name === 'strokeWidth') s.strokeWidth = PC.geometry.clamp(num(value, s.strokeWidth), 0.01, 2);
      else if (name === 'cutColor' || name === 'innerColor') s[name] = String(value);
      changed('style');
    },
    setSheet(prop, value) {
      const sh = app.state.sheet;
      if (prop === 'width') sh.width = PC.geometry.clamp(num(value, sh.width), 20, 3000);
      else if (prop === 'height') sh.height = PC.geometry.clamp(num(value, sh.height), 20, 3000);
      else if (prop === 'margin') sh.margin = PC.geometry.clamp(num(value, sh.margin), 0, 100);
      else if (prop === 'gap') sh.gap = PC.geometry.clamp(num(value, sh.gap), 0, 100);
      changed('sheet');
    },
    setSheetPreset(id) {
      const p = PC.sheet.SHEET_PRESETS.find((x) => x.id === id);
      if (!p) return;
      app.state.sheet.width = p.width;
      app.state.sheet.height = p.height;
      changed('sheet');
    },
    toggleGrid() {
      app.state.showGrid = !app.state.showGrid;
      changed('view');
    },
    addPlane(kinds) {
      if (!app.template()) return [];
      const items = PC.sheet.addPlane(app.state.sheet, app.planeSpec(), app.state.scale, geometryFor, kinds);
      app.state.selectedId = items.length ? items[0].id : null;
      changed('items');
      return items;
    },
    /** Moves a part into another plane (setId or 'new'); refused when that plane has such a part already. */
    moveToPlane(id, target) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      const moved = PC.sheet.moveToPlane(app.state.sheet, id, target);
      if (!moved) {
        PC.files.toast(`Plane ${PC.sheet.planeNumber(app.state.sheet, Number(target))} already has a ${PC.parts.KIND_LABEL[it.kind].toLowerCase()}`, 'warn');
        return;
      }
      changed('items');
    },
    /** Which wing or tail a fuselage's slot is made for while its plane has none on the sheet. */
    setItemFit(id, kind, templateId) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it || it.kind !== 'fuselage' || !['wing', 'tail'].includes(kind) || !PC.parts.getTemplate(templateId)) return;
      it.fits = { ...(it.fits || {}), [kind]: templateId };
      changed('items');
    },
    select(id) {
      app.state.selectedId = id;
      app.emit('change', 'selection');
    },
    moveItem(id, x, y, silent = false) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      it.x = Math.round(x * 2) / 2;
      it.y = Math.round(y * 2) / 2;
      delete it.placedOutside;
      if (silent) app.emit('change', 'drag');
      else changed('items');
    },
    rotateItem(id, rotation, silent = false) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      let r = num(rotation, it.rotation) % 360;
      if (r < 0) r += 360;
      it.rotation = Math.round(r * 10) / 10;
      if (silent) app.emit('change', 'drag');
      else changed('items');
    },
    rotateBy(id, delta) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (it) app.actions.rotateItem(id, it.rotation + delta);
    },
    nudge(id, dx, dy) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (it) app.actions.moveItem(id, it.x + dx, it.y + dy);
    },
    deleteItem(id) {
      PC.sheet.removeItem(app.state.sheet, id);
      if (app.state.selectedId === id) app.state.selectedId = null;
      changed('items');
    },
    duplicateItem(id) {
      const it = PC.sheet.duplicateItem(app.state.sheet, id, geometryFor);
      if (it) app.state.selectedId = it.id;
      changed('items');
    },
    setItemScale(id, scale) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      PC.sheet.setScale(app.state.sheet, it.setId, PC.geometry.clamp(num(scale, it.scale), 0.2, 4));
      changed('items');
    },
    setItemWingspan(id, mm) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      app.actions.setItemScale(id, PC.parts.wingspanToScale(wingTemplateFor(it), num(mm, 0)));
    },
    arrange() {
      PC.sheet.arrange(app.state.sheet, geometryFor);
      changed('items');
    },
    clearSheet() {
      app.state.sheet.items = [];
      app.state.selectedId = null;
      changed('items');
    },
    resetAll() {
      app.state = defaultState();
      app.cache.clear();
      changed('reset');
    },
    exportSheet() {
      const sh = app.state.sheet;
      if (!sh.items.length) {
        PC.files.toast('The sheet is empty – add a plane first', 'warn');
        return;
      }
      const svg = PC.exporter.sheetSvg(sh, geometryFor, app.state.style);
      const name = PC.exporter.sheetFilename(sh);
      PC.files.download(name, svg);
      PC.files.toast(`Downloaded ${name}`, 'ok');
    },
    async copySheet() {
      const sh = app.state.sheet;
      const svg = PC.exporter.sheetSvg(sh, geometryFor, app.state.style);
      try {
        await PC.files.copyText(svg);
        PC.files.toast('Sheet SVG copied to the clipboard', 'ok');
      } catch (e) {
        PC.files.toast('Could not copy – your browser blocked clipboard access', 'warn');
      }
    },
    exportItem(id) {
      const it = app.state.sheet.items.find((i) => i.id === id);
      if (!it) return;
      const geo = geometryFor(it);
      const name = PC.exporter.partFilename(geo);
      PC.files.download(name, PC.exporter.partSvg(geo, app.state.style));
      PC.files.toast(`Downloaded ${name}`, 'ok');
    },
    /** Downloads the parts the plane picker would add (mixed or not), at the current scale, one file each. */
    exportTemplateParts(kinds = PC.parts.KINDS) {
      const ids = app.planeTemplateIds();
      const scale = app.state.scale;
      const mates = { wing: { template: PC.parts.getTemplate(ids.wing), scale }, tail: { template: PC.parts.getTemplate(ids.tail), scale } };
      if (!mates.wing.template || !mates.tail.template || !PC.parts.getTemplate(ids.fuselage)) return;
      kinds.forEach((kind, i) => {
        const geo = PC.parts.buildPart(PC.parts.getTemplate(ids[kind]), kind, scale, app.state.params, mates);
        setTimeout(() => PC.files.download(PC.exporter.partFilename(geo), PC.exporter.partSvg(geo, app.state.style)), i * 350);
      });
      const name = app.isMixed() ? 'the mixed plane' : PC.parts.getTemplate(ids.fuselage).name;
      PC.files.toast(kinds.length === 1 ? `Downloaded the ${PC.parts.KIND_LABEL[kinds[0]].toLowerCase()} of ${name}` : `Downloading ${kinds.length} files for ${name}…`, 'ok');
    },
  };

  app.init = function init() {
    load();
    app.emit('change', 'init');
  };

  PC.app = app;
})();
