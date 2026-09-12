'use client';

import { useState, useEffect } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { poService } from '../services/poService';

const canFetchVendorData = () =>
  typeof window !== 'undefined' && localStorage.getItem('jwt_token') && !hasOwnChrome(window.location.pathname);

const generateInboundDeliveryCode = () => {
  return `1800${Math.floor(100000 + Math.random() * 900000)}`;
};

const generateGrnId = () => {
  return `GRN-${Math.floor(5000000 + Math.random() * 4900000)}`;
};

const generateSapMigoDoc = () => {
  return `50002${Math.floor(10000 + Math.random() * 90000)}`;
};

const calculateRejectedQuantity = (received) => {
  return Math.random() > 0.85 ? Math.min(2, Math.floor(received * 0.1)) : 0;
};

const generatePoId = () => {
  return `PO-45000${Math.floor(10000 + Math.random() * 90000)}`;
};

export function usePOs(profile) {
  const [pos, setPos] = useState([]);
  const [asns, setAsns] = useState([]);
  const [grns, setGrns] = useState([]);
  const [sapPoOrders, setSapPoOrders] = useState(null);
  // Whether the "has SAP recorded this?" question has been answered at all.
  // Kept beside sapPoOrders rather than folded into it because the screens
  // still want the array: 'loading' | 'ready' | 'error'.
  //
  // Without this, three separate failures all left the UI on a spinner that
  // never resolved, and a supplier reads a spinner as "checking", not as "we
  // could not find out": api-client answers null rather than throwing on a
  // connectivity error, poService maps every other rejection to null too, and
  // a response missing `orders` would have set the state back to undefined.
  const [sapPoStatus, setSapPoStatus] = useState('loading');

  const persistLocally = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {}
  };

  const refreshPOs = async () => {
    if (!canFetchVendorData()) return;
    try {
      const data = await poService.getPOs();
      if (data && data.pos) {
        setPos(data.pos);
        persistLocally('sap_vendor_portal_pos', data.pos);
      }
    } catch (e) {
      console.error('Failed to fetch POs', e);
    }
  };

  const refreshGRNs = async () => {
    if (!canFetchVendorData()) return;
    try {
      const data = await poService.getGRNs();
      if (data) {
        const grnList = Array.isArray(data) ? data : (data.grns || []);
        setGrns(grnList);
        persistLocally('sap_vendor_portal_grns', grnList);
      }
    } catch (e) {
      console.error('Failed to fetch GRNs', e);
    }
  };

  const refreshASNs = async () => {
    if (!canFetchVendorData()) return;
    try {
      const data = await poService.getASNs();
      if (data) {
        setAsns(data);
        persistLocally('sap_vendor_portal_asns', data);
      }
    } catch (e) {
      console.error('Failed to fetch ASNs', e);
    }
  };

  const refreshSapPoStatus = async () => {
    if (!canFetchVendorData()) return;
    setSapPoStatus('loading');
    try {
      const data = await poService.getSapStatus();
      // `data` is null for a connectivity error (api-client's convention) and
      // for anything poService's own catch swallowed. A body without `orders`
      // is a contract change, not an empty ledger — say so rather than
      // rendering it as "nothing on file".
      if (!data || !Array.isArray(data.orders)) {
        setSapPoStatus('error');
        return;
      }
      setSapPoOrders(data.orders);
      setSapPoStatus('ready');
    } catch (e) {
      console.error('Failed to fetch SAP PO/GRN status', e);
      setSapPoStatus('error');
    }
  };

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshPOs(), refreshGRNs(), refreshASNs(), refreshSapPoStatus()]);
    })();
  }, [profile]);

  const addPO = (newPO) => {
    setPos(prev => {
      const updated = [newPO, ...prev];
      persistLocally('sap_vendor_portal_pos', updated);
      return updated;
    });
  };

  const acknowledgePO = async (poId) => {
    try {
      setPos(prev => prev.map(po => po.id === poId ? { ...po, status: 'Acknowledged', acknowledgedAt: new Date().toISOString() } : po));
      await poService.acknowledgePO(poId);
      refreshPOs();
      return { success: true };
    } catch (e) {
      console.error(e);
      refreshPOs();
      return { success: false, error: e.message };
    }
  };

  const submitASN = async (asnData) => {
    try {
      setPos(prev => prev.map(po => po.id === asnData.poId ? { ...po, status: 'Dispatched' } : po));
      const res = await poService.submitASN(asnData.poId, asnData);
      refreshPOs();
      refreshASNs();
      return res;
    } catch (e) {
      console.error(e);
      refreshPOs();
      refreshASNs();
      throw e;
    }
  };

  const setInvoiceSubmittedForGrn = (grnId) => {
    setGrns(prev => {
      const updated = prev.map(g => {
        if (g.id === grnId) return { ...g, invoiceSubmitted: true };
        return g;
      });
      persistLocally('sap_vendor_portal_grns', updated);
      return updated;
    });
  };

  return {
    pos,
    asns,
    grns,
    sapPoOrders,
    sapPoStatus,
    addPO,
    acknowledgePO,
    submitASN,
    setInvoiceSubmittedForGrn,
    refreshPOs,
    refreshGRNs,
    refreshASNs,
    refreshSapPoStatus
  };
}
