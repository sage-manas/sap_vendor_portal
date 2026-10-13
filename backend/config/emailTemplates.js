// The single registry of outbound email. Nothing composes a subject or body
// inline; call sites name a template and pass data. Adding a notification means
// adding a key here.
//
// Bodies are written with the `line` tagged template, which escapes every
// interpolated value for HTML (issue #247). The rule that makes that safe is
// simple and worth keeping: a template literal here contains prose only, never
// markup. Emphasis, links and code spans come from the `link`/`strong`/`em`/
// `code` helpers, so the HTML part of a body is only ever markup this file
// wrote plus escaped data — a supplier called `<script>` or an SAP reason
// containing `"` cannot close a tag or an attribute. It also means the plain
// text part is genuinely plain text rather than HTML with the tags left in.

const APP_NAME = 'VendorConnect';

const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// Tenant-aware link base. Phase 6 turns the slug into a real subdomain; until
// then the slug rides as a query parameter that resolveClient understands.
const workspaceUrl = (path, clientSlug) => {
  const base = `${frontendUrl()}${path}`;
  return clientSlug ? `${base}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(clientSlug)}` : base;
};

// Subjects are a mail header: a newline in a company name must not be able to
// start one of its own.
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// A rendered fragment carries both representations and is branded, so `line`
// can tell "markup this file produced" from "a value a caller passed". Without
// the brand, data that happened to be an object with html/text keys would ride
// through unescaped, which is the hole this is here to close.
const FRAGMENT = Symbol('emailFragment');
const fragment = (html, text) => ({ [FRAGMENT]: true, html, text });
const isFragment = (value) => Boolean(value && value[FRAGMENT]);

// Links are built in this file from frontendUrl() and a token, never from
// caller data; the scheme check is a seatbelt so a future call site cannot
// smuggle `javascript:` into an href.
const safeUrl = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? String(url) : '#');
const link = (url, label) => fragment(
  `<a href="${escapeHtml(safeUrl(url))}">${escapeHtml(label ?? url)}</a>`,
  // A labelled link has to carry its destination into the text part, or a
  // text-only reader has nothing to follow.
  label === undefined || label === url ? String(url ?? '') : `${label} (${url})`
);
const strong = (value) => fragment(`<strong>${escapeHtml(value)}</strong>`, String(value ?? ''));
const em = (value) => fragment(`<em>${escapeHtml(value)}</em>`, String(value ?? ''));
const code = (value) => fragment(`<code>${escapeHtml(value)}</code>`, String(value ?? ''));

/**
 * One line of an email body. Interpolated values are escaped unless they are
 * fragments from the helpers above (which nest, so a line can be built from
 * conditional pieces).
 */
const line = (strings, ...values) => {
  const parts = values.map((value) => (isFragment(value) ? value : fragment(escapeHtml(value), String(value ?? ''))));
  const join = (key) => strings.reduce((acc, literal, index) => acc + literal + (index < parts.length ? parts[index][key] : ''), '');
  return fragment(join('html'), join('text'));
};

const layout = (heading, lines) => ({
  text: [heading, '', ...lines.map((body) => body.text), '', `— ${APP_NAME}`].join('\n'),
  html: `<div style="font-family:system-ui,sans-serif;line-height:1.5">
  <h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>
  ${lines.map((body) => `<p style="margin:0 0 12px">${body.html}</p>`).join('\n  ')}
  <p style="margin:24px 0 0;color:#666;font-size:12px">— ${APP_NAME}</p>
</div>`,
});

const TEMPLATES = {
  // { name, resetUrl, expiresInMinutes }
  passwordReset: ({ name, resetUrl, expiresInMinutes = 60 }) => ({
    subject: `${APP_NAME}: reset your password`,
    ...layout(`Reset your password`, [
      line`Hello${name ? ` ${name}` : ''},`,
      line`Use the link below to choose a new password. It expires in ${expiresInMinutes} minutes and works once.`,
      line`${link(resetUrl)}`,
      line`If you did not request this, no action is needed — your password has not changed.`,
    ]),
  }),

  // Registration is answered identically whether or not the address is already
  // known (finding 1.4), so what a visitor learns arrives by email, addressed
  // to whoever owns the mailbox.

  // { companyName, workspaceName, confirmUrl, expiresInHours }
  registrationConfirm: ({ companyName, workspaceName, confirmUrl, expiresInHours = 24 }) => ({
    subject: `${APP_NAME}: confirm your email to finish registering`,
    ...layout(`Confirm your email`, [
      line`Hello${companyName ? ` ${companyName}` : ''},`,
      line`Someone registered this address as a supplier${workspaceName ? ` of ${workspaceName}` : ''} on ${APP_NAME}. To finish, open the link below and enter the password you chose.`,
      line`${link(confirmUrl)}`,
      line`The link expires in ${expiresInHours} hours. If this was not you, ignore this email — nothing is created until it is confirmed.`,
    ]),
  }),

  // { signInUrl, resetUrl }
  registrationExisting: ({ signInUrl, resetUrl }) => ({
    subject: `${APP_NAME}: you already have an account`,
    ...layout(`You already have an account`, [
      line`Someone tried to register this email address on ${APP_NAME}, but it already belongs to an account.`,
      line`If that was you, ${link(signInUrl, 'sign in')}, or ${link(resetUrl, 'reset your password')} if you have forgotten it.`,
      line`If it was not you, no action is needed.`,
    ]),
  }),

  // { workspaceName, reason }
  registrationRefused: ({ workspaceName, reason }) => ({
    subject: `${APP_NAME}: your registration could not be completed`,
    ...layout(`We could not complete your registration`, [
      line`Someone used this email address to register as a supplier${workspaceName ? ` of ${workspaceName}` : ''}, and it could not be completed: ${reason}`,
      line`If that was you, please contact ${workspaceName || 'your buyer'} directly. If it was not you, no action is needed.`,
    ]),
  }),

  // { name, inviterName, companyName, role, acceptUrl }
  invitation: ({ name, inviterName, companyName, role, acceptUrl }) => ({
    subject: `${APP_NAME}: you have been invited to ${oneLine(companyName)}`,
    ...layout(`Join ${companyName} on ${APP_NAME}`, [
      line`Hello${name ? ` ${name}` : ''},`,
      line`${inviterName || 'An administrator'} has invited you to ${companyName} as ${strong(role)}.`,
      line`${link(acceptUrl, 'Accept the invitation')}`,
      line`This invitation expires in 7 days.`,
    ]),
  }),

  // { name, companyName, email, temporaryPassword, loginUrl }
  tenantAdminCredentials: ({ name, companyName, email, temporaryPassword, loginUrl }) => ({
    subject: `${APP_NAME}: your ${oneLine(companyName)} workspace is ready`,
    ...layout(`Your workspace is ready`, [
      line`Hello${name ? ` ${name}` : ''},`,
      line`The ${companyName} workspace has been created for you.`,
      line`Sign in at ${link(loginUrl)} with ${strong(email)} and the temporary password below.`,
      line`${code(temporaryPassword)}`,
      line`You will be asked to choose a new password the first time you sign in.`,
    ]),
  }),

  // A supplier a tenant added from its own directory: the record exists, the
  // account has no password anyone knows, and this link is how they claim it.
  // { companyName, workspaceName, vendorId, setPasswordUrl, expiresInMinutes }
  supplierWelcome: ({ companyName, workspaceName, vendorId, setPasswordUrl, expiresInMinutes = 60 }) => ({
    subject: `${APP_NAME}: ${oneLine(workspaceName)} has added you as a supplier`,
    ...layout(`${workspaceName} has added you as a supplier`, [
      line`Hello${companyName ? ` ${companyName}` : ''},`,
      line`${workspaceName} has created a supplier record for you on ${APP_NAME}. Your supplier ID is ${strong(vendorId)}.`,
      line`${link(setPasswordUrl, 'Choose a password')} to sign in and complete your onboarding details.`,
      line`This link expires in ${expiresInMinutes} minutes. You can request a new one from the sign-in page at any time.`,
    ]),
  }),

  // { companyName, workspaceName, approved, reason, sapVendorCode, portalUrl }
  supplierDecision: ({ companyName, workspaceName, approved, reason, sapVendorCode, portalUrl }) => ({
    subject: `${APP_NAME}: ${oneLine(workspaceName)} has ${approved ? 'approved' : 'declined'} your registration`,
    ...layout(
      approved ? `Your registration was approved` : `Your registration was not approved`,
      [
        line`Hello${companyName ? ` ${companyName}` : ''},`,
        approved
          ? line`${workspaceName} has approved your supplier registration${sapVendorCode ? line`, and your vendor master code is ${strong(sapVendorCode)}` : ''}.`
          : line`${workspaceName} has not approved your supplier registration.`,
        ...(approved ? [] : [line`Reason given: ${em(reason || 'no reason recorded')}`]),
        line`${link(portalUrl, 'Open the supplier portal')}`,
      ]
    ),
  }),

  // { name, email, temporaryPassword, loginUrl }
  operatorCredentials: ({ name, email, temporaryPassword, loginUrl }) => ({
    subject: `${APP_NAME}: your operator account`,
    ...layout(`Your operator account`, [
      line`Hello${name ? ` ${name}` : ''},`,
      line`An operator account has been created for you on the ${APP_NAME} platform console.`,
      line`Sign in at ${link(loginUrl)} with ${strong(email)} and the temporary password below.`,
      line`${code(temporaryPassword)}`,
      line`You will be asked to choose a new password, and to enrol in multi-factor authentication, on first sign-in.`,
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

module.exports = { TEMPLATES, render, workspaceUrl, frontendUrl, APP_NAME, escapeHtml };
