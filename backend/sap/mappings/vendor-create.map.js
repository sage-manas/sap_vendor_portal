// Field mapping for the `VENDOR_CR` custom Z REST endpoint (zvendor_create).
//
// CONFIRMED against the live endpoint's real contract (a worked request/response
// pair supplied by the client, which created vendor 1120250057). This file is no
// longer a reconstruction — the group shape, every field name, and the value
// conventions below are the real thing. Where an earlier version of this file
// guessed, the guess is recorded in CONTRACT_CORRECTIONS at the bottom so the
// change is auditable rather than silent.
//
// The contract, exactly:
//
//   {
//     "account_group", "industry", "gstin",          <- top level
//     "general_data":      { name, name2, street, city, postal_code, region,
//                            country, language, search_term_1, search_term_2,
//                            email },
//     "company_code_data": { company_code, reconciliation_account, payment_terms,
//                            payment_method, check_double_invoice,
//                            account_statement, planning_group },
//     "purchasing_data":   { purchasing_organization, currency, payment_terms,
//                            incoterms_1, incoterms_2,
//                            gr_based_invoice_verification, schema_group_vendor }
//   }
//
// Response: { TYPE: 'S'|'E', MESSAGE, VENDOR } — VENDOR is the SAP vendor code.
//
// Three things worth knowing about this contract:
//
//   1. `gstin` is TOP LEVEL, not a general_data tax field. It is also the only
//      identifier on the payload that ties the created vendor back to our
//      record, which makes it the correlation key the rest of the driver needs
//      (see s4odata.driver.js). PAN is NOT sent at all — SAP does not receive
//      it through this endpoint.
//   2. Booleans are SAP flag characters: 'X' for true, '' for false. Never
//      JSON true/false.
//   3. `payment_terms` appears in BOTH company_code_data and purchasing_data,
//      and `currency` belongs to purchasing_data (not company code data).
//      Both are deliberate in the real contract, not duplication errors here.
//
// Bank details (accountName, accountNumber, ifscCode, bankName, bankBranch) are
// deliberately EXCLUDED — the contract has no place for them, matching the
// Phase 7 decision to reserve them for a separate future SAP call.
//
// Each row: { group, sapField, source, flag?, note? }.
// `source` is 'vendor:<field>' (off the vendor doc), 'setting:<key>' (the
// per-tenant sapVendorCreate settings group) or 'derived:<name>' (computed
// below — never a raw form input; see IMPLEMENTATION_PLAN.md Phase 7c).
// `flag: true` marks a field SAP wants as 'X'/'' rather than a JSON boolean.

const FIELD_MAP = [
  // --- Top level ----------------------------------------------------------
  { group: 'top', sapField: 'account_group', source: 'setting:accountGroup',
    note: 'SAP supplier account group (e.g. SSDN). Tenant setting, set once by an admin.' },
  { group: 'top', sapField: 'industry', source: 'setting:industry',
    note: 'SAP industry key (e.g. ZENT). Tenant setting.' },
  { group: 'top', sapField: 'gstin', source: 'vendor:gstin',
    note: 'Top level, not a general_data tax field. Also the correlation key for reading the vendor back out of SAP.' },

  // --- general_data --------------------------------------------------------
  { group: 'general_data', sapField: 'name', source: 'vendor:companyName' },
  { group: 'general_data', sapField: 'name2', source: 'vendor:tradeName' },
  { group: 'general_data', sapField: 'street', source: 'vendor:address' },
  { group: 'general_data', sapField: 'city', source: 'vendor:city' },
  { group: 'general_data', sapField: 'postal_code', source: 'vendor:postalCode' },
  { group: 'general_data', sapField: 'region', source: 'vendor:region',
    note: 'SAP region code (e.g. "07"), not a state name — see Vendor.js on region vs. the legacy free-text state.' },
  { group: 'general_data', sapField: 'country', source: 'vendor:country',
    note: 'Two-letter country code, e.g. "IN".' },
  { group: 'general_data', sapField: 'language', source: 'setting:language',
    note: 'SAP language key, e.g. "E". Tenant setting — not asked of a supplier.' },
  { group: 'general_data', sapField: 'search_term_1', source: 'derived:searchTerm1',
    note: 'First 20 chars of the normalized companyName — computed server-side, not a form field.' },
  { group: 'general_data', sapField: 'search_term_2', source: 'derived:searchTerm2',
    note: 'Next 20 chars of the normalized companyName — computed server-side, not a form field.' },
  { group: 'general_data', sapField: 'email', source: 'vendor:email' },

  // --- company_code_data ----------------------------------------------------
  { group: 'company_code_data', sapField: 'company_code', source: 'setting:companyCode' },
  { group: 'company_code_data', sapField: 'reconciliation_account', source: 'setting:reconciliationAccount' },
  { group: 'company_code_data', sapField: 'payment_terms', source: 'vendor:paymentTerms' },
  { group: 'company_code_data', sapField: 'payment_method', source: 'vendor:paymentMethod' },
  { group: 'company_code_data', sapField: 'check_double_invoice', source: 'vendor:doubleInvoiceCheck', flag: true },
  { group: 'company_code_data', sapField: 'account_statement', source: 'setting:accountStatement' },
  { group: 'company_code_data', sapField: 'planning_group', source: 'setting:planningGroup' },

  // --- purchasing_data --------------------------------------------------
  { group: 'purchasing_data', sapField: 'purchasing_organization', source: 'setting:purchasingOrganization' },
  { group: 'purchasing_data', sapField: 'currency', source: 'vendor:currency',
    note: 'Currency lives on purchasing data in this contract, not company code data.' },
  { group: 'purchasing_data', sapField: 'payment_terms', source: 'vendor:paymentTerms',
    note: 'Deliberately repeated from company_code_data — the real contract carries it in both blocks.' },
  { group: 'purchasing_data', sapField: 'incoterms_1', source: 'vendor:incoterms1' },
  { group: 'purchasing_data', sapField: 'incoterms_2', source: 'vendor:incoterms2' },
  { group: 'purchasing_data', sapField: 'gr_based_invoice_verification', source: 'vendor:grBasedInvoiceVerification', flag: true },
  { group: 'purchasing_data', sapField: 'schema_group_vendor', source: 'setting:schemaGroupVendor' },
];

// SAP wants a flag character, not a JSON boolean.
const sapFlag = (value) => (value ? 'X' : '');

const searchTerms = (companyName) => {
  const normalized = String(companyName || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return {
    searchTerm1: normalized.slice(0, 20).trim(),
    searchTerm2: normalized.slice(20, 40).trim(),
  };
};

const readSource = (source, { vendor, settings }) => {
  const [kind, key] = source.split(':');
  if (kind === 'vendor') return vendor?.[key] ?? '';
  if (kind === 'setting') return settings?.[key] ?? '';
  if (kind === 'derived') {
    const { searchTerm1, searchTerm2 } = searchTerms(vendor?.companyName);
    return key === 'searchTerm1' ? searchTerm1 : searchTerm2;
  }
  return '';
};

/**
 * Builds the VENDOR_CR JSON body from FIELD_MAP, a vendor doc, and the
 * per-tenant sapVendorCreate settings (config/tenantSettings.js). Bank details
 * are excluded entirely — the contract has no place for them.
 */
const buildVendorCreatePayload = (vendor, settings = {}) => {
  const body = { general_data: {}, company_code_data: {}, purchasing_data: {} };
  for (const row of FIELD_MAP) {
    const raw = readSource(row.source, { vendor, settings });
    const value = row.flag ? sapFlag(raw) : raw;
    if (row.group === 'top') body[row.sapField] = value;
    else body[row.group][row.sapField] = value;
  }
  return body;
};

// Reads the tenant-configured VENDOR_CR values out of the
// config/tenantSettings.js 'sapVendorCreate' group for a given Client document,
// in the shape buildVendorCreatePayload expects as `settings`. Kept here (not in
// the controller) so there is exactly one place that knows both the
// tenantSettings keys and the payload field names they feed.
const settingsFromClient = (client) => {
  // Lazy require: avoids a require cycle risk if config/tenantSettings.js ever
  // needs anything sap-side in the future.
  const { settingValue } = require('../../config/tenantSettings');
  return {
    accountGroup: settingValue(client, 'sapVendorCreate.accountGroup'),
    industry: settingValue(client, 'sapVendorCreate.industry'),
    language: settingValue(client, 'sapVendorCreate.language'),
    companyCode: settingValue(client, 'sapVendorCreate.companyCode'),
    reconciliationAccount: settingValue(client, 'sapVendorCreate.reconciliationAccount'),
    planningGroup: settingValue(client, 'sapVendorCreate.planningGroup'),
    accountStatement: settingValue(client, 'sapVendorCreate.accountStatement'),
    purchasingOrganization: settingValue(client, 'sapVendorCreate.purchasingOrganization'),
    schemaGroupVendor: settingValue(client, 'sapVendorCreate.schemaGroupVendor'),
  };
};

// What the earlier reconstruction of this contract got wrong, kept so the
// correction is auditable and so nobody "fixes" these back. Left → what this
// file used to send; right → what the endpoint actually wants.
const CONTRACT_CORRECTIONS = Object.freeze({
  'general_data.name_1': 'general_data.name',
  'general_data.name_2': 'general_data.name2',
  'general_data.tax_number_gstin': 'gstin (top level)',
  'general_data.tax_number_pan': 'not sent at all — SAP does not receive PAN here',
  'general_data.telephone': 'not sent at all — no phone field in the contract',
  'general_data.(missing)': 'general_data.language — required, from tenant settings',
  'company_code_data.double_invoice_check': 'company_code_data.check_double_invoice',
  'company_code_data.currency': 'purchasing_data.currency',
  'purchasing_data.(missing)': 'purchasing_data.payment_terms — carried in both blocks',
  'booleans as JSON true/false': "SAP flag characters 'X' / ''",
});

module.exports = { FIELD_MAP, buildVendorCreatePayload, searchTerms, settingsFromClient, sapFlag, CONTRACT_CORRECTIONS };
