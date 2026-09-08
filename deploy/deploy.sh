#!/usr/bin/env bash
# Pulls latest, rebuilds, and restarts both processes. Run from the repo root
# on the server (e.g. via SSH after merging to your deploy branch).
set -euo pipefail

BRANCH="${1:-master}"

git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "== Frontend =="
npm install
npm run build

echo "== Backend =="
cd backend
npm install
cd ..

echo "== Restart =="
pm2 reload deploy/ecosystem.config.js --update-env
pm2 save

echo "Deployed $BRANCH at $(date -u +%FT%TZ)"
