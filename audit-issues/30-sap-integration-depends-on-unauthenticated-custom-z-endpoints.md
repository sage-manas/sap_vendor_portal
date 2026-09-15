<!-- title: RISK: the entire SAP integration depends on custom Z REST endpoints that are documented as unauthenticated -->
<!-- labels: security,severity:high,area:sap,documentation -->

**Severity:** High as a programme risk — not a defect in this codebase, but the assumption
the codebase is built on.

## Summary

Every read the portal performs, and the one vendor-master write, go to customer-specific Z
REST services rather than standard SAP APIs:

`/zpo_grn_vendor/Detail`, `/zmiro_display/MIRO`, `/zpayment_api/payment`,
`/zvendor_create/VENDOR_CR`, `/zinv_milestone/plan`, `/ZME43/ME43`, `/ZCL_ME48/vendor`,
`/ZQUOT_NETPR/QUOT_UPDPR`, `/ZREGION_CODE/REGION`, `/zpaym_term/PAY_TERM`,
`/ZPAYM_METHOD/PAYM_METHOD`.

The driver documents that these are open while the standard OData gateway requires
credentials the tenant does not have. In other words, vendor master creation, the MIRO
ledger, payment detail including UTR references, and full purchase-order history are
currently reachable on that system without authentication.

Two consequences follow:

1. **Security.** This is a serious exposure on the customer's SAP system. The first time
   their Basis or security team reviews it, those endpoints get locked down — and every
   integration in this portal stops at once.
2. **Portability.** The driver is coded against one specific sandbox's custom services. A
   second customer will not have them, so onboarding customer two means either building the
   same eleven Z services in their landscape or writing a different driver against standard
   APIs.

## Evidence

`backend/sap/drivers/s4odata.driver.js:1091-1099`:
> "this instance's Z REST endpoints (VENDOR_CR, the MIRO/payment/PO-GRN displays, ...) are
> deliberately open, but its OData gateway needs a technical user this tenant's
> SapConnection has no credentials for"

`backend/sap/drivers/s4odata.driver.js:45-48` — auth is optional and silently omitted when
absent:
```js
const authHeader = (secrets) => {
  if (!secrets.username || !secrets.password) return undefined;
```

`backend/sap/drivers/s4odata.driver.js:1281-1295` — the full Z path catalogue in
`configFields`.

Related: `getWithBody` (`:76-104`) exists because one Z service reads its filter from a GET
request body — a pattern many proxies and load balancers strip, so this will behave
differently behind the customer's production infrastructure than it does against the sandbox.

## Expected

- The customer's Basis team is told, explicitly and in writing, what these endpoints expose.
- Authentication is enabled on them, with a technical user issued to the portal.
- The portal is tested against the authenticated versions before go-live.
- A standard-API path is scoped for customer two.

## Suggested fix

Immediate, and not a code change: write this up for the customer's Basis and security teams,
listing each endpoint and the data it returns. Treat continued open access as a blocker for
production, not a convenience.

In code: make credentials mandatory in `validateConfig` for the production environment, so a
tenant cannot be promoted to production on an unauthenticated connection.

Medium term: assess which of the eleven can be replaced by standard OData services
(`API_PURCHASEORDER_PROCESS_SRV`, `API_SUPPLIERINVOICE_PROCESS_SRV`,
`API_BUSINESS_PARTNER` are already declared in `services()` but unused for these paths), and
record which genuinely need custom ABAP. That list is also the input to the filtering asks in
#13 and #20.

## Acceptance criteria

- [ ] Written disclosure to the customer's Basis/security team, acknowledged.
- [ ] Authentication enabled on all Z endpoints, portal tested against them.
- [ ] `validateConfig` requires credentials for `environment = production`.
- [ ] A standard-versus-custom matrix exists for the eleven endpoints.
