<!-- title: BUG: purchase orders carry no company code or purchasing organisation, and the sweep discards the one SAP returns -->
<!-- labels: bug,severity:high,area:sap,area:data,backend -->

**Severity:** High — a legal-entity data boundary problem, not only a modelling gap.

## Summary

`PurchaseOrder` has no `companyCode`, `purchasingOrg`, `purchasingGroup` or document type.
`vendorPoGrnDisplay` returns `COM_CODE`, and `sweepPurchaseOrders` drops it, because there is
nowhere to put it.

Every SAP read is keyed on the vendor code (`LIFNR`) alone with no company-code filter. A
supplier who trades with several legal entities in the customer's group therefore has all of
their orders pulled into whichever single tenant is configured — orders belonging to a
different company code, visible to staff who have no business seeing them.

MIRO and F110 are both company-code scoped, so the same gap makes correct reconciliation
impossible even in the single-entity case if the tenant ever spans two codes.

## Evidence

`backend/prisma/schema.prisma:449-501` — the `PurchaseOrder` model. `plant` is the only
organisational field.

`backend/sap/drivers/s4odata.driver.js:867` — SAP returns it:
```js
companyCode: po.COM_CODE,
```

`backend/jobs/handlers/sweepPurchaseOrders.js:109-124` — the create that ignores it. Note
also line 119, which takes the header plant from the first line item, so a multi-plant order
is mislabelled:
```js
plant: order.items?.[0]?.plant || '1000',
```

`backend/sap/drivers/s4odata.driver.js:238-239` — the defaults are the SAP IDES demo values:
```js
const companyCode = config.companyCode || '1000';
const plant = config.plant || '1000';
```
The same `'1000'` defaults appear in `schema.prisma:319-321` for RFQ `purchasingOrg` and
`companyCode`. A tenant that never sets these silently runs on demo values.

## Steps to reproduce

1. In SAP, give one vendor code purchase orders under two company codes.
2. Configure a tenant with that vendor and run the PO discovery sweep.
3. All orders from both company codes are created in the one tenant, with no field recording
   which entity they belong to.

## Expected

- `PurchaseOrder` carries company code, purchasing organisation, purchasing group and
  document type.
- A tenant declares which company codes it covers, and reads are filtered to them.
- Plant is per line item, not guessed from the first line.
- `companyCode`/`plant` have no default; an unconfigured connection fails validation rather
  than falling back to `1000`.

## Suggested fix

Schema: add the four fields to `PurchaseOrder`, move `plant` to `PurchaseOrderItem`, add a
`companyCodes String[]` to the tenant's SAP connection config.

Driver: filter discovered orders by the tenant's declared company codes even if the Z
endpoint cannot filter server-side, so nothing outside scope is ever written. Ask ABAP for a
company-code parameter on `zpo_grn_vendor/Detail` — this pairs with the filtering ask in #20.

Config: make `companyCode` a required field in `validateConfig`
(`s4odata.driver.js:1258-1264`), which currently validates only `baseUrl` and `sapClient`.

## Acceptance criteria

- [ ] Discovered orders record their company code.
- [ ] Orders outside the tenant's declared company codes are not imported.
- [ ] No `'1000'` fallback remains for company code, purchasing org or plant.
- [ ] Test: a sweep returning two company codes imports only the declared one.
