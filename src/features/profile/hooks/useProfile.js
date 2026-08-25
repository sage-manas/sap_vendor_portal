'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useShell } from '../../../lib/shell-context';
import { hasOwnChrome } from '../../../lib/planes';
import { profileService } from '../services/profileService';

const getOrGenerateVendorId = () => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('clerk_user_id');
    if (saved) return saved;
    const generated = `mock_vendor_${Math.floor(Math.random() * 100000)}`;
    localStorage.setItem('clerk_user_id', generated);
    return generated;
  }
  return '';
};

const generateSapVendorCode = () => {
  return `VND-400${Math.floor(1000 + Math.random() * 9000)}`;
};

export function useProfile() {
  const { addSapLog } = useShell();
  const [profile, setProfile] = useState({
    companyName: '',
    tradeName: '',
    businessType: '',
    incorporationDate: '',
    gstin: '',
    gstType: '',
    pan: '',
    cin: '',
    msmeNumber: '',
    tdsSection: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    bankName: '',
    accountNumber: '',
    ifscCode: '',
    accountName: '',
    bankBranch: '',
    cancelledCheque: null,
    panCardCopy: null,
    gstCertificate: null,
    msmeCertificate: null,
    status: 'Draft',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const pathname = usePathname();

  // Hydrate profile on mount or page transitions
  useEffect(() => {
    async function loadProfile() {
      if (typeof window === 'undefined') return;
      const token = localStorage.getItem('jwt_token');
      // The platform console and tenant workspace hold their own sessions and
      // never a supplier profile — this hook has nothing to fetch there.
      if (!token || hasOwnChrome(window.location.pathname)) {
        setLoading(false);
        return;
      }

      try {
        const data = await profileService.getProfile();
        if (data) {
          setProfile(data);
          try {
            localStorage.setItem('sap_vendor_profile_data', JSON.stringify(data));
          } catch (e) {}
        }
      } catch (err) {
        // Fallback to localStorage
        try {
          const saved = localStorage.getItem('sap_vendor_profile_data');
          if (saved) {
            setProfile(JSON.parse(saved));
          }
        } catch (e) {}
      } finally {
        setLoading(false);
      }
    }
    loadProfile();
  }, [pathname]);

  const persistLocally = (updated) => {
    try {
      localStorage.setItem('sap_vendor_profile_data', JSON.stringify(updated));
    } catch (e) {}
  };

  const saveDraft = async (profileData) => {
    const vendorId = profile.vendorId || getOrGenerateVendorId();
    const updated = {
      ...profile,
      ...profileData,
      vendorId,
      status: 'Draft'
    };
    setProfile(updated);
    persistLocally(updated);

    // The vendor's account (and its Vendor doc) already exists for anyone who
    // signed up normally, so PUT is the common case; only fall back to POST
    // for the dev/mock-vendor flow that hasn't created a profile doc yet.
    try {
      await profileService.updateProfile(updated).catch(() => profileService.createProfile(updated));
    } catch (e) {}
  };

  const submitRegistration = async (profileData) => {
    const vendorId = profile.vendorId || getOrGenerateVendorId();
    const updated = {
      ...profile,
      ...profileData,
      vendorId,
      status: 'Pending Approval',
      submittedAt: new Date().toISOString()
    };
    setProfile(updated);
    persistLocally(updated);

    addSapLog(
      'BAPI',
      'BAPI_VENDOR_CREATE',
      'OUTBOUND',
      JSON.stringify({
        I_GENERAL_DATA: {
          NAME: profileData.companyName,
          EMAIL: profileData.email,
          TEL: profileData.phone,
          TAX_NUMBER: profileData.gstin,
          PAN: profileData.pan
        },
        I_BANK_DETAIL: {
          BANK_NAME: profileData.bankName,
          ACC_NUMBER: profileData.accountNumber,
          IFSC: profileData.ifscCode
        }
      }),
      'PENDING'
    );

    try {
      await profileService.updateProfile(updated).catch(() => profileService.createProfile(updated));
      await profileService.submitRegistration(updated);
    } catch (err) {
      setError(err.message);
    }

    // Auto-approve after 5s
    setTimeout(() => {
      approveRegistration();
    }, 5000);
  };

  const approveRegistration = () => {
    setProfile(prev => {
      if (prev.status !== 'Pending Approval') return prev;

      const sapVendorCode = generateSapVendorCode();
      const updated = {
        ...prev,
        status: 'Approved',
        sapVendorCode,
        approvedAt: new Date().toISOString()
      };

      persistLocally(updated);

      addSapLog(
        'RFC',
        'RFC_VENDOR_SYNC_REPLY',
        'INBOUND',
        JSON.stringify({
          LIFNR: sapVendorCode,
          NAME1: prev.companyName,
          STATUS: 'ACTIVE',
          SAP_MSG: 'Vendor Master synchronization completed successfully'
        }),
        'SUCCESS'
      );

      return updated;
    });
  };

  return {
    profile,
    loading,
    error,
    saveDraft,
    submitRegistration,
    approveRegistration
  };
}
