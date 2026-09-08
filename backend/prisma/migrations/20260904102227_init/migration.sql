-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('Trial', 'Active', 'Suspended', 'Terminated');

-- CreateEnum
CREATE TYPE "SapEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('Draft', 'Bidding Open', 'Submitted', 'Under Review', 'Awarded', 'Closed');

-- CreateEnum
CREATE TYPE "RfqType" AS ENUM ('AN', 'AB');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('Open', 'Acknowledged', 'Dispatched', 'Delivered', 'Invoiced', 'Paid');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('Periodic', 'Partial');

-- CreateEnum
CREATE TYPE "PlanFrequency" AS ENUM ('Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly');

-- CreateEnum
CREATE TYPE "InvoicingRule" AS ENUM ('Advance', 'Arrears');

-- CreateEnum
CREATE TYPE "PlanSource" AS ENUM ('portal', 'sap');

-- CreateEnum
CREATE TYPE "PlanLineStatus" AS ENUM ('Open', 'Invoiced', 'Blocked', 'Cancelled');

-- CreateEnum
CREATE TYPE "AsnStatus" AS ENUM ('Submitted', 'In Transit', 'Received');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('Submitted', 'Under Review', 'Match Warning', 'Approved', 'Posted in SAP', 'Cleared');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('NEFT', 'RTGS', 'IMPS');

-- CreateEnum
CREATE TYPE "ChatSender" AS ENUM ('Vendor', 'Buyer', 'System', 'Finance', 'Quality', 'Warehouse');

-- CreateEnum
CREATE TYPE "DocumentLinkType" AS ENUM ('ASN', 'RFQ', 'Profile', 'Invoice');

-- CreateEnum
CREATE TYPE "SapLogType" AS ENUM ('BAPI', 'RFC', 'OData', 'IDoc', 'SYS', 'KYC');

-- CreateEnum
CREATE TYPE "SapLogDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "SapLogStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditPlane" AS ENUM ('platform', 'tenant', 'supplier', 'system');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('Pending', 'Accepted', 'Revoked', 'Expired');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('Invited', 'Active', 'Suspended');

-- CreateEnum
CREATE TYPE "PlatformUserStatus" AS ENUM ('Active', 'Suspended');

-- CreateTable
CREATE TABLE "clients" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL DEFAULT 'Trial',
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "brandingLogo" TEXT,
    "brandingColor" TEXT,
    "featureFlags" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "sapEnvironment" "SapEnvironment" NOT NULL DEFAULT 'sandbox',
    "limitVendors" INTEGER NOT NULL DEFAULT 50,
    "limitRfqsPerMonth" INTEGER NOT NULL DEFAULT 100,
    "limitStorageMb" INTEGER NOT NULL DEFAULT 1024,
    "createdBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "vendors" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "clerkId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'Vendor',
    "companyName" TEXT NOT NULL,
    "tradeName" TEXT,
    "businessType" TEXT,
    "incorporationDate" TEXT,
    "gstin" TEXT NOT NULL,
    "gstType" TEXT,
    "pan" TEXT NOT NULL,
    "cin" TEXT,
    "msmeNumber" TEXT,
    "tdsSection" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "paymentTerms" TEXT,
    "paymentMethod" TEXT,
    "currency" TEXT,
    "incoterms1" TEXT,
    "incoterms2" TEXT,
    "doubleInvoiceCheck" BOOLEAN NOT NULL DEFAULT false,
    "grBasedInvoiceVerification" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifscCode" TEXT,
    "accountName" TEXT,
    "bankBranch" TEXT,
    "cancelledCheque" JSONB,
    "panCardCopy" JSONB,
    "gstCertificate" JSONB,
    "msmeCertificate" JSONB,
    "gstinVerified" BOOLEAN NOT NULL DEFAULT false,
    "panVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verificationDetails" JSONB,
    "sapVendorCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "rejectionReason" TEXT,
    "vendorCategory" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "password" TEXT,
    "resetPasswordToken" TEXT,
    "resetPasswordExpires" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'Bidding Open',
    "deadlineDate" TIMESTAMP(3) NOT NULL,
    "rfqType" "RfqType" NOT NULL DEFAULT 'AN',
    "paymentTerms" TEXT,
    "purchasingOrg" TEXT NOT NULL DEFAULT '1000',
    "purchasingGroup" TEXT,
    "companyCode" TEXT NOT NULL DEFAULT '1000',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "deliveryLocation" TEXT,
    "createdDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awardedVendorId" TEXT,
    "awardedVendorName" TEXT,
    "awardedAt" TIMESTAMP(3),
    "convertedPoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfq_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "rfqPk" UUID NOT NULL,
    "line" INTEGER NOT NULL,
    "materialCode" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "targetPrice" DOUBLE PRECISION,
    "plant" TEXT NOT NULL DEFAULT '1000',
    "deliveryDate" TIMESTAMP(3),

    CONSTRAINT "rfq_items_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfq_bids" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "rfqPk" UUID NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorPk" UUID,
    "vendorName" TEXT,
    "gstRate" TEXT,
    "taxCode" TEXT,
    "freight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deliveryLeadTimeDays" INTEGER,
    "vendorRating" DOUBLE PRECISION,
    "technicalScore" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "validityDate" TIMESTAMP(3),
    "moq" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "remarks" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_bids_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfq_bid_unit_prices" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "bidPk" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "rfq_bid_unit_prices_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfq_bid_documents" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "bidPk" UUID NOT NULL,
    "documentId" TEXT,
    "originalName" TEXT,
    "url" TEXT,

    CONSTRAINT "rfq_bid_documents_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "rfq_invited_vendors" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "rfqPk" UUID NOT NULL,
    "vendorExtId" TEXT,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "rating" DOUBLE PRECISION,

    CONSTRAINT "rfq_invited_vendors_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "sapPoNumber" TEXT,
    "vendorId" TEXT NOT NULL,
    "vendorPk" UUID,
    "buyerName" TEXT,
    "plant" TEXT,
    "paymentTerms" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "incoterms" TEXT,
    "deliveryAddress" TEXT,
    "status" "PoStatus" NOT NULL DEFAULT 'Open',
    "createdDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "fromRfqId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "poPk" UUID NOT NULL,
    "line" INTEGER NOT NULL,
    "materialCode" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "grnQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "netValue" DOUBLE PRECISION NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "invoice_plans" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "itemPk" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "planNumber" TEXT,
    "type" "PlanType",
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "frequency" "PlanFrequency",
    "invoicingRule" "InvoicingRule" NOT NULL DEFAULT 'Arrears',
    "periodicAmount" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reference" TEXT,
    "source" "PlanSource" NOT NULL DEFAULT 'portal',
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "invoice_plans_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "invoice_plan_lines" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "planPk" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "description" TEXT,
    "settlementDate" TIMESTAMP(3) NOT NULL,
    "billingDate" TIMESTAMP(3),
    "percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PlanLineStatus" NOT NULL DEFAULT 'Open',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "invoiceNumber" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "sapMiroDoc" TEXT,

    CONSTRAINT "invoice_plan_lines_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "asns" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "AsnStatus" NOT NULL DEFAULT 'Submitted',
    "shipDate" TIMESTAMP(3) NOT NULL,
    "estimatedDeliveryDate" TIMESTAMP(3) NOT NULL,
    "carrierName" TEXT,
    "trackingNumber" TEXT,
    "vehicleNumber" TEXT,
    "invoiceReference" TEXT,
    "ewayBillNo" TEXT,
    "sapInboundDelivery" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asns_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "asn_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "asnPk" UUID NOT NULL,
    "line" INTEGER,
    "materialCode" TEXT NOT NULL,
    "description" TEXT,
    "shippedQuantity" DOUBLE PRECISION NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',

    CONSTRAINT "asn_items_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "grns" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "asnId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "sapMigoDoc" TEXT,
    "postingDate" TIMESTAMP(3) NOT NULL,
    "receivedBy" TEXT,
    "invoiceSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grns_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "grn_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "grnPk" UUID NOT NULL,
    "line" INTEGER,
    "materialCode" TEXT NOT NULL,
    "description" TEXT,
    "receivedQuantity" DOUBLE PRECISION NOT NULL,
    "acceptedQuantity" DOUBLE PRECISION NOT NULL,
    "rejectedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "uom" TEXT NOT NULL DEFAULT 'EA',

    CONSTRAINT "grn_items_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "invoices" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "grnId" TEXT,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "sapMiroDoc" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'Submitted',
    "subTotal" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "taxCode" TEXT NOT NULL DEFAULT 'G1',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "matchWarning" TEXT,
    "invoicePlanRef" JSONB,
    "postedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoicePk" UUID NOT NULL,
    "line" INTEGER,
    "materialCode" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "payments" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceRef" TEXT,
    "invoiceNumber" TEXT,
    "sapMiroDoc" TEXT,
    "grossAmount" DOUBLE PRECISION,
    "tdsDeducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "utrCode" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'NEFT',
    "sapPaymentDoc" TEXT,
    "bankName" TEXT,
    "runId" TEXT,
    "fiscalYear" INTEGER,
    "quarter" TEXT,
    "tdsSection" TEXT,
    "deducteePan" TEXT,
    "deductorTan" TEXT,
    "totalTds" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "sender" "ChatSender" NOT NULL,
    "message" TEXT NOT NULL,
    "linkedPoId" TEXT,
    "linkedRfqId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "documents" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "linkedTo" "DocumentLinkType" NOT NULL DEFAULT 'Profile',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "sap_logs" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "SapLogType" NOT NULL,
    "direction" "SapLogDirection" NOT NULL,
    "name" TEXT NOT NULL,
    "payload" TEXT,
    "status" "SapLogStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "documentRef" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sap_logs_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "pk" UUID NOT NULL,
    "clientId" TEXT,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "actorEmail" TEXT,
    "plane" "AuditPlane" NOT NULL,
    "action" TEXT NOT NULL,
    "target" JSONB,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "invitations" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'Pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "acceptedAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "sap_connections" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "environment" "SapEnvironment" NOT NULL,
    "driver" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "wrappedDataKey" TEXT,
    "lastTest" JSONB,
    "promotedAt" TIMESTAMP(3),
    "promotedBy" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sap_connections_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "sap_connection_secrets" (
    "pk" UUID NOT NULL,
    "connectionPk" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,

    CONSTRAINT "sap_connection_secrets_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "sap_connection_audits" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "driver" TEXT,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "secretsChanged" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "result" JSONB,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sap_connection_audits_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "users" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'Active',
    "phone" TEXT,
    "jobTitle" TEXT,
    "invitedBy" TEXT,
    "invitedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "password" TEXT,
    "resetPasswordToken" TEXT,
    "resetPasswordExpires" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "pk" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" "PlatformUserStatus" NOT NULL DEFAULT 'Active',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaEnrolledAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "password" TEXT,
    "resetPasswordToken" TEXT,
    "resetPasswordExpires" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("pk")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_clientId_key" ON "clients"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_slug_key" ON "clients"("slug");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_vendorId_key" ON "vendors"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_gstin_key" ON "vendors"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_email_key" ON "vendors"("email");

-- CreateIndex
CREATE INDEX "vendors_clientId_status_idx" ON "vendors"("clientId", "status");

-- CreateIndex
CREATE INDEX "vendors_clientId_vendorId_idx" ON "vendors"("clientId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_clientId_sapVendorCode_key" ON "vendors"("clientId", "sapVendorCode");

-- CreateIndex
CREATE INDEX "rfqs_clientId_status_idx" ON "rfqs"("clientId", "status");

-- CreateIndex
CREATE INDEX "rfqs_clientId_deadlineDate_idx" ON "rfqs"("clientId", "deadlineDate");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_clientId_id_key" ON "rfqs"("clientId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_items_rfqPk_line_key" ON "rfq_items"("rfqPk", "line");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_bid_unit_prices_bidPk_lineNumber_key" ON "rfq_bid_unit_prices"("bidPk", "lineNumber");

-- CreateIndex
CREATE INDEX "purchase_orders_clientId_vendorId_idx" ON "purchase_orders"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "purchase_orders_clientId_status_idx" ON "purchase_orders"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_clientId_id_key" ON "purchase_orders"("clientId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_poPk_line_key" ON "purchase_order_items"("poPk", "line");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_plans_itemPk_key" ON "invoice_plans"("itemPk");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_plan_lines_planPk_lineNumber_key" ON "invoice_plan_lines"("planPk", "lineNumber");

-- CreateIndex
CREATE INDEX "asns_clientId_vendorId_idx" ON "asns"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "asns_clientId_status_idx" ON "asns"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "asns_clientId_id_key" ON "asns"("clientId", "id");

-- CreateIndex
CREATE INDEX "grns_clientId_vendorId_idx" ON "grns"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "grns_clientId_poId_idx" ON "grns"("clientId", "poId");

-- CreateIndex
CREATE UNIQUE INDEX "grns_clientId_id_key" ON "grns"("clientId", "id");

-- CreateIndex
CREATE INDEX "invoices_clientId_vendorId_idx" ON "invoices"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "invoices_clientId_status_idx" ON "invoices"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_clientId_id_key" ON "invoices"("clientId", "id");

-- CreateIndex
CREATE INDEX "payments_clientId_vendorId_idx" ON "payments"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "payments_clientId_invoiceId_idx" ON "payments"("clientId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_clientId_id_key" ON "payments"("clientId", "id");

-- CreateIndex
CREATE INDEX "chat_messages_clientId_vendorId_timestamp_idx" ON "chat_messages"("clientId", "vendorId", "timestamp");

-- CreateIndex
CREATE INDEX "documents_clientId_vendorId_idx" ON "documents"("clientId", "vendorId");

-- CreateIndex
CREATE INDEX "sap_logs_clientId_vendorId_timestamp_idx" ON "sap_logs"("clientId", "vendorId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "sap_logs_clientId_timestamp_idx" ON "sap_logs"("clientId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "sap_logs_timestamp_idx" ON "sap_logs"("timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_clientId_at_idx" ON "audit_logs"("clientId", "at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_at_idx" ON "audit_logs"("action", "at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actorId_at_idx" ON "audit_logs"("actorId", "at" DESC);

-- CreateIndex
CREATE INDEX "invitations_clientId_email_status_idx" ON "invitations"("clientId", "email", "status");

-- CreateIndex
CREATE INDEX "invitations_clientId_status_idx" ON "invitations"("clientId", "status");

-- CreateIndex
CREATE INDEX "invitations_tokenHash_idx" ON "invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "sap_connections_clientId_environment_key" ON "sap_connections"("clientId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "sap_connection_secrets_connectionPk_name_key" ON "sap_connection_secrets"("connectionPk", "name");

-- CreateIndex
CREATE INDEX "sap_connection_audits_clientId_at_idx" ON "sap_connection_audits"("clientId", "at" DESC);

-- CreateIndex
CREATE INDEX "sap_connection_audits_action_at_idx" ON "sap_connection_audits"("action", "at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_clientId_role_idx" ON "users"("clientId", "role");

-- CreateIndex
CREATE INDEX "users_clientId_status_idx" ON "users"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_users_role_idx" ON "platform_users"("role");

-- CreateIndex
CREATE INDEX "platform_users_status_idx" ON "platform_users"("status");

-- AddForeignKey
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_rfqPk_fkey" FOREIGN KEY ("rfqPk") REFERENCES "rfqs"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_bids" ADD CONSTRAINT "rfq_bids_rfqPk_fkey" FOREIGN KEY ("rfqPk") REFERENCES "rfqs"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_bids" ADD CONSTRAINT "rfq_bids_vendorPk_fkey" FOREIGN KEY ("vendorPk") REFERENCES "vendors"("pk") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_bid_unit_prices" ADD CONSTRAINT "rfq_bid_unit_prices_bidPk_fkey" FOREIGN KEY ("bidPk") REFERENCES "rfq_bids"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_bid_documents" ADD CONSTRAINT "rfq_bid_documents_bidPk_fkey" FOREIGN KEY ("bidPk") REFERENCES "rfq_bids"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_invited_vendors" ADD CONSTRAINT "rfq_invited_vendors_rfqPk_fkey" FOREIGN KEY ("rfqPk") REFERENCES "rfqs"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendorPk_fkey" FOREIGN KEY ("vendorPk") REFERENCES "vendors"("pk") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_clientId_fromRfqId_fkey" FOREIGN KEY ("clientId", "fromRfqId") REFERENCES "rfqs"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_poPk_fkey" FOREIGN KEY ("poPk") REFERENCES "purchase_orders"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_plans" ADD CONSTRAINT "invoice_plans_itemPk_fkey" FOREIGN KEY ("itemPk") REFERENCES "purchase_order_items"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_plan_lines" ADD CONSTRAINT "invoice_plan_lines_planPk_fkey" FOREIGN KEY ("planPk") REFERENCES "invoice_plans"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asns" ADD CONSTRAINT "asns_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asn_items" ADD CONSTRAINT "asn_items_asnPk_fkey" FOREIGN KEY ("asnPk") REFERENCES "asns"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_clientId_asnId_fkey" FOREIGN KEY ("clientId", "asnId") REFERENCES "asns"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_grnPk_fkey" FOREIGN KEY ("grnPk") REFERENCES "grns"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clientId_grnId_fkey" FOREIGN KEY ("clientId", "grnId") REFERENCES "grns"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoicePk_fkey" FOREIGN KEY ("invoicePk") REFERENCES "invoices"("pk") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_clientId_invoiceId_fkey" FOREIGN KEY ("clientId", "invoiceId") REFERENCES "invoices"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_clientId_linkedPoId_fkey" FOREIGN KEY ("clientId", "linkedPoId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_clientId_linkedRfqId_fkey" FOREIGN KEY ("clientId", "linkedRfqId") REFERENCES "rfqs"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sap_connection_secrets" ADD CONSTRAINT "sap_connection_secrets_connectionPk_fkey" FOREIGN KEY ("connectionPk") REFERENCES "sap_connections"("pk") ON DELETE CASCADE ON UPDATE CASCADE;
