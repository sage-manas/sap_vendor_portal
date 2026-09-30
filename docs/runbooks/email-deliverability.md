# Email deliverability (SMTP, SPF, DKIM, DMARC)

Invitations, supplier welcome mails and password resets are sent by the API over
SMTP (`MAIL_TRANSPORT=smtp`, which production requires; the server refuses to boot
without it). If they land in spam or are rejected, nobody can join or recover an
account, so this is part of go-live, not polish.

## 1. Choose the sending domain

Send from a domain you control, e.g. `no-reply@your.domain.com` (`MAIL_FROM`).
Use the **same domain** in `MAIL_FROM` as the one you authenticate below. A
dedicated sending subdomain (`mail.your.domain.com`) keeps this reputation apart
from staff mail.

## 2. SMTP account

Use a transactional provider or your own relay that supports authenticated
submission on 587 (STARTTLS) or 465. Then, in `backend/.env`:
```
MAIL_TRANSPORT=smtp
SMTP_HOST=<host>
SMTP_PORT=587          # 465 with SMTP_SECURE=true
SMTP_USER=<user>
SMTP_PASSWORD=<password>
MAIL_FROM=VendorConnect <no-reply@your.domain.com>
```
The mailer sends from this server's process; the server itself is **not** a mail
server, so no port 25 and no reverse-DNS work is needed on it.

## 3. DNS records (publish, then verify each)

Ask the SMTP provider for the exact values; the shapes are:

| Record | Host | Value | Purpose |
|---|---|---|---|
| SPF | `your.domain.com` (TXT) | `v=spf1 include:<provider spf> -all` | which servers may send for the domain |
| DKIM | `<selector>._domainkey.your.domain.com` (TXT or CNAME) | provider's public key | mail is signed and untampered |
| DMARC | `_dmarc.your.domain.com` (TXT) | `v=DMARC1; p=none; rua=mailto:dmarc@your.domain.com; adkim=s; aspf=s` to start | what receivers do with failures, and where reports go |

Rules of thumb:
- **One** SPF record per domain (two records make SPF invalid); merge includes into it.
  SPF has a limit of 10 DNS lookups.
- Start DMARC at `p=none` and read the aggregate reports for 2-4 weeks. When
  every legitimate source passes, move to `p=quarantine`, then `p=reject`.
- Because workspaces are subdomains (`acme.your.domain.com`), DMARC on the parent
  covers them. Mail is sent from `MAIL_FROM`'s domain, not from the workspace host.

## 4. Verify before go-live (a checklist to tick)

- [ ] `dig +short TXT your.domain.com` shows exactly one `v=spf1` record.
- [ ] `dig +short TXT <selector>._domainkey.your.domain.com` returns the key.
- [ ] `dig +short TXT _dmarc.your.domain.com` returns the policy.
- [ ] Send a real password-reset mail (Forgot password on a test workspace) to a
      Gmail address and to an Outlook/Microsoft 365 address. Open "Show original":
      `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] Send one to <https://www.mail-tester.com> and aim for 9/10 or better.
- [ ] The mail is in the inbox, not spam, at both providers.
- [ ] Bounces and complaints from the provider go to a mailbox someone reads.
- [ ] The reset and invitation links in the mail open the right workspace (see the
      note on `FRONTEND_URL` in the domain-model PR: links currently use one URL).

## 5. When mail stops arriving

1. `pm2 logs vendorconnect-api | grep -i mail` for SMTP errors (auth failed, connection refused).
2. Check the provider's dashboard for suppression, throttling or a suspended account.
3. Re-run the checklist in section 4; a changed DNS record or an expired DKIM key is the common cause.
4. While mail is down, a platform operator can reissue a tenant administrator's
   credentials from the console. A locked-out platform operator needs another
   operator, or `npm run seed:platform-admin` on the server as a last resort.
