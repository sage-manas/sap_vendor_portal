const Vendor = require('../models/Vendor');
const GRN = require('../models/GRN');
const ASN = require('../models/ASN');
const Invoice = require('../models/Invoice');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyGstinPan } = require('../services/verification.service');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { resolveClientForRequest } = require('../utils/resolveClient');

const { requireVendorScope } = require('../utils/requestScope');

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
  }

  return mapped;
};

// Helper to format flat vendor db document to backwards-compatible format with nested objects
const formatVendorResponse = (vendor) => {
  if (!vendor) return null;
  const obj = vendor.toObject ? vendor.toObject({ virtuals: true }) : { ...vendor };

  // Never expose the password hash (select:false does not strip it on create/+password queries)
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

// Runs the GSTIN/PAN check for a vendor and persists the result on the
// document. This is the only place gstinVerified/panVerified get set, so
// every approval path is guaranteed to go through the same check.
const runGstinPanVerification = async (vendor) => {
  const result = await verifyGstinPan(vendor.gstin, vendor.pan);

  vendor.gstinVerified = result.gstinValid;
  vendor.panVerified = result.panValid;
  vendor.verifiedAt = new Date();
  vendor.verificationDetails = result;
  await vendor.save();

  const { createSapLog } = require('../utils/sapLogger');
  await createSapLog({
    vendorId: vendor.vendorId,
    type: 'KYC',
    direction: 'OUTBOUND',
    name: 'GSTIN_PAN_VERIFY',
    payload: { gstin: vendor.gstin, pan: vendor.pan, result },
    status: (result.gstinValid && result.panValid) ? 'SUCCESS' : 'FAILED',
    documentRef: vendor._id.toString()
  });

  return vendor;
};

// @desc    Get current vendor profile
// @route   GET /api/vendors/profile
// @access  Private
const getProfile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await Vendor.findOne({ vendorId });
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
  if (!client.isOperational()) {
    return next(ApiError.forbidden('This workspace is not accepting registrations'));
  }

  // Login identities are global, so this collision check spans all tenants.
  const existingVendor = await withoutTenantScope(
    () => Vendor.findOne({ $or: [{ vendorId }, { email }, { gstin }] })
  );
  if (existingVendor) {
    return next(ApiError.conflict('Vendor with this ID, email, or GSTIN already exists'));
  }

  // Determine starting status
  const defaultStatus = (vendorId && vendorId.startsWith('mock_vendor_')) ? 'Pending' : 'Draft';

  const vendor = await runWithTenant(client.clientId, () => Vendor.create({
    ...mappedBody,
    status: mappedBody.status || defaultStatus
  }));

  res.status(201).json(formatVendorResponse(vendor));
});

// @desc    Update current vendor profile
// @route   PUT /api/vendors/profile
// @access  Private
const updateProfile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await Vendor.findOne({ vendorId });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }

  const mappedBody = mapIncomingBody(req.body);
  
  // Update all fields dynamically
  Object.keys(mappedBody).forEach(key => {
    if (key !== 'vendorId' && key !== '_id') {
      vendor[key] = mappedBody[key];
    }
  });

  await vendor.save();
  res.json(formatVendorResponse(vendor));
});

// @desc    Submit registration for review
// @route   POST /api/vendors/profile/submit
// @access  Private
const submitRegistration = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await Vendor.findOne({ vendorId });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }

  vendor.status = vendor.status === 'Pending' ? 'Under Review' : 'Pending Approval';
  vendor.submittedAt = new Date();
  await vendor.save();

  // Create outbound pending log for BAPI_VENDOR_CREATE
  const { createSapLog } = require('../utils/sapLogger');
  const sapLog = await createSapLog({
    vendorId,
    type: 'BAPI',
    direction: 'OUTBOUND',
    name: 'BAPI_VENDOR_CREATE',
    payload: {
      vendorId,
      companyName: vendor.companyName,
      gstin: vendor.gstin,
      pan: vendor.pan,
      email: vendor.email
    },
    status: 'PENDING',
    documentRef: vendor._id.toString()
  });

  // Verify GSTIN/PAN as part of submission — approval is blocked until this passes
  await runGstinPanVerification(vendor);

  // Simulate SAP auto-approval in 5 seconds. The timer fires outside the
  // request, so the tenant context has to be re-bound explicitly.
  setTimeout(() => runWithTenant(req.clientId, async () => {
    try {
      const updatedVendor = await Vendor.findOne({ vendorId });
      if (updatedVendor && updatedVendor.gstinVerified && updatedVendor.panVerified &&
          (updatedVendor.status === 'Under Review' || updatedVendor.status === 'Pending Approval')) {
        updatedVendor.status = 'Approved';
        updatedVendor.approvedAt = new Date();
        updatedVendor.sapVendorCode = 'VND-' + Math.floor(10000 + Math.random() * 90000);
        await updatedVendor.save();

        // Update the outbound request status
        sapLog.status = 'SUCCESS';
        await sapLog.save();

        // Create inbound success log for OData confirmation
        await createSapLog({
          vendorId,
          type: 'OData',
          direction: 'INBOUND',
          name: 'OData_VENDOR_CONFIRM',
          payload: {
            sapVendorCode: updatedVendor.sapVendorCode,
            status: 'Approved'
          },
          status: 'SUCCESS',
          documentRef: updatedVendor._id.toString()
        });
        console.log(`[SIMULATOR] Auto-approved vendor: ${vendorId} (${updatedVendor.sapVendorCode})`);
      }
    } catch (err) {
      console.error('[SIMULATOR] Failed to auto-approve vendor:', err);
    }
  }), 5000);

  res.json({
    message: 'Registration submitted. Awaiting approval (simulated auto-approval in 5 seconds).',
    vendor: formatVendorResponse(vendor)
  });
});

// @desc    Approve vendor (Admin)
// @route   PUT /api/vendors/:id/approve
// @access  Admin/Private
const approveVendor = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const vendor = await Vendor.findById(id);
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  if (!vendor.verifiedAt) {
    await runGstinPanVerification(vendor);
  }

  if (!vendor.gstinVerified || !vendor.panVerified) {
    return next(ApiError.badRequest('Vendor cannot be approved: GSTIN/PAN verification failed or has not been completed'));
  }

  vendor.status = 'Approved';
  vendor.approvedAt = new Date();
  if (!vendor.sapVendorCode) {
    vendor.sapVendorCode = 'VND-' + Math.floor(10000 + Math.random() * 90000);
  }
  await vendor.save();

  const { createSapLog } = require('../utils/sapLogger');
  await createSapLog({
    vendorId: vendor.vendorId,
    type: 'OData',
    direction: 'INBOUND',
    name: 'OData_VENDOR_CONFIRM',
    payload: {
      sapVendorCode: vendor.sapVendorCode,
      status: 'Approved'
    },
    status: 'SUCCESS',
    documentRef: vendor._id.toString()
  });

  res.json({ message: 'Vendor approved successfully', vendor: formatVendorResponse(vendor) });
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

  const vendor = await Vendor.findById(id);
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  vendor.status = 'Rejected';
  vendor.rejectionReason = reason;
  await vendor.save();

  const { createSapLog } = require('../utils/sapLogger');
  await createSapLog({
    vendorId: vendor.vendorId,
    type: 'OData',
    direction: 'INBOUND',
    name: 'OData_VENDOR_REJECT',
    payload: {
      status: 'Rejected',
      reason
    },
    status: 'SUCCESS',
    documentRef: vendor._id.toString()
  });

  res.json({ message: 'Vendor rejected successfully', vendor: formatVendorResponse(vendor) });
});

// @desc    List all vendors (Admin)
// @route   GET /api/vendors
// @access  Admin/Private
const listVendors = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;
  const query = status ? { status } : {};

  const skip = (page - 1) * limit;
  const vendors = await Vendor.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await Vendor.countDocuments(query);

  res.json({
    vendors: vendors.map(formatVendorResponse),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get vendor performance score
// @route   GET /api/vendors/performance
// @access  Private
const getPerformance = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await Vendor.findOne({ vendorId });
  if (!vendor) {
    return next(ApiError.notFound('Vendor profile not found'));
  }

  // 1. Calculate Quality Acceptance from GRNs
  const grnStats = await GRN.aggregate([
    { $match: { vendorId } },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        totalReceived: { $sum: '$items.receivedQuantity' },
        totalAccepted: { $sum: '$items.acceptedQuantity' }
      }
    }
  ]);

  let qualityAcceptance = 100;
  if (grnStats.length > 0 && grnStats[0].totalReceived > 0) {
    qualityAcceptance = (grnStats[0].totalAccepted / grnStats[0].totalReceived) * 100;
  }

  // 2. Calculate Delivery OTIF (On-Time In-Full) from ASNs vs POs
  const asnStats = await ASN.aggregate([
    { $match: { vendorId } },
    {
      $lookup: {
        from: 'purchaseorders',
        localField: 'poId',
        foreignField: 'id',
        as: 'poDetails'
      }
    },
    { $unwind: { path: '$poDetails', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        onTime: {
          $cond: {
            if: { 
              $and: [ 
                { $gt: [ '$poDetails', null ] }, 
                { $lte: [ '$estimatedDeliveryDate', '$poDetails.createdDate' ] } 
              ] 
            },
            then: 1,
            else: 0
          }
        }
      }
    },
    {
      $group: {
        _id: null,
        totalAsns: { $sum: 1 },
        onTimeAsns: { $sum: '$onTime' }
      }
    }
  ]);

  let deliveryOTIF = 100;
  if (asnStats.length > 0 && asnStats[0].totalAsns > 0) {
    deliveryOTIF = (asnStats[0].onTimeAsns / asnStats[0].totalAsns) * 100;
  }

  // 3. Invoice Accuracy
  const invoiceStats = await Invoice.aggregate([
    { $match: { vendorId } },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        warningInvoices: {
          $sum: {
            $cond: [{ $ifNull: ['$matchWarning', false] }, 1, 0]
          }
        }
      }
    }
  ]);

  let invoiceAccuracy = 100;
  if (invoiceStats.length > 0 && invoiceStats[0].totalInvoices > 0) {
    invoiceAccuracy = ((invoiceStats[0].totalInvoices - invoiceStats[0].warningInvoices) / invoiceStats[0].totalInvoices) * 100;
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
  updateProfile,
  submitRegistration,
  approveVendor,
  rejectVendor,
  listVendors,
  getPerformance
};
