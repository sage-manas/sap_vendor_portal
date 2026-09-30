# Bootstrapping a fresh production database

A new production database must hold **one** thing: the platform super admin. No
demo tenant, no legacy client, no sample suppliers. Do not run `seed:demo` (or the
e2e/test suites, which wipe and seed) against it, ever.

## Steps

1. Server prepared per `deploy/setup-server.sh` (Postgres role and empty database
   `sap_vendor_portal`), `backend/.env` filled in, including `PORTAL_BASE_DOMAIN`,
   `MASTER_KEY`, `JWT_SECRET`, SMTP settings (see
   [email-deliverability.md](email-deliverability.md)).
2. Apply the schema (`deploy/deploy.sh` does this, or by hand):
   ```
   cd backend && npx prisma migrate deploy
   ```
   Migrations create tables only; they insert no tenant.
3. Create the first operator:
   ```
   cd backend
   NODE_ENV=production npm run bootstrap:production -- --email you@your.domain.com --name "Your Name"
   ```
   It prints a temporary password **once**. The script refuses if:
   - `NODE_ENV` is not `production`,
   - a variable production needs is missing (it lists which),
   - the database already has a tenant, supplier, tenant staff member or operator,
   - migrations have not been applied.
   To add later operators to a live system use `npm run seed:platform-admin` or the
   console's operator screen.
4. Sign in at `https://platform.<PORTAL_BASE_DOMAIN>/platform`, change the password
   (once the forced-change enforcement in the 0.7 PR is merged, the server refuses everything else until you do), enrol MFA.
5. Create the first client in the console, and give it a slug that is a valid DNS
   label: its workspace is `https://<slug>.<PORTAL_BASE_DOMAIN>`.
6. Configure that client's SAP connection (production requires https and a
   technical user), test it, then promote it.
7. Take the first backup by hand and run the restore drill once
   ([backup-restore.md](backup-restore.md)) before any real data goes in.

## Checks that it is really clean

```
psql "$DATABASE_URL" -c 'select (select count(*) from clients) c, (select count(*) from vendors) v, (select count(*) from users) u, (select count(*) from platform_users) p'
```
Expect `0 | 0 | 0 | 1` straight after step 3.
