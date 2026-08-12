// The single registry of outbound email. Nothing composes a subject or body
// inline; call sites name a template and pass data. Adding a notification means
// adding a key here.

const APP_NAME = 'VendorConnect';

const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// Tenant-aware link base. Phase 6 turns the slug into a real subdomain; until
// then the slug rides as a query parameter that resolveClient understands.
const workspaceUrl = (path, clientSlug) => {
  const base = `${frontendUrl()}${path}`;
  return clientSlug ? `${base}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(clientSlug)}` : base;
};

const layout = (heading, lines) => ({
  text: [heading, '', ...lines, '', `— ${APP_NAME}`].join('\n'),
  html: `<div style="font-family:system-ui,sans-serif;line-height:1.5">
  <h2 style="margin:0 0 16px">${heading}</h2>
  ${lines.map((line) => `<p style="margin:0 0 12px">${line}</p>`).join('\n  ')}
  <p style="margin:24px 0 0;color:#666;font-size:12px">— ${APP_NAME}</p>
</div>`,
});

const TEMPLATES = {
  // { name, resetUrl, expiresInMinutes }
  passwordReset: ({ name, resetUrl, expiresInMinutes = 60 }) => ({
    subject: `${APP_NAME}: reset your password`,
    ...layout(`Reset your password`, [
      `Hello${name ? ` ${name}` : ''},`,
      `Use the link below to choose a new password. It expires in ${expiresInMinutes} minutes and works once.`,
      `<a href="${resetUrl}">${resetUrl}</a>`,
      `If you did not request this, no action is needed — your password has not changed.`,
    ]),
  }),

  // { name, inviterName, companyName, role, acceptUrl }
  invitation: ({ name, inviterName, companyName, role, acceptUrl }) => ({
    subject: `${APP_NAME}: you have been invited to ${companyName}`,
    ...layout(`Join ${companyName} on ${APP_NAME}`, [
      `Hello${name ? ` ${name}` : ''},`,
      `${inviterName || 'An administrator'} has invited you to ${companyName} as <strong>${role}</strong>.`,
      `<a href="${acceptUrl}">Accept the invitation</a>`,
      `This invitation expires in 7 days.`,
    ]),
  }),

  // { name, companyName, email, temporaryPassword, loginUrl }
  tenantAdminCredentials: ({ name, companyName, email, temporaryPassword, loginUrl }) => ({
    subject: `${APP_NAME}: your ${companyName} workspace is ready`,
    ...layout(`Your workspace is ready`, [
      `Hello${name ? ` ${name}` : ''},`,
      `The ${companyName} workspace has been created for you.`,
      `Sign in at <a href="${loginUrl}">${loginUrl}</a> with <strong>${email}</strong> and the temporary password below.`,
      `<code>${temporaryPassword}</code>`,
      `You will be asked to choose a new password the first time you sign in.`,
    ]),
  }),

  // { name, email, temporaryPassword, loginUrl }
  operatorCredentials: ({ name, email, temporaryPassword, loginUrl }) => ({
    subject: `${APP_NAME}: your operator account`,
    ...layout(`Your operator account`, [
      `Hello${name ? ` ${name}` : ''},`,
      `An operator account has been created for you on the ${APP_NAME} platform console.`,
      `Sign in at <a href="${loginUrl}">${loginUrl}</a> with <strong>${email}</strong> and the temporary password below.`,
      `<code>${temporaryPassword}</code>`,
      `You will be asked to choose a new password, and to enrol in multi-factor authentication, on first sign-in.`,
    ]),
  }),
};

const render = (templateName, data = {}) => {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown email template: ${templateName}`);
  }
  return template(data);
};

module.exports = { TEMPLATES, render, workspaceUrl, frontendUrl, APP_NAME };
