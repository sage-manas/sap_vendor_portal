// GST computation (issue #66) — the part of an Indian tax invoice this
// portal used to fake: one header taxCode and one taxAmount, with an 18%
// rate assumed wherever the real figure was missing (the invoice PDF, the
// old submitInvoice fallback). Real GST is filed per line, by HSN/SAC, split
// between CGST+SGST (intra-state — supplier and place of supply in the same
// state) or IGST (inter-state — they differ), never invented from an
// assumed rate.
//
// Pure and side-effect-free throughout, like services/invoicePlan.service.js
// and services/poStatus.service.js — every caller (seed data today; a real
// submission or discovery path tomorrow) supplies the facts and gets back
// numbers, never a database handle.

const { toNumber } = require('../utils/money');

// Money math done in cents-equivalent-safe rounding, same convention as
// utils/money.js's callers use elsewhere (toFixed(2) then back to Number) —
// avoids `0.1 + 0.2`-style binary-float residue landing in a stored
// Decimal(14,2) column with three or more decimal digits of noise.
const round2 = (value) => Number(Number(value || 0).toFixed(2));

// Place of supply is the recipient's registered state for a goods invoice —
// here, the buyer tenant's own registration (Client.state), not the
// delivery address on any one PO. Comparing that against the supplier
// Vendor's own registered state is what determines intra- vs inter-state
// treatment. Case/whitespace-insensitive: "Maharashtra" and "maharashtra "
// naming the same state must not be read as different ones.
const isIntraState = (supplierState, placeOfSupply) => {
  if (!supplierState || !placeOfSupply) return false;
  return String(supplierState).trim().toLowerCase() === String(placeOfSupply).trim().toLowerCase();
};

/**
 * Splits one line's tax between CGST/SGST (intra-state) or IGST
 * (inter-state). Returns zeros, honestly, when the rate or either state is
 * unknown — never a guessed rate standing in for a real one.
 *
 * @param {object} params
 * @param {number} params.taxableValue - the line's own pre-tax amount (InvoiceItem.amount)
 * @param {number|null} params.gstRate - percentage, e.g. 18 for 18%
 * @param {string|null} params.supplierState - the vendor's registered state
 * @param {string|null} params.placeOfSupply - the buyer's registered state
 */
const splitLineTax = ({ taxableValue, gstRate, supplierState, placeOfSupply }) => {
  const rate = gstRate == null ? null : toNumber(gstRate);
  const value = toNumber(taxableValue) || 0;

  if (rate == null || Number.isNaN(rate)) {
    return { cgstAmount: 0, sgstAmount: 0, igstAmount: 0, totalTax: 0 };
  }

  const totalTax = round2((value * rate) / 100);

  if (isIntraState(supplierState, placeOfSupply)) {
    // Split as evenly as a rupee allows — a rate with an odd paisa (an 18%
    // charge on 100.01, say) puts the leftover paisa on SGST rather than
    // dropping or duplicating it, so cgst+sgst always reconciles to the
    // same totalTax IGST would have charged on the identical line.
    const cgstAmount = round2(totalTax / 2);
    const sgstAmount = round2(totalTax - cgstAmount);
    return { cgstAmount, sgstAmount, igstAmount: 0, totalTax };
  }

  return { cgstAmount: 0, sgstAmount: 0, igstAmount: totalTax, totalTax };
};

/**
 * Derives every InvoiceItem's tax split and the header totals that follow
 * from them — the header taxAmount/totalAmount are never an input under
 * this function; they are what results from adding up the lines, which is
 * the actual fix issue #66 (and the invoice-totals-trust issue it names)
 * asks for.
 *
 * @param {object} params
 * @param {Array<{amount:number, gstRate:number|null, hsnCode?:string}>} params.items
 * @param {string|null} params.supplierState
 * @param {string|null} params.buyerState
 * @param {boolean} [params.reverseCharge] - reverse-charge invoices carry no
 *   output tax for the supplier to collect; this portal still records the
 *   rate/split (what would have applied) rather than zeroing it, since a
 *   reverse-charge invoice's own GSTR-2 filing needs that figure — only
 *   `reverseCharge` itself tells a reader the buyer self-assesses it.
 */
const deriveGst = ({ items, supplierState, buyerState, reverseCharge = false }) => {
  const placeOfSupply = buyerState || null;

  const lines = (items || []).map((item) => {
    const split = splitLineTax({
      taxableValue: item.amount, gstRate: item.gstRate, supplierState, placeOfSupply,
    });
    return { ...item, ...split };
  });

  const subTotal = round2(lines.reduce((sum, line) => sum + (toNumber(line.amount) || 0), 0));
  const taxAmount = round2(lines.reduce((sum, line) => sum + line.totalTax, 0));
  const totalAmount = round2(subTotal + taxAmount);

  return {
    placeOfSupply,
    reverseCharge,
    items: lines.map(({ totalTax, ...line }) => line),
    subTotal,
    taxAmount,
    totalAmount,
  };
};

module.exports = { splitLineTax, deriveGst, isIntraState, round2 };
