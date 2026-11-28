'use client';

import React, { useId, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/Page';
import DataTable from '@/components/ui/DataTable';
import FileUploadZone from '@/components/shared/FileUploadZone';
import { displayDate } from '@/lib/displayDate';
import { useResource } from '@/components/console/primitives';
import { poService } from '@/features/purchase-order/services/poService';
import { EWAY_BILL_THRESHOLD_INR, ewayBillRequired, quantityErrors, shipmentErrors } from '../rules';
import { lineKey, plantOf, shippableLines } from '../lines';

// ASN design screens V2–V5: a shipment notice in four steps. Save draft keeps
// the form, at any step, with no ASN number; Submit gives it one. Each step's
// rules are checked before Next (../rules.js), and the API checks them all
// again on Submit against current data.

const STEPS = ['Select PO lines', 'Quantities', 'Shipment and documents', 'Review and submit'];

// The fields of step 3, in the shape POST /asns takes them.
const FORM_FIELDS = [
  'invoiceReference', 'invoiceDate', 'taxableValue', 'invoiceValue',
  'shipDate', 'estimatedDeliveryDate', 'arrivalTime',
  'carrierName', 'trackingNumber', 'vehicleNumber', 'vehicleType', 'driverMobile', 'transporterGstin',
  'ewayBillNo', 'ewayBillDate', 'packages', 'grossWeightKg',
];
const NUMERIC = ['taxableValue', 'invoiceValue', 'packages', 'grossWeightKg'];

const DOC_SLOTS = [
  { slot: 'invoiceCopy', label: 'Invoice copy' },
  { slot: 'ewayBill', label: 'E-way bill' },
  { slot: 'packingList', label: 'Packing list', optional: true },
  { slot: 'certificate', label: 'Certificate of analysis', optional: true },
];

const VEHICLE_TYPES = ['Truck - closed body', 'Truck - open body', 'Container', 'Tempo / LCV', 'Courier', 'Own vehicle'];

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const money = (value) => (value === '' || value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

// A labelled input with its error under it, tied together for screen readers.
function Field({ label, required, error, hint, children }) {
  const id = useId();
  const control = React.cloneElement(children, {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? `${id}-note` : undefined,
  });
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}{required && <span aria-hidden="true" className="text-fg-subtle"> *</span>}
      </label>
      {control}
      {(error || hint) && (
        <p id={`${id}-note`} className={`text-xs ${error ? 'text-danger' : 'text-fg-subtle'}`}>
          {error ? <><AlertCircle className="mr-1 inline size-3 align-[-1px]" aria-hidden="true" />{error}</> : hint}
        </p>
      )}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="card space-y-4 p-5">
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

// The form's values from a shipment being changed (ASN design D6).
const formFromAsn = (asn) => Object.fromEntries(FORM_FIELDS
  .filter((field) => asn[field] !== null && asn[field] !== undefined)
  .map((field) => [field, /Date$/.test(field) ? String(asn[field]).slice(0, 10) : String(asn[field])]));
const ownLines = (asn) => (asn?.items || []).map((item) => ({ key: lineKey(item.poId || asn.poId, item.line), qty: item.shippedQuantity }));

export default function AsnWizard({
  pos, draftPk: initialDraftPk, startPoId, editAsn, submitShipment, submitAsnDraft, updateShipment, onCancel, onSubmitted,
}) {
  const [step, setStep] = useState(1);
  const [draftPk, setDraftPk] = useState(initialDraftPk || null);
  const [savedAt, setSavedAt] = useState(null);
  const [plant, setPlant] = useState(null);
  const [selected, setSelected] = useState(() => ownLines(editAsn).map(({ key }) => key));
  const [quantities, setQuantities] = useState(() => Object.fromEntries(ownLines(editAsn).map(({ key, qty }) => [key, String(qty)])));
  const [form, setForm] = useState(() => (editAsn ? formFromAsn(editAsn) : { shipDate: today(), estimatedDeliveryDate: inDays(3) }));
  const [docs, setDocs] = useState({});
  // A changed shipment's documents already on it; kept unless removed.
  const [keptDocs, setKeptDocs] = useState(() => editAsn?.documents || []);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // Read once: the clock is not something a render may depend on.
  const [todayStr] = useState(today);

  // What a shipment being changed holds is still open to it (lines.js).
  const own = useMemo(() => Object.fromEntries(ownLines(editAsn).map(({ key, qty }) => [key, qty])), [editAsn]);
  const lines = useMemo(() => shippableLines(pos, { own }), [pos, own]);
  // SAP's inbound delivery can take new quantities but not new lines.
  const lockedToDelivery = Boolean(editAsn?.sapInboundDelivery);
  const plants = useMemo(() => [...new Set(lines.map(({ item }) => plantOf(item)))].sort(), [lines]);
  const byKey = useMemo(() => new Map(lines.map((line) => [line.key, line])), [lines]);

  // Resuming a draft: the server's copy is the form. There is no read-one
  // endpoint the list does not already answer, so it is found in the list.
  const draftResource = useResource(
    () => (initialDraftPk ? poService.listAsnDrafts() : Promise.resolve(null)),
    initialDraftPk || '',
  );

  // The three set-ups below happen once each, as soon as what they need has
  // arrived. They adjust state during render (React's pattern for state that
  // follows something loaded) rather than in effects.
  const [setUp, setSetUp] = useState({ draft: !initialDraftPk, start: Boolean(initialDraftPk) || !startPoId });

  if (!setUp.draft && !draftResource.loading) {
    setSetUp((prev) => ({ ...prev, draft: true }));
    const draft = (draftResource.data?.drafts || []).find((d) => d.pk === initialDraftPk);
    if (draftResource.error) {
      setNotice(draftResource.error);
    } else if (!draft) {
      setNotice('That draft no longer exists. It may have been submitted or deleted.');
      setDraftPk(null);
    } else {
      const p = draft.payload || {};
      const keys = (p.items || []).map((item) => lineKey(item.poId || draft.poId, item.line));
      setSelected(keys);
      setQuantities(Object.fromEntries((p.items || []).map((item) => [lineKey(item.poId || draft.poId, item.line), item.shippedQuantity ?? ''])));
      setForm((prev) => ({ ...prev, ...Object.fromEntries(FORM_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, String(p[f])])) }));
      setDocs(p.attachments || {});
      setStep(draft.step || 1);
      setSavedAt(draft.updatedAt);
    }
  }

  // Starting from one order: its open lines, chosen, at its plant — once the
  // orders have loaded.
  if (!setUp.start && lines.some((line) => line.po.id === startPoId)) {
    setSetUp((prev) => ({ ...prev, start: true }));
    const ofOrder = lines.filter((line) => line.po.id === startPoId);
    const orderPlant = plantOf(ofOrder[0].item);
    setPlant(orderPlant);
    setSelected(ofOrder.filter((line) => plantOf(line.item) === orderPlant).map((line) => line.key));
  }

  // A resumed draft knows its lines before the orders may have loaded; its
  // plant follows from them once they have.
  if (plant === null && selected.length && byKey.get(selected[0])) {
    setPlant(plantOf(byKey.get(selected[0]).item));
  }
  const loadingDraft = !setUp.draft;

  const plantLines = plant === null ? [] : lines.filter((line) => plantOf(line.item) === plant && (!lockedToDelivery || line.key in own));
  const chosen = selected.map((key) => byKey.get(key)).filter(Boolean);
  const currencies = [...new Set(chosen.map(({ po }) => po.currency || 'INR'))];
  const currency = currencies[0] || 'INR';
  const needsEway = ewayBillRequired(form.invoiceValue, currency);
  const setField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  // --- Draft and submit ------------------------------------------------------

  const formPayload = () => Object.fromEntries(FORM_FIELDS
    .filter((field) => form[field] !== undefined && String(form[field]).trim() !== '')
    .map((field) => [field, NUMERIC.includes(field) ? Number(form[field]) : String(form[field]).trim()]));

  const items = () => chosen.map(({ po, item, key }) => ({ poId: po.id, line: item.line, shippedQuantity: quantities[key] ?? '' }));

  const draftBody = (atStep = step) => ({
    poId: chosen[0]?.po.id || null,
    step: atStep,
    payload: {
      ...formPayload(),
      items: items().map((item) => ({ ...item, shippedQuantity: String(item.shippedQuantity) })),
      attachments: Object.fromEntries(Object.entries(docs).filter(([, doc]) => doc?.documentId)
        .map(([slot, doc]) => [slot, { documentId: doc.documentId, originalName: doc.originalName, size: doc.size }])),
    },
  });

  const saveDraft = async () => {
    setBusy(true);
    setNotice('');
    try {
      const saved = await poService.saveAsnDraft(draftPk, draftBody());
      setDraftPk(saved.pk);
      setSavedAt(saved.updatedAt);
    } catch (e) {
      setNotice('The draft could not be saved: ' + (e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setNotice('');
    try {
      let res;
      if (editAsn) {
        res = await updateShipment(editAsn.id, {
          ...formPayload(),
          items: items().map((item) => ({ ...item, shippedQuantity: Number(item.shippedQuantity) })),
          documentIds: [
            ...keptDocs.map((doc) => doc.documentId),
            ...Object.values(docs).filter((doc) => doc?.documentId).map((doc) => doc.documentId),
          ],
        });
      } else if (draftPk) {
        // Through the draft, so the server deletes it in the same transaction
        // that creates the shipment; saved first, so what is submitted is
        // what is on screen.
        await poService.saveAsnDraft(draftPk, draftBody(4));
        res = await submitAsnDraft(draftPk);
      } else {
        res = await submitShipment({
          ...formPayload(),
          items: items().map((item) => ({ ...item, shippedQuantity: Number(item.shippedQuantity) })),
          documentIds: Object.values(docs).filter((doc) => doc?.documentId).map((doc) => doc.documentId),
        });
      }
      onSubmitted(res.asn);
    } catch (e) {
      setNotice(e?.message || 'The shipment could not be submitted.');
      setBusy(false);
    }
  };

  // --- Steps -----------------------------------------------------------------

  const checkStep = (n) => {
    if (n === 1) {
      if (!chosen.length) return { lines: 'Choose at least one line to ship.' };
      if (currencies.length > 1) return { lines: 'These orders are in different currencies. One shipment carries one invoice.' };
      return {};
    }
    if (n === 2) return quantityErrors(chosen, quantities);
    if (n === 3) {
      return shipmentErrors(form, {
        currency,
        invoiceCopyAttached: Boolean(docs.invoiceCopy?.documentId) || keptDocs.length > 0,
        ewayBillAttached: Boolean(docs.ewayBill?.documentId),
      });
    }
    return {};
  };

  const next = () => {
    const found = checkStep(step);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step === 1) {
      // Quantities default to what is still open, the usual case.
      setQuantities((prev) => Object.fromEntries(chosen.map(({ key, open }) => [key, prev[key] ?? String(open)])));
    }
    setStep(step + 1);
  };

  const back = () => {
    setErrors({});
    setStep(step - 1);
  };

  const remaining = (n) => Object.keys(checkStep(n)).length;

  // --- Render ----------------------------------------------------------------

  if (loadingDraft) {
    return <p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading the draft…</p>;
  }

  const lineColumns = [
    { key: 'po', header: 'Order', mono: true, primary: true, render: ({ po }) => po.id },
    { key: 'line', header: 'Line', mono: true, render: ({ item }) => item.line },
    { key: 'material', header: 'Item', wrap: true, render: ({ item }) => <span><span className="mono">{item.materialCode || '—'}</span> {item.description}</span> },
    { key: 'due', header: 'Due', render: ({ item, po }) => displayDate(item.deliveryDate || po.createdDate) },
    { key: 'qty', header: 'Ordered', align: 'right', render: ({ item }) => <span className="mono">{item.quantity}</span> },
    { key: 'received', header: 'Received', align: 'right', render: ({ item }) => <span className="mono">{item.grnQuantity || 0}</span> },
    { key: 'transit', header: 'On open ASNs', align: 'right', render: ({ item }) => <span className="mono">{item.inTransitQuantity || 0}</span> },
    { key: 'open', header: 'Open to ship', align: 'right', render: ({ open }) => <span className="mono font-medium">{open}</span> },
    { key: 'uom', header: 'Unit', render: ({ item }) => item.uom || 'EA' },
  ];

  const quantityColumns = [
    { key: 'po', header: 'Order', mono: true, primary: true, render: ({ po }) => po.id },
    { key: 'line', header: 'Line', mono: true, render: ({ item }) => item.line },
    { key: 'material', header: 'Item', wrap: true, render: ({ item }) => item.description || item.materialCode },
    { key: 'open', header: 'Open', align: 'right', render: ({ open }) => <span className="mono">{open}</span> },
    {
      key: 'ship',
      header: 'Ship now',
      align: 'right',
      render: ({ key, item }) => (
        <div className="flex flex-col items-end gap-1 py-1">
          <input
            type="number"
            min="0"
            step="any"
            aria-label={`Quantity to ship for ${key.replace(':', ' line ')}`}
            aria-invalid={errors[key] ? true : undefined}
            value={quantities[key] ?? ''}
            onChange={(e) => setQuantities((prev) => ({ ...prev, [key]: e.target.value }))}
            className="mono w-28! min-h-8! py-1! text-right"
          />
          {errors[key] && <span className="max-w-56 whitespace-normal text-left text-xs text-danger">{errors[key]}</span>}
        </div>
      ),
    },
    { key: 'uom', header: 'Unit', render: ({ item }) => item.uom || 'EA' },
  ];

  const summary = [
    ['Invoice', `${form.invoiceReference || '—'} · ${displayDate(form.invoiceDate)} · ${money(form.invoiceValue)}`],
    ['Taxable value', money(form.taxableValue)],
    ['Dispatch', displayDate(form.shipDate)],
    ['Expected arrival', `${displayDate(form.estimatedDeliveryDate)}${form.arrivalTime ? ` ${form.arrivalTime}` : ''}`],
    ['Transporter', form.carrierName || '—'],
    ['LR / docket', form.trackingNumber || '—'],
    ['Vehicle', [form.vehicleNumber, form.vehicleType].filter(Boolean).join(' · ') || '—'],
    ['E-way bill', form.ewayBillNo ? `${form.ewayBillNo} · ${displayDate(form.ewayBillDate)}` : '—'],
    ['Packages', [form.packages, form.grossWeightKg && `${form.grossWeightKg} kg`].filter(Boolean).join(' · ') || '—'],
  ];

  return (
    <div>
      <PageHeader
        breadcrumb={<button type="button" className="text-accent-text hover:underline" onClick={onCancel}>ASN</button>}
        title={editAsn ? `Change ${editAsn.id}` : 'Create ASN'}
        caption={editAsn
          ? (lockedToDelivery
            ? `SAP holds inbound delivery ${editAsn.sapInboundDelivery} for it: quantities and details can change, but new lines go on a new ASN. If your buyer approves shipments, SAP is changed once they approve.`
            : 'Your changes replace what was sent. A shipment your buyer approved goes back to them for approval.')
          : savedAt ? `Draft saved ${new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Not saved yet. It gets an ASN number when you submit it.'}
      />

      <ol aria-label="Steps" className="card mb-6 flex flex-wrap gap-x-6 gap-y-2 p-4">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n < step ? 'done' : n === step ? 'current' : 'next';
          return (
            <li key={label} aria-current={state === 'current' ? 'step' : undefined} className={`flex items-center gap-2 text-sm ${state === 'next' ? 'text-fg-muted' : 'font-medium text-fg'}`}>
              <span className={`flex size-6 items-center justify-center rounded-full border text-xs ${state === 'current' ? 'border-accent-solid bg-accent-solid text-accent-fg' : state === 'done' ? 'border-success text-success' : 'border-border'}`}>
                {state === 'done' ? <Check className="size-3.5" aria-hidden="true" /> : n}
              </span>
              {label}
            </li>
          );
        })}
      </ol>

      {notice && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-sm text-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{notice}
        </p>
      )}

      {step === 1 && (
        <section aria-label="Select PO lines" className="space-y-4">
          {!lines.length ? (
            <p className="text-sm text-fg-muted">Nothing is open to ship. An order appears here once you have acknowledged it and a line still has quantity to send.</p>
          ) : (
            <>
              <Field label="Plant" required hint="One shipment goes to one plant. Lines for other plants need their own ASN.">
                <select
                  value={plant ?? ''}
                  onChange={(e) => { setPlant(e.target.value === '__none' ? null : e.target.value); setSelected([]); }}
                  className="w-64!"
                >
                  <option value="__none">Choose a plant</option>
                  {plants.map((code) => <option key={code || 'none'} value={code}>{code || 'Not stated on the order'}</option>)}
                </select>
              </Field>
              {plant !== null && (
                <DataTable
                  caption="Open PO lines"
                  columns={lineColumns}
                  rows={plantLines}
                  getRowId={(line) => line.key}
                  rowLabel={(line) => `${line.po.id} line ${line.item.line}`}
                  selectable
                  selected={selected}
                  onSelectedChange={setSelected}
                  maxHeight="520px"
                  empty="No open lines for this plant."
                />
              )}
              {errors.lines && <p className="text-sm text-danger">{errors.lines}</p>}
            </>
          )}
        </section>
      )}

      {step === 2 && (
        <section aria-label="Quantities" className="space-y-3">
          <p className="text-sm text-fg-muted">Each line starts at what is still open. Lower it for a part shipment.</p>
          <DataTable caption="Quantities" columns={quantityColumns} rows={chosen} getRowId={(line) => line.key} rowLabel={(line) => `${line.po.id} line ${line.item.line}`} />
        </section>
      )}

      {step === 3 && (
        <section aria-label="Shipment and documents" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Invoice">
              <Field label="Invoice / challan no." required error={errors.invoiceReference} hint="Goes to SAP as the external delivery ID (LIFEX).">
                <input type="text" maxLength={16} value={form.invoiceReference || ''} onChange={setField('invoiceReference')} className="mono" />
              </Field>
              <Field label="Invoice date" required error={errors.invoiceDate}>
                <input type="date" max={todayStr} value={form.invoiceDate || ''} onChange={setField('invoiceDate')} />
              </Field>
              <Field label="Taxable value (₹)" error={errors.taxableValue}>
                <input type="number" min="0" step="0.01" value={form.taxableValue || ''} onChange={setField('taxableValue')} className="mono text-right" />
              </Field>
              <Field label="Invoice total (₹)" required error={errors.invoiceValue}>
                <input type="number" min="0" step="0.01" value={form.invoiceValue || ''} onChange={setField('invoiceValue')} className="mono text-right" />
              </Field>
            </Card>

            <Card title="Delivery">
              <Field label="Dispatch date" required error={errors.shipDate}>
                <input type="date" value={form.shipDate || ''} onChange={setField('shipDate')} />
              </Field>
              <Field label="Expected arrival date" required error={errors.estimatedDeliveryDate}>
                <input type="date" min={form.shipDate || undefined} value={form.estimatedDeliveryDate || ''} onChange={setField('estimatedDeliveryDate')} />
              </Field>
              <Field label="Arrival time" error={errors.arrivalTime}>
                <input type="time" value={form.arrivalTime || ''} onChange={setField('arrivalTime')} />
              </Field>
              <p className="text-xs text-fg-subtle">
                Unloading point: chosen from SAP&apos;s receiving points for the plant once your buyer&apos;s SAP provides them.
              </p>
            </Card>

            <Card title="Transport">
              <Field label="Transporter" required error={errors.carrierName}>
                <input type="text" maxLength={100} value={form.carrierName || ''} onChange={setField('carrierName')} />
              </Field>
              <Field label="LR / docket no." error={errors.trackingNumber} hint="This, the vehicle number, or both.">
                <input type="text" maxLength={35} value={form.trackingNumber || ''} onChange={setField('trackingNumber')} className="mono" />
              </Field>
              <Field label="Vehicle no." error={errors.vehicleNumber}>
                <input type="text" maxLength={20} value={form.vehicleNumber || ''} onChange={setField('vehicleNumber')} placeholder="HR55AB1234" className="mono uppercase" />
              </Field>
              <Field label="Vehicle type">
                <select value={form.vehicleType || ''} onChange={setField('vehicleType')}>
                  <option value="">Not stated</option>
                  {VEHICLE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </Field>
              <Field label="Driver mobile" error={errors.driverMobile} hint="Seen by you and your buyer only.">
                <input type="tel" maxLength={16} value={form.driverMobile || ''} onChange={setField('driverMobile')} placeholder="+91 90000 00000" />
              </Field>
              <Field label="Transporter GSTIN" error={errors.transporterGstin}>
                <input type="text" maxLength={15} value={form.transporterGstin || ''} onChange={setField('transporterGstin')} className="mono uppercase" />
              </Field>
            </Card>

            <Card title="E-way bill and packing">
              <Field label="E-way bill no." required={needsEway} error={errors.ewayBillNo}>
                <input type="text" inputMode="numeric" maxLength={14} value={form.ewayBillNo || ''} onChange={setField('ewayBillNo')} placeholder="12 digits" className="mono" />
              </Field>
              <Field label="E-way bill date" required={needsEway || Boolean(form.ewayBillNo)} error={errors.ewayBillDate}>
                <input type="date" value={form.ewayBillDate || ''} onChange={setField('ewayBillDate')} />
              </Field>
              <Field label="Total packages">
                <input type="number" min="1" step="1" value={form.packages || ''} onChange={setField('packages')} className="mono text-right" />
              </Field>
              <Field label="Gross weight (kg)">
                <input type="number" min="0" step="0.001" value={form.grossWeightKg || ''} onChange={setField('grossWeightKg')} className="mono text-right" />
              </Field>
              <p className="text-xs text-fg-subtle">
                {needsEway
                  ? `E-way bill is required because the invoice total is above ₹${EWAY_BILL_THRESHOLD_INR.toLocaleString('en-IN')}.`
                  : `Needed when the invoice total is above ₹${EWAY_BILL_THRESHOLD_INR.toLocaleString('en-IN')}.`}
              </p>
            </Card>
          </div>

          <Card title="Documents">
            {keptDocs.length > 0 && (
              <ul aria-label="Already attached" className="space-y-1 text-sm">
                {keptDocs.map((doc) => (
                  <li key={doc.documentId} className="flex items-center gap-3">
                    <span className="flex-1">{doc.originalName}</span>
                    <Button size="sm" variant="ghost" onClick={() => setKeptDocs((prev) => prev.filter((d) => d.documentId !== doc.documentId))}>Remove</Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {DOC_SLOTS.map(({ slot, label, optional }) => {
                const required = slot === 'invoiceCopy' || (slot === 'ewayBill' && needsEway);
                return (
                  <div key={slot} role="group" aria-label={label}>
                    <FileUploadZone
                      label={`${label}${required ? ' · Required' : optional || slot === 'ewayBill' ? ' · Optional' : ''}`}
                      value={docs[slot] || null}
                      onUploadComplete={(result) => setDocs((prev) => ({ ...prev, [slot]: result }))}
                      onFileRemoved={() => setDocs((prev) => ({ ...prev, [slot]: null }))}
                      linkedTo="ASN"
                      accept=".pdf,.png,.jpg,.jpeg"
                    />
                    {errors[slot] && <p className="mt-1 text-xs text-danger">{errors[slot]}</p>}
                  </div>
                );
              })}
            </div>
          </Card>
        </section>
      )}

      {step === 4 && (
        <section aria-label="Review and submit" className="space-y-6">
          <Card title="Lines">
            <ul className="divide-y divide-border text-sm">
              {chosen.map(({ key, po, item }) => (
                <li key={key} className="flex flex-wrap justify-between gap-2 py-2">
                  <span><span className="mono">{po.id} / {item.line}</span> {item.description || item.materialCode}</span>
                  <span className="mono">{quantities[key]} {item.uom || 'EA'}</span>
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" onClick={() => setStep(2)}>Edit quantities</Button>
          </Card>
          <Card title="Shipment">
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {summary.map(([term, value]) => (
                <div key={term} className="flex gap-3"><dt className="w-36 shrink-0 text-fg-muted">{term}</dt><dd className="min-w-0 break-words">{value}</dd></div>
              ))}
            </dl>
            <Button variant="ghost" size="sm" onClick={() => setStep(3)}>Edit shipment details</Button>
          </Card>
          <Card title="Documents">
            <ul className="text-sm">
              {DOC_SLOTS.filter(({ slot }) => docs[slot]?.documentId).map(({ slot, label }) => (
                <li key={slot}>{label}: {docs[slot].originalName || 'attached'}</li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-canvas/95 px-4 py-3 md:-mx-6 md:px-6">
        <p className="mr-auto text-sm text-fg-muted">
          {step < 4 && (remaining(step) ? `${remaining(step)} ${remaining(step) === 1 ? 'thing' : 'things'} left on this step` : 'All required fields are filled')}
          {step === 4 && 'Check the summary. Submit sends it to your buyer and SAP.'}
        </p>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Close</Button>
        {step > 1 && <Button variant="secondary" onClick={back} disabled={busy}>Back</Button>}
        {!editAsn && <Button variant="secondary" onClick={saveDraft} disabled={busy || !chosen.length}>Save draft</Button>}
        {step < 4 && <Button onClick={next} disabled={busy}>Next: {STEPS[step].toLowerCase()}</Button>}
        {step === 4 && (
          <Button onClick={submit} disabled={busy}>
            {busy ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />Submitting…</> : editAsn ? 'Save changes' : 'Submit ASN'}
          </Button>
        )}
      </div>
    </div>
  );
}
