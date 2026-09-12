const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// SERVER_SETUP_QUICK_READ.md is the document handed to whoever hosts this. It
// has twice named a variable set that does not actually boot — MONGO_URI after
// the Postgres migration, and it never mentioned the CLERK_* keys that
// validateEnv hard-required in production. So the documented set is read from
// the document itself here: if the two drift again, this fails rather than an
// operator's first deploy.

const DOC = path.join(__dirname, '..', '..', 'SERVER_SETUP_QUICK_READ.md');
const SERVER = path.join(__dirname, '..', 'server.js');

const documentedEnv = () => {
  const doc = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const block = doc.match(/## Required Backend Environment[\s\S]*?```text\n([\s\S]*?)```/);
  if (!block) throw new Error('Could not find the "Required Backend Environment" block in SERVER_SETUP_QUICK_READ.md');

  return Object.fromEntries(
    block[1].split('\n').filter((line) => line.includes('=')).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1)];
    })
  );
};

// server.js loads backend/.env, which on a developer machine may still carry
// variables that are not part of the documented set — including the retired
// ones this issue is about. dotenv never overrides a key already present in
// the environment, and validateEnv reads '' as unset, so passing them empty is
// how the child is held to exactly the documented set. CI has no backend/.env
// and is strict without this.
const NOT_IN_THE_DOCUMENTED_SET = {
  CLERK_SECRET_KEY: '',
  CLERK_PUBLISHABLE_KEY: '',
  CLERK_WEBHOOK_SIGNING_SECRET: '',
  MONGO_URI: '',
  ADMIN_BOOTSTRAP_EMAILS: '',
};

// The doc carries <placeholders>; substitute the few that must be real for a
// boot to get as far as listening. Anything NOT named here is passed through
// exactly as documented — a variable the doc omits stays omitted, which is the
// whole point of the test.
const runnableValues = (documented, port) => ({
  ...NOT_IN_THE_DOCUMENTED_SET,
  ...documented,
  PORT: String(port),
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'boot-smoke-test-secret',
  MASTER_KEY: 'boot-smoke-test-master-key',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'boot-smoke',
  SMTP_PASSWORD: 'boot-smoke',
  MAIL_FROM: 'VendorConnect <no-reply@example.com>',
  FRONTEND_URL: 'https://example.com',
  ALLOWED_ORIGINS: 'https://example.com',
});

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const accepts = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => { socket.destroy(); resolve(false); });
});

// Boots server.js in a child process with ONLY the given env (no inherited
// shell environment, which would mask a missing variable) and resolves with
// how it ended: listening, or exited with this output.
//
// Readiness is "the port accepts a connection", not a log line: in production
// the logger has no console transport (utils/logger.js), so a successful boot
// is silent on stdout. A failed one is not — validateEnv writes to stderr
// directly, which is what the failure assertions read.
const boot = (env, port) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let done = false;
  const settle = (result) => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    child.kill('SIGKILL');
    resolve({ ...result, output });
  };

  const deadline = setTimeout(() => settle({ listening: false, timedOut: true }), 25000);

  const collect = (chunk) => { output += chunk.toString(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code) => settle({ listening: false, exitCode: code }));

  const poll = async () => {
    while (!done) {
      if (await accepts(port)) return settle({ listening: true });
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  poll();
});

describe('production boot with exactly the documented environment', () => {
  // Real boot: spawns a process, connects to Postgres, binds a port.
  jest.setTimeout(60000);

  it('starts and listens', async () => {
    const port = await freePort();
    const env = runnableValues(documentedEnv(), port);

    const result = await boot(env, port);

    // On failure the server's own error line is the most useful thing to see.
    expect(result.output).not.toMatch(/Missing strictly required env variables/);
    expect(result.listening).toBe(true);
  });

  it('documents NODE_ENV=production — the setting these crashes only appeared under', () => {
    expect(documentedEnv().NODE_ENV).toBe('production');
  });

  it('documents DATABASE_URL, not the retired MONGO_URI', () => {
    const documented = documentedEnv();
    expect(documented).toHaveProperty('DATABASE_URL');
    expect(documented).not.toHaveProperty('MONGO_URI');
  });

  it('refuses to start in production without MASTER_KEY, at boot rather than on first use', async () => {
    const port = await freePort();
    const env = runnableValues(documentedEnv(), port);
    delete env.MASTER_KEY;

    const result = await boot(env, port);

    expect(result.listening).toBe(false);
    expect(result.output).toMatch(/MASTER_KEY is required/);
  });

  it('refuses to start when a retired Clerk or Mongo variable is still set', async () => {
    const port = await freePort();
    const env = runnableValues(documentedEnv(), port);
    env.CLERK_SECRET_KEY = 'sk_test_left_over';

    const result = await boot(env, port);

    expect(result.listening).toBe(false);
    expect(result.output).toMatch(/Retired env variables/);
  });
});
