# ABAP ask: create and delete an inbound delivery from a portal shipment notice

**Raised:** ADR-0049. **Status:** the portal side is built and switched off. It waits for
these endpoints. The user confirmed on 2026-11-20 that the SAP team can expose them. Update
this status line when they are live and checked.

## Why

A supplier's shipment notice (ASN) lives only in the portal today. SAP learns about the
goods when they arrive and someone posts MIGO against the purchase order. Two problems
follow:

1. The warehouse cannot plan the receipt, because SAP has no expected delivery.
2. When an order ships in parts, the portal cannot tell which goods receipt belongs to which
   shipment. `zpo_grn_vendor/Detail` reports receipts per PO line with nothing that
   identifies the delivery, so the portal guesses by date and by elimination
   (`backend/sap/mappings/goods-receipt-match.js`).

An inbound delivery fixes both. The warehouse sees it in advance, and MIGO posted against it
records the delivery number on the material document.

## What to build

Three changes. Request and response shapes follow the existing Z write endpoints
(`zasset_po/create`, `zinv_plan/update`): plain JSON over POST, `sap-client` as a query
parameter, and a `{ TYPE, MESSAGE, RESULTS[] }` envelope.

### 1. Create: `POST /zinb_delivery/create` (path is your choice)

The equivalent of VL31N against one purchase order. Use whichever function module you
prefer (for example `BBP_INB_DELIVERY_CREATE`). The portal depends only on the HTTP
contract below.

Request:

```json
{
  "VENDOR": "1120250081",
  "PO_NUMBER": "4500022828",
  "EXT_DELIVERY_ID": "ASN-482913",
  "DELIVERY_DATE": "20261123",
  "SHIP_DATE": "20261120",
  "BILL_OF_LADING": "BD-1",
  "MEANS_OF_TRANSPORT_ID": "MH12AB1234",
  "CARRIER": "Blue Dart",
  "EWAY_BILL": "123456789012",
  "ITEMS": [
    { "PO_ITEM": "00010", "QUANTITY": "40.500", "UNIT": "EA" }
  ]
}
```

| Field | Meaning | Suggested target |
|---|---|---|
| `VENDOR` | Supplier | LIKP-LIFNR (must match EKKO-LIFNR of the PO) |
| `PO_NUMBER` | Order the goods are against | LIPS-VGBEL |
| `EXT_DELIVERY_ID` | The portal's ASN id, the supplier's delivery-note reference | **LIKP-LIFEX** |
| `DELIVERY_DATE` | Expected arrival, YYYYMMDD | LIKP-LFDAT |
| `SHIP_DATE` | Dispatch date, YYYYMMDD | LIKP-WADAT / document date, your choice |
| `BILL_OF_LADING` | Carrier tracking number, may be blank | LIKP-BOLNR |
| `MEANS_OF_TRANSPORT_ID` | Vehicle registration, may be blank | LIKP-TRAID |
| `CARRIER` | Carrier name, may be blank | Header text, or a partner if you keep carriers as vendors |
| `EWAY_BILL` | 12-digit e-way bill number, may be blank | Header text or a Z field |
| `ITEMS[].PO_ITEM` | PO line, 5 digits | LIPS-VGPOS |
| `ITEMS[].QUANTITY` | Quantity shipped, 3 decimals | LIPS-LFIMG |
| `ITEMS[].UNIT` | SAP internal unit code as on the PO line (`EA`, not ISO) | LIPS-VRKME |

Response on success:

```json
{ "TYPE": "S", "MESSAGE": "Inbound delivery 180000123 created", "DELIVERY": "0180000123",
  "RESULTS": [ { "TYPE": "S", "PO_ITEM": "00010", "MESSAGE": "" } ] }
```

Two requirements matter more than the rest:

- **Idempotent on `EXT_DELIVERY_ID` + `VENDOR`.** If a delivery with that LIFEX already
  exists for this vendor and is not deleted, return `TYPE: "S"` with **that** delivery's
  number and create nothing. The portal retries after a timeout, and without this a slow
  answer becomes two deliveries.
- **`DELIVERY` is always present on success.** The portal treats a success with no number as
  a failure.

On any error, return `TYPE: "E"` with the reason in `MESSAGE`, plus per-line rows in
`RESULTS` where the problem is a line. Examples: quantity above the open quantity, PO line
blocked, no confirmation control key on the line.

### 2. Delete: `POST /zinb_delivery/delete` (path is your choice)

The equivalent of deleting the delivery in VL32N.

```json
{ "DELIVERY": "0180000123", "EXT_DELIVERY_ID": "ASN-482913" }
```

- Return `TYPE: "S"` if the delivery is deleted, **or was already deleted**. This must also
  be idempotent.
- Return `TYPE: "E"` with a reason if it cannot be deleted. The case that matters is a goods
  receipt already posted against it. The portal shows the supplier that the shipment could
  not be cancelled.
- Refuse if `EXT_DELIVERY_ID` does not match the delivery's LIFEX. That stops the portal
  deleting a delivery it did not create.

We are not sure which function module your release prefers for deleting an inbound
delivery. That choice is yours, as long as the contract above holds.

### 3. Report the delivery on each goods receipt

On `zpo_grn_vendor/Detail`, add one field to each row of `GRN[]`:

- **`INB_DELIVERY`**: the inbound delivery the material document was posted against
  (MSEG-VBELN_IM, or MATDOC-VBELN_IM on S/4). Blank when MIGO was posted directly against
  the PO.

This is what lets the portal match a receipt to its shipment exactly.

## What the portal does with them

Already built (ADR-0049) and switched off until a tenant's SAP connection names the paths:

- Connection fields `inboundDeliveryCreatePath` and `inboundDeliveryCancelPath`. Both are
  blank by default, and blank means the portal sends nothing.
- When a supplier submits a shipment, a background job calls create. It stores the
  `DELIVERY` it gets back on the ASN. If SAP is down the job retries; the supplier is never
  blocked.
- When a supplier cancels a shipment, the portal calls delete **first**. It cancels the
  shipment only if SAP deleted the delivery.
- `INB_DELIVERY` is read when present. A receipt naming a delivery is matched only to that
  delivery's shipment. A missing field falls back to today's matching rule, so this change
  is safe to ship on either side first.

## Checking it once built

Against the sandbox, with a test PO on the real design-partner vendor:

1. Create with an ASN id. Check the delivery in VL33N: LIFEX, quantities, dates.
2. Repeat the identical create call. It must return the same `DELIVERY`.
3. Post MIGO against the delivery. `zpo_grn_vendor/Detail` must show `INB_DELIVERY` on that
   receipt.
4. Call delete on a second, unreceived delivery. Check it is gone. Call delete again; it
   must still return `S`.
5. Call delete on the received delivery. It must return `E` with a readable reason.

The portal's own contract tests for these shapes are in
`backend/tests/inbound-delivery.test.js` ("the S/4 driver against the requested
contract").
