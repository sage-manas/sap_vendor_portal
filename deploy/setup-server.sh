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

echo "== MongoDB 7.x =="
curl -fsSL https://pgp.mongodb.com/server-7.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/7.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update && sudo apt -y install mongodb-org
sudo systemctl enable --now mongod

cat <<'EOF'

== Manual steps left ==
1. Harden SSH: edit /etc/ssh/sshd_config
     PasswordAuthentication no
     PermitRootLogin no
   then: sudo systemctl restart sshd
   (Add your public key to ~/.ssh/authorized_keys BEFORE disabling password auth.)

2. Clone the app and set up backend/.env and .env (see PROJECT_CONTEXT.md §4)
     git clone <repo-url> vendorconnect && cd vendorconnect
     npm install && npm run build
     cd backend && npm install && cd ..

3. Copy deploy/nginx.conf to /etc/nginx/sites-available/vendorconnect,
   edit server_name, then:
     sudo ln -s /etc/nginx/sites-available/vendorconnect /etc/nginx/sites-enabled/
     sudo rm -f /etc/nginx/sites-enabled/default
     sudo nginx -t && sudo systemctl reload nginx
     sudo certbot --nginx -d your.domain.com

4. Start the app:
     pm2 start deploy/ecosystem.config.js
     pm2 save

5. Restrict MongoDB to localhost only (default bindIp 127.0.0.1 in
   /etc/mongod.conf — confirm it, don't expose 27017 publicly).
EOF
