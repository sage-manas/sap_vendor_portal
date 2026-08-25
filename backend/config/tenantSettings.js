// The single registry of everything a tenant can configure about its own
// workspace. One entry per setting: where it is stored, what it means, what a
// valid value looks like, and — the field that keeps this honest — which code
// reads it.
//
// Nothing anywhere else may name a settings field. The workspace settings
// screen renders from this list, the PATCH endpoint validates against it, and
// consumers ask for a value by key through `settingValue()` so a default lives
// in exactly one place.
//
// `path` is a dot path on the Client document. Branding and feature flags sit
// on the fields the platform plane already edits (ADR-0023); everything else
// lives under `Client.settings`.

const TYPES = {
  boolean: {
    coerce: (value) => (typeof value === 'string' ? value === 'true' : Boolean(value)),
    check: (value) => (typeof value === 'boolean' ? '' : 'must be true or false'),
  },
  number: {
    coerce: (value) => Number(value),
    check: (value) =>
      (Number.isFinite(value) && value >= 0 ? '' : 'must be a number of zero or more'),
  },
  text: {
    coerce: (value) => String(value ?? '').trim(),
    check: (value) => (value.length <= 200 ? '' : 'must be 200 characters or fewer'),
  },
  url: {
    coerce: (value) => String(value ?? '').trim(),
    check: (value) =>
      (!value || /^https?:\/\/\S+$/i.test(value) ? '' : 'must be an http(s) URL, or empty'),
  },
  color: {
    coerce: (value) => String(value ?? '').trim(),
    check: (value) =>
      (!value || /^#[0-9a-f]{6}$/i.test(value) ? '' : 'must be a hex colour like #2f6f4e, or empty'),
  },
};

const GROUPS = [
  { key: 'branding', label: 'Branding', caption: 'What suppliers see when they sign in to this workspace.' },
  { key: 'features', label: 'Features', caption: 'Modules this workspace offers. Turning one off closes its API, not just its screen.' },
  { key: 'thresholds', label: 'Thresholds', caption: 'The numbers the workspace overview measures against.' },
  { key: 'notifications', label: 'Notifications', caption: 'Which decisions send the supplier an email.' },
  {
    key: 'sapVendorCreate',
    label: 'SAP vendor creation',
    caption: 'System-controlled values SAP expects on every vendor master record — set once here, never asked of a supplier. These must match the target SAP system\'s own customizing (account group, company code, purchasing organization and so on); get them from whoever administers it.',
  },
];

const SETTINGS = [
  {
    key: 'branding.logo',
    path: 'branding.logo',
    group: 'branding',
    type: 'url',
    default: '',
    label: 'Logo URL',
    hint: 'Shown in the supplier portal header. Leave empty for the VendorConnect mark.',
    readBy: 'supplier portal header, workspace chrome',
  },
  {
    key: 'branding.primaryColor',
    path: 'branding.primaryColor',
    group: 'branding',
    type: 'color',
    default: '',
    label: 'Accent colour',
    hint: 'A hex colour. Empty keeps the console default.',
    readBy: 'supplier portal theme',
  },
  {
    key: 'features.supplierSelfRegistration',
    path: 'featureFlags.supplierSelfRegistration',
    group: 'features',
    type: 'boolean',
    default: true,
    label: 'Supplier self-registration',
    hint: 'When off, suppliers can only join by invitation or by being created from the directory.',
    readBy: 'POST /api/auth/register, POST /api/vendors/profile',
  },
  {
    key: 'features.supplierChat',
    path: 'featureFlags.supplierChat',
    group: 'features',
    type: 'boolean',
    default: true,
    label: 'Supplier messaging',
    hint: 'When off, the /api/chats endpoints answer 404 for this workspace.',
    readBy: 'requireFeature on /api/chats',
  },
  {
    key: 'thresholds.invoiceReviewAmount',
    path: 'settings.thresholds.invoiceReviewAmount',
    group: 'thresholds',
    type: 'number',
    default: 500000,
    label: 'Invoice review amount',
    hint: 'Invoices at or above this value are counted as needing a human look.',
    readBy: 'workspace overview',
  },
  {
    key: 'thresholds.supplierApprovalSlaHours',
    path: 'settings.thresholds.supplierApprovalSlaHours',
    group: 'thresholds',
    type: 'number',
    default: 48,
    label: 'Supplier approval SLA (hours)',
    hint: 'A submitted supplier older than this is counted as overdue.',
    readBy: 'workspace overview',
  },
  {
    key: 'notifications.supplierDecisionEmail',
    path: 'settings.notifications.supplierDecisionEmail',
    group: 'notifications',
    type: 'boolean',
    default: true,
    label: 'Email suppliers on approval or rejection',
    hint: 'The rejection reason is included, so the supplier knows what to fix.',
    readBy: 'vendor approve / reject',
  },

  // --- SAP vendor creation (VENDOR_CR) — system-controlled, Phase 7 ---------
  // These are NOT vendor-entered form fields. They are set once per tenant by
  // an admin and read by sap/mappings/vendor-create.map.js when building the
  // VENDOR_CR payload. The field names are CONFIRMED against the live
  // endpoint's contract — see that mapping file's header comment. The *values*
  // are per-system and still come from whoever configures the tenant.
  {
    key: 'sapVendorCreate.accountGroup',
    path: 'settings.sapVendorCreate.accountGroup',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Supplier account group',
    hint: 'SAP account_group for new vendors (e.g. SSDN).',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.industry',
    path: 'settings.sapVendorCreate.industry',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Industry key',
    hint: 'SAP industry code for new vendors (e.g. ZENT).',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.language',
    path: 'settings.sapVendorCreate.language',
    group: 'sapVendorCreate',
    type: 'text',
    default: 'E',
    label: 'Language key',
    hint: 'SAP language key on the vendor\'s general data (e.g. E for English).',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.companyCode',
    path: 'settings.sapVendorCreate.companyCode',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Company code',
    hint: 'SAP company_code new vendors are created under (e.g. SSDN).',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.reconciliationAccount',
    path: 'settings.sapVendorCreate.reconciliationAccount',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Reconciliation account',
    hint: 'GL reconciliation account for the vendor\'s company code data (e.g. 0000040000).',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.planningGroup',
    path: 'settings.sapVendorCreate.planningGroup',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Planning group',
    hint: 'Cash management planning group. Unverified — confirm with SAP/ABAP.',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.accountStatement',
    path: 'settings.sapVendorCreate.accountStatement',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Account statement group',
    hint: 'Sort key / account statement grouping. Field name is a guess — unverified.',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.purchasingOrganization',
    path: 'settings.sapVendorCreate.purchasingOrganization',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Purchasing organization',
    hint: 'SAP purchasing_organization for the vendor\'s purchasing view. Unverified — confirm with SAP/ABAP.',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
  {
    key: 'sapVendorCreate.schemaGroupVendor',
    path: 'settings.sapVendorCreate.schemaGroupVendor',
    group: 'sapVendorCreate',
    type: 'text',
    default: '',
    label: 'Schema group (vendor)',
    hint: 'Pricing/calculation schema group for the vendor. Unverified — confirm with SAP/ABAP.',
    readBy: 'sap/mappings/vendor-create.map.js via s4odata.driver.js vendorCreate',
  },
];

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

const readPath = (doc, path) =>
  path.split('.').reduce((node, part) => (node == null ? undefined : node[part]), doc);

const writePath = (doc, path, value) => {
  const parts = path.split('.');
  const last = parts.pop();
  const parent = parts.reduce((node, part) => {
    if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
    return node[part];
  }, doc);
  parent[last] = value;
};

/**
 * The effective value of one setting for a tenant — the stored value, or the
 * registry's default. Every consumer goes through here, so "what happens when
 * it was never set" is answered once.
 */
const settingValue = (client, key) => {
  const setting = BY_KEY.get(key);
  if (!setting) throw new Error(`Unknown tenant setting "${key}" — add it to config/tenantSettings.js`);
  const stored = client ? readPath(client, setting.path) : undefined;
  return stored === undefined || stored === null || stored === '' ? setting.default : stored;
};

// The whole settings surface for a tenant, grouped the way the screen renders
// it. The screen has no field list of its own.
const describeSettings = (client) =>
  GROUPS.map((group) => ({
    ...group,
    settings: SETTINGS.filter((setting) => setting.group === group.key).map((setting) => ({
      key: setting.key,
      label: setting.label,
      hint: setting.hint,
      type: setting.type,
      default: setting.default,
      value: settingValue(client, setting.key),
    })),
  }));

/**
 * Applies a `{ key: value }` patch to a Client document. Returns the keys that
 * actually changed, so the audit entry records a change rather than a save.
 * Throws on an unknown key or an invalid value — a settings write is small
 * enough to reject whole rather than half-apply.
 */
const applySettings = (client, patch = {}) => {
  const errors = {};
  const staged = [];

  for (const [key, raw] of Object.entries(patch)) {
    const setting = BY_KEY.get(key);
    if (!setting) {
      errors[key] = 'is not a setting of this workspace';
      continue;
    }
    const type = TYPES[setting.type];
    const value = type.coerce(raw);
    const problem = type.check(value);
    if (problem) {
      errors[key] = problem;
      continue;
    }
    staged.push({ setting, value });
  }

  if (Object.keys(errors).length) {
    const error = new Error('Invalid settings');
    error.fields = errors;
    throw error;
  }

  const changed = [];
  for (const { setting, value } of staged) {
    if (settingValue(client, setting.key) === value) continue;
    writePath(client, setting.path, value);
    // Mixed subtrees do not track their own mutations.
    client.markModified(setting.path.split('.')[0]);
    changed.push(setting.key);
  }

  return changed;
};

module.exports = {
  SETTING_GROUPS: GROUPS,
  SETTING_DEFINITIONS: SETTINGS,
  SETTING_KEYS: SETTINGS.map((setting) => setting.key),
  settingValue,
  describeSettings,
  applySettings,
};
