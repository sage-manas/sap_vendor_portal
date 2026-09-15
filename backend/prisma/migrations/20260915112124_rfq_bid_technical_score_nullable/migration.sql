-- AlterTable
ALTER TABLE "rfq_bids" ALTER COLUMN "technicalScore" DROP NOT NULL,
ALTER COLUMN "technicalScore" DROP DEFAULT;

-- Data cleanup for issue #58: until this change, submitBid stamped every bid
-- with the DEFAULT_TECHNICAL_SCORE constant (80) — no code path has ever
-- written a real, buyer-entered technical score, so every existing row still
-- holding exactly 80 here is that fabricated default, not a measurement.
-- Relabelled to NULL ("not evaluated") rather than left to be misread as
-- data. Safe specifically because 80 was the *only* value this column has
-- ever held; unlike vendorRating (a real, buyer-set field elsewhere in the
-- same table), there is no genuine value this could be confused with.
UPDATE "rfq_bids" SET "technicalScore" = NULL WHERE "technicalScore" = 80;
