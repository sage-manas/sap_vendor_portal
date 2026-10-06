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

    // The supplier's account already exists — registration created it — so
    // saving is always an update.
    try {
      await profileService.updateProfile(updated);
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
      await profileService.updateProfile(updated);
      await profileService.submitRegistration(updated);
      // The backend is the source of truth for status from here — it may
      // already be 'Under Review' rather than 'Pending Approval', and the
      // GSTIN/PAN check it runs happens synchronously with this call.
      await loadProfile();
      return { success: true };
    } catch (err) {
      setError(err.message);
      // The optimistic "Pending Approval" above must not outlive a refusal:
      // the supplier would be looking at a submitted registration the server
      // never received. Re-read what the server actually holds.
      await loadProfile();
      return { success: false, error: err.message || 'Your registration could not be submitted.' };
    }
  };

  // Finding 4.2. An approved supplier asking for their payout account to be
  // changed, which the server turns into a `pendingBankChange` for the tenant
  // to review (issue #53) rather than writing to the live columns.
  //
  // Deliberately not `saveDraft`, which the registration flow uses, for two
  // reasons that both matter here:
  //
  //  - it sets `status: 'Draft'` on the local profile. The API refuses a
  //    client-supplied status (it is not in PROFILE_WRITABLE_FIELDS), so this
  //    corrupts only local state — but for an approved supplier that is still
  //    enough to drop them out of the approved view until the next reload.
  //  - it swallows every error in an empty catch. A bank-change request that
  //    silently failed would leave a supplier believing their payments were
  //    about to move.
  //
  // Sends only the five bank fields: a PUT carrying the whole profile would
  // re-send every other column too, and `updateProfile` audits an identity
  // change, so a request about a bank account should not look like one about
  // a company name. Re-reads the profile afterwards rather than guessing at
  // the new state — whether a change is pending is the server's answer, which
  // is the whole point of #53.
  const requestBankChange = async (bankFields) => {
    setError(null);
    try {
      await profileService.updateProfile({ ...bankFields, vendorId: profile.vendorId });
      await loadProfile();
      return { success: true };
    } catch (err) {
      const message = err?.message || 'Your request could not be sent.';
      setError(message);
      return { success: false, error: message };
    }
  };

  return {
    profile,
    loading,
    error,
    saveDraft,
    submitRegistration,
    requestBankChange
  };
}
