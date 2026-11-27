-- Issue #351: SAP-discovered purchase orders and RFQs carried the day the sweep
-- first saw them as "Raised", not SAP's own PO_DATE / ME48 date. The sweeps now
-- correct this, but they only reconcile when SAP's answer changes, and an
-- old order's answer has not. Forgetting the last fingerprint for these two
-- feeds makes the next tick treat every vendor's ledger as changed once, which
-- corrects every existing row. Nothing else is lost: the fingerprint is a
-- cache of the last response, and the sweep rebuilds it on that same tick.
UPDATE "sap_sync_cursors" SET "fingerprint" = NULL WHERE "feed" IN ('po', 'quotation');
