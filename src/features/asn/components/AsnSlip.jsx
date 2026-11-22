'use client';

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { displayDate } from '@/lib/displayDate';

// The ASN slip (ASN design screen V6, "Print ASN slip"): one A4 page that
// travels with the goods. Gate security scans its QR code in SAP's own
// gate-entry transaction (the user's decision: gate entry stays in SAP).
//
// The QR code holds `<ASN number>|<SAP inbound delivery>` — plain text, so any
// scanner reads it and the gate transaction can split it on "|". Before SAP
// has a delivery the second part is empty; the slip says so in words too.
// docs/abap-requests/inbound-delivery.md ("The ASN slip") states the format
// for whoever builds the gate transaction.

export const slipCode = (asn) => `${asn.id}|${asn.sapInboundDelivery || ''}`;

const money = (value) => (value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

export default function AsnSlip({ asn, supplierName, onBack }) {
  const [qr, setQr] = useState(null);

  // Rendered in the browser, like the MFA enrolment code (PlatformGate).
  useEffect(() => {
    QRCode.toDataURL(slipCode(asn), { margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch(() => setQr(null));
  }, [asn]);

  const waiting = asn.status === 'Pending Approval';
  const details = [
    ['Supplier', supplierName || asn.vendorId],
    ['Plant', asn.plant || '—'],
    ['Dispatched', displayDate(asn.shipDate)],
    ['Expected', `${displayDate(asn.estimatedDeliveryDate)}${asn.arrivalTime ? ` ${asn.arrivalTime}` : ''}`],
    ['Transporter', asn.carrierName || '—'],
    ['LR / docket', asn.trackingNumber || '—'],
    ['Vehicle', [asn.vehicleNumber, asn.vehicleType].filter(Boolean).join(' · ') || '—'],
    ['Invoice', [asn.invoiceReference, displayDate(asn.invoiceDate), money(asn.invoiceValue)].filter(Boolean).join(' · ')],
    ['E-way bill', asn.ewayBillNo ? `${asn.ewayBillNo} · ${displayDate(asn.ewayBillDate)}` : '—'],
    ['Packages', [asn.packages, asn.grossWeightKg != null && `${asn.grossWeightKg} kg`].filter(Boolean).join(' · ') || '—'],
  ];

  return (
    <div>
      <div className="mb-4 flex gap-2 print:hidden">
        <Button variant="ghost" onClick={onBack}>Back to {asn.id}</Button>
        <Button onClick={() => window.print()}><Printer className="mr-1.5 size-4" aria-hidden="true" />Print</Button>
      </div>

      {/* Printed alone: globals.css hides everything else while a .print-slip
          is on the page. Black on white whatever the theme, for paper. */}
      <article aria-label={`ASN slip ${asn.id}`} className="print-slip mx-auto max-w-[210mm] bg-white p-8 text-black shadow-sm print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b border-black pb-4">
          <div>
            <p className="text-sm uppercase tracking-wide">Advance shipping notice</p>
            <h1 className="mono text-3xl font-bold">{asn.id}</h1>
            <p className="mt-1 text-sm">
              SAP inbound delivery: <span className="mono font-semibold">{asn.sapInboundDelivery || 'not created yet'}</span>
            </p>
            {waiting && (
              <p className="mt-2 border border-black px-2 py-1 text-sm font-semibold">
                Waiting for the buyer&apos;s approval. Do not dispatch on this slip until it is approved.
              </p>
            )}
          </div>
          {qr
            ? <img src={qr} alt={`QR code: ${slipCode(asn)}`} width={160} height={160} className="shrink-0" />
            : <div className="size-40 shrink-0 border border-black" aria-hidden="true" />}
        </header>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 py-4 text-sm">
          {details.map(([term, value]) => (
            <div key={term} className="flex gap-3"><dt className="w-28 shrink-0 font-semibold">{term}</dt><dd className="min-w-0 break-words">{value || '—'}</dd></div>
          ))}
        </dl>

        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Lines on this shipment</caption>
          <thead>
            <tr className="border-y border-black text-left">
              <th className="py-1.5 pr-2">Order</th>
              <th className="py-1.5 pr-2">Line</th>
              <th className="py-1.5 pr-2">Item</th>
              <th className="py-1.5 pr-2 text-right">Quantity</th>
              <th className="py-1.5">Unit</th>
            </tr>
          </thead>
          <tbody>
            {(asn.items || []).map((item) => (
              <tr key={`${item.poId}:${item.line}`} className="border-b border-black/30">
                <td className="mono py-1.5 pr-2">{item.poId || asn.poId}</td>
                <td className="mono py-1.5 pr-2">{item.line}</td>
                <td className="py-1.5 pr-2"><span className="mono">{item.materialCode}</span> {item.description}</td>
                <td className="mono py-1.5 pr-2 text-right">{item.shippedQuantity}</td>
                <td className="py-1.5">{item.uom || 'EA'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <footer className="mt-6 border-t border-black pt-3 text-xs">
          At the gate: scan the QR code in the gate-entry transaction, or enter <span className="mono font-semibold">{asn.id}</span>
          {asn.sapInboundDelivery ? <> or delivery <span className="mono font-semibold">{asn.sapInboundDelivery}</span></> : null}.
        </footer>
      </article>
    </div>
  );
}
