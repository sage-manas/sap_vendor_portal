# The Uvira palette

The portal painted in the brand mark. This changes **token values only** — the
"Ledger Night" structure from `04-redesign-v2-plan.md` (radii, type, layout,
primitives) is untouched, and so is every semantic rule.

## The mark

| Swatch | Where it is in the logo | What it became |
|---|---|---|
| Violet `#7A3FD6` | The U's left stroke, the `.ai` pill | **The accent.** Buttons, links, focus rings, the accent card, the solid meter pill, chart series 1 |
| Cyan `#3FC5DC` | The dot, the U's right sweep | **`--accent-2`.** Chart series 2, the ordinal ramp, the info state |
| Navy `#0E1B3F` | The wordmark | **The neutral ramp.** Every surface, border and text tier in both themes |
| Cream `#F3EEDF` | The plate behind the mark | **Deliberately unused.** See below |

## Why these roles

**Violet is the accent, not just a colour on the page.** The accent is the one
token a tenant overrides (`--color-emerald-default-rgb`, ADR-0030). Putting the
brand violet there means the unbranded portal is Uvira's, and a tenant's own
colour still takes over everywhere at once. Nothing else had to learn the brand.

**Cyan is information, never an action.** Two accents compete: if cyan were also
clickable, neither hue would mean anything. So cyan carries what is *being read*
rather than what can be *pressed* — chart series 2, the ageing ramp, the info
state. The result is the mark's own pairing: violet leads, cyan answers.

**Navy is the whole room, not a highlight.** The largest surface in the app is
the canvas, so the cheapest way to look like the brand is to tint the neutrals
rather than add more brand-coloured elements. The ramp keeps its `--slate-*`
names and its fourteen steps; only the hue moved, from neutral graphite to the
wordmark's navy (~225°). The deep end is the wordmark; the light end is a cool
white.

**Cream is left out on purpose.** It is the plate the logo is printed on, not an
interface surface. A warm cream canvas fights the navy that carries the brand,
and the previous redesign retired exactly that look ("Cream & Coral",
`01-audit.md`). Bringing it back as the app canvas would undo a decision and
muddy the one this palette is built on.

**Semantic colours stay semantic.** Success, warning and danger are unchanged.
Green means passed and red means failed, whatever the brand is. Only `--info`
moved, because "informational" is exactly the role cyan now holds.

**The logo's gradient stays in the logo.** Violet→cyan is a mark treatment. On a
surface it would either have to ignore tenant branding or produce
`tenant-colour → cyan`, which is nobody's brand. The pairing shows up as two
flat hues side by side instead — in the charts most of all.

## Contrast

`npm run check:contrast` grew three guards for this palette, over and above the
pairs it already held:

- `--accent-2` ≥ 3:1 on both the surface and the canvas, in each theme. It is a
  plotted line and an icon colour, so it is held to the non-text rule.
- Each `--chart-seq-*` step ≥ 2:1 on its own theme's surface, so the lightest
  bucket is still visible.
- The sample tenant sweep leads with the Uvira violet; v2's pink stays in the
  set so a regression in either direction shows up.

All 28 token pairs pass in each theme, and all 11 tenant colours pass.
