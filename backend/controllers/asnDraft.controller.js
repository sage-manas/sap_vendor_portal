const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { requireVendorScope } = require('../utils/requestScope');
const { asnCreateSchema } = require('../validators/asn.validator');
const { createAsn, ASN_SUBMITTED_MESSAGE } = require('./po.controller');
const { formatAsn } = require('../services/asn.service');

// Shipment notice drafts — see the note on AsnDraft in schema.prisma. A draft
// belongs to the supplier who started it and is only ever theirs: there is no
// staff view of drafts, because nothing in one has been sent to anyone yet.

// How many drafts a supplier may keep. A draft is cheap, but an unbounded
// number of them is a way to fill the database through one account.
const MAX_DRAFTS_PER_SUPPLIER = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ownDraft = async (req) => {
  const vendorId = requireVendorScope(req);
  // Not a uuid is not a draft — answered here rather than as a Postgres cast error.
  if (!UUID.test(req.params.pk)) throw ApiError.notFound('Draft not found');
  const draft = await prisma.asnDraft.findFirst({ where: { pk: req.params.pk, vendorId } });
  if (!draft) throw ApiError.notFound('Draft not found');
  return draft;
};

const formatDraft = ({ clientId, ...draft }) => draft;

// @route   GET /api/asn-drafts
const listDrafts = asyncHandler(async (req, res) => {
  const vendorId = requireVendorScope(req);
  const drafts = await prisma.asnDraft.findMany({ where: { vendorId }, orderBy: { updatedAt: 'desc' } });
  res.json({ drafts: drafts.map(formatDraft) });
});

// @route   GET /api/asn-drafts/:pk
const getDraft = asyncHandler(async (req, res) => {
  res.json(formatDraft(await ownDraft(req)));
});

// @route   POST /api/asn-drafts
const createDraft = asyncHandler(async (req, res) => {
  const vendorId = requireVendorScope(req);
  const count = await prisma.asnDraft.count({ where: { vendorId } });
  if (count >= MAX_DRAFTS_PER_SUPPLIER) {
    throw ApiError.badRequest(`You have ${count} drafts. Submit or delete some before starting another.`);
  }
  const { poId = null, step = 1, payload = {} } = req.body;
  const draft = await prisma.asnDraft.create({ data: { vendorId, poId, step, payload } });
  res.status(201).json(formatDraft(draft));
});

// @route   PUT /api/asn-drafts/:pk
// Replaces the fields it is sent. `payload` is replaced whole, not merged:
// the form always sends what it shows, and a merge would keep a line the
// supplier removed.
const updateDraft = asyncHandler(async (req, res) => {
  const draft = await ownDraft(req);
  const { poId, step, payload } = req.body;
  const updated = await prisma.asnDraft.update({
    where: { pk: draft.pk },
    data: {
      ...(poId !== undefined ? { poId } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(payload !== undefined ? { payload } : {}),
    },
  });
  res.json(formatDraft(updated));
});

// @route   DELETE /api/asn-drafts/:pk
const deleteDraft = asyncHandler(async (req, res) => {
  const draft = await ownDraft(req);
  await prisma.asnDraft.delete({ where: { pk: draft.pk } });
  res.status(204).end();
});

// @route   POST /api/asn-drafts/:pk/submit
// The draft becomes a shipment notice: it is checked by the same schema and
// the same rules as POST /pos/:id/asn, against today's open quantities and
// invoice numbers, and gets its ASN number only now. The draft is deleted in
// the create's own transaction, so the two can never both exist, and a second
// submit of the same draft finds nothing to submit.
const submitDraft = asyncHandler(async (req, res) => {
  const draft = await ownDraft(req);
  if (!draft.poId) throw ApiError.badRequest('Choose the purchase order this shipment is for.');

  // `attachments` is the draft's own record of which file sits in which slot;
  // the shipment only takes the ids.
  const { attachments, ...form } = draft.payload || {};
  if (attachments && !form.documentIds) {
    form.documentIds = Object.values(attachments).filter(Boolean).map((doc) => doc.documentId);
  }
  const parsed = asnCreateSchema.safeParse(form);
  if (!parsed.success) {
    throw ApiError.badRequest('This draft is not complete yet.', {
      errors: Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.') || 'payload', issue.message])),
    });
  }

  const asn = await createAsn(req, draft.poId, parsed.data, {
    inTransaction: async (tx) => {
      const { count } = await tx.asnDraft.deleteMany({ where: { pk: draft.pk } });
      if (!count) throw ApiError.conflict('This draft has already been submitted.');
    },
  });

  res.status(201).json({ message: ASN_SUBMITTED_MESSAGE, asn: formatAsn(asn) });
});

module.exports = {
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, submitDraft, MAX_DRAFTS_PER_SUPPLIER,
};
