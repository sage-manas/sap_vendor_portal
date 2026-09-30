// Starts the built app (`npm run build` first) and checks the security headers
// the pages are actually served with, and that the nonce in the
// Content-Security-Policy is the one the page's scripts carry.
//
//   npm run build && npm run check:headers
//
// The unit tests (src/lib/security-headers.test.js) cover the pieces; this covers
// the assembled result, which is where a proxy that is not wired up, a static
// page that has no nonce to take, or a header the framework overwrites shows up.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.CHECK_PORT) || 3111;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A sample of every plane: public, supplier, workspace, platform, and one that
// does not exist (the not-found page must carry the headers too).
const PAGES = ['/sign-in', '/', '/pos', '/workspace', '/workspace/users', '/platform', '/platform/tenants', '/no-such-page'];

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const waitUntilUp = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${ORIGIN}/sign-in`, { redirect: 'manual' });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`next start never answered on ${ORIGIN}\n${serverLog}`);
};

const directive = (csp, name) => (csp || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) || '';

try {
  await waitUntilUp();
  const nonces = new Set();

  for (const path of PAGES) {
    const response = await fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
    const html = await response.text();
    const at = `${path} (${response.status})`;
    const header = (name) => response.headers.get(name);

    const csp = header('content-security-policy');
    check(csp, `${at}: no Content-Security-Policy`);
    check(directive(csp, 'frame-ancestors') === "frame-ancestors 'none'", `${at}: frame-ancestors is not 'none'`);
    check(!directive(csp, 'script-src').includes("'unsafe-inline'"), `${at}: script-src allows unsafe-inline`);
    check(!directive(csp, 'script-src').includes("'unsafe-eval'"), `${at}: script-src allows unsafe-eval in production`);
    check(/max-age=\d{8,}/.test(header('strict-transport-security') || ''), `${at}: Strict-Transport-Security missing or short`);
    check(header('x-content-type-options') === 'nosniff', `${at}: X-Content-Type-Options is not nosniff`);
    check(header('referrer-policy') === 'strict-origin-when-cross-origin', `${at}: Referrer-Policy missing`);
    check(header('x-frame-options') === 'DENY', `${at}: X-Frame-Options is not DENY`);
    check(!header('x-powered-by'), `${at}: X-Powered-By is sent`);

    // Every script the page ships must carry this response's nonce, or the
    // browser will refuse to run it.
    const nonce = /'nonce-([^']+)'/.exec(csp || '')?.[1];
    check(nonce, `${at}: no nonce in the CSP`);
    if (nonce) {
      nonces.add(nonce);
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
      check(scripts.length > 0, `${at}: page has no scripts to check`);
      scripts.forEach((attrs) => {
        // The React Server Components payload and next's own bootstrap are also
        // scripts; all of them are nonce'd by Next once a nonce is in the CSP.
        const own = /\bnonce="([^"]*)"/.exec(attrs)?.[1];
        check(own === nonce, `${at}: <script ${attrs.trim().slice(0, 80)}> carries nonce ${own ?? '(none)'}, expected ${nonce}`);
      });
    }
  }

  check(nonces.size === PAGES.length, `expected a different nonce on each of ${PAGES.length} requests, saw ${nonces.size}`);
} catch (error) {
  failures.push(error.message);
} finally {
  server.kill();
}

if (failures.length) {
  console.error(`Security header check FAILED (${failures.length}):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(`Security header check passed for ${PAGES.length} pages.`);
