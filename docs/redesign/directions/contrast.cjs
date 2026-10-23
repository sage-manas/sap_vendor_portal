// WCAG 2.x contrast for every text/background pair the specimens render.
const T = require('./tokens.cjs');
const lum = (hex) => {
  const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [fg, bg, min] â€” 4.5 for text, 3 for non-text UI (borders of inputs, focus ring, meter fill)
const PAIRS = [
  ...['fg', 'fgMuted', 'fgSubtle'].flatMap((f) => ['canvas', 'surface', 'subtle', 'hover'].map((b) => [f, b, 4.5])),
  ['accentText', 'surface', 4.5], ['accentText', 'canvas', 4.5], ['accentText', 'accentTint', 4.5],
  ['accentFg', 'accent', 4.5],
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [[s, 'surface', 4.5], [s, `${s}Tint`, 4.5], [s, 'canvas', 4.5]]),
  ['navFg', 'navBg', 4.5], ['navActiveFg', 'navActiveBg', 4.5],
  ['inputBorder', 'surface', 3], ['inputBorder', 'canvas', 3], ['accent', 'surface', 3], ['accent', 'canvas', 3],
];

let fails = 0;
for (const [key, dir] of Object.entries(T)) {
  for (const theme of ['light', 'dark']) {
    const t = dir[theme];
    for (const [f, b, min] of PAIRS) {
      const r = ratio(t[f], t[b]);
      if (r < min) { fails++; console.log(`FAIL ${key}/${theme}: ${f} ${t[f]} on ${b} ${t[b]} = ${r.toFixed(2)} (< ${min})`); }
    }
    const worst = PAIRS.map(([f, b, min]) => ({ f, b, min, r: ratio(t[f], t[b]) })).sort((p, q) => p.r / p.min - q.r / q.min)[0];
    console.log(`${key}/${theme}: ${PAIRS.length} pairs, tightest ${worst.f} on ${worst.b} = ${worst.r.toFixed(2)}:1 (min ${worst.min})`);
  }
}
console.log(fails ? `${fails} failing pairs` : 'ALL PAIRS PASS');
process.exit(fails ? 1 : 0);
