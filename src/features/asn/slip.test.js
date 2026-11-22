import { describe, it, expect } from 'vitest';
import { slipCode } from './components/AsnSlip';

// The QR code's text is a contract with SAP's gate-entry transaction
// (docs/abap-requests/inbound-delivery.md, "The ASN slip").
describe('the slip\'s QR code', () => {
  it('is the ASN number and the SAP delivery, split by |', () => {
    expect(slipCode({ id: 'ASN-482913', sapInboundDelivery: '0180000123' })).toBe('ASN-482913|0180000123');
  });

  it('leaves the delivery empty until SAP has one', () => {
    expect(slipCode({ id: 'ASN-482913', sapInboundDelivery: null })).toBe('ASN-482913|');
  });
});
