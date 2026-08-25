// Phase 7: the VENDOR_CR field mapping table / payload builder.
//
// These assertions encode the CONFIRMED contract — the shape and field names
// from a request/response pair that really created a vendor (1120250057). If
// one of them fails, the mapping has drifted away from what SAP accepts, which
// is exactly the failure this file exists to catch.
const { buildVendorCreatePayload, searchTerms, sapFlag, FIELD_MAP } = require('../sap/mappings/vendor-create.map');
const { FIXTURES, sapVendorCreateSettings } = require('../sap/conformance/fixtures');

// Every key the live endpoint was confirmed to take, per block.
const CONTRACT = {
  top: ['account_group', 'industry', 'gstin'],
  general_data: [
    'name', 'name2', 'street', 'city', 'postal_code', 'region', 'country',
    'language', 'search_term_1', 'search_term_2', 'email',
  ],
  company_code_data: [
    'company_code', 'reconciliation_account', 'payment_terms', 'payment_method',
    'check_double_invoice', 'account_statement', 'planning_group',
  ],
  purchasing_data: [
    'purchasing_organization', 'currency', 'payment_terms', 'incoterms_1',
    'incoterms_2', 'gr_based_invoice_verification', 'schema_group_vendor',
  ],
};

describe('vendor-create.map', () => {
  it('groups every FIELD_MAP row into top-level, general_data, company_code_data or purchasing_data', () => {
    const groups = new Set(FIELD_MAP.map((row) => row.group));
    expect(groups).toEqual(new Set(['top', 'general_data', 'company_code_data', 'purchasing_data']));
  });

  it('never references a bank field (bank details are excluded from VENDOR_CR per the Phase 7 decision)', () => {
    const bankFields = ['accountName', 'accountNumber', 'ifscCode', 'bankName', 'bankBranch'];
    for (const row of FIELD_MAP) {
      expect(bankFields).not.toContain(row.source.split(':')[1]);
    }
  });

  it('splits a company name into two 20-char search terms', () => {
    expect(searchTerms('Conformance Testing Pvt Ltd')).toEqual({
      searchTerm1: 'CONFORMANCE TESTING',
      searchTerm2: 'PVT LTD',
    });
  });

  it('truncated search terms do not overflow 20 chars each', () => {
    const long = 'A'.repeat(50);
    const { searchTerm1, searchTerm2 } = searchTerms(long);
    expect(searchTerm1.length).toBeLessThanOrEqual(20);
    expect(searchTerm2.length).toBeLessThanOrEqual(20);
  });

  it('renders booleans as SAP flag characters, not JSON booleans', () => {
    expect(sapFlag(true)).toBe('X');
    expect(sapFlag(false)).toBe('');
    expect(sapFlag(undefined)).toBe('');
  });

  describe('the built payload matches the confirmed contract', () => {
    const { vendor } = FIXTURES.vendorCreate;
    const payload = buildVendorCreatePayload(vendor, sapVendorCreateSettings);

    it('carries exactly the contract\'s top-level keys, no more and no fewer', () => {
      const topKeys = Object.keys(payload).filter((k) => typeof payload[k] !== 'object');
      expect(topKeys.sort()).toEqual([...CONTRACT.top].sort());
    });

    for (const block of ['general_data', 'company_code_data', 'purchasing_data']) {
      it(`carries exactly the contract's ${block} keys, no more and no fewer`, () => {
        expect(Object.keys(payload[block]).sort()).toEqual([...CONTRACT[block]].sort());
      });
    }

    it('puts gstin at the top level, and gives PAN and phone no field of their own', () => {
      expect(payload.gstin).toBe(vendor.gstin);
      // Not a substring check: an Indian GSTIN embeds the PAN by construction
      // (state code + PAN + suffix), so the PAN's characters legitimately
      // appear inside the GSTIN. What must not exist is a field carrying it.
      const everyValue = [payload, ...Object.values(payload).filter((v) => typeof v === 'object')]
        .flatMap((block) => Object.entries(block).filter(([, v]) => typeof v !== 'object'));
      expect(everyValue.find(([, v]) => v === vendor.pan)).toBeUndefined();
      expect(everyValue.find(([, v]) => v === vendor.phone)).toBeUndefined();
      expect(JSON.stringify(payload)).not.toMatch(/tax_number|telephone/);
    });

    it('reads tenant settings for the system-controlled fields', () => {
      expect(payload.account_group).toBe(sapVendorCreateSettings.accountGroup);
      expect(payload.industry).toBe(sapVendorCreateSettings.industry);
      expect(payload.general_data.language).toBe(sapVendorCreateSettings.language);
      expect(payload.company_code_data.company_code).toBe(sapVendorCreateSettings.companyCode);
      expect(payload.company_code_data.reconciliation_account).toBe(sapVendorCreateSettings.reconciliationAccount);
      expect(payload.purchasing_data.purchasing_organization).toBe(sapVendorCreateSettings.purchasingOrganization);
      expect(payload.purchasing_data.schema_group_vendor).toBe(sapVendorCreateSettings.schemaGroupVendor);
    });

    it('reads the vendor record for the supplier-entered fields', () => {
      expect(payload.general_data.name).toBe(vendor.companyName);
      expect(payload.general_data.country).toBe(vendor.country);
      expect(payload.general_data.region).toBe(vendor.region);
      expect(payload.general_data.email).toBe(vendor.email);
      expect(payload.general_data.search_term_1).toBe('CONFORMANCE TESTING');
      expect(payload.company_code_data.payment_terms).toBe(vendor.paymentTerms);
      expect(payload.purchasing_data.incoterms_1).toBe(vendor.incoterms1);
    });

    it('carries currency on purchasing data and payment terms in both blocks', () => {
      expect(payload.purchasing_data.currency).toBe(vendor.currency);
      expect(payload.company_code_data).toHaveProperty('payment_terms');
      expect(payload.purchasing_data).toHaveProperty('payment_terms');
      expect(payload.company_code_data).not.toHaveProperty('currency');
    });

    it('sends the two flag fields as X or empty string', () => {
      expect(['X', '']).toContain(payload.company_code_data.check_double_invoice);
      expect(['X', '']).toContain(payload.purchasing_data.gr_based_invoice_verification);
    });

    it('never leaks a bank field', () => {
      expect(JSON.stringify(payload)).not.toMatch(/accountNumber|ifscCode|bankName|bankBranch/i);
    });
  });

  it('tolerates missing settings/vendor fields rather than throwing', () => {
    expect(() => buildVendorCreatePayload({ companyName: 'X' }, {})).not.toThrow();
  });
});
