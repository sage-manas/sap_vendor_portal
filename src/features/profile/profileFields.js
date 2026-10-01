// The profile columns PUT /api/vendors/profile accepts — the keys of
// profileUpdateSchema (backend/validators/vendor.validator.js). The API refuses
// any other key (a supplier's status, ids and timestamps are the server's), and
// the profile object the form holds is the whole GET /vendors/profile response,
// so it is narrowed to these before it is sent. A backend test
// (tests/profile-fields-contract.test.js) fails if this list names a key the
// schema does not.
export const PROFILE_WRITABLE_FIELDS = [
  'vendorId',
  'companyName',
  'gstin',
  'pan',
  'email',
  'phone',
  'tradeName',
  'businessType',
  'incorporationDate',
  'cin',
  'msmeNumber',
  'tdsSection',
  'vendorCategory',
  'msmeRegistered',
  'address',
  'city',
  'state',
  'country',
  'region',
  'postalCode',
  'bankName',
  'accountNumber',
  'ifscCode',
  'accountName',
  'bankBranch',
  'bankDetails',
  'paymentTerms',
  'paymentMethod',
  'currency',
  'incoterms1',
  'incoterms2',
  'doubleInvoiceCheck',
  'grBasedInvoiceVerification',
  'cancelledCheque',
  'panCardCopy',
  'gstCertificate',
  'msmeCertificate',
];

export const pickProfileFields = (profile = {}) =>
  Object.fromEntries(PROFILE_WRITABLE_FIELDS.filter((field) => field in profile).map((field) => [field, profile[field]]));
