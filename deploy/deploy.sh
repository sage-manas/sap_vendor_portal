#!/usr/bin/env bash
# Pulls latest, rebuilds, migrates the database and restarts every process.
# Run from the repo root on the server (e.g. via SSH after merging to your
# deploy branch).
#
# Order matters: everything that can fail without touching production state
# (install, generate, build) runs first, so a broken build stops the deploy
# before the database is migrated or a process is restarted. Migrations run
# before the reload, because new code may read columns only they create.
set -euo pipefail

BRANCH="${1:-master}"

git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

# --include=dev: the Next build and the Prisma CLI are devDependencies, and
# npm would silently drop them if the shell happens to export
# NODE_ENV=production.
echo "== Frontend =="
npm ci --include=dev
npm run build

echo "== Backend =="
cd backend
npm ci --include=dev
npx prisma generate

echo "== Database migrations =="
npx prisma migrate deploy
cd ..

echo "== Restart =="
pm2 reload deploy/ecosystem.config.js --update-env
pm2 save

echo "Deployed $BRANCH ($(git rev-parse --short HEAD)) at $(date -u +%FT%TZ)"
