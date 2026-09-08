const { prisma } = require('../db/prisma');
const { hashPassword, issueResetToken } = require('../db/credentials');
const { isClientOperational } = require('../db/clientHelpers');
const { getTenantId } = require('../utils/tenantContext');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { verifyGstinPan } = require('../services/verification.service');
const { runWithTenant } = require('../utils/tenantContext');
const { resolveClientForRequest } = require('../utils/resolveClient');
const { getSapAdapterForClient } = require('../sap');

const { requireVendorScope } = require('../utils/requestScope');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { settingValue } = require('../config/tenantSettings');
const { toNumber } = require('../utils/money');
const { settingsFromClient } = require('../sap/mappings/vendor-create.map');
const { VENDOR_STATUS, VENDOR_STATUSES, VENDOR_AWAITING_DECISION } = require('../config/statuses');
const { generateVendorId, identityConflict, unguessablePassword } = require('../utils/vendorIdentity');

const IDENTITY_CONFLICT_MESSAGE = {
  vendorId: 'A supplier with this vendor ID already exists',
  email: 'A supplier or user account with this email already exists',
  gstin: 'A supplier with this GSTIN already exists',
};
const { assertCanCreate } = require('../utils/usage');
const { hasSupplierInvitation } = require('./invitation.controller');
const { sendMail } = require('../utils/mailer');
const { frontendUrl } = require('../config/emailTemplates');
const { RESET_TOKEN_TTL_MS } = require('../db/credentials');

// Fields nobody may set through a dynamic field-by-field update — identity,
// tenant scoping, and credential internals are all written through their own
// dedicated paths, never via "whatever keys were in the request body".
const PROTECTED_VENDOR_FIELDS = new Set([
  'pk', 'clientId', 'vendorId', 'createdAt', 'updatedAt',
  'resetPasswordToken', 'resetPasswordExpires', 'passwordChangedAt',
]);

// Helper to map flat or nested fields into flat Vendor model fields
const mapIncomingBody = (body) => {
  const mapped = { ...body };

  // If address is nested (legacy tests), flatten it
  if (body.address && typeof body.address === 'object') {
    mapped.address = body.address.street || body.address.address || '';
    mapped.city = body.address.city || '';
    mapped.state = body.address.state || '';
    mapped.postalCode = body.address.pincode || body.address.postalCode || '';
  }

  // If bankDetails is nested (legacy tests), flatten it
  if (body.bankDetails && typeof body.bankDetails === 'object') {
    mapped.bankName = body.bankDetails.bankName || '';
    mapped.accountNumber = body.bankDetails.accountNumber || '';
    mapped.ifscCode = body.bankDetails.ifscCode || '';
    mapped.accountName = body.bankDetails.accountName || body.bankDetails.accountHolderName || '';
    mapped.bankBranch = body.bankDetails.branch || body.bankDetails.bankBranch || '';
    // Mongoose silently dropped an unrecognized `bankDetails` key on write
    // (strict-mode schemas ignore undeclared paths); Prisma has no such
    // tolerance and rejects an unknown field outright, so the nested shape
    // has to be removed once it's been flattened into real columns.
    delete mapped.bankDetails;
  }

  return mapped;
};

// Helper to format a Vendor row to the backwards-compatible response shape
// with nested objects.
const formatVendorResponse = (vendor) => {
  if (!vendor) return null;
  const obj = { ...vendor };

  // Never expose the password hash.
  delete obj.password;

  obj.bankDetails = {
    bankName: obj.bankName || '',
    accountNumber: obj.accountNumber || '',
    ifscCode: obj.ifscCode || '',
    accountName: obj.accountName || '',
    accountHolderName: obj.accountName || '',
    branch: obj.bankBranch || '',
    accountType: 'Current'
  };

  return obj;
};

// Runs the GSTIN/PAN check for a vendor and persists the result on the row.
// This is the only place gstinVerified/panVerified get set, so every
// approval path is guaranteed to go through the same check.
const runGstinPanVerification = async (vendor, sap) => {
  const result = await verifyGstinPan(vendor.gstin, vendor.pan);

  const updated = await prisma.vendor.update({
    where: { pk: vendor.pk },
    data: {
      gstinVerified: result.gstinValid,
      panVerified: result.panValid,
      verifiedAt: new Date(),
      verificationDetails: result,
    },
  });

  await sap.vendorVerifyKyc({ vendor: updated, result });

  return updated;
};

// Tells a supplier what was decided about them, if this workspace has said it
// wants that (config/tenantSettings.js). A mail failure must not undo a
// decision that has already been taken and logged to SAP, so it is caught here.
const notifyDecision = async (req, vendor, { approved, reason }) => {
  if (!settingValue(req.client, 'notifications.supplierDecisionEmail')) return;

  try {
    await sendMail({
      to: vendor.email,
      template: 'supplierDecision',
      data: {
        companyName: vendor.companyName,
        workspaceName: req.client.companyName,
        approved,
        reason,
        sapVendorCode: vendor.sapVendorCode,
        portalUrl: frontendUrl(),
      },
    });
  } catch (error) {
    logger.error(`[vendor] decision email to ${vendor.email} failed: ${error.message}`);
  }
};

// @desc    Master-data catalogues (region, payment terms, payment method) the
//          registration form's dropdowns are populated from — VENDOR_CR
//          rejects free text for these, so the form must offer only values
//          SAP actually knows.
// @route   GET /api/vendors/sap-reference-data
// @access  Private
const getSapReferenceData = asyncHandler(async (req, res) => {
  const sap = await getSapAdapterForClient(req.clientId);
  const [regions, paymentTerms, paymentMethods] = await Promise.all([
    sap.vendorRegionCatalogue(),
    sap.vendorPaymentTermsCatalogue(),
    sap.vendorPaymentMethodCatalogue(),
  ]);
  res.json({
    regions: regions.regions,
    paymentTerms: paymentTerms.paymentTerms,
    paymentMethods: paymentMethods.paymentMethods,
  });
});

// @desc    Get current vendor profile
// @route   GET /api/vendors/profile
// @access  Private
const getProfile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }
  res.json(formatVendorResponse(vendor));
});

// @desc    Create vendor profile (for dev onboarding / clerk sync)
// @route   POST /api/vendors/profile
// @access  Public
const createProfile = asyncHandler(async (req, res, next) => {
  const mappedBody = mapIncomingBody(req.body);
  const { vendorId, companyName, gstin, pan, email } = mappedBody;

  if (!vendorId || !companyName || !gstin || !pan || !email) {
    return next(ApiError.badRequest('Vendor ID, company name, GSTIN, PAN, and email are required'));
  }

  // This route is unauthenticated, so — like registration — it resolves the
  // workspace from the request rather than from a bound tenant context.
  const client = await resolveClientForRequest(req);
  if (!client) {
    return next(ApiError.badRequest('Unknown workspace'));
  }
  if (!isClientOperational(client)) {
    return next(ApiError.forbidden('This workspace is not accepting registrations'));
  }

  // Same rule as POST /api/auth/register: a workspace may admit suppliers by
  // invitation only, and an invited supplier is not self-service.
  if (!settingValue(client, 'features.supplierSelfRegistration')
    && !(await hasSupplierInvitation(client.clientId, email))) {
    return next(ApiError.forbidden('This workspace admits suppliers by invitation only'));
  }

  await assertCanCreate(client, 'vendors');

  // Login identities are global, so this collision check spans all tenants.
  const conflict = await identityConflict({ vendorId, email, gstin });
  if (conflict) {
    return next(ApiError.conflict(IDENTITY_CONFLICT_MESSAGE[conflict], { reason: conflict }));
  }

  // Determine starting status
  const defaultStatus = (vendorId && vendorId.startsWith('mock_vendor_'))
    ? VENDOR_STATUS.PENDING
    : VENDOR_STATUS.DRAFT;

  const { password, ...rest } = mappedBody;
  const passwordFields = password ? await hashPassword(password) : {};

  const vendor = await runWithTenant(client.clientId, () => prisma.vendor.create({
    data: {
      ...rest,
      ...passwordFields,
      status: mappedBody.status || defaultStatus,
    },
  }));

  res.status(201).json(formatVendorResponse(vendor));
});

// @desc    Create a supplier from the tenant's own directory
// @route   POST /api/vendors
// @access  vendor:create
//
// The tenant-side mirror of self-registration. It shares the field list, the
// validation schema and the flat/nested mapping with POST /vendors/profile —
// the only differences are whose word the record starts on and how the supplier
// gets in: the tenant never sets a password, so the account is created with one
// nobody knows and the supplier claims it through an emailed link (ADR-0026).
const createVendor = asyncHandler(async (req, res, next) => {
  const mappedBody = mapIncomingBody(req.body);
  const { companyName, gstin, pan, email } = mappedBody;

  const conflict = await identityConflict({ email, gstin });
  if (conflict) {
    return next(ApiError.conflict(IDENTITY_CONFLICT_MESSAGE[conflict], { reason: conflict }));
  }

  await assertCanCreate(req.client, 'vendors');

  const vendorId = await generateVendorId();
  const passwordFields = await hashPassword(unguessablePassword());
  const { rawToken, fields: resetFields } = issueResetToken();

  const vendor = await prisma.vendor.create({
    data: {
      ...mappedBody,
      vendorId,
      ...passwordFields,
      mustChangePassword: true,
      ...resetFields,
      // A record the tenant vouches for, but the supplier has not yet confirmed
      // or documented: it starts where a self-registered draft starts, and the
      // same submit-then-approve path applies from there.
      status: VENDOR_STATUS.DRAFT,
    },
  });

  await sendMail({
    to: vendor.email,
    template: 'supplierWelcome',
    data: {
      companyName,
      workspaceName: req.client.companyName,
      vendorId,
      setPasswordUrl: `${frontendUrl()}/reset-password?token=${rawToken}`,
      expiresInMinutes: RESET_TOKEN_TTL_MS / 60000,
    },
  });

  await recordAudit({
    action: AUDIT_ACTIONS.VENDOR_CREATED,
    req,
    target: { type: 'Vendor', id: vendorId, label: companyName },
    meta: { email, gstin, pan },
  });

  res.status(201).json({ success: true, vendor: formatVendorResponse(vendor) });
});

// @desc    Update current vendor profile
// @route   PUT /api/vendors/profile
// @access  Private
const updateProfile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }

  const mappedBody = mapIncomingBody(req.body);

  // Update all fields dynamically, same field-by-field behavior as before —
  // including that a `password` key in the body is honored (re-hashed, since
  // there is no pre-save hook to do it implicitly anymore).
  const data = {};
  for (const [key, value] of Object.entries(mappedBody)) {
    if (PROTECTED_VENDOR_FIELDS.has(key)) continue;
    data[key] = value;
  }
  if (data.password) {
    Object.assign(data, await hashPassword(data.password));
  }

  const updated = await prisma.vendor.update({ where: { pk: vendor.pk }, data });
  res.json(formatVendorResponse(updated));
});

// @desc    Submit registration for review
// @route   POST /api/vendors/profile/submit
// @access  Private
const submitRegistration = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }

  // The vendor master is not created in SAP until a client admin approves —
  // see approveVendor. Once approved, resubmitting would leave a stray VENDOR_CR
  // behind for a record SAP already holds, so that's what this guards against.
  if (vendor.sapVendorCode) {
    return next(ApiError.conflict(
      'This registration has already been approved and created in SAP.',
      { reason: 'already_approved' },
    ));
  }

  let updated = await prisma.vendor.update({
    where: { pk: vendor.pk },
    data: {
      status: vendor.status === 'Pending' ? 'Under Review' : 'Pending Approval',
      submittedAt: new Date(),
    },
  });

  const sap = await getSapAdapterForClient(req.clientId);

  // Verify GSTIN/PAN as part of submission — approval is blocked until this
  // passes. SAP itself is not told about this vendor yet: the vendor master
  // (VENDOR_CR) is only created once a client admin approves.
  updated = await runGstinPanVerification(updated, sap);

  res.json({
    message: 'Registration submitted and awaiting admin approval.',
    vendor: formatVendorResponse(updated)
  });
});

// @desc    Approve vendor (Admin)
// @route   PUT /api/vendors/:id/approve
// @access  Admin/Private
const approveVendor = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  let vendor = await prisma.vendor.findFirst({ where: { pk: id } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  const sap = await getSapAdapterForClient(req.clientId);

  if (!vendor.verifiedAt) {
    vendor = await runGstinPanVerification(vendor, sap);
  }

  if (!vendor.gstinVerified || !vendor.panVerified) {
    return next(ApiError.badRequest('Vendor cannot be approved: GSTIN/PAN verification failed or has not been completed'));
  }

  // The vendor master is created in SAP right here, on approval — not at
  // submission. VENDOR_CR is not idempotent, so a vendor that already holds a
  // code (e.g. a retried approval request) must not be sent to SAP again.
  let { sapVendorCode } = vendor;
  if (!sapVendorCode) {
    ({ sapVendorCode } = await sap.vendorCreate({ vendor, settings: settingsFromClient(req.client) }));
  }

  const updated = await prisma.vendor.update({
    where: { pk: vendor.pk },
    data: { status: VENDOR_STATUS.APPROVED, approvedAt: new Date(), sapVendorCode },
  });

  await notifyDecision(req, updated, { approved: true });

  await recordAudit({
    action: AUDIT_ACTIONS.VENDOR_APPROVED,
    req,
    target: { type: 'Vendor', id: updated.vendorId, label: updated.companyName },
    meta: { sapVendorCode },
  });

  res.json({ message: 'Vendor approved successfully', vendor: formatVendorResponse(updated) });
});

// @desc    Reject vendor (Admin)
// @route   PUT /api/vendors/:id/reject
// @access  Admin/Private
const rejectVendor = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason) {
    return next(ApiError.badRequest('Rejection reason is required'));
  }

  const vendor = await prisma.vendor.findFirst({ where: { pk: id } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  const updated = await prisma.vendor.update({
    where: { pk: vendor.pk },
    data: { status: VENDOR_STATUS.REJECTED, rejectionReason: reason },
  });

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.vendorReject({ vendor: updated, reason });

  await notifyDecision(req, updated, { approved: false, reason });

  await recordAudit({
    action: AUDIT_ACTIONS.VENDOR_REJECTED,
    req,
    target: { type: 'Vendor', id: updated.vendorId, label: updated.companyName },
    meta: { reason },
  });

  res.json({ message: 'Vendor rejected successfully', vendor: formatVendorResponse(updated) });
});

// @desc    List all vendors (Admin)
// @route   GET /api/vendors
// @access  Admin/Private
const listVendors = asyncHandler(async (req, res, next) => {
  const { status, search, page = 1, limit = 20 } = req.query;

  const where = {};
  if (status) {
    // The directory's filter offers the registry's statuses; anything else is
    // a malformed request rather than an empty page.
    if (!VENDOR_STATUSES.includes(status)) {
      return next(ApiError.badRequest(`status must be one of: ${VENDOR_STATUSES.join(', ')}`));
    }
    where.status = status;
  }
  if (search) {
    const term = String(search);
    where.OR = [
      { companyName: { contains: term, mode: 'insensitive' } },
      { vendorId: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
      { gstin: { contains: term, mode: 'insensitive' } },
    ];
  }

  const skip = (page - 1) * limit;
  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.vendor.count({ where }),
  ]);

  res.json({
    vendors: vendors.map(formatVendorResponse),
    // The directory's filter is offered by the registry rather than typed into
    // the screen, so a new status appears in the dropdown by existing.
    filters: { statuses: VENDOR_STATUSES, awaitingDecision: VENDOR_AWAITING_DECISION },
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// A Postgres uuid column throws a type error if compared against a
// non-uuid-shaped string, so `pk` can only go in a lookup's OR when `id`
// actually looks like one — mirrors the old `mongoose.isValidObjectId(id)`
// branch that picked `_id` vs `vendorId`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// @desc    One supplier in full — their profile, their compliance state, and
//          how much trading they have actually done with this workspace
// @route   GET /api/vendors/:id
// @access  Private (vendor:read — tenant staff, never another supplier)
//
// `:id` accepts either the row's own `pk` (what the directory list carries,
// the modern equivalent of the old Mongo `_id`) or the supplier's own
// `vendorId`. The activity aggregates below now run as real SQL against
// PurchaseOrder/Invoice/Payment/RFQ/GRN/ASN's relational tables (Phase 2 of
// the migration plan) — `$queryRaw` bypasses the tenant extension entirely,
// so `clientId` is filtered explicitly in every one of these queries.
const getVendorById = asyncHandler(async (req, res, next) => {
  const { id } = req.params;

  const vendor = await prisma.vendor.findFirst({
    where: UUID_RE.test(id) ? { OR: [{ pk: id }, { vendorId: id }] } : { vendorId: id },
  });
  if (!vendor) {
    return next(ApiError.notFound('Supplier not found'));
  }

  const { vendorId } = vendor;
  const clientId = getTenantId();

  // One round trip each, in parallel — a supplier with a long history should
  // not make this page noticeably slower than one with none.
  const [
    poStatusCounts,
    invoiceStatusCounts,
    paymentTotals,
    rfqInvitations,
    grnCount,
    asnCount,
    recentOrders,
  ] = await Promise.all([
    prisma.$queryRaw`
      SELECT po.status AS status, COUNT(DISTINCT po.pk)::int AS count,
             COALESCE(SUM(poi."netValue"), 0)::float AS value
      FROM purchase_orders po
      LEFT JOIN purchase_order_items poi ON poi."poPk" = po.pk
      WHERE po."vendorId" = ${vendorId} AND po."clientId" = ${clientId}
      GROUP BY po.status
    `,
    prisma.$queryRaw`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS value
      FROM invoices
      WHERE "vendorId" = ${vendorId} AND "clientId" = ${clientId}
      GROUP BY status
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count, COALESCE(SUM("grossAmount"), 0)::float AS gross,
             COALESCE(SUM("netAmount"), 0)::float AS net, COALESCE(SUM("tdsDeducted"), 0)::float AS tds
      FROM payments
      WHERE "vendorId" = ${vendorId} AND "clientId" = ${clientId}
    `,
    prisma.rfqInvitedVendor.count({ where: { vendorExtId: vendorId } }),
    prisma.gRN.count({ where: { vendorId } }),
    prisma.aSN.count({ where: { vendorId } }),
    // Enough recent orders to show the shape of the relationship without
    // turning this into the purchase order list.
    prisma.purchaseOrder.findMany({ where: { vendorId }, include: { items: true }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);

  const totalOf = (rows, field) => rows.reduce((sum, row) => sum + (row[field] || 0), 0);
  const byStatus = (rows) => Object.fromEntries(rows.map((row) => [row.status, { count: row.count, value: row.value || 0 }]));

  res.json({
    vendor: formatVendorResponse(vendor),
    // Whether this supplier is a decision waiting to happen is the registry's
    // answer, the same as it is for the directory list — a screen that retyped
    // the list would silently stop offering the buttons the day a status is
    // added.
    awaitingDecision: VENDOR_AWAITING_DECISION.includes(vendor.status),
    activity: {
      purchaseOrders: {
        total: totalOf(poStatusCounts, 'count'),
        value: totalOf(poStatusCounts, 'value'),
        byStatus: byStatus(poStatusCounts),
      },
      invoices: {
        total: totalOf(invoiceStatusCounts, 'count'),
        value: totalOf(invoiceStatusCounts, 'value'),
        byStatus: byStatus(invoiceStatusCounts),
      },
      payments: {
        total: paymentTotals[0]?.count || 0,
        grossPaid: paymentTotals[0]?.gross || 0,
        netPaid: paymentTotals[0]?.net || 0,
        tdsDeducted: paymentTotals[0]?.tds || 0,
      },
      rfqInvitations,
      goodsReceipts: grnCount,
      shipments: asnCount,
    },
    recentOrders: recentOrders.map((po) => ({
      id: po.id,
      sapPoNumber: po.sapPoNumber || null,
      status: po.status,
      createdDate: po.createdDate,
      currency: po.currency,
      // netValue is a Decimal-typed column, and `po` here is a raw (unformatted)
      // Prisma read — see utils/money.js for why `sum + item.netValue` would
      // otherwise silently concatenate strings instead of summing.
      value: (po.items || []).reduce((sum, item) => sum + (toNumber(item.netValue) || 0), 0),
      lines: (po.items || []).length,
    })),
  });
});

// @desc    Get vendor performance score
// @route   GET /api/vendors/performance
// @access  Private
//
// Same raw-SQL-with-explicit-clientId approach as getVendorById above, for
// the same reason: these three joins/aggregations have no single-table
// Prisma query-builder equivalent.
const getPerformance = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }
  const clientId = getTenantId();

  // 1. Calculate Quality Acceptance from GRNs
  const [grnStats] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(gi."receivedQuantity"), 0)::float AS "totalReceived",
           COALESCE(SUM(gi."acceptedQuantity"), 0)::float AS "totalAccepted"
    FROM grn_items gi
    JOIN grns g ON g.pk = gi."grnPk"
    WHERE g."vendorId" = ${vendorId} AND g."clientId" = ${clientId}
  `;

  let qualityAcceptance = 100;
  if (grnStats && grnStats.totalReceived > 0) {
    qualityAcceptance = (grnStats.totalAccepted / grnStats.totalReceived) * 100;
  }

  // 2. Delivery OTIF (On-Time In-Full), measured per receipted shipment.
  //
  // "On time" is when the goods were actually received against when the
  // supplier promised them: the GRN's posting date versus the ASN's estimated
  // delivery date, compared by day, since a shipment received on its promised
  // date is on time whatever o'clock the receipt was posted. This used to
  // compare the ASN's ETA against the PO's *creation* date, which an ETA is
  // always later than — so every supplier scored 0% OTIF and no realistic data
  // could ever score anything else.
  //
  // "In full" is received against shipped. Quantity rejected on inspection is
  // deliberately not counted here: that is what qualityAcceptance above
  // measures, and charging it to both metrics would penalise it twice.
  //
  // A shipment still in transit has no receipt to judge, so it is outside the
  // denominator rather than counted as late.
  const [asnStats] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "receiptedAsns",
           SUM(CASE WHEN date_trunc('day', d."postingDate") <= date_trunc('day', d."estimatedDeliveryDate")
                     AND d.received >= d.shipped
                    THEN 1 ELSE 0 END)::int AS "otifAsns"
    FROM (
      SELECT a."estimatedDeliveryDate",
             g."postingDate",
             COALESCE((SELECT SUM(ai."shippedQuantity") FROM asn_items ai WHERE ai."asnPk" = a.pk), 0) AS shipped,
             COALESCE((SELECT SUM(gi."receivedQuantity") FROM grn_items gi WHERE gi."grnPk" = g.pk), 0) AS received
      FROM asns a
      JOIN grns g ON g."clientId" = a."clientId" AND g."asnId" = a.id
      WHERE a."vendorId" = ${vendorId} AND a."clientId" = ${clientId}
    ) d
  `;

  let deliveryOTIF = 100;
  if (asnStats && asnStats.receiptedAsns > 0) {
    deliveryOTIF = (asnStats.otifAsns / asnStats.receiptedAsns) * 100;
  }

  // 3. Invoice Accuracy
  const [invoiceStats] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "totalInvoices",
           SUM(CASE WHEN "matchWarning" IS NOT NULL THEN 1 ELSE 0 END)::int AS "warningInvoices"
    FROM invoices
    WHERE "vendorId" = ${vendorId} AND "clientId" = ${clientId}
  `;

  let invoiceAccuracy = 100;
  if (invoiceStats && invoiceStats.totalInvoices > 0) {
    invoiceAccuracy = ((invoiceStats.totalInvoices - invoiceStats.warningInvoices) / invoiceStats.totalInvoices) * 100;
  }

  // 4. Calculate Grade based on weighted score
  const weightedScore = (qualityAcceptance * 0.4) + (deliveryOTIF * 0.4) + (invoiceAccuracy * 0.2);

  let grade = 'A';
  if (weightedScore < 70) grade = 'D';
  else if (weightedScore < 85) grade = 'C';
  else if (weightedScore < 95) grade = 'B';

  res.json({
    vendorId,
    companyName: vendor.companyName,
    sapVendorCode: vendor.sapVendorCode,
    qualityAcceptance: Math.round(qualityAcceptance * 100) / 100,
    deliveryOTIF: Math.round(deliveryOTIF * 100) / 100,
    invoiceAccuracy: Math.round(invoiceAccuracy * 100) / 100,
    weightedScore: Math.round(weightedScore * 100) / 100,
    grade
  });
});

module.exports = {
  getProfile,
  createProfile,
  createVendor,
  updateProfile,
  submitRegistration,
  approveVendor,
  rejectVendor,
  listVendors,
  getVendorById,
  getPerformance,
  getSapReferenceData
};
