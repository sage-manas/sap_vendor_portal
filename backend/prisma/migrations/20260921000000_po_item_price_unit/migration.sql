-- PEINH on a purchase order line (issue #108).
--
-- SAP's NETPR is the price for PEINH units. The portal sent PEINH to SAP and
-- never stored it, and computed a line's value as quantity * unitPrice with no
-- divisor -- overstating any line whose price unit was not 1 by exactly that
-- factor, on the one document the portal creates in SAP and cannot reverse.
--
-- DEFAULT 1 is correct for every existing row: 1 is what the omitted divisor
-- effectively was, so no historical value changes meaning. NOT NULL because
-- "unknown price unit" is not a state SAP has -- a line is priced per some
-- number of units, and that number is 1 unless stated.
ALTER TABLE "purchase_order_items"
  ADD COLUMN "priceUnit" INTEGER NOT NULL DEFAULT 1;
