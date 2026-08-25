'use client';

import { useState, useEffect } from 'react';
import { useShell } from '../../../lib/shell-context';
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
  const { addSapLog } = useShell();
  const [pos, setPos] = useState([]);
  const [asns, setAsns] = useState([]);
  const [grns, setGrns] = useState([]);

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

  useEffect(() => {
    refreshPOs();
    refreshGRNs();
    refreshASNs();
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

  const simulateIncomingPO = async () => {
    try {
      const res = await poService.createPO({});
      if (res && (res.id || res._id)) {
        setPos(prev => {
          if (prev.some(p => p.id === res.id)) return prev;
          const updated = [res, ...prev];
          persistLocally('sap_vendor_portal_pos', updated);
          return updated;
        });
        addSapLog('OData', '/API_PURCHASEORDER_PROCESS_SRV', 'INBOUND', res, 'SUCCESS');
        return res;
      }
    } catch (e) {
      console.error('API simulation error:', e);
    }

    const newId = generatePoId();
    const fallbackPO = {
      id: newId,
      sapPoNumber: '4500' + Math.floor(100000 + Math.random() * 900000),
      vendorId: profile?.vendorId || 'mock_vendor_id',
      buyerName: 'SAP Buyer System',
      plant: '1000',
      paymentTerms: 'NET 30 Days',
      currency: 'INR',
      deliveryAddress: 'Plant 1000 Main Warehouse, Mumbai',
      status: 'Open',
      createdDate: new Date().toLocaleDateString('en-GB'),
      items: [{
        line: 10,
        materialCode: 'MAT-3849',
        description: 'Steel Pipe 3" SCH40',
        quantity: 500,
        grnQuantity: 0,
        unitPrice: 240,
        netValue: 120000,
        uom: 'EA'
      }]
    };

    setPos(prev => {
      const updated = [fallbackPO, ...prev];
      persistLocally('sap_vendor_portal_pos', updated);
      return updated;
    });
    addSapLog('OData', '/API_PURCHASEORDER_PROCESS_SRV', 'INBOUND', fallbackPO, 'SUCCESS');
    return fallbackPO;
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
    addPO,
    acknowledgePO,
    submitASN,
    simulateIncomingPO,
    setInvoiceSubmittedForGrn,
    refreshPOs,
    refreshGRNs,
    refreshASNs
  };
}
