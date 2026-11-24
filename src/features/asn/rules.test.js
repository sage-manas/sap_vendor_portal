import { describe, it, expect } from 'vitest';
import { quantityErrors, shipmentErrors, ewayBillRequired, VEHICLE_NUMBER } from './rules';

// The same examples backend/tests/asn-lifecycle.test.js uses, so the wizard
// and the API refuse the same things.

const today = new Date().toISOString().slice(0, 10);
const valid = {
  invoiceReference: 'INV/2526/0871', invoiceDate: today, invoiceValue: '1180', taxableValue: '1000',
  shipDate: today, estimatedDeliveryDate: today, carrierName: 'Safexpress', trackingNumber: 'LR778812',
};
const attached = { invoiceCopyAttached: true, ewayBillAttached: true };

describe('shipment details', () => {
  it('passes a complete form', () => {
    expect(shipmentErrors(valid, attached)).toEqual({});
  });

  it('asks for an LR / docket number or a vehicle number, either is enough', () => {
    expect(shipmentErrors({ ...valid, trackingNumber: '' }, attached)).toHaveProperty('trackingNumber');
    expect(shipmentErrors({ ...valid, trackingNumber: '', vehicleNumber: 'hr 55 ab 1234' }, attached)).toEqual({});
  });

  it('knows standard, Bharat-series and temporary registrations', () => {
    for (const ok of ['HR55AB1234', 'MH12A1234', '22BH1234AB', 'T0526MH1234AB']) expect(VEHICLE_NUMBER.test(ok)).toBe(true);
    for (const bad of ['TRUCK1', 'HR55AB123', '12345678']) expect(VEHICLE_NUMBER.test(bad)).toBe(false);
  });

  it('asks for an e-way bill only above ₹50,000 with tax', () => {
    expect(ewayBillRequired(50000)).toBe(false);
    expect(ewayBillRequired(50000.01)).toBe(true);
    expect(ewayBillRequired(80000, 'USD')).toBe(false);
    const big = { ...valid, invoiceValue: '486750', taxableValue: '412500' };
    expect(shipmentErrors(big, { invoiceCopyAttached: true })).toMatchObject({ ewayBillNo: expect.any(String), ewayBill: 'Attach the e-way bill' });
    expect(shipmentErrors({ ...big, ewayBillNo: '3210 0987 6543', ewayBillDate: today }, attached)).toEqual({});
  });

  it('wants the e-way bill date once a number is given, even below the limit', () => {
    expect(shipmentErrors({ ...valid, ewayBillNo: '321009876543' }, attached)).toHaveProperty('ewayBillDate');
  });

  it('checks dates against dispatch and taxable value against the total', () => {
    const errors = shipmentErrors({
      ...valid, shipDate: '2026-01-10', invoiceDate: '2026-01-11', estimatedDeliveryDate: '2026-01-09', taxableValue: '2000',
    }, attached);
    expect(Object.keys(errors).sort()).toEqual(['estimatedDeliveryDate', 'invoiceDate', 'taxableValue']);
  });

  it('needs the invoice copy attached', () => {
    expect(shipmentErrors(valid, { invoiceCopyAttached: false })).toHaveProperty('invoiceCopy');
  });
});

describe('quantities', () => {
  const line = (open) => ({ key: 'PO-1:10', item: { openToShipQuantity: open } });

  it('takes the whole open quantity, decimals and all, and nothing more', () => {
    expect(quantityErrors([line(66.7)], { 'PO-1:10': '66.7' })).toEqual({});
    expect(quantityErrors([line(66.7)], { 'PO-1:10': '66.701' })).toHaveProperty('PO-1:10');
    expect(quantityErrors([line(10)], { 'PO-1:10': '' })).toHaveProperty('PO-1:10');
  });
});
