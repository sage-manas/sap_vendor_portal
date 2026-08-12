const nodemailer = require('nodemailer');
const logger = require('./logger');
const { render } = require('../config/emailTemplates');

// The mailer. Phase 2 replaces "log the reset link and hope an operator reads
// the file" with a real transport (ADR-0011).
//
// Transport selection, in order: MAIL_TRANSPORT, else smtp in production,
// memory under test, log in development. Production boot fails loudly if SMTP
// is unconfigured — silently degrading to logs is exactly what we removed.
//
// Bodies contain reset links and temporary passwords, so they are never
// written to the log. The `log` transport prints recipient, subject and
// template name; set MAIL_DEBUG_BODY=true in development only to see the body.

const SENT = []; // memory transport (tests read this)

const chooseTransportName = () => {
  if (process.env.MAIL_TRANSPORT) return process.env.MAIL_TRANSPORT;
  if (process.env.NODE_ENV === 'production') return 'smtp';
  if (process.env.NODE_ENV === 'test') return 'memory';
  return 'log';
};

let smtpTransport;

const getSmtpTransport = () => {
  if (smtpTransport) return smtpTransport;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE } = process.env;
  if (!SMTP_HOST) {
    throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST (and normally SMTP_PORT/SMTP_USER/SMTP_PASSWORD)');
  }

  smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
  });
  return smtpTransport;
};

const fromAddress = () => process.env.MAIL_FROM || 'VendorConnect <no-reply@vendorconnect.local>';

/**
 * Sends a templated email.
 *
 * @param {object} args
 * @param {string} args.to          recipient address
 * @param {string} args.template    key in config/emailTemplates.js
 * @param {object} args.data        template data
 * @returns {Promise<{transport: string, to: string, subject: string, template: string}>}
 */
const sendMail = async ({ to, template, data = {} }) => {
  if (!to) throw new Error('sendMail requires a recipient');

  const { subject, text, html } = render(template, data);
  const transportName = chooseTransportName();
  const record = { transport: transportName, to, subject, template, text, html, sentAt: new Date() };

  switch (transportName) {
    case 'memory':
      SENT.push(record);
      break;

    case 'log':
      logger.info(`[mail:${template}] to=${to} subject="${subject}" (body withheld)`);
      if (process.env.MAIL_DEBUG_BODY === 'true' && process.env.NODE_ENV !== 'production') {
        logger.debug(`[mail:${template}] body:\n${text}`);
      }
      SENT.push(record);
      break;

    case 'smtp':
      await getSmtpTransport().sendMail({ from: fromAddress(), to, subject, text, html });
      logger.info(`[mail:${template}] delivered to=${to} subject="${subject}"`);
      break;

    default:
      throw new Error(`Unknown MAIL_TRANSPORT "${transportName}" (expected smtp, log or memory)`);
  }

  return { transport: transportName, to, subject, template };
};

// Called at boot: fail now, not the first time someone resets a password.
const assertMailerConfigured = () => {
  const transportName = chooseTransportName();
  if (transportName === 'smtp') {
    getSmtpTransport();
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `MAIL_TRANSPORT="${transportName}" is not permitted in production — invitations and password resets must be delivered over SMTP`
    );
  }
};

// Test helpers for the memory/log transports.
const sentMails = () => [...SENT];
const lastMailTo = (to) => [...SENT].reverse().find((mail) => mail.to === to.toLowerCase() || mail.to === to) || null;
const clearMails = () => { SENT.length = 0; };

module.exports = { sendMail, assertMailerConfigured, sentMails, lastMailTo, clearMails, chooseTransportName };
