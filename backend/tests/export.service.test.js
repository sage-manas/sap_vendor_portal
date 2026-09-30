// Issue #75: csvCell escaped quotes/commas/newlines but not a cell beginning
// with =, +, -, @, or a tab/carriage return — which Excel/LibreOffice read
// as a formula on open. vendorName/companyName are attacker-controlled (a
// supplier picks both at self-registration), so a malicious company name
// reaching a PO export could execute on the buyer's machine
// (=HYPERLINK exfiltration, or DDE with an older Excel).
const { buildExportPayload, EXPORT_FORMATS } = require('../services/export.service');

const basePo = ({ vendorName = 'Acme Pvt Ltd', description = 'Widget' } = {}) => ({
  rfq: { id: 'RFQ-1' },
  po: {
    id: 'PO-2026-0001',
    sapPoNumber: '4500000001',
    sapSyncState: 'synced',
    buyerName: 'Buyer Co',
    vendorId: 'vendor_1',
    vendor: { companyName: vendorName, gstin: '27AAAAA0000A1Z5', sapVendorCode: 'VEN001' },
    companyCode: '1000',
    purchasingOrg: '1000',
    purchasingGroup: '100',
    currency: 'INR',
    paymentTerms: 'NET30',
    incoterms: 'FOB',
    deliveryAddress: 'Warehouse 1',
    status: 'Open',
    createdDate: new Date('2026-01-01'),
    items: [
      { line: 10, materialCode: 'MAT-1', description, quantity: 5, uom: 'EA', unitPrice: 10, netValue: 50, plant: '1000' },
    ],
  },
});

// CSV/XML escaping (quote-doubling, entity-encoding) is orthogonal to
// formula neutralisation and already covered by its own dedicated test
// below — these use formula-shaped names with no quotes of their own so a
// row/cell's content can be checked directly without having to undo that
// escaping first.
const FORMULA_NAMES = [
  '=SUM(A1:A2)',
  "+cmd|'/c calc'!A1",
  '-2+3',
  '@SUM(A1:A2)',
  '\tshifted',
];

describe('export.service neutralises formula injection (issue #75)', () => {
  it.each(FORMULA_NAMES)('CSV: prefixes a vendor name starting with %j so it cannot execute as a formula', (vendorName) => {
    const payload = buildExportPayload(basePo({ vendorName }));
    const csv = EXPORT_FORMATS.csv.build(payload);
    const row = csv.split('\r\n')[1];

    expect(row).not.toMatch(/,=|,\+|,-|,@|,\t/); // the raw cell never lands on the row unprefixed
    expect(row).toContain(`'${vendorName}`);
  });

  it.each(FORMULA_NAMES)('XLS: a header cell stays safe because it is label-prefixed, whatever the vendor name starts with', (vendorName) => {
    const payload = buildExportPayload(basePo({ vendorName }));
    const xml = EXPORT_FORMATS.xlsx.build(payload);

    // The header cell's actual content is "Vendor Name: <value>" — the fixed
    // label already keeps this *cell* from ever starting with a formula
    // character, whatever the vendor name is, so ssCell leaves it as-is here.
    // (The item-row test below is where a String cell has no such label and
    // genuinely needs the neutralising prefix.)
    expect(xml).toContain(`Vendor Name: ${vendorName}`);
  });

  it('CSV: prefixes an item field (materialCode/description) the same way', () => {
    const payload = buildExportPayload(basePo({ description: '=1+1' }));
    const csv = EXPORT_FORMATS.csv.build(payload);
    const dataRow = csv.split('\r\n')[1];

    expect(dataRow).toContain("'=1+1");
  });

  it('XLS: prefixes an item field (description) as a plain String cell, unprefixed for a Number cell', () => {
    const payload = buildExportPayload(basePo({ description: '=1+1' }));
    const xml = EXPORT_FORMATS.xlsx.build(payload);

    expect(xml).toContain('<Data ss:Type="String">\'=1+1</Data>');
    // Quantity/unitPrice/netValue are Number-typed and never string content —
    // neutralising them would corrupt the numeric value for nothing.
    expect(xml).toContain('<Data ss:Type="Number">5</Data>');
  });

  it('a plain, non-formula name is left exactly as-is in both formats', () => {
    const payload = buildExportPayload(basePo({ vendorName: 'Acme Pvt Ltd' }));
    const csv = EXPORT_FORMATS.csv.build(payload);
    const xml = EXPORT_FORMATS.xlsx.build(payload);

    expect(csv.split('\r\n')[1]).toContain('Acme Pvt Ltd');
    expect(xml).toContain('Vendor Name: Acme Pvt Ltd');
    expect(csv).not.toContain("'Acme");
    expect(xml).not.toContain("'Acme");
  });

  it('a value already quoted for a comma/newline is still neutralised underneath the quoting', () => {
    const payload = buildExportPayload(basePo({ vendorName: '=A1,"gotcha"' }));
    const csv = EXPORT_FORMATS.csv.build(payload);
    const headerAndFirstDataRow = csv.split('\r\n').slice(0, 2).join('\n');

    expect(headerAndFirstDataRow).toContain('"\'=A1,""gotcha"""');
  });
});
