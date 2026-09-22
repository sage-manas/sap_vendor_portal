import { describe, it, expect } from 'vitest';
import { validateField } from './validation';

describe('validateField — required fields', () => {
  const requiredTextFields = [
    ['companyName', 'Legal Entity Name is required'],
    ['tradeName', 'Trade / Brand Name is required'],
    ['address', 'Street address is required'],
    ['city', 'City is required'],
    ['accountName', 'Account Holder Name is required'],
    ['bankName', 'Bank Name is required'],
    ['bankBranch', 'Bank Branch is required'],
    ['incoterms1', 'Shipping Terms 1 is required'],
    ['incoterms2', 'Shipping Terms 2 is required'],
  ];

  it.each(requiredTextFields)('%s: empty and whitespace-only values are rejected', (field, message) => {
    expect(validateField(field, '')).toBe(message);
    expect(validateField(field, '   ')).toBe(message);
    expect(validateField(field, undefined)).toBe(message);
  });

  it('select/document fields reject falsy values without calling trim', () => {
    expect(validateField('businessType', '')).toMatch(/required/);
    expect(validateField('state', undefined)).toMatch(/required/);
    expect(validateField('gstType', null)).toMatch(/required/);
    expect(validateField('tdsSection', '')).toMatch(/required/);
    expect(validateField('cancelledCheque', null)).toMatch(/required/);
    expect(validateField('panCardCopy', undefined)).toMatch(/required/);
    expect(validateField('gstCertificate', '')).toMatch(/required/);
  });

  // These feed VENDOR_CR (backend/sap/mappings/vendor-create.map.js). They
  // were rendered but left out of the form's step config, so nothing validated
  // them and they reached SAP empty — which SAP refuses without naming a
  // field. submitRegistration refuses the same set server-side.
  it('trade & payment terms are required', () => {
    expect(validateField('paymentTerms', '')).toMatch(/required/);
    expect(validateField('paymentMethod', '')).toMatch(/required/);
    expect(validateField('currency', undefined)).toMatch(/required/);
    expect(validateField('incoterms1', '')).toMatch(/required/);
    expect(validateField('incoterms2', '')).toMatch(/required/);

    expect(validateField('paymentTerms', '0001')).toBe('');
    expect(validateField('paymentMethod', 'T')).toBe('');
    expect(validateField('currency', 'INR')).toBe('');
    expect(validateField('incoterms1', 'FOB')).toBe('');
    expect(validateField('incoterms2', 'Pune')).toBe('');
  });

  // Confirmed live: a VENDOR_CR with both flags empty is accepted. They are
  // booleans where '' means "no", so requiring them would mean forcing every
  // supplier to switch the behaviour on.
  it('the two SAP flags stay optional', () => {
    expect(validateField('doubleInvoiceCheck', false)).toBe('');
    expect(validateField('grBasedInvoiceVerification', false)).toBe('');
  });

  it('unknown fields are always valid', () => {
    expect(validateField('nonexistent', '')).toBe('');
    expect(validateField('nonexistent', 'anything')).toBe('');
  });
});

describe('validateField — format rules', () => {
  it('postalCode must be exactly 6 digits', () => {
    expect(validateField('postalCode', '411001')).toBe('');
    expect(validateField('postalCode', '41100')).toMatch(/6 digits/);
    expect(validateField('postalCode', '4110011')).toMatch(/6 digits/);
    expect(validateField('postalCode', '41100a')).toMatch(/6 digits/);
  });

  it('email format', () => {
    expect(validateField('email', 'ops@acme.co.in')).toBe('');
    expect(validateField('email', 'not-an-email')).toMatch(/valid email/);
    expect(validateField('email', 'a @b.com')).toMatch(/valid email/);
  });

  it('phone accepts 10-15 digits with optional +, spaces, dashes', () => {
    expect(validateField('phone', '9876543210')).toBe('');
    expect(validateField('phone', '+91 98765 43210')).toBe('');
    expect(validateField('phone', '123')).toMatch(/10 and 15/);
    expect(validateField('phone', 'abcdefghij')).toMatch(/10 and 15/);
  });

  it('PAN format ABCDE1234F (case-insensitive)', () => {
    expect(validateField('pan', 'ABCDE1234F')).toBe('');
    expect(validateField('pan', 'abcde1234f')).toBe('');
    expect(validateField('pan', 'AB1DE1234F')).toMatch(/standard format/);
    expect(validateField('pan', 'ABCDE12345')).toMatch(/standard format/);
  });

  it('GSTIN format 27AABCB1234F1Z5', () => {
    expect(validateField('gstin', '27AABCB1234F1Z5')).toBe('');
    expect(validateField('gstin', '27aabcb1234f1z5')).toBe('');
    expect(validateField('gstin', '27AABCB1234F1X5')).toMatch(/standard format/); // Z slot wrong
    expect(validateField('gstin', 'AABCB1234F')).toMatch(/standard format/);
  });

  it('account number must be 9-18 digits', () => {
    expect(validateField('accountNumber', '123456789')).toBe('');
    expect(validateField('accountNumber', '123456789012345678')).toBe('');
    expect(validateField('accountNumber', '12345678')).toMatch(/9 to 18/);
    expect(validateField('accountNumber', '1234567890123456789')).toMatch(/9 to 18/);
    expect(validateField('accountNumber', '12345678a')).toMatch(/9 to 18/);
  });

  it('IFSC format: 4 letters, a zero, 6 alphanumerics', () => {
    expect(validateField('ifscCode', 'HDFC0000060')).toBe('');
    expect(validateField('ifscCode', 'hdfc0000060')).toBe('');
    expect(validateField('ifscCode', 'HDFC1000060')).toMatch(/standard format/); // 5th char must be 0
    expect(validateField('ifscCode', 'HDF00000060')).toMatch(/standard format/);
  });
});
