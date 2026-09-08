/**
 * Seeds one demo tenant with a supplier whose portal has something in every tab.
 *
 *   node scripts/seed-demo.js            # create (refuses if the demo vendor exists)
 *   node scripts/seed-demo.js --reset    # wipe the demo tenant's data and re-seed
 *
 * The point of this data is fidelity, not volume: every row is shaped the way
 * the running code would have shaped it. Document numbers use the same
 * generators the controllers use (INV-######, ASN-######, GRN-1800#####), SAP
 * numbers use the exact formulas sap/drivers/mock.driver.js answers with
 * (mockSapPoNumber, mockMiroDoc, MIGO-18#########, PAY-53########), GRN
 * quantities follow the mock warehouse's 95% acceptance rate, TDS is the
 * driver's 1% section 194C, and the SAP log rows name transactions from
 * config/sapTransactions.js rather than inventing codes. Where the portal never
 * writes a field today (Invoice.sapMiroDoc before clearing, ASN.sapInboundDelivery)
 * it is left unwritten here too.
 *
 * Uses rawPrisma and stamps clientId explicitly — same approach as
 * scripts/seed-platform-admin.js, since a script runs outside a request and so
 * outside any tenant context.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma: prisma } = require('../db/prisma');
const { hashPassword, issueResetToken } = require('../db/credentials');
const { newInviteToken } = require('../db/invitationHelpers');
const { unguessablePassword } = require('../utils/vendorIdentity');
const { ROLES } = require('../config/roles');
const { VENDOR_STATUS } = require('../config/statuses');
const { transaction } = require('../config/sapTransactions');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { fiscalPeriodOf } = require('../utils/fiscalPeriod');

const log = (...args) => console.log('[seed-demo]', ...args);
const flag = (name) => process.argv.includes(`--${name}`);

const clientId = 'CLT-0001';
const CLIENT_SLUG = 'legacy';           // matches DEFAULT_CLIENT_SLUG's fallback
const VENDOR_ID = 'VND-77104';
const VENDOR_EMAIL = 'supplier@meridiancastings.in';
const VENDOR_PASSWORD = 'Demo@12345';
const ADMIN_EMAIL = 'admin@nucleusmfg.in';
const ADMIN_PASSWORD = 'Demo@12345';

// Tenant staff beyond the admin — a buyer and a finance seat, so the same
// workspace back office can be demoed as every role sees it (workspaceNav.js
// filters on exactly these permission sets).
const BUYER_EMAIL = 'buyer@nucleusmfg.in';
const BUYER_PASSWORD = 'Demo@12345';
const FINANCE_EMAIL = 'finance@nucleusmfg.in';
const FINANCE_PASSWORD = 'Demo@12345';

// A second supplier still in the approval queue, and a third the admin
// created but who has not yet claimed the account — the two states the
// Suppliers tab and workspace Overview's "awaiting decision" count need
// besides "Approved" to mean anything.
const VENDOR2_ID = 'VND-83217';
const VENDOR2_EMAIL = 'contact@bharatprecision.in';
const VENDOR2_PASSWORD = 'Demo@12345';
const VENDOR3_ID = 'VND-90556';
const VENDOR3_EMAIL = 'onboarding@shreeindustrial.in';

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const money = (n) => Math.round(n * 100) / 100;

// The mock SAP's own number formats — see sap/drivers/mock.driver.js.
const sapPoNumber = (poId) => `45${String(poId).replace(/\D/g, '').padStart(8, '0').slice(-8)}`;
const sapMiroDoc = (invoiceId, invoiceDate) =>
  `51${String(invoiceId).replace(/\D/g, '').padStart(6, '0').slice(-6)}${String(new Date(invoiceDate).getFullYear()).slice(-2)}`;

// The mock warehouse accepts 95% and rejects the rest with an inspection reason.
const ACCEPTANCE = 0.95;
const TDS_RATE = 0.01;
const REJECTION_REASON = 'Surface inspection defect / Dimensional variance';
const GST = 0.18;

// The mock catalogue, so the demo talks about the same materials SAP does.
const MAT = {
  pipe:   { materialCode: 'MAT-3849', description: 'Steel Pipe 3" SCH40' },
  flange: { materialCode: 'MAT-9210', description: 'Flange 3" ANSI 150#' },
  bolt:   { materialCode: 'MAT-5531', description: 'Hex Bolt M12x50 Grade 8.8' },
  gasket: { materialCode: 'MAT-1029', description: 'Gasket 3" Non-Asbestos' },
};

// ---------------------------------------------------------------------------

const wipe = async () => {
  // Parents last; cascades take the line-item tables (and, via PurchaseOrder →
  // PurchaseOrderItem → InvoicePlan → InvoicePlanLine, any invoicing plan) with
  // them.
  const order = [
    'sapLog', 'chatMessage', 'document', 'payment', 'invoice', 'gRN', 'aSN',
    'purchaseOrder', 'rFQ', 'invitation', 'vendor', 'user',
  ];
  for (const model of order) {
    const { count } = await prisma[model].deleteMany({ where: { clientId } });
    if (count) log(`  removed ${count} ${model}`);
  }
  await prisma.auditLog.deleteMany({ where: { clientId } });
};

// The one way anything below lands in the audit trail — same fields
// utils/audit.js's recordAudit would stamp for a request, but recordAudit
// itself reads the tenant out of AsyncLocalStorage (getTenantId()), which
// nothing binds outside a request. Writing the row directly, with clientId
// passed explicitly, is the same approach this script already takes for
// SapLog rather than routing through utils/sapLogger.js.
const writeAudit = ({ action, actor, target, meta = {}, at }) =>
  prisma.auditLog.create({
    data: {
      clientId,
      actorId: actor.pk,
      actorRole: actor.role,
      actorEmail: actor.email,
      plane: 'tenant',
      action,
      target,
      meta,
      at,
    },
  });

// Finance turned the review threshold down from the ₹5,00,000 default — see
// config/tenantSettings.js — to ₹30,000, so the one Match Warning invoice
// (₹39,010.80) is what the workspace Overview's "needs a human look" count is
// demonstrating, without needing an invoice whose size alone would be the story.
const REVIEW_AMOUNT = 30000;

const seedClient = async () => {
  const data = {
    companyName: 'Nucleus Manufacturing Pvt Ltd',
    slug: CLIENT_SLUG,
    status: 'Active',
    plan: 'growth',
    sapEnvironment: 'sandbox',
    settings: { thresholds: { invoiceReviewAmount: REVIEW_AMOUNT } },
  };
  const existing = await prisma.client.findFirst({ where: { clientId } });
  // wipe() clears the tenant's business data but not the Client row itself —
  // the tenant this whole demo lives under is expected to survive a --reset —
  // so an existing row is updated rather than left stale on whatever an
  // earlier run of this script last wrote here.
  if (existing) return prisma.client.update({ where: { pk: existing.pk }, data });
  return prisma.client.create({ data: { clientId, ...data } });
};

const seedPeople = async () => {
  const vendor = await prisma.vendor.create({
    data: {
      clientId,
      vendorId: VENDOR_ID,
      role: ROLES.VENDOR,
      companyName: 'Meridian Castings Pvt Ltd',
      tradeName: 'Meridian Castings',
      businessType: 'Private Limited Company',
      incorporationDate: '2011-06-14',
      gstin: '27AACCM4519R1ZK',
      gstType: 'Regular',
      pan: 'AACCM4519R',
      cin: 'U27310MH2011PTC219884',
      msmeNumber: 'UDYAM-MH-19-0043287',
      tdsSection: '194C',
      email: VENDOR_EMAIL,
      phone: '+91 98204 41127',
      address: 'Plot D-14, MIDC Industrial Area, Andheri East',
      city: 'Mumbai',
      country: 'IN',
      region: '13',                       // Maharashtra, per the SAP region catalogue
      postalCode: '400093',
      // Codes, not free text — these are the values the registration form's
      // pickers read out of the SAP catalogues (vendorPaymentTermsCatalogue etc.).
      paymentTerms: 'NT30',
      paymentMethod: 'T',
      currency: 'INR',
      incoterms1: 'FOB',
      incoterms2: 'Mumbai',
      doubleInvoiceCheck: true,
      grBasedInvoiceVerification: true,
      bankName: 'HDFC Bank Ltd',
      accountNumber: '50200041178623',
      ifscCode: 'HDFC0000521',
      accountName: 'Meridian Castings Pvt Ltd',
      bankBranch: 'Andheri East, Mumbai',
      cancelledCheque: { documentId: 'DOC-CHQ-4471', originalName: 'cancelled-cheque.pdf', url: '/uploads/demo/cancelled-cheque.pdf' },
      panCardCopy:     { documentId: 'DOC-PAN-4472', originalName: 'pan-card.pdf', url: '/uploads/demo/pan-card.pdf' },
      gstCertificate:  { documentId: 'DOC-GST-4473', originalName: 'gst-certificate.pdf', url: '/uploads/demo/gst-certificate.pdf' },
      msmeCertificate: { documentId: 'DOC-MSM-4474', originalName: 'udyam-certificate.pdf', url: '/uploads/demo/udyam-certificate.pdf' },
      gstinVerified: true,
      panVerified: true,
      verifiedAt: day('2026-02-11'),
      verificationDetails: { gstinValid: true, panValid: true, source: 'GSTIN_PAN_VERIFY (mock)' },
      // Minted by the mock driver's vendorCreate on approval — VND-<5 digits>.
      sapVendorCode: 'VND-51204',
      status: VENDOR_STATUS.APPROVED,
      vendorCategory: 'Castings & Forgings',
      submittedAt: day('2026-02-10'),
      approvedAt: day('2026-02-12'),
      ...(await hashPassword(VENDOR_PASSWORD)),
    },
  });

  const admin = await prisma.user.create({
    data: {
      clientId,
      email: ADMIN_EMAIL,
      name: 'Priya Raghavan',
      role: ROLES.CLIENT_ADMIN,
      status: 'Active',
      jobTitle: 'Head of Procurement',
      activatedAt: day('2026-01-05'),
      ...(await hashPassword(ADMIN_PASSWORD)),
    },
  });

  // Retroactive — approveVendor's own audit call, for the approval this
  // vendor row already reflects (vendorCreate/status above).
  await writeAudit({
    action: AUDIT_ACTIONS.VENDOR_APPROVED,
    actor: { pk: admin.pk, role: admin.role, email: admin.email },
    target: { type: 'Vendor', id: vendor.vendorId, label: vendor.companyName },
    meta: { sapVendorCode: vendor.sapVendorCode },
    at: day('2026-02-12'),
  });

  return { vendor, admin };
};

// ---------------------------------------------------------------------------
// Tenant staff beyond the admin, and the seats still being filled — buyer and
// finance both arrive the way invitation.controller.js's acceptInvitation
// produces a User: an Invitation row flips to Accepted and carries its
// invitedBy/createdAt onto the new account's invitedBy/invitedAt.
// ---------------------------------------------------------------------------

const seedStaff = async (admin) => {
  const inviteAccepted = async ({ email, name, role, jobTitle, invitedAt, activatedAt, password }) => {
    const { tokenHash } = newInviteToken();
    const invitation = await prisma.invitation.create({
      data: {
        clientId, email, name, role, tokenHash,
        status: 'Accepted',
        expiresAt: new Date(invitedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        invitedBy: admin.email,
        createdAt: invitedAt,
        acceptedAt: activatedAt,
      },
    });

    await writeAudit({
      action: AUDIT_ACTIONS.USER_INVITED,
      actor: { pk: admin.pk, role: admin.role, email: admin.email },
      target: { type: 'Invitation', id: invitation.pk, label: invitation.email },
      meta: { role },
      at: invitedAt,
    });

    const user = await prisma.user.create({
      data: {
        clientId, email, name, role, status: 'Active', jobTitle,
        invitedBy: admin.email, invitedAt, activatedAt,
        ...(await hashPassword(password)),
      },
    });

    await prisma.invitation.update({ where: { pk: invitation.pk }, data: { acceptedAccountId: user.pk } });
    return user;
  };

  const buyer = await inviteAccepted({
    email: BUYER_EMAIL, name: 'Ritika Shah', role: ROLES.BUYER,
    jobTitle: 'Senior Buyer — Metals & Fabrication',
    invitedAt: day('2026-01-18'), activatedAt: day('2026-01-20'), password: BUYER_PASSWORD,
  });

  const finance = await inviteAccepted({
    email: FINANCE_EMAIL, name: 'Kabir Anand', role: ROLES.FINANCE,
    jobTitle: 'AP & Compliance Lead',
    invitedAt: day('2026-01-12'), activatedAt: day('2026-01-14'), password: FINANCE_PASSWORD,
  });

  // A seat invited but not yet claimed — the Users tab's pending-invitation
  // row, and the count workspace Overview's `staff.pendingInvitations` reads.
  const invitedAt = day('2026-09-02');
  const pending = await prisma.invitation.create({
    data: {
      clientId,
      email: 'ops.finance@nucleusmfg.in',
      name: 'Devansh Oberoi',
      role: ROLES.FINANCE,
      tokenHash: newInviteToken().tokenHash,
      status: 'Pending',
      expiresAt: new Date(invitedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      invitedBy: admin.email,
      createdAt: invitedAt,
    },
  });

  await writeAudit({
    action: AUDIT_ACTIONS.USER_INVITED,
    actor: { pk: admin.pk, role: admin.role, email: admin.email },
    target: { type: 'Invitation', id: pending.pk, label: pending.email },
    meta: { role: ROLES.FINANCE },
    at: invitedAt,
  });

  return { buyer, finance };
};

// ---------------------------------------------------------------------------
// Two more suppliers, in the two other states the directory and the approval
// queue need: one mid-onboarding (self-registered, KYC done, waiting on a
// decision), one the admin created directly and who has not claimed the
// account yet. Neither is invited to Meridian's RFQs or POs — they exist for
// the Suppliers tab and the Overview's approval-queue count, not for the
// lifecycle data itself.
// ---------------------------------------------------------------------------

const seedSecondaryVendors = async (admin) => {
  // Under Review: submitRegistration ran GSTIN/PAN verification and flipped
  // Pending → Under Review, exactly like Meridian did before it was approved
  // — it just has not been decided yet, so no sapVendorCode, no approvedAt.
  const vendor2 = await prisma.vendor.create({
    data: {
      clientId,
      vendorId: VENDOR2_ID,
      role: ROLES.VENDOR,
      companyName: 'Bharat Precision Engineering Works',
      tradeName: 'Bharat Precision',
      businessType: 'Partnership Firm',
      incorporationDate: '2016-03-22',
      gstin: '24AAECB7742F1Z8',
      gstType: 'Regular',
      pan: 'AAECB7742F',
      msmeNumber: 'UDYAM-GJ-06-0021184',
      tdsSection: '194C',
      email: VENDOR2_EMAIL,
      phone: '+91 79661 20044',
      address: 'Plot 212, GIDC Industrial Estate, Naroda',
      city: 'Ahmedabad',
      country: 'IN',
      region: '06',                       // Gujarat, per the SAP region catalogue
      postalCode: '382330',
      paymentTerms: 'NT30',
      paymentMethod: 'T',
      currency: 'INR',
      incoterms1: 'EXW',
      incoterms2: 'Ahmedabad',
      doubleInvoiceCheck: false,
      grBasedInvoiceVerification: true,
      bankName: 'ICICI Bank Ltd',
      accountNumber: '000405006789',
      ifscCode: 'ICIC0000045',
      accountName: 'Bharat Precision Engineering Works',
      bankBranch: 'Naroda, Ahmedabad',
      cancelledCheque: { documentId: 'DOC-CHQ-5581', originalName: 'cancelled-cheque.pdf', url: '/uploads/demo/cancelled-cheque-2.pdf' },
      panCardCopy:     { documentId: 'DOC-PAN-5582', originalName: 'pan-card.pdf', url: '/uploads/demo/pan-card-2.pdf' },
      gstCertificate:  { documentId: 'DOC-GST-5583', originalName: 'gst-certificate.pdf', url: '/uploads/demo/gst-certificate-2.pdf' },
      msmeCertificate: { documentId: 'DOC-MSM-5584', originalName: 'udyam-certificate.pdf', url: '/uploads/demo/udyam-certificate-2.pdf' },
      gstinVerified: true,
      panVerified: true,
      verifiedAt: day('2026-09-06'),
      verificationDetails: { gstinValid: true, panValid: true, source: 'GSTIN_PAN_VERIFY (mock)' },
      sapVendorCode: null,
      status: VENDOR_STATUS.UNDER_REVIEW,
      vendorCategory: 'Precision Machining',
      submittedAt: day('2026-09-06'),      // within the 48h SLA as of "today"
      approvedAt: null,
      ...(await hashPassword(VENDOR2_PASSWORD)),
    },
  });

  // Draft: created by the buying organisation itself (vendor.controller.js's
  // createVendor — POST /api/vendors), the same path as an admin onboarding a
  // supplier straight into the directory. The supplier has not claimed the
  // account (no login they know), so it carries an unguessable password and a
  // live password-reset token exactly as that endpoint leaves it — not the
  // real emailed token, since nothing here sends mail, but the same shape.
  const { fields: resetFields } = issueResetToken();
  const vendor3 = await prisma.vendor.create({
    data: {
      clientId,
      vendorId: VENDOR3_ID,
      role: ROLES.VENDOR,
      companyName: 'Shree Industrial Traders',
      businessType: 'Proprietorship',
      gstin: '07AABFS1122K1ZQ',
      pan: 'AABFS1122K',
      email: VENDOR3_EMAIL,
      phone: '+91 98111 22034',
      address: 'B-45, Wazirpur Industrial Area',
      city: 'Delhi',
      country: 'IN',
      region: '30',                       // Delhi, per the SAP region catalogue
      status: VENDOR_STATUS.DRAFT,
      mustChangePassword: true,
      createdAt: day('2026-09-05'),
      ...(await hashPassword(unguessablePassword())),
      ...resetFields,
    },
  });

  await writeAudit({
    action: AUDIT_ACTIONS.VENDOR_CREATED,
    actor: { pk: admin.pk, role: admin.role, email: admin.email },
    target: { type: 'Vendor', id: vendor3.vendorId, label: vendor3.companyName },
    meta: { email: vendor3.email, gstin: vendor3.gstin, pan: vendor3.pan },
    at: day('2026-09-05'),
  });

  return { vendor2, vendor3 };
};

// ---------------------------------------------------------------------------
// RFQs — one still open to bid on, one bid and awaiting evaluation, one awarded
// and converted into PO-2026-0001.
// ---------------------------------------------------------------------------

const seedRfqs = async (vendor) => {
  const invited = (status) => ({
    clientId, vendorExtId: VENDOR_ID, name: vendor.companyName, status, rating: 4.4,
  });
  const bid = (prices, extra = {}) => ({
    clientId,
    vendorId: VENDOR_ID,
    vendorPk: vendor.pk,
    vendorName: vendor.companyName,
    gstRate: '18',
    taxCode: 'G1',
    freight: 4500,
    deliveryLeadTimeDays: 21,
    vendorRating: 4.4,
    technicalScore: 86,
    moq: 50,
    unitPrices: { create: prices.map(([lineNumber, price]) => ({ clientId, lineNumber, price })) },
    ...extra,
  });

  await prisma.rFQ.create({
    data: {
      clientId,
      id: 'RFQ-2026-001',
      description: 'Structural piping and fittings — Q3 shutdown maintenance',
      status: 'Bidding Open',
      deadlineDate: day('2026-09-19'),
      rfqType: 'AN',
      paymentTerms: 'NET 30 Days',
      purchasingGroup: '101',
      deliveryLocation: 'Plant 1000 — Chakan Works',
      createdDate: day('2026-09-01'),
      items: {
        create: [
          { clientId, line: 10, ...MAT.pipe,   quantity: 400, uom: 'EA', targetPrice: 1420, deliveryDate: day('2026-10-15') },
          { clientId, line: 20, ...MAT.gasket, quantity: 250, uom: 'EA', targetPrice: 165,  deliveryDate: day('2026-10-15') },
        ],
      },
      invitedVendors: { create: [invited('Pending')] },
    },
  });

  await prisma.rFQ.create({
    data: {
      clientId,
      id: 'RFQ-2026-002',
      description: 'Fasteners — annual rate contract',
      status: 'Submitted',
      deadlineDate: day('2026-09-10'),
      rfqType: 'AN',
      paymentTerms: 'NET 45 Days',
      purchasingGroup: '101',
      deliveryLocation: 'Plant 1000 — Chakan Works',
      createdDate: day('2026-08-21'),
      items: {
        create: [{ clientId, line: 10, ...MAT.bolt, quantity: 5000, uom: 'EA', targetPrice: 40, deliveryDate: day('2026-10-01') }],
      },
      invitedVendors: { create: [invited('Submitted')] },
      bids: {
        create: [bid([[10, 41.5]], {
          remarks: 'Rate held for 12 months. Ex-works Mumbai.',
          validityDate: day('2026-12-31'),
          submittedAt: day('2026-08-27'),
        })],
      },
    },
  });

  await prisma.rFQ.create({
    data: {
      clientId,
      id: 'RFQ-2026-003',
      description: 'Pipe and flange package — Line 4 expansion',
      status: 'Awarded',
      deadlineDate: day('2026-06-12'),
      rfqType: 'AN',
      paymentTerms: 'NET 30 Days',
      purchasingGroup: '101',
      deliveryLocation: 'Plant 1000 — Chakan Works',
      createdDate: day('2026-06-01'),
      awardedVendorId: VENDOR_ID,
      awardedVendorName: vendor.companyName,
      awardedAt: day('2026-06-15'),
      convertedPoId: 'PO-2026-0001',
      items: {
        create: [
          { clientId, line: 10, ...MAT.pipe,   quantity: 120, uom: 'EA', targetPrice: 1500, deliveryDate: day('2026-07-10') },
          { clientId, line: 20, ...MAT.flange, quantity: 60,  uom: 'EA', targetPrice: 920,  deliveryDate: day('2026-07-10') },
        ],
      },
      invitedVendors: { create: [invited('Awarded')] },
      bids: {
        create: [bid([[10, 1450], [20, 890]], {
          remarks: 'Includes third-party inspection certificate.',
          validityDate: day('2026-08-31'),
          submittedAt: day('2026-06-09'),
        })],
      },
    },
  });

  // cancelRFQ only ever flips status → Closed, on whatever the RFQ already
  // was — here, before any bid came in, which is the buyer's most common
  // reason to cancel one.
  await prisma.rFQ.create({
    data: {
      clientId,
      id: 'RFQ-2026-004',
      description: 'Industrial insulation blankets — Boiler House retrofit',
      status: 'Closed',
      deadlineDate: day('2026-08-05'),
      rfqType: 'AN',
      paymentTerms: 'NET 30 Days',
      purchasingGroup: '101',
      deliveryLocation: 'Plant 1000 — Chakan Works',
      createdDate: day('2026-07-15'),
      items: {
        create: [{ clientId, line: 10, materialCode: 'MAT-7734', description: 'Ceramic Fibre Insulation Blanket 50mm', quantity: 80, uom: 'EA', targetPrice: 2100, deliveryDate: day('2026-08-20') }],
      },
      invitedVendors: { create: [invited('Pending')] },
    },
  });
};

// ---------------------------------------------------------------------------
// Purchase orders — one per status the lifecycle can be in.
// ---------------------------------------------------------------------------

const line = (lineNo, mat, quantity, unitPrice, grnQuantity = 0) =>
  ({ line: lineNo, ...mat, quantity, unitPrice, grnQuantity, uom: 'EA' });

const po = ({ id, status, createdDate, items, confirmedInSap = true, ...rest }) => ({
  clientId,
  id,
  // The portal never mints this; it is the number SAP's own ledger reports back
  // (vendorPoGrnDisplay). Left null on the order SAP has not confirmed yet.
  sapPoNumber: confirmedInSap ? sapPoNumber(id) : null,
  vendorId: VENDOR_ID,
  buyerName: 'SAP System Procurement',
  plant: '1000',
  paymentTerms: 'NET 30 Days',
  currency: 'INR',
  incoterms: 'FOB Mumbai',
  deliveryAddress: 'Plant 1000 — Chakan Works, Pune 410501',
  status,
  createdDate,
  items: { create: items.map((i) => ({ clientId, ...i, netValue: money(i.unitPrice * i.quantity) })) },
  ...rest,
});

const seedPos = async (vendor) => {
  const vendorPk = vendor.pk;
  const rows = [
    po({
      id: 'PO-2026-0001', status: 'Paid', createdDate: day('2026-06-15'), vendorPk, fromRfqId: 'RFQ-2026-003',
      acknowledgedAt: day('2026-06-16'),
      items: [line(10, MAT.pipe, 120, 1450, 114), line(20, MAT.flange, 60, 890, 57)],
    }),
    po({
      id: 'PO-2026-0002', status: 'Invoiced', createdDate: day('2026-07-20'), vendorPk,
      acknowledgedAt: day('2026-07-21'),
      items: [line(10, MAT.bolt, 800, 42, 760)],
    }),
    po({
      id: 'PO-2026-0003', status: 'Delivered', createdDate: day('2026-08-10'), vendorPk,
      acknowledgedAt: day('2026-08-11'),
      items: [line(10, MAT.gasket, 300, 168, 285)],
    }),
    po({
      id: 'PO-2026-0004', status: 'Dispatched', createdDate: day('2026-08-24'), vendorPk,
      acknowledgedAt: day('2026-08-25'),
      items: [line(10, MAT.pipe, 200, 1450)],
    }),
    po({
      id: 'PO-2026-0005', status: 'Acknowledged', createdDate: day('2026-08-31'), vendorPk,
      acknowledgedAt: day('2026-09-01'),
      items: [line(10, MAT.flange, 150, 890)],
    }),
    po({
      id: 'PO-2026-0006', status: 'Open', createdDate: day('2026-09-04'), vendorPk, confirmedInSap: false,
      items: [line(10, MAT.bolt, 1000, 42)],
    }),
  ];

  const created = {};
  for (const data of rows) {
    created[data.id] = await prisma.purchaseOrder.create({ data, include: { items: true } });
  }
  return created;
};

// ---------------------------------------------------------------------------
// One PO billed on an invoicing plan (FPLA/FPLT) rather than goods receipt —
// an annual maintenance contract, the model docstring's own example of a
// periodic plan. No ASN/GRN applies to it; buildPlan's own line numbering
// (services/invoicePlan.service.js) is 10/20/30/40, and Arrears settles each
// quarter on its last day.
//
// The three states a finance user actually acts on are all represented: the
// first date already billed and cleared, one still open and not yet due, and
// one finance has put a billing hold on ahead of its date (setInvoicePlanLineBlock
// only ever flips the `blocked` flag — `status` stays 'Open' until an invoice
// is actually raised against it, so a blocked-but-unbilled line is Open+blocked,
// not a distinct "Blocked" status, matching that endpoint exactly).
// ---------------------------------------------------------------------------

const seedInvoicingPlan = async (vendor) => {
  const poId = 'PO-2026-0007';
  const planNumber = `${String(poId).replace(/\D/g, '').padStart(6, '0').slice(-6)}0010`; // mockPlanNumber(po, item)

  const planInvoiceId = 'INV-604821';
  const planInvoiceDate = day('2026-07-02');
  const planMiro = sapMiroDoc(planInvoiceId, planInvoiceDate);
  const planClearedAt = day('2026-07-18');

  const po7 = await prisma.purchaseOrder.create({
    data: {
      clientId,
      id: poId,
      sapPoNumber: sapPoNumber(poId),
      vendorId: VENDOR_ID,
      vendorPk: vendor.pk,
      buyerName: 'SAP System Procurement',
      plant: '1000',
      paymentTerms: 'NET 30 Days',
      currency: 'INR',
      deliveryAddress: 'Plant 1000 — Chakan Works, Pune 410501',
      status: 'Acknowledged',
      createdDate: day('2026-04-01'),
      acknowledgedAt: day('2026-04-02'),
      items: {
        create: [{
          clientId, line: 10, materialCode: 'SRV-1188',
          description: 'Annual Maintenance Contract — CNC Line 4 installation',
          quantity: 1, grnQuantity: 0, unitPrice: 600000, netValue: 600000, uom: 'EA',
          invoicePlan: {
            create: {
              clientId,
              enabled: true,
              planNumber,
              type: 'Periodic',
              startDate: day('2026-04-01'),
              endDate: day('2027-04-01'),
              frequency: 'Quarterly',
              invoicingRule: 'Arrears',
              periodicAmount: 150000,
              currency: 'INR',
              reference: 'AMC-2026-004 — CNC Line 4 annual maintenance contract',
              source: 'portal',
              lines: {
                create: [
                  {
                    clientId, lineNumber: 10, description: 'Quarterly charge 2026-06-30',
                    settlementDate: day('2026-06-30'), billingDate: day('2026-06-30'),
                    percentage: 0, amount: 150000, status: 'Invoiced', blocked: false,
                    invoiceId: planInvoiceId, invoiceNumber: 'MC/2026-27/0102',
                    invoicedAt: planInvoiceDate, sapMiroDoc: planMiro,
                  },
                  {
                    clientId, lineNumber: 20, description: 'Quarterly charge 2026-09-30',
                    settlementDate: day('2026-09-30'), billingDate: day('2026-09-30'),
                    percentage: 0, amount: 150000, status: 'Open', blocked: false,
                  },
                  {
                    // Finance held this one ahead of its date pending a
                    // compliance re-check — the plan tab's "billing blocked" state.
                    clientId, lineNumber: 30, description: 'Quarterly charge 2026-12-31',
                    settlementDate: day('2026-12-31'), billingDate: day('2026-12-31'),
                    percentage: 0, amount: 150000, status: 'Open', blocked: true,
                  },
                  {
                    clientId, lineNumber: 40, description: 'Quarterly charge 2027-03-31',
                    settlementDate: day('2027-03-31'), billingDate: day('2027-03-31'),
                    percentage: 0, amount: 150000, status: 'Open', blocked: false,
                  },
                ],
              },
            },
          },
        }],
      },
    },
    include: { items: true },
  });

  // submitPlanInvoice's own shape: quantity 1, unitPrice/amount = the plan
  // line's amount, invoicePlanRef naming the line it bills, no grnId.
  const planInvoice = await prisma.invoice.create({
    data: {
      clientId, id: planInvoiceId, grnId: null, poId, vendorId: VENDOR_ID,
      invoiceNumber: 'MC/2026-27/0102', invoiceDate: planInvoiceDate,
      sapMiroDoc: planMiro, status: 'Cleared',
      subTotal: 150000, taxAmount: 27000, totalAmount: 177000,
      taxCode: 'G1', currency: 'INR', matchWarning: null,
      invoicePlanRef: { line: 10, planLineNumber: 10, planType: 'Periodic', settlementDate: '2026-06-30' },
      clearedAt: planClearedAt,
      items: {
        create: [{
          clientId, line: 10, materialCode: 'SRV-1188', description: 'Quarterly charge 2026-06-30',
          quantity: 1, unitPrice: 150000, amount: 150000,
        }],
      },
    },
  });

  const tds = money(177000 * TDS_RATE);
  const planPaymentId = 'PMT-410552';
  await prisma.payment.create({
    data: {
      clientId, id: planPaymentId, invoiceId: planInvoice.id, poId, vendorId: VENDOR_ID,
      invoiceRef: planInvoice.id, invoiceNumber: planInvoice.invoiceNumber, sapMiroDoc: planMiro,
      grossAmount: 177000, tdsDeducted: tds, netAmount: money(177000 - tds),
      paymentDate: planClearedAt, utrCode: 'UTR2026071800552104', paymentMethod: 'NEFT',
      sapPaymentDoc: 'PAY-5341021009', bankName: 'HDFC Bank Ltd', runId: 'F110-071826',
      ...fiscalPeriodOf(planClearedAt),
      tdsSection: '194C', deducteePan: vendor.pan, deductorTan: 'TAN-SAP1000', totalTds: tds,
    },
  });

  return { po: po7, planNumber, planInvoiceId, planMiro, planPaymentId, planClearedAt };
};

// ---------------------------------------------------------------------------
// Deliveries: ASN → GRN, at the mock warehouse's acceptance rate.
// ---------------------------------------------------------------------------

const seedDeliveries = async (pos) => {
  const shipments = [
    { poId: 'PO-2026-0001', asnId: 'ASN-418206', ship: '2026-06-28', eta: '2026-07-04', status: 'Received',
      carrier: 'VRL Logistics', tracking: 'VRL8841273366', vehicle: 'MH-04-GX-2291', eway: '381004417726',
      grn: { id: 'GRN-180043117', migo: 'MIGO-18400291746', posting: '2026-07-04', invoiceSubmitted: true } },
    { poId: 'PO-2026-0002', asnId: 'ASN-552914', ship: '2026-08-01', eta: '2026-08-06', status: 'Received',
      carrier: 'TCI Freight', tracking: 'TCI5590128841', vehicle: 'MH-12-KL-8830', eway: '381005528190',
      grn: { id: 'GRN-180051884', migo: 'MIGO-18400318052', posting: '2026-08-06', invoiceSubmitted: true } },
    { poId: 'PO-2026-0003', asnId: 'ASN-604771', ship: '2026-08-22', eta: '2026-08-27', status: 'Received',
      carrier: 'Safexpress', tracking: 'SFX7710028394', vehicle: 'MH-14-CD-4417', eway: '381006041182',
      // Received a day after the promised date — one late delivery, so the
      // performance tab shows an OTIF that is actually being measured.
      grn: { id: 'GRN-180058903', migo: 'MIGO-18400339215', posting: '2026-08-28', invoiceSubmitted: false } },
    // Still in the air: no goods receipt discovered in SAP yet.
    { poId: 'PO-2026-0004', asnId: 'ASN-671338', ship: '2026-09-03', eta: '2026-09-09', status: 'Submitted',
      carrier: 'VRL Logistics', tracking: 'VRL8841298104', vehicle: 'MH-04-GX-3078', eway: '381006713306',
      grn: null },
  ];

  const grns = {};
  for (const s of shipments) {
    const order = pos[s.poId];

    await prisma.aSN.create({
      data: {
        clientId, id: s.asnId, poId: s.poId, vendorId: VENDOR_ID, status: s.status,
        shipDate: day(s.ship), estimatedDeliveryDate: day(s.eta),
        carrierName: s.carrier, trackingNumber: s.tracking, vehicleNumber: s.vehicle,
        invoiceReference: null, ewayBillNo: s.eway,
        // The portal creates no inbound delivery in SAP — the receipt is
        // discovered on the purchase order number instead.
        sapInboundDelivery: null,
        submittedAt: day(s.ship),
        items: {
          create: order.items.map((item) => ({
            clientId, line: item.line, materialCode: item.materialCode,
            description: item.description, shippedQuantity: item.quantity, uom: item.uom,
          })),
        },
      },
    });

    if (!s.grn) continue;

    grns[s.poId] = await prisma.gRN.create({
      data: {
        clientId, id: s.grn.id, poId: s.poId, asnId: s.asnId, vendorId: VENDOR_ID,
        sapMigoDoc: s.grn.migo, postingDate: day(s.grn.posting), receivedBy: 'SAP Warehouse Staff',
        invoiceSubmitted: s.grn.invoiceSubmitted,
        items: {
          create: order.items.map((item) => {
            const received = item.quantity;
            const accepted = Math.round(received * ACCEPTANCE);
            const rejected = received - accepted;
            return {
              clientId, line: item.line, materialCode: item.materialCode, description: item.description,
              receivedQuantity: received, acceptedQuantity: accepted, rejectedQuantity: rejected,
              rejectionReason: rejected > 0 ? REJECTION_REASON : null, uom: item.uom,
            };
          }),
        },
      },
      include: { items: true },
    });
  }
  return grns;
};

// ---------------------------------------------------------------------------
// Invoices and the F110 payment run.
// ---------------------------------------------------------------------------

const invoiceItemsFrom = (order, grn, priceOverride = {}) =>
  grn.items.map((g) => {
    const poItem = order.items.find((i) => i.line === g.line);
    const unitPrice = priceOverride[g.line] ?? poItem.unitPrice;
    return {
      clientId, line: g.line, materialCode: g.materialCode, description: g.description,
      quantity: g.acceptedQuantity, unitPrice, amount: money(g.acceptedQuantity * unitPrice),
    };
  });

const seedInvoicesAndPayments = async (vendor, pos, grns) => {
  // 1. PO-2026-0001 — billed on the accepted quantity, posted by AP, cleared
  //    by F110. This is the only path that writes sapMiroDoc.
  const clearedItems = invoiceItemsFrom(pos['PO-2026-0001'], grns['PO-2026-0001']);
  const clearedSub = money(clearedItems.reduce((sum, i) => sum + i.amount, 0));
  const clearedTax = money(clearedSub * GST);
  const clearedTotal = money(clearedSub + clearedTax);
  const clearedId = 'INV-482913';
  const clearedDate = day('2026-07-08');
  const miro = sapMiroDoc(clearedId, clearedDate);

  const cleared = await prisma.invoice.create({
    data: {
      clientId, id: clearedId, grnId: grns['PO-2026-0001'].id, poId: 'PO-2026-0001', vendorId: VENDOR_ID,
      invoiceNumber: 'MC/2026-27/0117', invoiceDate: clearedDate,
      sapMiroDoc: miro, status: 'Cleared',
      subTotal: clearedSub, taxAmount: clearedTax, totalAmount: clearedTotal,
      taxCode: 'G1', currency: 'INR', matchWarning: null,
      clearedAt: day('2026-07-24'),
      items: { create: clearedItems },
    },
  });

  const paymentDate = day('2026-07-24');
  const tds = money(clearedTotal * TDS_RATE);
  await prisma.payment.create({
    data: {
      clientId, id: 'PMT-310884', invoiceId: cleared.id, poId: 'PO-2026-0001', vendorId: VENDOR_ID,
      invoiceRef: cleared.id, invoiceNumber: cleared.invoiceNumber, sapMiroDoc: miro,
      grossAmount: clearedTotal, tdsDeducted: tds, netAmount: money(clearedTotal - tds),
      paymentDate, utrCode: 'UTR2026072400418823', paymentMethod: 'NEFT',
      sapPaymentDoc: 'PAY-5341009827', bankName: 'HDFC Bank Ltd', runId: 'F110-072426',
      ...fiscalPeriodOf(paymentDate),
      tdsSection: '194C', deducteePan: vendor.pan, deductorTan: 'TAN-SAP1000', totalTds: tds,
    },
  });

  // 2. PO-2026-0002 — billed above the PO price, so the three-way match flags
  //    it. It sits at Match Warning with no MIRO document: AP has not posted it.
  const warnPrice = 43.5;
  const warnItems = invoiceItemsFrom(pos['PO-2026-0002'], grns['PO-2026-0002'], { 10: warnPrice });
  const warnSub = money(warnItems.reduce((sum, i) => sum + i.amount, 0));
  const warnTax = money(warnSub * GST);
  await prisma.invoice.create({
    data: {
      clientId, id: 'INV-517402', grnId: grns['PO-2026-0002'].id, poId: 'PO-2026-0002', vendorId: VENDOR_ID,
      invoiceNumber: 'MC/2026-27/0148', invoiceDate: day('2026-08-09'),
      sapMiroDoc: null, status: 'Match Warning',
      subTotal: warnSub, taxAmount: warnTax, totalAmount: money(warnSub + warnTax),
      taxCode: 'G1', currency: 'INR',
      matchWarning: `Line 10: Price variance detected (billed ${warnPrice} vs PO 42). `,
      items: { create: warnItems },
    },
  });

  // PO-2026-0003's GRN is deliberately left uninvoiced — that is the
  // dashboard's "awaiting invoice" count and the invoice tab's open action.
};

// ---------------------------------------------------------------------------
// Chat and the SAP communication log.
// ---------------------------------------------------------------------------

const seedChat = async () => {
  const messages = [
    ['Buyer',     'Welcome aboard — your vendor master is live in SAP as VND-51204.', '2026-02-12T09:12:00Z', {}],
    ['Vendor',    'Thank you. We have acknowledged PO-2026-0001 and will ship by 28 June.', '2026-06-16T11:40:00Z', { linkedPoId: 'PO-2026-0001' }],
    ['Warehouse', 'GRN-180043117 posted. 6 pipes and 3 flanges rejected on dimensional variance.', '2026-07-04T14:05:00Z', { linkedPoId: 'PO-2026-0001' }],
    ['Finance',   'Invoice MC/2026-27/0148 is on hold — billed rate 43.50 against a PO rate of 42.00.', '2026-08-11T10:22:00Z', { linkedPoId: 'PO-2026-0002' }],
    ['Buyer',     'RFQ-2026-001 closes on 19 September — please submit your quotation.', '2026-09-02T08:30:00Z', { linkedRfqId: 'RFQ-2026-001' }],
  ];
  for (const [sender, message, timestamp, links] of messages) {
    await prisma.chatMessage.create({
      data: {
        clientId, vendorId: VENDOR_ID, sender, message,
        timestamp: new Date(timestamp), isRead: sender === 'Vendor', ...links,
      },
    });
  }
};

const seedSapLogs = async (vendor, vendor2, plan) => {
  // Every row names a transaction from config/sapTransactions.js, so its code,
  // type and direction cannot disagree with the call it describes. vendorId
  // defaults to Meridian — the vendor most of this demo's traffic belongs to.
  const entries = [
    { key: 'VENDOR_KYC_VERIFY', at: '2026-02-11T06:40:00Z', documentRef: vendor.pk,
      payload: { gstin: vendor.gstin, pan: vendor.pan, result: { gstinValid: true, panValid: true } } },
    { key: 'VENDOR_CREATE', at: '2026-02-12T05:02:00Z', documentRef: vendor.pk,
      payload: { vendorId: VENDOR_ID, companyName: vendor.companyName, gstin: vendor.gstin, pan: vendor.pan, email: vendor.email, accountGroup: 'ZVEN' } },
    { key: 'VENDOR_CONFIRM', at: '2026-02-12T05:02:04Z', documentRef: vendor.pk,
      payload: { sapVendorCode: 'VND-51204', status: 'Approved' } },
    { key: 'QUOTATION_PRICE_UPDATE', at: '2026-06-09T09:15:00Z', documentRef: '6100238841',
      payload: { rfq_number: '6100238841', items: [{ line: 10, netPrice: 1450 }, { line: 20, netPrice: 890 }] } },
    { key: 'PO_ACKNOWLEDGE', at: '2026-06-16T11:41:00Z', documentRef: 'PO-2026-0001',
      payload: { poId: 'PO-2026-0001', acknowledgedAt: '2026-06-16T11:41:00Z' } },
    { key: 'GOODS_RECEIPT', at: '2026-07-04T14:04:00Z', documentRef: 'GRN-180043117',
      payload: { id: 'GRN-180043117', poId: 'PO-2026-0001', sapMigoDoc: 'MIGO-18400291746', receivedBy: 'SAP Warehouse Staff' } },
    { key: 'GOODS_RECEIPT_READ', at: '2026-07-04T14:04:02Z', documentRef: 'GRN-180043117',
      payload: { migoDoc: 'MIGO-18400291746', items: [{ line: 10, acceptedQuantity: 114, rejectedQuantity: 6 }, { line: 20, acceptedQuantity: 57, rejectedQuantity: 3 }] } },
    { key: 'PAYMENT_RUN', at: '2026-07-24T18:30:00Z', documentRef: 'PMT-310884',
      payload: { id: 'PMT-310884', invoiceId: 'INV-482913', runId: 'F110-072426', utrCode: 'UTR2026072400418823', sapPaymentDoc: 'PAY-5341009827' } },
    // The AMC's invoicing plan, pushed to SAP the day the buyer configured it
    // (controllers/po.controller.js's configureInvoicePlan calls
    // sap.poInvoicePlanUpdate before it ever persists locally).
    { key: 'PO_INVOICE_PLAN_UPDATE', at: '2026-04-01T10:05:00Z', documentRef: `${plan.po.id}/10`,
      payload: { poNumber: plan.po.sapPoNumber, item: '00010', planNumber: plan.planNumber, planType: 'Periodic', frequency: 'Quarterly', invoicingRule: 'Arrears', dates: 4 } },
    // The AMC's first quarterly instalment, cleared by F110.
    { key: 'PAYMENT_RUN', at: `${plan.planClearedAt.toISOString().slice(0, 10)}T18:30:00Z`, documentRef: plan.planPaymentId,
      payload: { id: plan.planPaymentId, invoiceId: plan.planInvoiceId, runId: 'F110-071826', utrCode: 'UTR2026071800552104', sapPaymentDoc: 'PAY-5341021009' } },
    { key: 'PO_ACKNOWLEDGE', at: '2026-09-01T07:20:00Z', documentRef: 'PO-2026-0005',
      payload: { poId: 'PO-2026-0005', acknowledgedAt: '2026-09-01T07:20:00Z' } },
    // The second supplier's onboarding KYC — submitRegistration runs this
    // before a client admin ever sees the Under Review record.
    { key: 'VENDOR_KYC_VERIFY', at: '2026-09-06T09:10:00Z', documentRef: vendor2.pk, vendorId: vendor2.vendorId,
      payload: { gstin: vendor2.gstin, pan: vendor2.pan, result: { gstinValid: true, panValid: true } } },
    { key: 'PING', at: '2026-09-07T04:00:00Z',
      payload: { system: 'MOCK', client: '1000', latencyMs: 1 } },
  ];

  for (const entry of entries) {
    const { code, type, direction } = transaction(entry.key);
    await prisma.sapLog.create({
      data: {
        clientId, vendorId: entry.vendorId || VENDOR_ID, type, direction, name: code,
        payload: JSON.stringify(entry.payload, null, 2),
        status: entry.status || 'SUCCESS', documentRef: String(entry.documentRef || ''), timestamp: new Date(entry.at),
      },
    });
  }
};

// ---------------------------------------------------------------------------

const run = async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('refusing to seed demo data into a production database');
    process.exit(1);
  }

  if (flag('reset')) {
    log(`resetting tenant ${clientId}`);
    await wipe();
  }

  const existing = await prisma.vendor.findFirst({ where: { email: VENDOR_EMAIL } });
  if (existing) {
    log(`demo vendor ${VENDOR_EMAIL} already exists — re-run with --reset to rebuild`);
    await prisma.$disconnect();
    return;
  }

  const client = await seedClient();
  log(`tenant ${client.clientId} "${client.companyName}" (slug: ${client.slug})`);

  const { vendor, admin } = await seedPeople();
  log(`vendor ${vendor.vendorId} "${vendor.companyName}" — ${vendor.status}, SAP ${vendor.sapVendorCode}`);
  log(`client admin ${admin.email}`);

  await writeAudit({
    action: AUDIT_ACTIONS.SETTINGS_UPDATED,
    actor: { pk: admin.pk, role: admin.role, email: admin.email },
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: { changed: ['thresholds.invoiceReviewAmount'], values: { 'thresholds.invoiceReviewAmount': REVIEW_AMOUNT } },
    at: day('2026-01-06'),
  });

  const { buyer, finance } = await seedStaff(admin);
  log(`buyer ${buyer.email}, finance ${finance.email}, 1 invitation still pending`);

  const { vendor2, vendor3 } = await seedSecondaryVendors(admin);
  log(`vendor ${vendor2.vendorId} "${vendor2.companyName}" — ${vendor2.status}`);
  log(`vendor ${vendor3.vendorId} "${vendor3.companyName}" — ${vendor3.status} (unclaimed)`);

  await seedRfqs(vendor);
  log('4 RFQs — Bidding Open / Submitted / Awarded / Closed');

  const pos = await seedPos(vendor);
  log('6 purchase orders — Open / Acknowledged / Dispatched / Delivered / Invoiced / Paid');

  const grns = await seedDeliveries(pos);
  log(`4 ASNs, ${Object.keys(grns).length} GRNs`);

  await seedInvoicesAndPayments(vendor, pos, grns);
  log('2 invoices (Cleared, Match Warning), 1 payment, 1 GRN left awaiting invoice');

  const plan = await seedInvoicingPlan(vendor);
  log(`PO-2026-0007 — invoicing plan ${plan.planNumber}, 1 instalment cleared, 1 open, 1 billing-blocked, 1 not yet due`);

  await seedChat();
  await seedSapLogs(vendor, vendor2, plan);
  log('5 chat messages, 13 SAP log entries');

  console.log('');
  log(`supplier login:  ${VENDOR_EMAIL} / ${VENDOR_PASSWORD}`);
  log(`client admin:    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  log(`buyer:           ${BUYER_EMAIL} / ${BUYER_PASSWORD}`);
  log(`finance:         ${FINANCE_EMAIL} / ${FINANCE_PASSWORD}`);
  log(`2nd supplier:    ${VENDOR2_EMAIL} / ${VENDOR2_PASSWORD}  (Under Review — no SAP vendor master yet)`);

  await prisma.$disconnect();
};

run().catch(async (error) => {
  console.error('[seed-demo] failed:', error);
  await prisma.$disconnect();
  process.exit(1);
});
