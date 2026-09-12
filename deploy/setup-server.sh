#!/usr/bin/env bash
# One-time server bootstrap for Ubuntu 22.04/24.04. Run as a sudo-capable
# non-root user, NOT root directly. Review each section before running blindly.
set -euo pipefail

echo "== System update =="
sudo apt update && sudo apt -y upgrade

echo "== Firewall (ufw): allow SSH, HTTP, HTTPS only =="
sudo apt -y install ufw fail2ban
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo systemctl enable --now fail2ban

echo "== Node.js 22.x (via NodeSource) =="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v

echo "== PM2 (process manager) =="
sudo npm install -g pm2
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n1 | sudo bash || true

echo "== Nginx + Certbot =="
sudo apt -y install nginx certbot python3-certbot-nginx

echo "== PostgreSQL 16 =="
sudo apt -y install postgresql postgresql-contrib
sudo systemctl enable --now postgresql

echo "== Application database and role =="
# Set DB_PASSWORD in the environment before running, and use the same value in
# backend/.env's DATABASE_URL.
if [ -z "${DB_PASSWORD:-}" ]; then
  echo "DB_PASSWORD is not set. Re-run as: DB_PASSWORD='<strong password>' ./deploy/setup-server.sh" >&2
  exit 1
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DB_PASSWORD" \
  -c "CREATE ROLE sap_portal LOGIN PASSWORD :'pw'" || echo "  role sap_portal already exists, leaving it as is"
sudo -u postgres psql -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE sap_vendor_portal OWNER sap_portal" || echo "  database sap_vendor_portal already exists, leaving it as is"

cat <<'EOF'

== Manual steps left ==
1. Harden SSH: edit /etc/ssh/sshd_config
     PasswordAuthentication no
     PermitRootLogin no
   then: sudo systemctl restart sshd
   (Add your public key to ~/.ssh/authorized_keys BEFORE disabling password auth.)

2. Clone the app and set up backend/.env and .env (see PROJECT_CONTEXT.md §4).
   DATABASE_URL must match the role/database created above, e.g.
     postgresql://sap_portal:<password>@localhost:5432/sap_vendor_portal?schema=public
     git clone <repo-url> vendorconnect && cd vendorconnect
     npm install && npm run build
     cd backend && npm install && npx prisma migrate deploy && cd ..

3. Copy deploy/nginx.conf to /etc/nginx/sites-available/vendorconnect,
   edit server_name, then:
     sudo ln -s /etc/nginx/sites-available/vendorconnect /etc/nginx/sites-enabled/
     sudo rm -f /etc/nginx/sites-enabled/default
     sudo nginx -t && sudo systemctl reload nginx
     sudo certbot --nginx -d your.domain.com

4. Start the app:
     pm2 start deploy/ecosystem.config.js
     pm2 save

5. Confirm PostgreSQL listens on localhost only (default listen_addresses
   in /etc/postgresql/*/main/postgresql.conf — don't expose 5432 publicly).
EOF
