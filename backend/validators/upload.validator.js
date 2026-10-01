const { z } = require('zod');

// The text fields of the multipart upload — multer has already parsed them by
// the time this runs. `vendorId` is how tenant staff name the supplier they are
// uploading for; a supplier's own request is pinned to their id regardless.
const uploadFieldsSchema = z.strictObject({
  linkedTo: z.enum(['ASN', 'RFQ', 'Profile', 'Invoice']).optional(),
  vendorId: z.string().min(1).optional(),
});

module.exports = { uploadFieldsSchema };
