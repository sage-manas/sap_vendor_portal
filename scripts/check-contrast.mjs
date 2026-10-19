#!/usr/bin/env node
// WCAG 2.x contrast check for the Ledger tokens in src/app/globals.css.
//
//   node scripts/check-contrast.mjs
//
// Reads the semantic tokens for both themes straight from the stylesheet (so
// what is checked is what ships), checks every text/background pair the
// design system allows, then runs the tenant-accent derivation for a range of
// brand colours — including light ones a tenant might pick — through the same
// oklch clamps the CSS applies. Exits 1 on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8');

// ── Token extraction ───────────────────────────────────────────────────────
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf('\n}', start));
};
const decls = (text) => Object.fromEntries(
  [...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
);
const root = decls(block(':root'));
const dark = { ...root, ...decls(block('.dark')) };

const resolve = (vars, name, seen = new Set()) => {
  const raw = vars[name];
  if (raw == null || seen.has(name)) return null;
  seen.add(name);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref) return resolve(vars, ref[1], seen);
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : null;
};

// ── Colour maths ───────────────────────────────────────────────────────────
const hexToRgb = (h) => h.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const lum = (rgb) => { const [r, g, b] = rgb.map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const rgbToOklch = (rgb) => {
  const [r, g, b] = rgb.map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
};
const oklchToRgb = ([L, C, H]) => {
  const A = C * Math.cos(H); const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, fromLin(Math.max(0, c)))));
};
const withL = (rgb, f) => { const [L, C, H] = rgbToOklch(rgb); return oklchToRgb([f(L), C, H]); };
const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));
const onAccent = (bg) => (rgbToOklch(bg)[0] < 0.6 ? [1, 1, 1] : [0, 0, 0]);
const hex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

// ── Pairs ──────────────────────────────────────────────────────────────────
const TEXT = ['--fg', '--fg-muted', '--fg-subtle'];
const SURFACES = ['--canvas', '--surface', '--subtle', '--hover'];
const SEMANTIC = ['success', 'warning', 'danger', 'info'];

let failures = 0;
const check = (label, fg, bg, min) => {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failures++;
  return { label, r, min, ok };
};
const report = (title, rows) => {
  const worst = [...rows].sort((a, b) => a.r / a.min - b.r / b.min)[0];
  console.log(`${title}: ${rows.length} pairs, tightest ${worst.label} ${worst.r.toFixed(2)}:1 (min ${worst.min})`);
  rows.filter((x) => !x.ok).forEach((x) => console.log(`  FAIL ${x.label} ${x.r.toFixed(2)}:1 < ${x.min}`));
};

for (const [theme, vars] of [['light', root], ['dark', dark]]) {
  const c = (n) => { const h = resolve(vars, n); if (!h) throw new Error(`${theme}: cannot resolve ${n}`); return hexToRgb(h); };
  const rows = [];
  for (const t of TEXT) for (const s of SURFACES) rows.push(check(`${t} on ${s}`, c(t), c(s), 4.5));
  for (const s of SEMANTIC) {
    rows.push(check(`--${s} on --surface`, c(`--${s}`), c('--surface'), 4.5));
    rows.push(check(`--${s} on --${s}-tint`, c(`--${s}`), c(`--${s}-tint`), 4.5));
  }
  for (const s of ['--surface', '--canvas']) rows.push(check(`--input-border on ${s}`, c('--input-border'), c(s), 3));
  report(`tokens/${theme}`, rows);
}

// Tenant accents, through the CSS derivation:
//   light: text = L≤0.5, tint = 9% over surface, button = raw accent
//   dark:  text = L≥0.76, button = L≥0.70, tint = 22% over surface
const TENANTS = {
  default: '#E8457E', ledgerInk: '#1E4FD0', seededGreen: '#2F6F4E', oldCoral: '#CC785C', yellow: '#F5C518',
  sky: '#38BDF8', violet: '#7C3AED', rose: '#E11D48', black: '#111111', lime: '#A3E635',
};
const lightSurface = hexToRgb(resolve(root, '--surface'));
const lightCanvas = hexToRgb(resolve(root, '--canvas'));
const darkSurface = hexToRgb(resolve(dark, '--surface'));
const darkCanvas = hexToRgb(resolve(dark, '--canvas'));

for (const [name, h] of Object.entries(TENANTS)) {
  const a = hexToRgb(h);
  const rows = [];
  const lText = withL(a, (L) => Math.min(L, 0.5));
  const lTint = mix(a, lightSurface, 0.09);
  rows.push(check('light text/surface', lText, lightSurface, 4.5));
  rows.push(check('light text/canvas', lText, lightCanvas, 4.5));
  rows.push(check('light text/tint', lText, lTint, 4.5));
  rows.push(check('light on-accent/button', onAccent(a), a, 4.5));
  const dText = withL(a, (L) => Math.max(L, 0.76));
  const dSolid = withL(a, (L) => Math.max(L, 0.7));
  const dTint = mix(a, darkSurface, 0.22);
  rows.push(check('dark text/surface', dText, darkSurface, 4.5));
  rows.push(check('dark text/canvas', dText, darkCanvas, 4.5));
  rows.push(check('dark text/tint', dText, dTint, 4.5));
  rows.push(check('dark on-accent/button', onAccent(dSolid), dSolid, 4.5));
  report(`accent ${name} ${h} → light text ${hex(lText)}, dark button ${hex(dSolid)}`, rows);
}

console.log(failures ? `\n${failures} failing pair(s)` : '\nAll pairs pass WCAG AA.');
process.exit(failures ? 1 : 0);
