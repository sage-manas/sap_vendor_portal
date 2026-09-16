-- A material document number (MBLNR) is only unique together with its fiscal
-- year (MJAHR) in SAP. The portal minted the GRN business id from the bare
-- number alone, so a recycled number range collides with an old row the
-- moment SAP crosses a fiscal-year boundary. This column carries the year
-- half of that key; the id itself is now minted as `GRN-{year}-{number}`
-- (see sap/drivers/*.driver.js) so the existing @@unique([clientId, id])
-- constraint enforces the real SAP key instead of half of it.
ALTER TABLE "grns" ADD COLUMN "sapDocYear" INTEGER;
