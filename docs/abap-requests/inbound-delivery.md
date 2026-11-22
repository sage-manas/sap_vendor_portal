# ABAP ask: inbound delivery endpoints for portal shipment notices

**Raised:** ADR-0049, aligned with the ASN design doc (`docs/Uvira Vendor Portal – ASN
Process Design.docx`) and the decisions taken on it on 2026-11-20. **Status:** the portal
side of *create*, *delete* and *receipt matching* is built and switched off, waiting for
these endpoints. *Change* and *status* are requested here so the ABAP work is done once;
their portal side is the next slice. Update this line when the endpoints are live and
checked.

## Decisions this follows

| # | Decision |
|---|---|
| D1 | LIKP-LIFEX = the supplier's **invoice number**. The portal ASN number is the idempotency key, kept in Z-table **ZVP_ASN_HDR**. |
| D2 | Plain **Z REST over HTTP** (an ICF handler in SICF), like the 14 endpoints the portal already calls. Not RFC/PyRFC/JCo. |
| D3 | **ECC 6.0 (EHP 6+) and S/4HANA on-premise (1909+).** The same handler class and the same JSON contract on both. ICF REST handlers (`IF_HTTP_EXTENSION`) exist on ECC 6.0, so one contract serves both releases. |
| D6 | The ASN can be **changed** after posting, through BAPI_INB_DELIVERY_CHANGE. |
| Gap 2 | Gate entry is a SAP Z-transaction, and the portal needs the **gate-in status** back. |
| Gap 5 | The sandbox endpoints are open for testing only. **Production endpoints must require credentials** (see "Security"). |

## Conventions (all endpoints)

- POST with a JSON body. `sap-client` as a query parameter.
- Response envelope: `{ "TYPE": "S"|"E", "MESSAGE": "...", "RESULTS": [ { "TYPE", "MESSAGE", "PO_ITEM"? } ] }`.
  `TYPE: "E"` with SAP's own message text on any failure; one `RESULTS` row per line where
  the problem is a line. The portal shows SAP's text to the supplier.
- Dates `YYYYMMDD`. Quantities as strings with 3 decimals. Units are SAP internal codes
  (`EA`, `KG`) as on the PO line, not ISO codes.
- Paths below are suggestions. The portal reads each path from the SAP connection
  settings.

## Security

Production endpoints must authenticate the caller. Use HTTP basic authentication with a
system user, which the portal already supports (connection secrets). The design doc
suggests the user name `VP_RFC` for this user. Give it the minimum authorisations:
delivery create, change and display (`V_LIKP_VST`), PO display (`M_BEST_EKO`, `M_BEST_WRK`),
and S_ICF for these services only. Do not leave the production services open, as the
sandbox ones are.

## 1. Create: `POST /zinb_delivery/create`

Request:

```json
{
  "PORTAL_ASN": "ASN-482913",
  "VENDOR": "1120250081",
  "PO_NUMBER": "4500022828",
  "INVOICE_NO": "INV/2526/0871",
  "INVOICE_DATE": "20261119",
  "DELIVERY_DATE": "20261123",
  "SHIP_DATE": "20261120",
  "BILL_OF_LADING": "BD-1",
  "MEANS_OF_TRANSPORT_ID": "MH12AB1234",
  "CARRIER": "Blue Dart",
  "EWAY_BILL": "123456789012",
  "ITEMS": [
    { "PO_NUMBER": "4500022828", "PO_ITEM": "00010", "QUANTITY": "40.500", "UNIT": "EA" },
    { "PO_NUMBER": "4500022835", "PO_ITEM": "00020", "QUANTITY": "12.000", "UNIT": "EA" }
  ]
}
```

| Field | Meaning | Target |
|---|---|---|
| `PORTAL_ASN` | The portal's ASN number. **The idempotency key.** | ZVP_ASN_HDR (key: VBELN; store PORTAL_ASN with a unique index) |
| `VENDOR` | Supplier | LIKP-LIFNR (must match EKKO-LIFNR) |
| `PO_NUMBER` | Order the goods are against | LIPS-VGBEL |
| `INVOICE_NO` | Supplier's invoice / challan number, at most 16 characters | **LIKP-LIFEX** (D1) |
| `INVOICE_DATE` | Invoice date | ZVP_ASN_HDR |
| `DELIVERY_DATE` | Expected arrival | LIKP-LFDAT |
| `SHIP_DATE` | Dispatch date | Document date or ZVP_ASN_HDR, your choice |
| `BILL_OF_LADING` | LR / docket number, may be blank | LIKP-BOLNR |
| `MEANS_OF_TRANSPORT_ID` | Vehicle number, may be blank | LIKP-TRAID |
| `CARRIER` | Transporter name, may be blank | Header text ID 0001, or partner SP |
| `EWAY_BILL` | 12-digit e-way bill number, may be blank | ZVP_ASN_HDR |
| `ARRIVAL_TIME` | Expected arrival time `HHMMSS`, may be blank | LIKP-LFUHR |
| `RECEIVING_POINT` | From endpoint 6, may be blank | LIKP-VSTEL / unloading point LIKP-ABLAD, your choice |
| `VEHICLE_TYPE` | Means-of-transport type, may be blank | LIKP-TRATY |
| `PACKAGES` | Number of packages, may be blank | LIKP-ANZPK |
| `GROSS_WEIGHT` / `WEIGHT_UNIT` | May be blank | LIKP-BTGEW / GEWEI |
| `TAXABLE_VALUE` / `INVOICE_VALUE` | Invoice values, ₹ | ZVP_ASN_HDR |
| `EWAY_BILL_DATE` | May be blank | ZVP_ASN_HDR |
| `TRANSPORTER_GSTIN` | May be blank | ZVP_ASN_HDR |
| `DRIVER_MOBILE` | May be blank; personal data, keep access narrow | ZVP_ASN_HDR |
| `ITEMS[].PO_NUMBER` | The order this line is for. **A delivery can carry lines of several orders** for one plant (ASN design V2); the header `PO_NUMBER` is the first of them | LIPS-VGBEL |
| `ITEMS[].PO_ITEM` | PO line, 5 digits | LIPS-VGPOS |
| `ITEMS[].QUANTITY` | Quantity shipped | LIPS-LFIMG |
| `ITEMS[].UNIT` | Unit as on the PO line | LIPS-VRKME |

Success:

```json
{ "TYPE": "S", "MESSAGE": "Inbound delivery 180000123 created", "DELIVERY": "0180000123",
  "RESULTS": [ { "TYPE": "S", "PO_ITEM": "00010", "MESSAGE": "" } ] }
```

Wrapper logic, following section 4.2 of the design doc:

1. Look up `PORTAL_ASN` in ZVP_ASN_HDR. If a delivery exists for it and is not deleted,
   return `TYPE: "S"` with **that** `DELIVERY` and create nothing. The portal retries after a
   timeout; without this, one slow answer becomes two deliveries.
2. Validate each PO item: vendor matches; the item is not deleted or delivery-completed
   (EKPO-LOEKZ, ELIKZ); its confirmation control key creates an inbound delivery; and the
   quantity is at most the open quantity plus the over-delivery tolerance (EKPO-UEBTO).
3. Create with BBP_INB_DELIVERY_CREATE (or the release's equivalent). Set LIFEX, BOLNR and
   TRAID with BAPI_INB_DELIVERY_CHANGE if the create structure does not take them.
4. Write ZVP_ASN_HDR and the header text. Then call BAPI_TRANSACTION_COMMIT with
   `WAIT = 'X'`.
5. On any error, roll back and return only `E` messages.

`DELIVERY` must always be present on success. The portal treats a success with no number
as a failure.

Optional, from the design doc: `"TESTRUN": "X"` runs steps 1–2 only and returns the
messages, for a "Validate with SAP" button. The portal does not send it yet.

## 2. Change: `POST /zinb_delivery/change` (D6)

```json
{
  "PORTAL_ASN": "ASN-482913",
  "DELIVERY": "0180000123",
  "DELIVERY_DATE": "20261124",
  "BILL_OF_LADING": "BD-2",
  "MEANS_OF_TRANSPORT_ID": "MH12AB9999",
  "ITEMS": [
    { "PO_NUMBER": "4500022828", "PO_ITEM": "00010", "QUANTITY": "35.000", "UNIT": "EA" },
    { "PO_NUMBER": "4500022835", "PO_ITEM": "00020", "DELETE": "X" }
  ]
}
```

- Header fields that are absent are not changed.
- An item with `QUANTITY` sets the delivery quantity (ITEM_DATA-DLV_QTY with
  ITEM_CONTROL-CHG_DELQTY = 'X'). An item with `DELETE: "X"` removes the line
  (ITEM_CONTROL-DEL_ITEM = 'X'). `DELIVERY_DATE` uses HEADER_DEADLINES, timetype WSHDRLFDAT.
- Refuse (`E`) if `PORTAL_ASN` does not match ZVP_ASN_HDR for this delivery, if the vehicle
  is through gate-in, or if a goods receipt is posted against the delivery.
- Validate quantities as in create, step 2.
- The portal sends every line still on the shipment with its new quantity, and `DELETE: "X"` for each line taken off. It never asks for a line the delivery does not already have: the supplier puts a new line on a new ASN.
- The portal changes SAP first and its own record only on `S`. Connection field `inboundDeliveryChangePath`; blank means the portal refuses to change a shipment SAP holds a delivery for.

## 3. Delete: `POST /zinb_delivery/delete`

```json
{ "DELIVERY": "0180000123", "PORTAL_ASN": "ASN-482913" }
```

- Delete with BAPI_INB_DELIVERY_CHANGE, HEADER_CONTROL-DLV_DEL = 'X' (design doc 4.3).
- Return `S` if the delivery is deleted, **or was already deleted**. This must also be
  idempotent.
- Return `E` with a reason if it cannot be deleted. The case that matters is a goods
  receipt already posted against the delivery.
- Refuse if `PORTAL_ASN` does not match ZVP_ASN_HDR for this delivery. That stops the
  portal deleting a delivery it did not create.

## 4. Status: `POST /zinb_delivery/status` (gap 2; portal side not built yet)

The portal needs the gate-in time from your gate-entry Z-transaction. It also needs the
goods-movement status per delivery. The portal will call this every 30 seconds for its
open shipments (decision D4), in batches.

```json
{ "DELIVERIES": ["0180000123", "0180000124"] }
```

```json
{ "TYPE": "S", "RESULTS": [
  { "DELIVERY": "0180000123", "PORTAL_ASN": "ASN-482913",
    "GATE_IN_AT": "20261123101500", "GM_STATUS": "B", "DELETED": "",
    "ITEMS": [ { "PO_NUMBER": "4500022828", "PO_ITEM": "00010", "DELIVERY_QTY": "40.500", "GR_QTY": "38.000" } ] }
] }
```

| Field | Meaning | Source |
|---|---|---|
| `GATE_IN_AT` | Gate-in date and time, `YYYYMMDDHHMMSS`, blank before gate-in | Your gate-entry Z-table |
| `GM_STATUS` | Goods-movement status: blank/A not received, B partly, C complete | VBUK-WBSTK (ECC) / LIKP-WBSTK (S/4) |
| `DELETED` | `X` if someone deleted the delivery directly in SAP | — |
| `ITEMS[].GR_QTY` | Quantity received against the delivery item | EKBE / MATDOC |

A delivery number that does not exist must come back with `DELETED: "X"`, not as an error
for the whole call.

With `GATE_IN_AT`, the portal shows **At gate** and stops the supplier from cancelling or
changing the shipment. After gate-in, only the tenant admin can cancel. With `GM_STATUS`, the
portal shows **Partially received** and **Received**. With `DELETED`, the portal detects a
delivery that was removed in SAP.

## 5. Report the delivery on each goods receipt

On `zpo_grn_vendor/Detail`, add one field to each row of `GRN[]`:

- **`INB_DELIVERY`**: the inbound delivery the material document was posted against
  (MSEG-VBELN_IM on ECC, MATDOC-VBELN_IM on S/4). Blank when MIGO was posted directly against
  the PO.

This lets the portal match a receipt to its shipment exactly. It is still needed with
endpoint 4, because a receipt record in the portal is created from this feed.

## 6. Receiving points: `POST /zinb_delivery/receiving_points`

The ASN screen offers the supplier a list of unloading points for the plant. The user chose
SAP's own receiving points as the source.

```json
{ "PLANT": "1100" }
```

```json
{ "TYPE": "S", "RESULTS": [
  { "CODE": "1100", "DESCRIPTION": "Stores – Gate 2", "STORAGE_LOCATIONS": ["0001", "0002"] }
] }
```

Return the receiving points (shipping points used for inbound, TVST/TVSWZ) and any
unloading points you keep for the plant. Read-only. The portal caches the answer per plant.

## SAP configuration this depends on

This is from section 3 of the design doc, and is the functional consultant's work, not the
portal's:

- A confirmation control key that creates an inbound delivery (category LA, "Create Inb.
  Dlv."), defaulted on portal vendors (LFM1-BSTAE) so it copies to every PO item.
- Delivery type EL, item category ELN, number range and receiving point.
- A MIGO check (BAdI MB_MIGO_BADI) that refuses a GR without an inbound delivery on
  ASN-mandatory PO items. Without it, stores can bypass the delivery, and the portal falls
  back to matching by PO.

## What the portal does with them

Built (ADR-0049) and switched off until a tenant's SAP connection names the paths:

- Connection fields `inboundDeliveryCreatePath` and `inboundDeliveryCancelPath`. Blank is the
  default, and blank means the portal sends nothing.
- When a supplier submits a shipment, a background job calls create and stores the
  `DELIVERY`. If SAP is down the job retries; the supplier is never blocked.
- When a supplier cancels a shipment, the portal calls delete **first**. It cancels the
  shipment only if SAP deleted the delivery.
- `INB_DELIVERY` is read when present. A missing field falls back to today's matching rule,
  so this change is safe to ship on either side first.

Change (endpoint 2) is built too. Next portal slice: the status poll (endpoint 4) and the
At gate status.

## Checking it once built

Do this on the S/4 sandbox, and on an ECC 6.0 system, with a test PO on the real
design-partner vendor:

1. Create. Check the delivery in VL33N: LIFEX = invoice number, quantities, dates.
   Check ZVP_ASN_HDR.
2. Repeat the identical create call. It must return the same `DELIVERY`.
3. Change the quantity and the date. Check VL33N.
4. Record gate-in in the Z-transaction. Status must show `GATE_IN_AT`. Change must now
   refuse.
5. Post MIGO against the delivery. Status must show `GM_STATUS` C, and
   `zpo_grn_vendor/Detail` must show `INB_DELIVERY` on that receipt.
6. Delete a second, unreceived delivery. Check it is gone. Delete it again; it must still
   return `S`. Status must show `DELETED: "X"`.
7. Delete the received delivery. It must return `E` with a readable reason.
8. Call any endpoint without credentials on production. It must refuse.

The portal's contract tests for create and delete are in
`backend/tests/inbound-delivery.test.js` ("the S/4 driver against the requested
contract").
