'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
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

// A vendor's own browser only ever asks for its own status; it cannot decide
// it for itself. Approval is a client-admin action against the backend (see
// backend/controllers/vendor.controller.js approveVendor) — the vendor master
// is created in SAP only once that happens. So while the profile is awaiting
// a decision, this hook polls the real profile rather than faking one.
const AWAITING_DECISION_STATUSES = ['Pending Approval', 'Under Review'];
const PENDING_POLL_MS = 10000;

export function useProfile() {
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

  const loadProfile = async () => {
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
  };

  // Hydrate profile on mount or page transitions
  useEffect(() => {
    void (async () => { await loadProfile(); })();
  }, [pathname]);

  // While a decision is pending, the client admin — not this browser — is the
  // one who moves the vendor to Approved/Rejected (approveVendor/rejectVendor
  // in the backend). Poll for that decision rather than assuming one.
  useEffect(() => {
    if (!AWAITING_DECISION_STATUSES.includes(profile.status)) return;
    const interval = setInterval(loadProfile, PENDING_POLL_MS);
    return () => clearInterval(interval);
  }, [profile.status]);

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

    try {
      await profileService.updateProfile(updated).catch(() => profileService.createProfile(updated));
      await profileService.submitRegistration(updated);
      // The backend is the source of truth for status from here — it may
      // already be 'Under Review' rather than 'Pending Approval', and the
      // GSTIN/PAN check it runs happens synchronously with this call.
      await loadProfile();
    } catch (err) {
      setError(err.message);
    }
  };

  return {
    profile,
    loading,
    error,
    saveDraft,
    submitRegistration
  };
}
