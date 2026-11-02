#!/usr/bin/env node
'use strict';
/*
 * build.js – bundles src/ into one standalone HTML file (dist/plane-cutter.html).
 *
 * The source page (src/index.html) stays usable as-is for development; this
 * script simply inlines its stylesheet and every <script src> in document
 * order, so the load order is defined in exactly one place.
 *
 *   node tools/build.js            -> dist/plane-cutter.html
 *   node tools/build.js --out x.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist/plane-cutter.html');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
let html = read('index.html');
const inlined = [];

// stylesheets
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (m, href) => {
  inlined.push(href);
  return `<style>\n${read(href).replace(/<\/style/gi, '<\\/style')}\n</style>`;
});

// scripts (keep a comment with the original file name so errors are easy to locate)
html = html.replace(/<script\s+src="([^"]+)"><\/script>/g, (m, src) => {
  inlined.push(src);
  const code = read(src).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<script>\n/* ---- ${src} ---- */\n${code}\n</script>`;
});

// version + build stamp
const stamp = new Date().toISOString();
html = html.replace('<!-- build:scripts (the builder inlines these in order) -->', `<script>globalThis.PlaneCutter = globalThis.PlaneCutter || {}; globalThis.PlaneCutter.version = 'v${pkg.version}'; globalThis.PlaneCutter.builtAt = '${stamp}';</script>`);
html = `<!-- Plane Cutter v${pkg.version} – standalone build ${stamp}. Source: src/, build: node tools/build.js -->\n${html}`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`built ${path.relative(ROOT, OUT)} (${(html.length / 1024).toFixed(0)} kB) from ${inlined.length} files:\n  ${inlined.join('\n  ')}`);
