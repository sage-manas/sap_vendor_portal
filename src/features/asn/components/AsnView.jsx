'use client';

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePortal } from '@/lib/portal-context';
import AsnDashboard from './AsnDashboard';
import AsnWizard from './AsnWizard';
import AsnDetail from './AsnDetail';

// The ASN module (ASN design screens V1–V6) on one route, /asn, so the
// sidebar keeps it highlighted wherever the supplier is in it:
//
//   /asn                     the dashboard: shipments and drafts (V1)
//   /asn?new=1[&po=PO-…]     the four-step wizard (V2–V5), optionally
//                            starting from one order's lines
//   /asn?draft=<pk>          the wizard, resuming a saved draft
//   /asn?id=ASN-…            one shipment, with its tracking (V6)
//
// The view lives in state, read from the URL on arrival and when the URL
// changes (back/forward), and pushed to it on every move so a view can be
// bookmarked or shared.
const viewFrom = (params) => {
  if (params?.get('id')) return { name: 'detail', id: params.get('id') };
  if (params?.get('draft')) return { name: 'wizard', draftPk: params.get('draft') };
  if (params?.get('new')) return { name: 'wizard', poId: params.get('po') || null };
  return { name: 'list' };
};

const urlFor = (view) => {
  if (view.name === 'detail') return `/asn?id=${encodeURIComponent(view.id)}`;
  if (view.name === 'wizard' && view.draftPk) return `/asn?draft=${encodeURIComponent(view.draftPk)}`;
  if (view.name === 'wizard') return `/asn?new=1${view.poId ? `&po=${encodeURIComponent(view.poId)}` : ''}`;
  return '/asn';
};

export default function AsnView() {
  const router = useRouter();
  const params = useSearchParams();
  const { state, poHook } = usePortal();
  const [view, setView] = useState(() => viewFrom(params));

  // A URL change the page did not make itself (back, forward, a link) moves
  // the view with it — adjusted during render, React's pattern for state that
  // follows a prop, rather than in an effect.
  const paramsKey = params?.toString() || '';
  const [seenKey, setSeenKey] = useState(paramsKey);
  if (seenKey !== paramsKey) {
    setSeenKey(paramsKey);
    setView(viewFrom(params));
  }

  const go = (next) => {
    setView(next);
    router.push(urlFor(next));
  };

  if (view.name === 'wizard') {
    return (
      <AsnWizard
        key={view.draftPk || view.poId || 'new'}
        pos={state.pos || []}
        draftPk={view.draftPk}
        startPoId={view.poId}
        submitShipment={poHook.submitShipment}
        submitAsnDraft={poHook.submitAsnDraft}
        onCancel={() => go({ name: 'list' })}
        onSubmitted={(asn) => go({ name: 'detail', id: asn.id })}
      />
    );
  }

  if (view.name === 'detail') {
    return (
      <AsnDetail
        asn={(state.asns || []).find((asn) => asn.id === view.id)}
        asnId={view.id}
        cancelShipment={poHook.cancelShipment}
        onBack={() => go({ name: 'list' })}
      />
    );
  }

  return (
    <AsnDashboard
      pos={state.pos || []}
      asns={state.asns || []}
      onCreate={() => go({ name: 'wizard' })}
      onResume={(draft) => go({ name: 'wizard', draftPk: draft.pk })}
      onOpen={(asn) => go({ name: 'detail', id: asn.id })}
    />
  );
}
