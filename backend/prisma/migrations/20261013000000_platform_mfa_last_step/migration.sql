-- The TOTP step whose code was last accepted for this operator, so one code
-- cannot be verified twice inside its validity window (ADR-0045).
ALTER TABLE "platform_users" ADD COLUMN "mfaLastStepAt" TIMESTAMP(3);
