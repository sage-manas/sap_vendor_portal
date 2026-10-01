-- Self-registration is confirmed by email before the account can sign in
-- (finding 1.4). NULL = confirmed, so every existing account stays usable and
-- no backfill is needed.
ALTER TABLE "vendors" ADD COLUMN "emailVerificationToken" TEXT;
ALTER TABLE "vendors" ADD COLUMN "emailVerificationExpires" TIMESTAMP(3);
