'use client';

import React from 'react';
import { usePortal } from '@/lib/portal-context';
import RegistrationView from '@/features/profile/components/RegistrationView';

export default function RegistrationPage() {
  const {
    state,
    companyForm,
    setCompanyForm,
    handleCompanySubmit,
    profileHook
  } = usePortal();

  return (
    <RegistrationView
      state={state}
      companyForm={companyForm}
      setCompanyForm={setCompanyForm}
      handleCompanySubmit={handleCompanySubmit}
      saveDraft={profileHook.saveDraft}
      submitRegistration={profileHook.submitRegistration}
    />
  );
}
