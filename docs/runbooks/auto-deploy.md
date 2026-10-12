# Auto-deploy from master

The server deploys `master` by itself. `deploy/auto-deploy.sh` runs from cron
every three minutes, and when `master` has moved **and every CI check on that
commit is green** it runs `deploy/deploy.sh`: install, build, `prisma migrate
deploy`, then a PM2 reload.

It pulls rather than being pushed to because the server's SSH port is not
reachable from the internet, so a GitHub Actions job could not log in. The
repository is public, so the server needs no credentials to read it.

## What it will and won't do

- Deploys only a commit whose checks have all finished green: every check run
  GitHub reports on that commit (the `Tests` workflow, plus any other that runs on
  push). Pending → waits. Failed → does not deploy, and says so in
  `status`.
- Applies database migrations **automatically**. A migration that drops or
  rewrites data therefore goes live minutes after it merges. Review those in the
  PR as if you were pressing the button yourself.
- Rebuilds in place, so the site can return errors for roughly a minute while
  `next build` rewrites `.next`, then again briefly at the PM2 reload.
- Never touches `backend/.env` or `.env.production` (neither is in git). It
  copies `backend/.env` into `/opt/vp/backups/` before every deploy and keeps
  the last ten.
- Leaves out the documentation (see "The checkout" below).

## One-time setup

On the server, as the deploy user, with Node and PM2 already installed under nvm
and the app already running from `/opt/vp/app` (an extracted archive is fine).

```bash
cd /opt/vp/app
cp backend/.env /opt/vp/backups/backend.env.pre-autodeploy
cp .env.production /opt/vp/backups/env.production.pre-autodeploy

git init -q -b master
git remote add origin https://github.com/sage-manas/sap_vendor_portal.git
git sparse-checkout set --no-cone '/*' '!/docs/' '!/audit-issues/' '!/claude/' \
  '!/.cursor/' '!/.gemini/' '!/.impeccable/' '!/*.png' '!/backend/**/*.md' \
  '!/AGENTS.md' '!/CLAUDE.md' '!/DECISIONS.md' '!/HOSTING_PROVIDER_HANDOFF.md' \
  '!/PROJECT_CONTEXT.md' '!/SERVER_SETUP_QUICK_READ.md' '!/product-info-vendor-portal.md'
git fetch -q --depth 1 origin master
git checkout -q -f -B master FETCH_HEAD
ls

mkdir -p /opt/vp/logs /opt/vp/state
bash deploy/auto-deploy.sh        # first run: builds and deploys what is now checked out
cat /opt/vp/state/status          # "deployed <sha> at <time>"

( crontab -l 2>/dev/null; echo '*/3 * * * * /bin/bash /opt/vp/app/deploy/auto-deploy.sh >> /opt/vp/logs/auto-deploy.log 2>&1' ) | crontab -
crontab -l
```

`ls` should show `README.md`, `deploy/`, `backend/`, `src/` and `.env.production`
and none of the documentation. `backend/.env` is untouched.

## Day to day

| I want to | Do |
| --- | --- |
| See what it is doing | `cat /opt/vp/state/status` |
| See deploy history | `tail -50 /opt/vp/logs/auto-deploy.log` (quiet unless a deploy runs) |
| Which commit is live | `cat /opt/vp/state/deployed-sha` |
| Deploy now, CI or not | `FORCE=1 bash /opt/vp/app/deploy/auto-deploy.sh` |
| Pause auto-deploy | `crontab -e` and comment the line out |
| Resume | Uncomment it |
| Roll back | Revert the commit on `master` and merge the revert; it deploys like anything else |

## When a deploy fails

The script marks the commit failed, restores the checkout to the last good
commit, and does not retry that commit. It tries again when `master` moves.

- **Failed at install or build** (the log shows no "Database migrations"
  heading): nothing was restarted and the database is untouched. The old
  processes are still serving, though a half-finished build can leave `.next`
  inconsistent; if the site misbehaves, run
  `cd /opt/vp/app && npm run build && pm2 restart vendorconnect-web`.
- **Failed at or after "Database migrations"**: the database may be partly
  migrated while the old code still runs. Do not re-run blindly. Read the
  migration error, check `backend/prisma/migrations`, and if needed restore from
  the nightly backup (`backup-restore.md`). Fix forward on `master`.
- **Failed at the PM2 reload**: the new build and schema are in place; run
  `pm2 status` and `pm2 logs --lines 50 --nostream`.

## The checkout

`/opt/vp/app` is a shallow, sparse git checkout of `master`. The sparse rules
keep documentation, design screenshots and AI-tool folders off the server, so a
deploy never brings them back. If a new top-level folder should also stay off the
server, add it to the `sparse-checkout set` list and run the same command again.

Do not edit tracked files on the server: every deploy runs `git reset --hard`
and the edit is gone. Configuration belongs in `backend/.env` or
`.env.production`, which git ignores.

## Requirements

`git`, `flock`, Node 18+ from nvm (the CI check uses its `fetch`), outbound
HTTPS to `github.com` and `api.github.com`. GitHub's unauthenticated API allows 60
requests an hour per address; the script calls it only when `master` has moved,
so a deploy day stays far below that. If it ever reports "could not read CI
status", it simply tries again on the next tick.
