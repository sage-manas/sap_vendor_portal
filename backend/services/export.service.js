// Phase 5.2 of docs/04-sap-runtime-engineering-plan.md — the export bridge.
// Sourcing has no SAP write path (see sap/contract.js's notes on
// quotationUpdatePrice being the one confirmed exception), so an awarded
// portal PO reaches the buyer's SAP team as a downloadable *file*, imported
// on their own schedule — never a live connection, never ABAP, never a WE20
// partner profile. Each `build*` function below takes the same plain payload
// (see buildExportPayload) and is pure — no I/O, so each is trivial to unit
// test on its own.

const { toNumber } = require('../utils/money');

// Reshapes the PO Prisma returned (with `items` and `vendor` included) plus
// its originating RFQ into the flat, presentation-ready shape every format
// below reads from. Keeping this one place means a new export format never
// re-derives header/line fields from the raw Prisma rows itself.
const buildExportPayload = ({ rfq, po }) => ({
  poId: po.id,
  sapPoNumber: po.sapPoNumber || null,
  sapSyncState: po.sapSyncState,
  rfqId: rfq.id,
  buyerName: po.buyerName || '',
  vendorId: po.vendorId,
  vendorName: po.vendor?.companyName || '',
  vendorGstin: po.vendor?.gstin || '',
  vendorSapCode: po.vendor?.sapVendorCode || '',
  plant: po.plant || '',
  companyCode: rfq.companyCode || '1000',
  purchasingOrg: rfq.purchasingOrg || '1000',
  purchasingGroup: rfq.purchasingGroup || '',
  currency: po.currency || 'INR',
  paymentTerms: po.paymentTerms || '',
  incoterms: po.incoterms || '',
  deliveryAddress: po.deliveryAddress || '',
  status: po.status,
  createdDate: po.createdDate,
  items: (po.items || []).map((item) => ({
    line: item.line,
    materialCode: item.materialCode,
    description: item.description || '',
    quantity: item.quantity,
    uom: item.uom || 'EA',
    unitPrice: toNumber(item.unitPrice),
    netValue: toNumber(item.netValue),
  })),
});

const csvCell = (value) => {
  const str = value == null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const HEADER_COLUMNS = [
  ['poId', 'PO Number'],
  ['sapPoNumber', 'SAP PO Number'],
  ['vendorId', 'Vendor Code'],
  ['vendorName', 'Vendor Name'],
  ['vendorGstin', 'Vendor GSTIN'],
  ['plant', 'Plant'],
  ['companyCode', 'Company Code'],
  ['purchasingOrg', 'Purchasing Org'],
  ['currency', 'Currency'],
  ['paymentTerms', 'Payment Terms'],
];

const ITEM_COLUMNS = [
  ['line', 'Line'],
  ['materialCode', 'Material Code'],
  ['description', 'Description'],
  ['quantity', 'Quantity'],
  ['uom', 'UoM'],
  ['unitPrice', 'Unit Price'],
  ['netValue', 'Net Value'],
];

// One row per line item, PO header fields repeated on every row — the
// pragmatic default (§5.2): any MM team can pivot/filter this in Excel
// without a data model.
const buildCsv = (payload) => {
  const columns = [...HEADER_COLUMNS, ...ITEM_COLUMNS];
  const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
  for (const item of payload.items) {
    const row = { ...payload, ...item };
    lines.push(columns.map(([key]) => csvCell(row[key])).join(','));
  }
  return lines.join('\r\n');
};

const buildJson = (payload) => JSON.stringify(payload, null, 2);

const xmlEscape = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A workbook the buyer's MM team can open directly in Excel — SpreadsheetML
// (the Excel 2003 XML format), not the OOXML .xlsx zip container. Excel
// opens it natively under the .xls extension, and it needs no library: it is
// plain XML this function writes by hand, so there is no third-party parser
// in the dependency tree to carry a CVE for a file this service only ever
// *produces*, never reads back.
const ssCell = (value, type = 'String') =>
  `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;

const buildXlsx = (payload) => {
  const headerRow = `<Row>${HEADER_COLUMNS.map(([key, label]) => ssCell(`${label}: ${payload[key] ?? ''}`)).join('')}</Row>`;
  const itemHeaderRow = `<Row>${ITEM_COLUMNS.map(([, label]) => ssCell(label)).join('')}</Row>`;
  const itemRows = payload.items.map((item) => `<Row>${ITEM_COLUMNS.map(([key]) => {
    const numeric = key === 'quantity' || key === 'unitPrice' || key === 'netValue';
    return ssCell(item[key], numeric ? 'Number' : 'String');
  }).join('')}</Row>`).join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="PO Header">
  <Table>${headerRow}</Table>
 </Worksheet>
 <Worksheet ss:Name="Line Items">
  <Table>${itemHeaderRow}${itemRows}</Table>
 </Worksheet>
</Workbook>`;
};

// A flat file shaped like an ORDERS05/PORDCR IDoc — one segment per line,
// tab-separated fields, matching the layout WE19/WE16 accept for a manual
// flat-file inbound test. This is illustrative, not a byte-exact SAP IDoc
// dump (that format is a fixed-width binary the buyer's own Basis team would
// map from these fields); the point (§5.2) is that it is a file the buyer's
// team can feed through their own tooling, not a connection this service
// holds open.
const idocField = (...values) => values.map((v) => (v == null ? '' : String(v))).join('\t');

const buildIdoc = (payload) => {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const lines = [
    idocField('EDI_DC40', 'TABNAM', 'MANDT', 'DOCNUM', 'IDOCTYP', 'MESTYP', 'SNDPRN', 'RCVPRN', 'CREDAT', 'CRETIM'),
    idocField('', 'EDI_DC40', '100', '', 'ORDERS05', 'ORDERS', 'VENDORCONNECT', payload.companyCode, now.toISOString().slice(0, 10).replace(/-/g, ''), stamp.slice(8)),
    idocField('E1EDK01', 'BELNR', 'BSART', 'WAERS', 'ZTERM', 'EKORG', 'EKGRP', 'WERKS'),
    idocField('', payload.poId, 'NB', payload.currency, payload.paymentTerms, payload.purchasingOrg, payload.purchasingGroup, payload.plant),
    idocField('E1EDKA1', 'PARVW', 'LIFNR', 'NAME1'),
    idocField('', 'LF', payload.vendorSapCode || payload.vendorId, payload.vendorName),
  ];
  for (const item of payload.items) {
    lines.push(idocField('E1EDP01', 'POSEX', 'MATNR', 'MENGE', 'MENEE', 'NETPR', 'NETWR', 'KTEXT'));
    lines.push(idocField('', String(item.line).padStart(5, '0'), item.materialCode, item.quantity, item.uom, item.unitPrice, item.netValue, item.description));
  }
  return lines.join('\n');
};

const EXPORT_FORMATS = {
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv', build: buildCsv },
  json: { contentType: 'application/json; charset=utf-8', extension: 'json', build: buildJson },
  xlsx: { contentType: 'application/vnd.ms-excel', extension: 'xls', build: buildXlsx },
  idoc: { contentType: 'text/plain; charset=utf-8', extension: 'idoc.txt', build: buildIdoc },
};

module.exports = { buildExportPayload, EXPORT_FORMATS };
