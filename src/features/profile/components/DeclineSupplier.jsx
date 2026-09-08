'use client';

import React, { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { Notice } from '@/components/console/primitives';
import Modal from '@/components/ui/Modal';

// Declining a supplier, from wherever the decision is taken — the directory
// list or one supplier's own page. Shared rather than copied because the reason
// is not a formality: it is what the supplier is told to fix, and a second copy
// is where that requirement would quietly get dropped.

export default function DeclineSupplier({ supplier, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const submit = async () => {
    if (!reason.trim()) return setFailed('A reason is required — the supplier is told what to fix.');
    setBusy(true);
    setFailed('');
    try {
      await apiClient.put(`/vendors/${supplier.pk}/reject`, { reason });
      onDone(`${supplier.companyName} was declined.`);
    } catch (err) {
      setFailed(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Decline ${supplier.companyName}`}
      footer={
        <>
          <button type="button" className="btn btn-o h-9" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-r h-9" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : 'Decline'}
          </button>
        </>
      }
    >
      <Notice tone="error">{failed}</Notice>
      <label className="label">Reason</label>
      <textarea
        rows={4}
        className="w-full"
        value={reason}
        disabled={busy}
        onChange={(event) => setReason(event.target.value)}
        placeholder="The GST certificate is illegible — please upload a clearer copy."
      />
    </Modal>
  );
}
