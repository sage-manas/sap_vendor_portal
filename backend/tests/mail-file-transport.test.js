const fs = require('fs');
const os = require('os');
const path = require('path');
const mailer = require('../utils/mailer');

// The browser suite reads the mail the API sent from another process, through
// MAIL_TRANSPORT=file. It exists for that and nothing else: like log and
// memory, it is refused in production, where mail must go over SMTP.

describe('MAIL_TRANSPORT=file', () => {
  const original = {};
  let dir;

  beforeEach(() => {
    for (const key of ['MAIL_TRANSPORT', 'MAIL_FILE', 'NODE_ENV']) original[key] = process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-file-'));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per message', async () => {
    process.env.MAIL_TRANSPORT = 'file';
    process.env.MAIL_FILE = path.join(dir, 'outbox.jsonl');

    await mailer.sendMail({ to: 'a@example.com', template: 'registrationExisting', data: { signInUrl: 'http://x/sign-in', resetUrl: 'http://x/forgot' } });
    await mailer.sendMail({ to: 'b@example.com', template: 'registrationExisting', data: { signInUrl: 'http://x/sign-in', resetUrl: 'http://x/forgot' } });

    const lines = fs.readFileSync(process.env.MAIL_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(lines.map((line) => line.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(lines[0]).toMatchObject({ transport: 'file', template: 'registrationExisting' });
  });

  it('needs somewhere to write', async () => {
    process.env.MAIL_TRANSPORT = 'file';
    delete process.env.MAIL_FILE;
    await expect(mailer.sendMail({ to: 'a@example.com', template: 'registrationExisting', data: {} })).rejects.toThrow(/MAIL_FILE/);
  });

  it('is not permitted in production', () => {
    process.env.MAIL_TRANSPORT = 'file';
    process.env.NODE_ENV = 'production';
    expect(() => mailer.assertMailerConfigured()).toThrow(/not permitted in production/);
  });
});
