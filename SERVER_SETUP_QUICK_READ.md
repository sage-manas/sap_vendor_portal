 # VendorConnect Server Quick Read

VendorConnect runs as two Node.js apps behind one Nginx domain.

```text
Browser
  -> Nginx /             -> Next.js frontend on 127.0.0.1:3000
  -> Nginx /api/         -> Express API on 127.0.0.1:5000
  -> Nginx /socket.io/   -> Express Socket.io on 127.0.0.1:5000
```

## What To Run

```text
Root package      frontend    Next.js 16 + React 19
backend package   API         Express 5 + Socket.io + MongoDB/Mongoose
MongoDB           database    external MongoDB URI or local MongoDB
PM2               process     keeps frontend and backend alive
Nginx             proxy       routes web, API and websocket traffic
```

PM2 config is already present:

```text
deploy/ecosystem.config.js
  vendorconnect-web  -> repo root, next start -p 3000
  vendorconnect-api  -> backend/server.js, port 5000
```

Nginx config is already present:

```text
deploy/nginx.conf
  /api/       -> backend:5000
  /socket.io/ -> backend:5000 with websocket upgrade headers
  /           -> frontend:3000
```

## Install And Start

```bash
# frontend
npm ci
npm run build

# backend
cd backend
npm ci
cd ..

# production processes
pm2 start deploy/ecosystem.config.js
pm2 save
```

## Required Backend Environment

Create `backend/.env`.

Important values:

```text
PORT=5000
MONGO_URI=<mongodb connection string>
FRONTEND_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
NODE_ENV=production
JWT_SECRET=<strong random secret>
MASTER_KEY=<strong key/passphrase for encrypted SAP/MFA secrets>
MAIL_TRANSPORT=smtp
SMTP_HOST=<smtp host>
SMTP_PORT=<smtp port>
SMTP_USER=<smtp user>
SMTP_PASSWORD=<smtp password>
MAIL_FROM=<sender email>
SAP_MOCK_MODE=true
```

Use `backend/.env.example` as the full reference.

## Database

MongoDB stores everything:

```text
Client tenants
Vendor suppliers
User tenant staff
PlatformUser platform operators
RFQ, PurchaseOrder, ASN, GRN, Invoice, Payment
Document metadata
ChatMessage
SapLog
SapConnection and SapConnectionAudit
AuditLog
Invitation
```

This is a multi-tenant app. Most data is scoped by `clientId`. Do not manually edit tenant data unless you know the tenant boundary.

## Login Planes

```text
/             supplier portal      uses localStorage jwt_token
/workspace    tenant back office   uses same jwt_token
/platform     platform console     uses separate vc_platform_token
```

Roles:

```text
platform: super_admin, sap_manager
tenant:   client_admin, buyer, finance
supplier: vendor
```

## SAP Reality

SAP is abstracted through `backend/sap`.

Current production-safe default:

```text
mock driver -> simulates SAP calls, GRN, MIRO and payment
```

Real SAP driver paths exist:

```text
s4_odata -> partial / connection testing
ecc_rfc  -> skeleton
```

SAP credentials are stored encrypted in MongoDB and are configured from `/platform`.

## Health Checks

```text
GET /api/health
GET /api/status
GET /api/platform/health
```

`/api/health` confirms API, MongoDB and socket connection count.

## Logs

```text
backend/logs/
pm2 logs vendorconnect-api
pm2 logs vendorconnect-web
```

SAP call history is also stored in MongoDB as `SapLog` and auto-expires after 30 days.

## Files

Uploads are handled by the backend with `multer`.

```text
backend/uploads/
```

Make sure this directory is writable by the API process.

## Do Not Miss

1. Build frontend before `next start`.
2. Backend needs `backend/.env`, not root `.env`.
3. In production, `JWT_SECRET`, `MASTER_KEY` and SMTP config must be real.
4. Keep `/socket.io/` proxy upgrade headers in Nginx.
5. Do not run Socket.io in PM2 cluster mode unless sticky sessions are added.
6. Platform admin is seeded with:

```bash
cd backend
npm run seed:platform-admin
```

7. Frontend talks to backend through `NEXT_PUBLIC_API_URL`; set it before build if API is not same domain/proxy.

