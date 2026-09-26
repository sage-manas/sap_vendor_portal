// The single registry of auditable actions. An action that is not listed here
// cannot be recorded — `recordAudit` throws — which is what stops the action
// vocabulary drifting into free text that no explorer can filter on.
//
// Naming: <subject>.<verb>, past tense implied. The subject is the thing acted
// upon, so filtering by prefix gives you "everything that happened to tenants".

const AUDIT_ACTIONS = {
  // Tenant lifecycle (platform plane)
  TENANT_CREATED: 'tenant.created',
  TENANT_UPDATED: 'tenant.updated',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_REACTIVATED: 'tenant.reactivated',
  TENANT_TERMINATED: 'tenant.terminated',
  TENANT_EXPORTED: 'tenant.exported',
  TENANT_ADMIN_PROVISIONED: 'tenant.admin_provisioned',
  TENANT_ADMIN_CREDENTIALS_REISSUED: 'tenant.admin_credentials_reissued',

  // Operator lifecycle (platform plane)
  OPERATOR_CREATED: 'operator.created',
  OPERATOR_UPDATED: 'operator.updated',
  OPERATOR_SUSPENDED: 'operator.suspended',
  OPERATOR_REACTIVATED: 'operator.reactivated',
  OPERATOR_MFA_ENROLLED: 'operator.mfa_enrolled',
  OPERATOR_MFA_RESET: 'operator.mfa_reset',
  OPERATOR_LOGIN: 'operator.login',
  OPERATOR_LOGIN_FAILED: 'operator.login_failed',
  OPERATOR_PASSWORD_CHANGED: 'operator.password_changed',

  // Supplier directory (tenant plane)
  VENDOR_INVITED: 'vendor.invited',
  VENDOR_CREATED: 'vendor.created',
  VENDOR_APPROVED: 'vendor.approved',
  VENDOR_REJECTED: 'vendor.rejected',
  VENDOR_BANK_CHANGE_REQUESTED: 'vendor.bank_change_requested',
  VENDOR_BANK_CHANGE_APPROVED: 'vendor.bank_change_approved',
  VENDOR_BANK_CHANGE_REJECTED: 'vendor.bank_change_rejected',
  // The manual half of an approval SAP could not take automatically: a
  // person states the change is now in SAP's vendor master (XK02), and only
  // then does the portal's copy move to the new account.
  VENDOR_BANK_CHANGE_SAP_CONFIRMED: 'vendor.bank_change_sap_confirmed',

  // Tenant staff (tenant plane)
  USER_INVITED: 'user.invited',
  USER_INVITATION_REVOKED: 'user.invitation_revoked',
  USER_UPDATED: 'user.updated',
  USER_STATUS_CHANGED: 'user.status_changed',

  // Workspace configuration (tenant plane)
  SETTINGS_UPDATED: 'settings.updated',

  // SAP configuration (Phase 4 writes these; the explorer already reads them)
  SAP_CONNECTION_CREATED: 'sap.connection_created',
  SAP_CONNECTION_UPDATED: 'sap.connection_updated',
  SAP_CONNECTION_TESTED: 'sap.connection_tested',
  SAP_CONNECTION_PROMOTED: 'sap.connection_promoted',

  // Purchase orders (tenant plane). Only one action, because only one thing a
  // user does to a purchase order originates a document in SAP rather than
  // recording something SAP already decided (ADR-0042). The asset number it
  // carries in `meta` is operator-entered and unverifiable by this application,
  // so this entry is the only record of who chose it.
  PO_ASSET_CREATE: 'po.asset_created',

  // Invoicing plan changes a supplier proposes on their own PO line — mirrors
  // vendor.bank_change_* above: a supplier's request never reaches SAP on its
  // own, so the audit trail needs to say who proposed what as clearly as it
  // says who decided it.
  PO_INVOICE_PLAN_CHANGE_REQUESTED: 'po.invoice_plan_change_requested',
  PO_INVOICE_PLAN_CHANGE_APPROVED: 'po.invoice_plan_change_approved',
  PO_INVOICE_PLAN_CHANGE_REJECTED: 'po.invoice_plan_change_rejected',

  // SAP job runtime (Phase 1 of docs/04-sap-runtime-engineering-plan.md)
  JOB_RETRIED: 'job.retried',
};

const ALL_AUDIT_ACTIONS = Object.values(AUDIT_ACTIONS);

// Subjects, derived rather than declared — the explorer's category filter reads
// this, so adding an action to the map above is the whole change.
const AUDIT_SUBJECTS = [...new Set(ALL_AUDIT_ACTIONS.map((action) => action.split('.')[0]))];

const isAuditAction = (action) => ALL_AUDIT_ACTIONS.includes(action);

module.exports = { AUDIT_ACTIONS, ALL_AUDIT_ACTIONS, AUDIT_SUBJECTS, isAuditAction };
