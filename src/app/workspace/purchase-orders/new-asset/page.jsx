'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { poService } from '@/features/purchase-order/services/poService';
import { PageHeader, Notice, Field, Loading, useResource } from '@/components/console/primitives';

// Raise an asset purchase order (account assignment category A) in SAP.
//
// This is the only screen in this application that creates a document in SAP.
// Everywhere else the portal reads SAP's records or annotates a document SAP
// already owns; here SAP creates the order and reports its number back. See
// DECISIONS.md ADR-0042 for why this is a deliberate, narrow exception rather
// than a reversal of "the portal creates no purchase orders in SAP", and
// PROJECT_CONTEXT.md §5.6 for what still holds.
//
// Two things this screen is responsible for saying out loud, because no code
// behind it can check either one:
//
//   1. The asset number is typed by whoever is standing here, from AS03. The
//      portal has no asset master to validate it against, so the form checks
//      its shape and nothing else — a well-formed wrong number posts capex to
//      the wrong fixed asset and nothing in this system will notice.
//   2. Submitting creates a real document in the customer's SAP. There is no
//      draft state and no undo; reversing it is an ME22N/ME23N job on SAP's
//      side.

const BLANK_LINE = {
  description: '',
  plant: '',
  storageLocation: '',
  materialGroup: '',
  quantity: '1',
  uom: 'EA',
  unitPrice: '',
  priceUnit: '1',
  taxCode: '',
  assetNumber: '',
  assetSubNumber: '0000',
};

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number.isFinite(value) ? value : 0);

// SAP's NETPR is the price for `priceUnit` (PEINH) units, not for one, so the
// divisor is not optional: without it a line priced per 100 reads 100x its real
// value — and this is the figure an operator checks before creating a document
// in SAP that the portal cannot reverse (issue #108). Mirrors
// backend/utils/lineValue.js; the backend is what actually stores the value.
const lineValue = (line) => {
  const qty = Number(line.quantity || 0);
  const price = Number(line.unitPrice || 0);
  const per = Number(line.priceUnit) || 1;
  return (qty / per) * price;
};

export default function NewAssetPoPage() {
  const router = useRouter();

  // Only approved suppliers can be named on an order, and only ones SAP has a
  // master record for — the backend enforces both, but offering an ineligible
  // supplier and then rejecting the submission would be a worse way to learn it.
  const { data: vendorData, error: vendorError, loading: vendorsLoading } =
    useResource(() => apiClient.get('/vendors?limit=200&status=Approved'));
  const vendors = (vendorData?.vendors || []).filter((vendor) => vendor.sapVendorCode);

  const [header, setHeader] = React.useState({
    vendorId: '',
    companyCode: '',
    purchasingOrg: '',
    purchasingGroup: '',
    docType: 'NB',
    paymentTerms: '',
    currency: 'INR',
    docDate: new Date().toISOString().slice(0, 10),
    deliveryAddress: '',
  });
  const [lines, setLines] = React.useState([{ ...BLANK_LINE }]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [created, setCreated] = React.useState(null);

  const setField = (name) => (event) => setHeader((prev) => ({ ...prev, [name]: event.target.value }));
  const setLine = (index, name) => (event) => setLines((prev) =>
    prev.map((line, i) => (i === index ? { ...line, [name]: event.target.value } : line)));

  const total = lines.reduce((sum, line) => sum + lineValue(line), 0);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await poService.createAssetPo({
        ...header,
        // Optional header fields are omitted rather than sent empty: the
        // validator treats '' as a value and SAP would store it.
        paymentTerms: header.paymentTerms || undefined,
        deliveryAddress: header.deliveryAddress || undefined,
        items: lines.map((line) => ({
          description: line.description,
          plant: line.plant,
          storageLocation: line.storageLocation || undefined,
          materialGroup: line.materialGroup || undefined,
          quantity: Number(line.quantity),
          uom: line.uom,
          unitPrice: Number(line.unitPrice),
          priceUnit: Number(line.priceUnit || 1),
          taxCode: line.taxCode || undefined,
          assetNumber: line.assetNumber,
          assetSubNumber: line.assetSubNumber || '0000',
        })),
      });
      setCreated(res.po);
    } catch (err) {
      setError(err?.message || 'The order was not created in SAP.');
    } finally {
      setBusy(false);
    }
  };

  // Once SAP has the order there is nothing more to do here, and re-submitting
  // the same form would create a second one — so the form is replaced outright
  // rather than left on screen with a success message above it.
  if (created) {
    return (
      <>
        <PageHeader title="Asset purchase order created" caption={`SAP order ${created.sapPoNumber}`} />
        <div className="card p-6">
          <p className="text-sm">
            SAP created order <span className="mono">{created.sapPoNumber}</span>, recorded here as{' '}
            <span className="mono">{created.id}</span>.
          </p>
          <div className="mt-5 flex gap-2">
            <button type="button" className="btn btn-v h-9"
              onClick={() => router.push(`/workspace/purchase-orders/${created.id}`)}>
              Open the order
            </button>
            <button type="button" className="btn btn-o h-9"
              onClick={() => router.push('/workspace/purchase-orders')}>
              Back to purchase orders
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New asset purchase order"
        caption="Creates the order directly in SAP (ME21N, account assignment A)"
      />

      <Notice tone="error">{error || vendorError}</Notice>
      <Notice tone="warn">
        Submitting this form creates a real purchase order in SAP immediately — there is no draft
        and no undo from the portal. Asset numbers are not validated: this workspace has no asset
        master, so a wrong-but-well-formed number will post capex against the wrong fixed asset.
        Check them in AS03 first.
      </Notice>

      {vendorsLoading ? (
        <Loading label="Loading suppliers" />
      ) : (
        <>
          <div className="card p-5">
            <h3 className="text-sm font-semibold mb-4">Order</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Field label="Supplier">
                <select className="w-full" value={header.vendorId} onChange={setField('vendorId')}>
                  <option value="">Select a supplier…</option>
                  {vendors.map((vendor) => (
                    <option key={vendor.vendorId} value={vendor.vendorId}>
                      {vendor.companyName} · {vendor.sapVendorCode}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Company code" value={header.companyCode} onChange={setField('companyCode')} placeholder="e.g. SSDN" />
              <Field label="Purchasing org" value={header.purchasingOrg} onChange={setField('purchasingOrg')} placeholder="e.g. SSDN" />
              <Field label="Purchasing group" value={header.purchasingGroup} onChange={setField('purchasingGroup')} placeholder="e.g. SDN" />
              <Field label="Document type" value={header.docType} onChange={setField('docType')} hint="SAP BSART" />
              <Field label="Payment terms" value={header.paymentTerms} onChange={setField('paymentTerms')} placeholder="e.g. 0001" />
              <Field label="Currency" value={header.currency} onChange={setField('currency')} />
              <Field label="Document date" type="date" value={header.docDate} onChange={setField('docDate')} />
              <Field label="Delivery address" value={header.deliveryAddress} onChange={setField('deliveryAddress')} />
            </div>
            {vendors.length === 0 && (
              <p className="mt-4 text-[11px] text-text-tertiary">
                No supplier here is both approved and carries an SAP vendor master. An order can
                only be raised against one that is.
              </p>
            )}
          </div>

          <div className="card p-5 mt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Lines</h3>
              <button type="button" className="btn btn-o h-8"
                onClick={() => setLines((prev) => [...prev, { ...BLANK_LINE }])}>
                Add a line
              </button>
            </div>

            {lines.map((line, index) => (
              <div key={index} className="border-t border-border pt-4 mt-4 first:border-0 first:pt-0 first:mt-0">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] text-text-tertiary mono">Line {(index + 1) * 10}</span>
                  {lines.length > 1 && (
                    <button type="button" className="btn btn-o h-7 text-[11px]"
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <Field label="Description" value={line.description} onChange={setLine(index, 'description')}
                    hint="Max 40 characters — SAP truncates beyond that" />
                  <Field label="Asset number" value={line.assetNumber} onChange={setLine(index, 'assetNumber')}
                    placeholder="000000000701" hint="ANLN1, from AS03 — not validated here" />
                  <Field label="Asset sub-number" value={line.assetSubNumber} onChange={setLine(index, 'assetSubNumber')}
                    hint="ANLN2 — 0000 is the main asset" />
                  <Field label="Plant" value={line.plant} onChange={setLine(index, 'plant')} />
                  <Field label="Storage location" value={line.storageLocation} onChange={setLine(index, 'storageLocation')} />
                  <Field label="Material group" value={line.materialGroup} onChange={setLine(index, 'materialGroup')} />
                  <Field label="Quantity" type="number" step="0.001" min="0" value={line.quantity} onChange={setLine(index, 'quantity')} />
                  <Field label="Unit" value={line.uom} onChange={setLine(index, 'uom')} />
                  <Field label="Unit price" type="number" step="0.01" min="0" value={line.unitPrice} onChange={setLine(index, 'unitPrice')} />
                  <Field label="Price unit" type="number" step="1" min="1" value={line.priceUnit} onChange={setLine(index, 'priceUnit')}
                    hint="SAP PEINH — the unit price is per this many units" />
                  <Field label="Tax code" value={line.taxCode} onChange={setLine(index, 'taxCode')} placeholder="e.g. V0" />
                  <Field label="Line value">
                    <div className="mono text-sm pt-2">{money(lineValue(line), header.currency)}</div>
                  </Field>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mt-4">
            <span className="text-sm">
              Order total <span className="mono font-semibold">{money(total, header.currency)}</span>
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn btn-o h-9" disabled={busy}
                onClick={() => router.push('/workspace/purchase-orders')}>
                Cancel
              </button>
              <button type="button" className="btn btn-v h-9" disabled={busy} onClick={submit}>
                {busy ? 'Creating in SAP…' : 'Create in SAP'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
