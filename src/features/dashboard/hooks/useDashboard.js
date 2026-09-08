'use client';

import { useState, useEffect, useCallback } from 'react';
import { INITIAL_CHATS, INITIAL_PERFORMANCE } from '../constants';
import { hasOwnChrome } from '../../../lib/planes';
import { dashboardService } from '../services/dashboardService';

// Only a supplier login caches a vendor profile (see sign-in/page.jsx) — a
// tenant-staff token present on a supplier-chrome page (e.g. mid-redirect to
// /workspace) must not trigger a vendor-scoped fetch, since staff have no
// scopeVendorId and the backend will 400 it.
const canFetchVendorData = () =>
  typeof window !== 'undefined'
  && localStorage.getItem('jwt_token')
  && localStorage.getItem('sap_vendor_profile_data')
  && !hasOwnChrome(window.location.pathname);

export function useDashboard(profile) {
  const [chats, setChats] = useState([]);

  const [performance, setPerformance] = useState(INITIAL_PERFORMANCE);

  // Read any locally cached performance score after mount (client-only, so it
  // can't cause a server/client render mismatch during hydration).
  useEffect(() => {
    try {
      const savedPerf = localStorage.getItem('sap_vendor_portal_performance');
      if (savedPerf) {
        // Seeding mutable state from an external store on mount. It cannot move
        // into the initial useState value (localStorage does not exist during
        // the server render, so the two passes would disagree and hydration
        // would fail) and it cannot become derived state, because the same
        // `performance` value is subsequently replaced by the API response
        // below and cleared by the reset path. One extra render on mount is the
        // real cost of reading a browser-only cache, not a cascade.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPerformance(JSON.parse(savedPerf));
      }
    } catch (e) {
      console.error('Failed to load dashboard state performance', e);
    }
  }, []);

  // Fetch live backend performance score if vendor is approved
  useEffect(() => {
    if (!canFetchVendorData()) return;
    if (profile?.sapVendorCode && profile?.status === 'Approved') {
      dashboardService.getPerformance().then(data => {
        if (data) {
          const mapped = {
            deliveryOTIF: data.deliveryOTIF,
            qualityAcceptance: data.qualityAcceptance,
            priceIndex: 88.0, // Fallback accent metric
            responseTimeHours: 3.4,
            grade: data.grade
          };
          setPerformance(mapped);
          try {
            localStorage.setItem('sap_vendor_portal_performance', JSON.stringify(mapped));
          } catch (e) {}
        }
      }).catch(() => {});
    }
  }, [profile]);

  const persistChats = (updated) => {
    try {
      localStorage.setItem('sap_vendor_portal_chats', JSON.stringify(updated));
    } catch (e) {}
  };

  const refreshChats = useCallback(async () => {
    if (!canFetchVendorData()) return;
    try {
      const data = await dashboardService.getChats();
      if (data) {
        setChats(data);
        persistChats(data);
      }
    } catch (e) {
      console.error('Failed to load chats from API', e);
    }
  }, []);

  useEffect(() => {
    void (async () => { await refreshChats(); })();
  }, [refreshChats]);

  const sendChatMessage = async (text) => {
    const tempMsg = {
      id: `MSG-${Date.now()}`,
      sender: 'Vendor',
      message: text,
      timestamp: new Date().toISOString()
    };
    setChats(prev => [...prev, tempMsg]);

    try {
      await dashboardService.sendChatMessage({ message: text });
      refreshChats();
    } catch (e) {
      console.error(e);
      refreshChats();
    }
  };

  const addSystemMessage = (messageText) => {
    const sysMsg = {
      id: `MSG-SYS-${Date.now()}`,
      sender: 'System',
      message: messageText,
      timestamp: new Date().toISOString()
    };
    setChats(prev => {
      const final = [...prev, sysMsg];
      persistChats(final);
      return final;
    });
  };

  const clearAllState = () => {
    localStorage.removeItem('sap_vendor_profile_data');
    localStorage.removeItem('sap_vendor_portal_rfqs');
    localStorage.removeItem('sap_vendor_portal_pos');
    localStorage.removeItem('sap_vendor_portal_asns');
    localStorage.removeItem('sap_vendor_portal_grns');
    localStorage.removeItem('sap_vendor_portal_invoices');
    localStorage.removeItem('sap_vendor_portal_payments');
    localStorage.removeItem('sap_vendor_portal_chats');
    localStorage.removeItem('sap_vendor_portal_performance');
    localStorage.removeItem('sap_vendor_portal_logs');

    // Refresh page to reset states
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  return {
    chats,
    performance,
    sendChatMessage,
    addSystemMessage,
    clearAllState,
    refreshChats
  };
}
