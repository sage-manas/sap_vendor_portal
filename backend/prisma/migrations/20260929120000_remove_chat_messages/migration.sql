-- Supplier<->buyer messaging was confirmed out of scope (issue #168); the
-- portal never built a UI on top of it beyond a local-only fake drawer, and
-- the only real content was 5 demo rows. Dropping the table this feature's
-- endpoints (already removed) wrote to.
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_clientId_linkedPoId_fkey";
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_clientId_linkedRfqId_fkey";

DROP TABLE "chat_messages";

DROP TYPE "ChatSender";
