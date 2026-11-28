'use client';

import React, { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Modal from '@/components/ui/Modal';

// The tenant admin turning down a shipment notice, with the reason the
// supplier will see.
export default function RejectShipmentDialog({ asn, onClose, onReject }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!reason.trim()) {
      setError('Say why — the supplier sees this and corrects the shipment from it.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onReject(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || 'The shipment could not be rejected.');
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Reject shipment ${asn.id}`}>
      <div className="space-y-4 pt-1">
        <p className="text-fg-muted">
          Nothing is sent to SAP. Its quantities become free to ship again, and the supplier can send a corrected one.
        </p>
        <textarea
          aria-label="Reason for rejecting"
          className="min-h-24 w-full"
          placeholder="For example: quantity does not match the delivery schedule"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <p className="flex items-start gap-1 text-danger"><AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Keep it waiting</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="mr-2 size-4 animate-spin" /> Rejecting…</> : 'Reject shipment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
