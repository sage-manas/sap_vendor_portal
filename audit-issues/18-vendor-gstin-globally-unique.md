<!-- title: BUG: Vendor.gstin is globally unique, so one supplier cannot be onboarded by two tenants -->
<!-- labels: bug,severity:high,area:data,backend -->

**Severity:** High — a foundational multi-tenancy defect in a product whose premise is one
portal serving many buyers.

## Summary

`Vendor.gstin` carries a global `@unique`. A `Vendor` row belongs to exactly one tenant
(it has `clientId`), so a supplier trading with two buyers on this platform needs two rows —
and the second registration fails on the GSTIN constraint.

One GSTIN is one legal entity. Two buyers commonly share suppliers; in some verticals most
suppliers are shared. The first time two tenants overlap, onboarding breaks with a
constraint violation that will surface to the supplier as an opaque error.

`email` has the same global constraint. That one is at least arguable — `vendorId` is
deliberately global because login identity is resolved before tenancy is known (ADR-0002) —
but it forces a supplier to maintain a second email address per buyer, which is a poor
experience for the same underlying reason.

## Evidence

`backend/prisma/schema.prisma:236` and `:242`:
```prisma
gstin  String  @unique
email  String  @unique
```

Note the model gets it right immediately below, at `:299`:
```prisma
@@unique([clientId, sapVendorCode])
```

## Steps to reproduce

1. Onboard supplier with GSTIN `27AAAAA0000A1Z5` into tenant CLT-0001.
2. Onboard the same legal entity into tenant CLT-0002.
3. Unique-constraint violation on `vendors_gstin_key`.

## Expected

A GSTIN is unique within a tenant, not across the platform.

## Suggested fix

Replace with `@@unique([clientId, gstin])`. Then decide the login identity question
deliberately:

- **Option A (smaller):** keep one Vendor row per (tenant, supplier); the supplier holds one
  login per buyer. Requires `email` to become `@@unique([clientId, email])` and the login
  lookup to resolve tenant first (subdomain or an explicit selector).
- **Option B (better product):** separate supplier *identity* from supplier *master data* —
  one global account, N tenant-scoped vendor records. This is the model every established
  vendor network uses, and it is far cheaper to do now than after the first multi-tenant
  customer.

Either way this is a migration; flag it before the second production tenant, not after.

## Acceptance criteria

- [ ] The same GSTIN can be onboarded by two tenants.
- [ ] Tenant isolation tests still pass — neither tenant sees the other's vendor row.
- [ ] A decision is recorded as an ADR on the identity question.
