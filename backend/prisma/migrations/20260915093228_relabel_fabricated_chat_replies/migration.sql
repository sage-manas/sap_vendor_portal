-- Data cleanup for issue #55: sendMessage (backend/controllers/chat.controller.js)
-- used to schedule a setTimeout that wrote a keyword-matched "reply" into
-- chat_messages, attributed to sender Buyer, Finance, Quality or Warehouse —
-- no human ever sent these, and one asserted a SAP write that never happened.
-- That auto-reply block is removed in this same change; this relabels any
-- row it already wrote so it stops reading as a genuine staff message.
--
-- The four reply strings were fixed constants (no interpolation), so an exact
-- match identifies every fabricated row with no risk of catching a real
-- message that happens to share a few words. Relabelled to System rather
-- than deleted — the row still records that something was sent to the
-- supplier at that time, which is worth keeping; what changes is who it is
-- attributed to.
UPDATE "chat_messages"
SET "sender" = 'System'
WHERE "sender" IN ('Buyer', 'Finance', 'Quality', 'Warehouse')
  AND "message" IN (
    'We have received your query and updated the transaction record in SAP. A buyer officer will get back to you shortly.',
    'Tax code G1 (18% GST) applies to regular domestic supplies. Ensure your matching HSN invoice parameters align exactly with the Purchase Order unit rates.',
    'Please send us your shipment details with the expected delivery dates. If the delay is significant, message the logistics desk.',
    'Quality rejection requires a signed Inspection Sheet and a copy of the discrepancy report. Please submit a physical claim form or contact warehouse quality control.'
  );
