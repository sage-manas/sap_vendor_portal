const { TEMPLATES, render } = require('../config/emailTemplates');

// Issue #247. Every value in an outbound email is data someone else chose: a
// company name typed into a public registration form, a decline reason typed by
// a buyer, an SAP vendor code. `layout()` used to drop them into HTML as they
// came, so `<img src=x onerror=...>` in a company name was markup in the
// mailbox of whoever received the mail — and a quote in a value could break out
// of an href.
//
// These tests render every template in the registry with one hostile payload in
// every field, so a template added later is covered without anyone remembering
// to come back here.

const PAYLOAD = '<img src=x onerror="alert(1)">\'&';
const ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;';

// Every field any template reads, all hostile. URLs are deliberately not URLs:
// a template must not produce a working href out of one.
const hostileData = () => ({
  name: PAYLOAD,
  companyName: PAYLOAD,
  workspaceName: PAYLOAD,
  inviterName: PAYLOAD,
  role: PAYLOAD,
  email: PAYLOAD,
  temporaryPassword: PAYLOAD,
  vendorId: PAYLOAD,
  sapVendorCode: PAYLOAD,
  reason: PAYLOAD,
  expiresInMinutes: PAYLOAD,
  expiresInHours: PAYLOAD,
  resetUrl: PAYLOAD,
  confirmUrl: PAYLOAD,
  signInUrl: PAYLOAD,
  acceptUrl: PAYLOAD,
  loginUrl: PAYLOAD,
  setPasswordUrl: PAYLOAD,
  portalUrl: PAYLOAD,
});

const templateNames = Object.keys(TEMPLATES);

describe('every email template escapes the values it is given', () => {
  it.each(templateNames)('%s', (templateName) => {
    // supplierDecision branches on `approved`; render both sides.
    for (const approved of [true, false]) {
      const { subject, html, text } = render(templateName, { ...hostileData(), approved });

      expect(html).not.toContain(PAYLOAD);
      // Nothing a value contains may open a tag or close an attribute:
      // `onerror=` surviving as text is fine, inside a tag it is not.
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/<[^>]*onerror/i);

      // The subject is a header, so a newline in a value must not start one.
      expect(subject).not.toMatch(/[\r\n]/);
    }
  });

  // The loop above proves no template emits the payload as markup. This says
  // what it emits instead, so "escaped" cannot quietly become "dropped".
  it('shows a hostile value as text, escaped', () => {
    const { html, text } = render('registrationRefused', { workspaceName: 'Northwind', reason: PAYLOAD });
    expect(html).toContain(ESCAPED);
    expect(text).toContain(PAYLOAD);
  });

  it('keeps the markup the template itself wrote', () => {
    const { html, text } = render('invitation', {
      name: 'Asha', inviterName: 'Ravi', companyName: 'Northwind', role: 'finance',
      acceptUrl: 'https://portal.example.com/invite?token=abc',
    });

    expect(html).toContain('<strong>finance</strong>');
    expect(html).toContain('<a href="https://portal.example.com/invite?token=abc">Accept the invitation</a>');
    // A labelled link still has to carry its URL into the text part, or the
    // text-only reader has nothing to click.
    expect(text).toContain('Accept the invitation (https://portal.example.com/invite?token=abc)');
    // ...and keeps it out of the plain text part, which used to carry the raw
    // tags of every line.
    expect(text).not.toMatch(/<\/?(a|strong|em|code|div|p|h2)\b/i);
  });

  it('refuses a link scheme that is not http(s)', () => {
    const { html } = render('passwordReset', { name: 'Asha', resetUrl: 'javascript:alert(1)' });
    // Shown as text, never as a destination.
    expect(html).toContain('<a href="#">javascript:alert(1)</a>');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('does not let a value pose as pre-rendered markup', () => {
    // `line` passes its own fragments through unescaped; a plain object that
    // merely looks like one must still be escaped.
    const { html } = render('registrationRefused', {
      workspaceName: { html: '<script>alert(1)</script>', text: 'x' },
      reason: 'declined',
    });
    expect(html).not.toContain('<script>');
  });

  it('strips a newline a value tries to add to the subject', () => {
    const { subject } = render('supplierWelcome', {
      workspaceName: 'Northwind\r\nBcc: attacker@example.com',
      companyName: 'Acme', vendorId: 'V-1', setPasswordUrl: 'https://portal.example.com/set',
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('Bcc: attacker@example.com');
  });
});
