// The shipment notice rules, as the wizard shows them before anything is sent.
//
// The API is the authority — backend/validators/asn.validator.js and
// backend/controllers/po.controller.js's createAsn apply every one of these
// again, against current data — so this file exists only so a mistake shows
// next to its field on the step where it was made, not as a refusal after
// Submit. Keep the two in step: the tests in rules.test.js use the same
// examples as backend/tests/asn-lifecycle.test.js.

export const EWAY_BILL_THRESHOLD_INR = 50000;

const compact = (value) => String(value || '').replace(/[\s-]+/g, '').toUpperCase();

export const VEHICLE_NUMBER = /^(?:[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}|\d{2}BH\d{4}[A-Z]{1,2}|T\d{4}[A-Z]{2}\d{4}[A-Z]{1,2})$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const MOBILE = /^(?:\+?91)?[6-9]\d{9}$/;
const INVOICE_NUMBER = /^[A-Za-z0-9/-]{1,16}$/;

// Quantities are compared in thousandths (Decimal(13,3)), as the API does.
const milli = (value) => Math.round((Number(value) || 0) * 1000);

/** The line's open quantity, as the API reports it on GET /pos. */
export const openToShip = (item) => item.openToShipQuantity
  ?? Math.max(0, Number(item.quantity) - Number(item.grnQuantity || 0));

/** Whether the e-way bill is required for this invoice total (INR only). */
export const ewayBillRequired = (invoiceValue, currency = 'INR') => currency === 'INR'
  && Number(invoiceValue) > EWAY_BILL_THRESHOLD_INR;

/**
 * Step 2: every selected line's quantity.
 * @param {Array<{key:string, item:object}>} lines - the selected PO lines
 * @param {Object<string, string|number>} quantities - by line key
 * @returns {Object<string, string>} error by line key
 */
export const quantityErrors = (lines, quantities) => {
  const errors = {};
  for (const { key, item } of lines) {
    const raw = quantities[key];
    const qty = Number(raw);
    if (raw === '' || raw === undefined || Number.isNaN(qty) || qty <= 0) {
      errors[key] = 'Enter a quantity above 0, or go back and leave this line out';
    } else if (milli(qty) > milli(openToShip(item))) {
      errors[key] = `Only ${openToShip(item)} left to ship on this line`;
    }
  }
  return errors;
};

const dayOf = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

/**
 * Step 3: the shipment details.
 * @param {object} form
 * @param {object} [options]
 * @param {string} [options.currency]
 * @param {boolean} [options.invoiceCopyAttached]
 * @param {boolean} [options.ewayBillAttached]
 * @returns {Object<string, string>} error by field
 */
export const shipmentErrors = (form, { currency = 'INR', invoiceCopyAttached = false, ewayBillAttached = false } = {}) => {
  const errors = {};
  const set = (field, message) => { if (!errors[field]) errors[field] = message; };
  const today = new Date().toISOString().slice(0, 10);
  const ship = dayOf(form.shipDate) || today;

  if (!INVOICE_NUMBER.test(form.invoiceReference || '')) set('invoiceReference', 'Enter the invoice number: up to 16 letters, digits, - or /');
  if (!form.invoiceDate) set('invoiceDate', 'Enter the invoice date');
  else if (dayOf(form.invoiceDate) > today) set('invoiceDate', 'The invoice date cannot be in the future');
  else if (dayOf(form.invoiceDate) > ship) set('invoiceDate', 'The invoice date cannot be after the dispatch date');
  if (!(Number(form.invoiceValue) > 0)) set('invoiceValue', 'Enter the invoice total with tax');
  if (form.taxableValue !== '' && form.taxableValue != null && Number(form.taxableValue) > Number(form.invoiceValue)) {
    set('taxableValue', 'The taxable value cannot be more than the invoice total');
  }

  if (!form.shipDate) set('shipDate', 'Enter the dispatch date');
  if (!form.estimatedDeliveryDate) set('estimatedDeliveryDate', 'Enter the expected arrival date');
  else if (dayOf(form.estimatedDeliveryDate) < ship) set('estimatedDeliveryDate', 'Expected arrival cannot be before dispatch');

  if (!String(form.carrierName || '').trim()) set('carrierName', 'Enter the transporter');
  if (!String(form.trackingNumber || '').trim() && !String(form.vehicleNumber || '').trim()) {
    set('trackingNumber', 'Enter the LR / docket number or the vehicle number');
  }
  if (form.vehicleNumber && !VEHICLE_NUMBER.test(compact(form.vehicleNumber))) {
    set('vehicleNumber', 'Check the vehicle number (for example HR55AB1234 or 22BH1234AB)');
  }
  if (form.driverMobile && !MOBILE.test(String(form.driverMobile).replace(/[\s-]+/g, ''))) {
    set('driverMobile', 'Enter a 10-digit Indian mobile number');
  }
  if (form.transporterGstin && !GSTIN.test(compact(form.transporterGstin))) {
    set('transporterGstin', 'Check the transporter GSTIN');
  }

  const ewayNumber = String(form.ewayBillNo || '').replace(/\s+/g, '');
  const needsEway = ewayBillRequired(form.invoiceValue, currency);
  if (ewayNumber && !/^\d{12}$/.test(ewayNumber)) set('ewayBillNo', 'An e-way bill number is 12 digits');
  if (needsEway && !ewayNumber) set('ewayBillNo', `Required: the invoice is worth more than ₹${EWAY_BILL_THRESHOLD_INR.toLocaleString('en-IN')}`);
  if (ewayNumber && !form.ewayBillDate) set('ewayBillDate', 'Enter the e-way bill date');
  if (form.ewayBillDate && dayOf(form.ewayBillDate) > ship) set('ewayBillDate', 'The e-way bill date cannot be after the dispatch date');

  if (!invoiceCopyAttached) set('invoiceCopy', 'Attach the invoice copy');
  if (needsEway && !ewayBillAttached) set('ewayBill', 'Attach the e-way bill');

  return errors;
};
