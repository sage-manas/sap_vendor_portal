# Hosting Provider Deployment Handoff

Use this checklist when giving VendorConnect hosting/deployment work to a service provider.

## 1. Project Summary To Share

```text
Project type: Full-stack Node.js application
Frontend: Next.js 16 + React 19
Backend: Express 5 + Socket.io
Database: PostgreSQL (via Prisma)
Process manager: PM2
Reverse proxy: Nginx
Default frontend port: 3000
Default backend/API port: 5000
API base path: /api
WebSocket path: /socket.io
```

The app has two packages:

```text
repo root     -> frontend package
backend/      -> backend API package
```

## 2. Repository Access

Share:

```text
Git repository URL
Branch to deploy
Read-only deploy key or GitHub/GitLab access
Any private package registry details, if applicable
```

Do not share your personal Git credentials. Give a deploy key or restricted service account.

## 3. Domain And DNS Details

Share:

```text
Main domain name
Subdomains, if any
Which domain points to which project
DNS provider login or ask them for required A/CNAME records
SSL requirement: HTTPS required
```

For 3 similar projects, give a clear mapping:

```text
project-1.example.com -> Project 1
project-2.example.com -> Project 2
project-3.example.com -> Project 3
```

or:

```text
example.com            -> Project 1
client2.example.com    -> Project 2
client3.example.com    -> Project 3
```

## 4. Server Access

Share securely:

```text
Server IP address
SSH username
SSH key access
Sudo policy
Cloud provider panel access, if they manage the server
Firewall/security-group access, if they manage ports
```

Required open ports:

```text
22    SSH, restricted to trusted IPs if possible
80    HTTP for redirect and SSL challenge
443   HTTPS
```

Internal-only ports:

```text
3000+ frontend processes
5000+ backend processes
5432  PostgreSQL, only if self-hosted and not publicly exposed
```

## 5. Runtime Requirements

Ask them to install:

```text
Node.js 20.9+ or Node.js 22 LTS
npm
PM2
Nginx
Certbot
Git
PostgreSQL client tools (psql, pg_dump), if database backup/restore is needed
```

If PostgreSQL is self-hosted, they must also install and secure PostgreSQL.

## 6. Build And Start Commands

Frontend:

```bash
npm ci
npm run build
```

Backend:

```bash
cd backend
npm ci
npx prisma migrate deploy   # creates/updates the Postgres schema
cd ..
```

Start with PM2:

```bash
pm2 start deploy/ecosystem.config.js
pm2 save
```

Existing reference files:

```text
deploy/ecosystem.config.js
deploy/nginx.conf
SERVER_SETUP_QUICK_READ.md
PROJECT_ARCHITECTURE_FLOW.md
```

## 7. Environment Variables

Backend environment goes in:

```text
backend/.env
```

Required/important backend values:

```text
PORT=5000
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/sap_vendor_portal?schema=public
FRONTEND_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
JWT_SECRET=<strong secret>
JWT_EXPIRES_IN=30d
MASTER_KEY=<strong key/passphrase>
MAIL_TRANSPORT=smtp
SMTP_HOST=<smtp host>
SMTP_PORT=<smtp port>
SMTP_USER=<smtp user>
SMTP_PASSWORD=<smtp password>
SMTP_SECURE=true/false
MAIL_FROM=<sender email>
SAP_MOCK_MODE=true
LOG_LEVEL=info
UPLOAD_DIR=uploads
MAX_FILE_SIZE_MB=10
TENANT_RATE_LIMIT_MAX=300
BILLING_PROVIDER=null
DEFAULT_CLIENT_SLUG=legacy
```

Frontend environment:

```text
NEXT_PUBLIC_API_URL=https://your-domain.com/api
```

If frontend and backend are served from the same domain through Nginx, this can point to that domain's `/api`.

For 3 projects, each project needs its own env values. At minimum:

```text
Different PORT values if sharing one server
Different FRONTEND_URL
Different ALLOWED_ORIGINS
Different DATABASE_URL or database name
Different JWT_SECRET
Different MASTER_KEY
Different NEXT_PUBLIC_API_URL
```

## 8. Database Details

Share one of these:

### Managed PostgreSQL

```text
Managed Postgres project access (RDS, Cloud SQL, Neon, Supabase, ...), or
DATABASE_URL with username/password
Allowed server IP for database access
Backup policy
Database name per project
```

### Self-hosted PostgreSQL

```text
Whether PostgreSQL should be installed on same server or separate server
PostgreSQL admin credentials
Database names
Backup location
Restore instructions, if existing data exists
```

If existing production data exists, share:

```text
pg_dump output
Restore command (psql or pg_restore)
Expected database name
Any existing uploaded files from backend/uploads/
```

## 9. Email / SMTP Details

Required because password reset, invitations and supplier welcome emails depend on it.

Share:

```text
SMTP host
SMTP port
SMTP username
SMTP password
Secure/TLS setting
From email address
Any DNS records needed: SPF, DKIM, DMARC
```

Use secret manager or encrypted handoff. Do not send SMTP passwords in normal chat/email.

## 10. SAP Details

Current default deployment can run with:

```text
SAP_MOCK_MODE=true
```

If real SAP integration is needed, share:

```text
Tenant/client name
SAP environment: sandbox or production
Driver: mock, s4_odata or ecc_rfc
SAP base URL/gateway details
Client number
Username/password or technical user credentials
Network/VPN/IP allowlisting requirements
Certificate requirements, if any
```

Important: SAP credentials are configured from `/platform` and stored encrypted in PostgreSQL.

## 11. File Uploads

The backend stores uploaded files under:

```text
backend/uploads/
```

Tell the provider:

```text
This folder must be writable by the API process
This folder must be backed up
If deploying 3 projects, each project should have its own uploads directory
```

## 12. Nginx Requirements

They must proxy:

```text
/api/       -> backend API
/socket.io/ -> backend Socket.io with Upgrade headers
/           -> Next.js frontend
```

Socket.io must include websocket upgrade headers:

```text
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 86400;
```

## 13. PM2 Requirements For 3 Projects

The existing PM2 file is for one project. For 3 projects, they must either:

1. create 3 separate PM2 ecosystem entries, or
2. deploy each project in its own folder/container.

Example port plan:

```text
Project 1: frontend 3000, backend 5000
Project 2: frontend 3001, backend 5001
Project 3: frontend 3002, backend 5002
```

Each backend must have its own `PORT`.

## 14. First Admin / Platform Access

After deployment, seed the platform admin:

```bash
cd backend
npm run seed:platform-admin
```

Share securely:

```text
Platform admin email
Platform admin name
Temporary password delivery method
```

Do not keep temporary credentials in tickets or chat after setup.

## 15. Health Checks After Deployment

Ask the provider to verify:

```text
https://your-domain.com
https://your-domain.com/api/health
https://your-domain.com/api/status
Socket.io connects from browser
Login page loads
Password reset email sends
File upload works
PM2 processes restart after reboot
SSL certificate auto-renewal is configured
PostgreSQL backup job is configured
```

## 16. What Not To Share Casually

Do not send these over normal chat/email:

```text
JWT_SECRET
MASTER_KEY
SMTP_PASSWORD
PostgreSQL password
SAP credentials
SSH private key
Cloud root credentials
Production database dumps
```

Use a password manager, secret manager, encrypted note, or let the provider create placeholders and you enter secrets yourself.

