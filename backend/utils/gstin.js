// The GSTIN's own arithmetic: shape, check character and embedded PAN. Free
// and offline, so it runs on every write, ahead of any paid verification
// provider (docs/03-verification-layer-design.md).
//
// The fifteenth character is a check character computed from the first
// fourteen (a Luhn mod-36 sum, the scheme the GST system issues them with).
// Every GSTIN the government has issued passes it, so one that fails was
// mistyped or made up — there is nothing to look up. That is why a failure is
// refused outright rather than reported as "unverified": no provider outage
// can make it pass later.
//
// The shape keeps the slack the validators have always allowed (letters or
// digits in characters 3–7); tightening it is gap #8 of the design note and a
// separate change. The check character is enforced either way.

const GSTIN_SHAPE = /^[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// The check character for the first fourteen characters of a GSTIN. Odd
// positions (1st, 3rd, …) weigh 1 and even positions weigh 2; each product is
// folded back into base 36 (quotient + remainder) before summing.
const gstinCheckCharacter = (first14) => {
  const text = String(first14).toUpperCase();
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(text[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
};

const isGstinShape = (gstin) => GSTIN_SHAPE.test(String(gstin ?? ''));

// True only for a GSTIN of the right shape whose last character is its check
// character.
const hasValidCheckCharacter = (gstin) => {
  if (!isGstinShape(gstin)) return false;
  const text = String(gstin).toUpperCase();
  return gstinCheckCharacter(text.slice(0, 14)) === text[14];
};

// Characters 3–12 of a GSTIN are always the holder's PAN.
const panOfGstin = (gstin) => String(gstin ?? '').slice(2, 12).toUpperCase();

const GSTIN_CHECK_MESSAGE = 'This GSTIN is not valid: its last character does not match the rest. Check it for a typo.';

module.exports = {
  GSTIN_SHAPE,
  GSTIN_CHECK_MESSAGE,
  gstinCheckCharacter,
  isGstinShape,
  hasValidCheckCharacter,
  panOfGstin,
};
