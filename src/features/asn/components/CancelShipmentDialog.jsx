'use client';

import React, { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Modal from '@/components/ui/Modal';

// Withdrawing a shipment notice, with the reason the buyer will see.
export default function CancelShipmentDialog({ asn, onClose, onCancel }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!reason.trim()) {
      setError('Say why — your buyer may already be planning to receive it.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onCancel(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || 'The shipment could not be cancelled.');
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Cancel shipment ${asn.id}`}>
      <div className="space-y-4 pt-1">
        <p className="text-fg-muted">
          The quantities on it become free to ship again. To correct a shipment, cancel it and send a new one.
        </p>
        <textarea
          aria-label="Reason for cancelling"
          className="min-h-24 w-full"
          placeholder="For example: vehicle did not leave, wrong quantity"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <p className="flex items-start gap-1 text-danger"><AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Keep shipment</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="mr-2 size-4 animate-spin" /> Cancelling…</> : 'Cancel shipment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
