-- EKPO-KNTTP, read back from zpo_grn/Detail's ACC_ASSIGNMNT_CAT: 'A' asset,
-- 'D' service, NULL an ordinary material line. Nullable with no default —
-- every row written before this column existed predates the portal reading
-- the field at all, and NULL is the honest value for them.
ALTER TABLE "purchase_order_items" ADD COLUMN "accountAssignmentCategory" TEXT;
