// Per-tenant branding, expressed the only way the design system allows: by
// moving the one accent variable the Kinetic Industrial Console already builds
// every accented surface from. A tenant chooses where the accent sits, not what
// the palette is — no new colours, no second theme.

const ACCENT_VARIABLE = '--color-emerald-default-rgb';

const HEX = /^#?([0-9a-f]{6})$/i;

/**
 * "#2f6f4e" → "47, 111, 78", the `r, g, b` triplet the stylesheet wraps in
 * rgb()/rgba(). Returns null for anything that is not a six-digit hex colour,
 * which is what an unset or malformed setting looks like.
 */
export function hexToRgbTriplet(hex) {
  const match = HEX.exec(String(hex || '').trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

/**
 * The style overrides for a workspace's branding — an empty object when the
 * tenant has not chosen an accent, so the console default stands untouched.
 */
export function accentVariables(primaryColor) {
  const triplet = hexToRgbTriplet(primaryColor);
  return triplet ? { [ACCENT_VARIABLE]: triplet } : {};
}

/**
 * What the header shows for a workspace: the tenant's logo when they have set
 * one, and the wordmark to sit beside it. `null` logo means the built-in mark.
 */
export function brandMark(workspace) {
  return {
    logo: workspace?.branding?.logo || null,
    name: workspace?.companyName || 'VendorConnect',
  };
}

export { ACCENT_VARIABLE };
