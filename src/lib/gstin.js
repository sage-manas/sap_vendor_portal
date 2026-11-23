// The GSTIN's check character, for the registration form's instant feedback.
//
// A copy of backend/utils/gstin.js, which is what the API enforces. Unlike a
// list (see src/lib/indianStates.js) this is fixed arithmetic the GST system
// issues every GSTIN with, so there is nothing to drift; gstin.test.js pins
// both copies to the same examples.

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Odd positions (1st, 3rd, …) weigh 1 and even positions weigh 2; each product
// is folded back into base 36 (quotient + remainder) before summing.
export const gstinCheckCharacter = (first14) => {
  const text = String(first14).toUpperCase();
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(text[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
};

export const hasValidCheckCharacter = (gstin) => {
  const text = String(gstin ?? '').toUpperCase();
  return text.length === 15 && gstinCheckCharacter(text.slice(0, 14)) === text[14];
};

// Characters 3–12 of a GSTIN are always the holder's PAN.
export const panOfGstin = (gstin) => String(gstin ?? '').slice(2, 12).toUpperCase();
