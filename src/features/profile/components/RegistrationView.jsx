import React, { useState, useEffect, useRef } from 'react';
import { validateField } from '../validation';
import { profileService } from '../services/profileService';
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  Check,
  FileText,
  ChevronRight,
  ChevronLeft,
  Eye,
  EyeOff,
  Search,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import FileUploadZone from '@/components/shared/FileUploadZone';
import FieldCard from '@/components/ui/FieldCard';
import { PageHeader } from '@/components/ui/Page';
import StatusBadge from '@/components/ui/StatusBadge';
import { BankChangeRequest } from './BankChangeRequest';

// --- INDIAN STATES CONSTANT ---
const INDIAN_STATES = [
  { code: 'AN', name: 'Andaman & Nicobar Islands' },
  { code: 'AP', name: 'Andhra Pradesh' },
  { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' },
  { code: 'BR', name: 'Bihar' },
  { code: 'CH', name: 'Chandigarh' },
  { code: 'CG', name: 'Chhattisgarh' },
  { code: 'DN', name: 'Dadra & Nagar Haveli' },
  { code: 'DD', name: 'Daman & Diu' },
  { code: 'DL', name: 'Delhi' },
  { code: 'GA', name: 'Goa' },
  { code: 'GJ', name: 'Gujarat' },
  { code: 'HR', name: 'Haryana' },
  { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'JK', name: 'Jammu & Kashmir' },
  { code: 'JH', name: 'Jharkhand' },
  { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' },
  { code: 'LA', name: 'Ladakh' },
  { code: 'LD', name: 'Lakshadweep' },
  { code: 'MP', name: 'Madhya Pradesh' },
  { code: 'MH', name: 'Maharashtra' },
  { code: 'MN', name: 'Manipur' },
  { code: 'ML', name: 'Meghalaya' },
  { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' },
  { code: 'OD', name: 'Odisha' },
  { code: 'PY', name: 'Puducherry' },
  { code: 'PB', name: 'Punjab' },
  { code: 'RJ', name: 'Rajasthan' },
  { code: 'SK', name: 'Sikkim' },
  { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TS', name: 'Telangana' },
  { code: 'TR', name: 'Tripura' },
  { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UK', name: 'Uttarakhand' },
  { code: 'WB', name: 'West Bengal' }
];

// --- COUNTRY / REGION DATA ---
// A curated set of trading-partner countries, not an exhaustive ISO list —
// intentionally small per IMPLEMENTATION_PLAN.md Phase 7c ("a reasonably
// short curated set is fine"). India gets a real region list (mapped from
// the pre-existing INDIAN_STATES codes); other countries get a short
// placeholder region list. Region codes are unverified against what SAP's
// `region` field (T005S-BLAND-style) actually expects for non-India
// countries — confirm with the buyer’s system before relying on them.
const COUNTRIES = [
  { code: 'IN', name: 'India', regions: INDIAN_STATES },
  {
    code: 'US', name: 'United States',
    regions: [
      { code: 'CA', name: 'California' }, { code: 'NY', name: 'New York' },
      { code: 'TX', name: 'Texas' }, { code: 'IL', name: 'Illinois' },
      { code: 'OTH', name: 'Other / Not Listed' },
    ],
  },
  {
    code: 'GB', name: 'United Kingdom',
    regions: [
      { code: 'ENG', name: 'England' }, { code: 'SCT', name: 'Scotland' },
      { code: 'WLS', name: 'Wales' }, { code: 'NIR', name: 'Northern Ireland' },
    ],
  },
  {
    code: 'AE', name: 'United Arab Emirates',
    regions: [
      { code: 'DU', name: 'Dubai' }, { code: 'AZ', name: 'Abu Dhabi' },
      { code: 'SH', name: 'Sharjah' }, { code: 'OTH', name: 'Other Emirate' },
    ],
  },
  {
    code: 'SG', name: 'Singapore',
    regions: [{ code: 'SG', name: 'Singapore' }],
  },
  {
    code: 'DE', name: 'Germany',
    regions: [
      { code: 'BY', name: 'Bavaria' }, { code: 'BW', name: 'Baden-Württemberg' },
      { code: 'NW', name: 'North Rhine-Westphalia' }, { code: 'OTH', name: 'Other / Not Listed' },
    ],
  },
];

const regionsForCountry = (countryCode) =>
  COUNTRIES.find((c) => c.code === countryCode)?.regions || [];

// --- STATIC SUBCOMPONENTS ---

// One titled group of fields. Numbers are gone: the stepper already says
// where the supplier is, and a heading per group is what a screen reader
// lists.
function FormSection({ title, children }) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

// 5. Accessible Searchable Dropdown
// `id` and the aria props come from the FieldCard wrapping this — the trigger
// button IS the control, so they belong on it. Without forwarding them the
// label has nothing to point at and the field is announced unnamed.
function SearchableSelect({ value, onChange, options, placeholder, error, id, ...aria }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const filteredOptions = options.filter(opt =>
    opt.name.toLowerCase().includes(search.toLowerCase()) ||
    opt.code.toLowerCase().includes(search.toLowerCase())
  );

  const selectedOpt = options.find(opt => opt.code === value);

  return (
    <div className="relative w-full" ref={containerRef}>
      <button
        type="button"
        id={id}
        onClick={() => {
          setIsOpen(!isOpen);
          setSearch('');
        }}
        className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm text-fg hover:border-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-solid)] aria-[invalid=true]:border-danger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        {...aria}
      >
        <span className={selectedOpt ? 'text-fg' : 'text-fg-subtle'}>
          {selectedOpt ? `${selectedOpt.name} (${selectedOpt.code})` : placeholder}
        </span>
        <ChevronRight className={`size-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-popover">
          <div className="sticky top-0 flex items-center gap-1.5 border-b border-border bg-surface px-2.5 py-1.5">
            <Search className="size-4 shrink-0 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
              placeholder="Search…"
              aria-label="Search options"
              className="min-h-0! w-full border-0! bg-transparent! px-0! py-1! text-sm shadow-none! outline-none!"
              autoFocus
            />
          </div>
          <ul className="py-1" role="listbox">
            {filteredOptions.length > 0 ? (
              filteredOptions.map(opt => (
                <li
                  key={opt.code}
                  role="option"
                  aria-selected={opt.code === value}
                  onClick={() => {
                    onChange(opt.code);
                    setIsOpen(false);
                  }}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm hover:bg-subtle ${opt.code === value ? 'bg-subtle font-medium text-fg' : 'text-fg'}`}
                >
                  <span>{opt.name}</span>
                  <span className="mono text-xs text-fg-subtle">{opt.code}</span>
                </li>
              ))
            ) : (
              <li className="px-3 py-2 text-sm text-fg-muted">No matches</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// 7. Drag and Drop Document Upload Zone Component
function DocumentUploadZone({ fieldName, value, onChange, label, error, id, ...aria }) {
  const fileValue = value
    ? (typeof value === 'object' && value.documentId
        ? value
        : { documentId: value, originalName: typeof value === 'object' ? value.originalName || 'file.pdf' : value, url: typeof value === 'object' ? value.url || '#' : '#' })
    : null;

  return (
    <FileUploadZone
      id={id}
      {...aria}
      label={label}
      value={fileValue}
      onUploadComplete={(result) => onChange(result)}
      onFileRemoved={() => onChange(null)}
      linkedTo="Profile"
      accept=".pdf,.png,.jpg,.jpeg"
    />
  );
}

// The four registration steps. A step is a button: it moves the supplier
// there, subject to the same validation as "Save and continue".
function ProgressIndicator({ steps, currentStep, onStepClick, errors }) {
  return (
    <nav aria-label="Registration steps">
      <ol className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {steps.map((step, idx) => {
          const stepNum = idx + 1;
          const isActive = currentStep === stepNum;
          const isCompleted = currentStep > stepNum;
          const stepHasErrors = errors[stepNum] && Object.keys(errors[stepNum]).length > 0;
          return (
            <li key={stepNum}>
              <button
                type="button"
                onClick={() => onStepClick && onStepClick(stepNum)}
                aria-current={isActive ? 'step' : undefined}
                className={`block w-full cursor-pointer border-t-2 pt-2.5 text-left ${isActive
                  ? 'border-accent-solid'
                  : isCompleted ? 'border-fg' : stepHasErrors ? 'border-danger' : 'border-border hover:border-fg-subtle'}`}
              >
                <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                  {isCompleted && <Check className="size-3.5 text-success" strokeWidth={2} aria-hidden="true" />}
                  {stepHasErrors && !isCompleted && <AlertTriangle className="size-3.5 text-danger" strokeWidth={1.5} aria-hidden="true" />}
                  Step {stepNum}
                </span>
                <span className={`mt-0.5 block text-sm ${isActive ? 'font-medium text-fg' : isCompleted ? 'text-fg' : 'text-fg-muted'}`}>
                  {step.name}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// Sticky action bar: back and save on the left, the one forward action on
// the right.
function ActionFooter({ currentStep, onBack, onSaveDraft, onContinue, onSubmit, draftSaving }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 flex items-center justify-between gap-3 border-t border-border bg-canvas px-4 py-3 md:-mx-6 md:px-6">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" disabled={currentStep === 1} onClick={onBack}>
          <ChevronLeft className="size-4" strokeWidth={1.5} /> Back
        </Button>
        <Button type="button" variant="secondary" onClick={onSaveDraft} disabled={draftSaving}>
          {draftSaving ? (
            <>
              <RefreshCw className="mr-1 size-3.5 animate-spin" strokeWidth={1.5} />
              Saving…
            </>
          ) : 'Save draft'}
        </Button>
      </div>
      {currentStep < 4 ? (
        <Button type="button" onClick={onContinue}>
          Save and continue <ChevronRight className="size-4" strokeWidth={1.5} />
        </Button>
      ) : (
        <Button type="button" onClick={onSubmit}>
          Submit registration
        </Button>
      )}
    </div>
  );
}

// --- MAIN MODULE RENDERING VIEW ---
export default function RegistrationView({
  state,
  companyForm,
  setCompanyForm,
  handleCompanySubmit,
  saveDraft,
  submitRegistration,
  requestBankChange
}) {
  const isApproved = state.profile.status === 'Approved';
  const isPending = state.profile.status === 'Pending Approval' || state.profile.status === 'Under Review';
  const isDraft = state.profile.status === 'Draft' || state.profile.status === 'Rejected' || state.profile.status === 'Pending';

  const [currentStep, setCurrentStep] = useState(1);
  const [validationErrors, setValidationErrors] = useState({});
  const [draftSaving, setDraftSaving] = useState(false);
  const [showSaveToast, setShowSaveToast] = useState(false);
  const [passVisible, setPassVisible] = useState(false);
  const [blockedStepAlert, setBlockedStepAlert] = useState('');
  const [ifscLookup, setIfscLookup] = useState({ status: 'idle', error: '' });
  const [pincodeLookup, setPincodeLookup] = useState({ status: 'idle', error: '' });

  // VENDOR_CR rejects free text for region and payment terms — they're SAP
  // master-data codes (T005S / T052), not descriptive strings — so the form's
  // dropdowns for these two fields are populated from the tenant's own SAP,
  // not a hardcoded guess. Fetched once; this data changes as rarely as SAP
  // config does.
  const [sapReference, setSapReference] = useState({ regions: null, paymentTerms: null, paymentMethods: null, status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    profileService.getSapReferenceData()
      .then((data) => { if (!cancelled && data) setSapReference({ ...data, status: 'ready' }); })
      .catch(() => { if (!cancelled) setSapReference((prev) => ({ ...prev, status: 'error' })); });
    return () => { cancelled = true; };
  }, []);

  // Field definitions to calculate metadata counts dynamically
  const stepConfigs = [
    {
      name: 'Company Information',
      sections: [
        { title: 'COMPANY IDENTITY', fields: ['companyName', 'tradeName', 'businessType', 'incorporationDate'] },
        { title: 'REGISTERED ADDRESS', fields: ['address', 'city', 'country', 'region', 'postalCode', 'email', 'phone'] },
        // Rendered as FormSection 03 below but absent from this list until now,
        // which meant validateStep never looked at them and every one of them
        // could reach SAP empty. VENDOR_CR needs all five.
        { title: 'TRADE & PAYMENT TERMS', fields: ['paymentTerms', 'paymentMethod', 'currency', 'incoterms1', 'incoterms2'] }
      ]
    },
    {
      name: 'Tax & Regulatory',
      sections: [
        { title: 'INDIAN TAX IDS', fields: ['pan', 'gstin', 'gstType', 'cin', 'msmeNumber', 'tdsSection'] }
      ]
    },
    {
      name: 'Bank Details',
      sections: [
        { title: 'BANK ACCOUNT', fields: ['accountName', 'accountNumber', 'ifscCode', 'bankName', 'bankBranch', 'cancelledCheque'] }
      ]
    },
    {
      name: 'Document Uploads',
      sections: [
        { title: 'MANDATORY', fields: ['panCardCopy', 'gstCertificate'] },
        { title: 'OPTIONAL', fields: ['msmeCertificate'] }
      ]
    }
  ];

  const validateStep = (stepIdx) => {
    const config = stepConfigs[stepIdx - 1];
    const stepErrors = {};
    let stepValid = true;

    config.sections.forEach(sec => {
      sec.fields.forEach(field => {
        const error = validateField(field, companyForm[field]);
        if (error) {
          stepErrors[field] = error;
          stepValid = false;
        }
      });
    });

    setValidationErrors(prev => ({ ...prev, [stepIdx]: stepErrors }));
    return stepValid;
  };

  // What's left across every step, from the live form values — not just the
  // current step's errors. A vendor fixing a rejection (or resuming a draft)
  // should see the whole remaining checklist up front rather than discover it
  // one "Continue" click at a time. Read-only: unlike validateStep, this never
  // touches validationErrors, so nothing turns red before the vendor reaches it.
  const outstandingByStep = stepConfigs.reduce((acc, config, idx) => {
    const items = [];
    config.sections.forEach(sec => {
      sec.fields.forEach(field => {
        const error = validateField(field, companyForm[field]);
        if (error) items.push(error);
      });
    });
    if (items.length > 0) acc.push({ stepNum: idx + 1, stepName: config.name, items });
    return acc;
  }, []);
  const outstandingCount = outstandingByStep.reduce((n, g) => n + g.items.length, 0);

  // Bank name and branch are filled from the IFSC lookup and locked while it is
  // pending or has answered; if it failed, the supplier types them instead.
  const bankFieldsLocked = ifscLookup.status === 'loading' || ifscLookup.status === 'success';

  // Auto-fetch bank name/branch whenever a valid IFSC code is entered
  useEffect(() => {
    const code = (companyForm.ifscCode || '').toUpperCase();
    if (!/^[A-Z]{4}0[A-Z\d]{6}$/.test(code)) {
      return;
    }

    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setIfscLookup({ status: 'loading', error: '' });
        return fetch(`https://ifsc.razorpay.com/${code}`);
      })
      .then(res => {
        if (cancelled || !res) return null;
        if (!res.ok) throw new Error('No bank found for this IFSC code');
        return res.json();
      })
      .then(data => {
        if (cancelled || !data) return;
        setCompanyForm(prev => ({ ...prev, bankName: data.BANK || '', bankBranch: data.BRANCH || '' }));
        setIfscLookup({ status: 'success', error: '' });
      })
      .catch(() => {
        if (cancelled) return;
        // The lookup is a convenience on a third-party service the portal does
        // not control; being offline or behind a firewall must not stop a
        // supplier registering. What they have typed is kept, and the two
        // fields become editable (see `bankFieldsLocked` below).
        setIfscLookup({ status: 'error', error: 'Could not look up this IFSC code. Enter the bank name and branch yourself.' });
      });

    return () => { cancelled = true; };
  }, [companyForm.ifscCode, setCompanyForm]);

  // Auto-fill city/state and default the phone country code whenever a valid
  // 6-digit PIN code is entered. City/state/phone stay normal editable inputs
  // so the vendor can still override the looked-up values.
  useEffect(() => {
    const pin = (companyForm.postalCode || '').trim();
    // api.postalpincode.in only covers India — skip the lookup once a
    // non-India country is selected rather than silently mis-filling it.
    if (!/^\d{6}$/.test(pin) || (companyForm.country && companyForm.country !== 'IN')) {
      return;
    }

    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setPincodeLookup({ status: 'loading', error: '' });
        return fetch(`https://api.postalpincode.in/pincode/${pin}`);
      })
      .then(res => {
        if (cancelled || !res) return null;
        if (!res.ok) throw new Error('Could not look up this PIN code');
        return res.json();
      })
      .then(data => {
        if (cancelled || !data) return;
        const record = data[0];
        const postOffice = record?.Status === 'Success' ? record.PostOffice?.[0] : null;
        if (!postOffice) throw new Error('No location found for this PIN code');

        // Prefer the SAP-sourced region code (what VENDOR_CR actually wants)
        // over the curated INDIAN_STATES abbreviation once the catalogue has
        // loaded — matched by state name either way.
        const stateName = (postOffice.State || '').toLowerCase();
        const sapRegionMatch = sapReference.regions?.find(r => r.label.toLowerCase() === stateName);
        const legacyStateMatch = INDIAN_STATES.find(s => s.name.toLowerCase() === stateName);
        const regionCode = sapRegionMatch?.code || legacyStateMatch?.code;

        setCompanyForm(prev => {
          const phone = (prev.phone || '').trim();
          return {
            ...prev,
            city: postOffice.District || prev.city,
            country: 'IN',
            region: regionCode || prev.region,
            state: legacyStateMatch ? legacyStateMatch.code : prev.state, // legacy mirror, see Vendor.js
            phone: phone.startsWith('+') ? prev.phone : (phone ? `+91 ${phone}` : '+91 ')
          };
        });
        setPincodeLookup({ status: 'success', error: '' });
      })
      .catch(err => {
        if (cancelled) return;
        setPincodeLookup({ status: 'error', error: err.message || 'Could not look up this PIN code' });
      });

    return () => { cancelled = true; };
  }, [companyForm.postalCode, companyForm.country, setCompanyForm]);

  // Auto-save progress so a vendor who leaves mid-form (closed tab, network
  // blip, etc.) doesn't have to re-enter everything. Debounced so it doesn't
  // fire on every keystroke, and skipped on the initial mount/hydration pass
  // so it never overwrites a saved draft with the still-empty starting form.
  const autosaveTimerRef = useRef(null);
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    if (!isDraft) return;
    if (!companyForm.companyName || !companyForm.gstin || !companyForm.email) return;

    // Only autosave fields that are actually well-formed — a field that's merely
    // non-empty (e.g. a GSTIN still mid-typed) would otherwise get sent to the
    // backend and rejected with a 400 by its Zod validation.
    const hasFormatErrors = Object.keys(companyForm).some(field => {
      const val = companyForm[field];
      if (!val) return false;
      return !!validateField(field, val);
    });
    if (hasFormatErrors) return;

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      saveDraft(companyForm);
    }, 1500);

    return () => clearTimeout(autosaveTimerRef.current);
  }, [companyForm, isDraft, saveDraft]);

  // Field change hook
  const handleFieldChange = (field, val) => {
    setCompanyForm(prev => ({ ...prev, [field]: val }));

    // Clear error dynamically on input edit
    if (validationErrors[currentStep]?.[field]) {
      setValidationErrors(prev => {
        const nextErrors = { ...prev };
        if (nextErrors[currentStep]) {
          delete nextErrors[currentStep][field];
        }
        return nextErrors;
      });
    }
  };

  // Navigation handlers
  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleContinue = () => {
    const stepValid = validateStep(currentStep);
    if (!stepValid) {
      setBlockedStepAlert('Please fill in all mandatory fields before continuing.');
      setTimeout(() => setBlockedStepAlert(''), 3000);
      return;
    }
    saveDraft(companyForm);
    setCurrentStep(prev => prev + 1);
  };

  const handleStepClick = (targetStep) => {
    if (targetStep <= currentStep) {
      setCurrentStep(targetStep);
      return;
    }
    for (let step = currentStep; step < targetStep; step++) {
      if (!validateStep(step)) {
        setBlockedStepAlert('Please fill in all mandatory fields before continuing.');
        setTimeout(() => setBlockedStepAlert(''), 3000);
        return;
      }
    }
    setCurrentStep(targetStep);
  };

  const handleTriggerSaveDraft = () => {
    setDraftSaving(true);
    saveDraft(companyForm);
    setTimeout(() => {
      setDraftSaving(false);
      setShowSaveToast(true);
      setTimeout(() => setShowSaveToast(false), 2000);
    }, 800);
  };

  const handleFinalSubmit = (e) => {
    e.preventDefault();
    let firstInvalidStep = null;
    for (let step = 1; step <= stepConfigs.length; step++) {
      if (!validateStep(step) && firstInvalidStep === null) {
        firstInvalidStep = step;
      }
    }
    if (firstInvalidStep !== null) {
      setCurrentStep(firstInvalidStep);
      setBlockedStepAlert('Please fill in all mandatory fields before submitting your registration.');
      setTimeout(() => setBlockedStepAlert(''), 3000);
      return;
    }
    Promise.resolve(submitRegistration(companyForm)).then((result) => {
      if (result && result.success === false) {
        setBlockedStepAlert(`Registration not submitted: ${result.error}`);
        setTimeout(() => setBlockedStepAlert(''), 8000);
      }
    });
  };

  // Auto-fill form values on page mount if state exists
  useEffect(() => {
    if (state.profile && state.profile.companyName) {
      // Restore step tracking if previously drafted
      if (state.profile.status === 'Draft' || state.profile.status === 'Rejected') {
        Promise.resolve().then(() => {
          // Find if they filled bank details but not uploads, etc.
          if (state.profile.panCardCopy && state.profile.gstCertificate) {
            setCurrentStep(4);
          } else if (state.profile.accountNumber && state.profile.cancelledCheque) {
            setCurrentStep(3);
          } else if (state.profile.pan && state.profile.gstin) {
            setCurrentStep(2);
          } else {
            setCurrentStep(1);
          }
        });
      }
    }
  }, []);

  return (
    <div className="relative space-y-8 pb-8">
      {showSaveToast && (
        <div role="status" className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-fg shadow-popover">
          <CheckCircle2 className="size-4 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
          Draft saved
        </div>
      )}

      <PageHeader
        title="Company profile"
        description={isApproved
          ? 'The details your buyer holds for your company.'
          : isPending
            ? 'Your registration is with your buyer for review.'
            : `Register your company with your buyer — step ${currentStep} of ${stepConfigs.length}.`}
      />

      {isDraft && (
        <ProgressIndicator
          steps={stepConfigs}
          currentStep={currentStep}
          onStepClick={handleStepClick}
          errors={validationErrors}
        />
      )}

      {blockedStepAlert && (
        <div role="alert" className="fixed right-4 top-4 z-50 flex max-w-md items-start gap-2 rounded-lg border border-danger/40 bg-danger-tint px-4 py-2.5 text-sm text-fg shadow-popover">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
          <span>{blockedStepAlert}</span>
        </div>
      )}

      {/* 5. DRAFT STATE: 4-STEP WIZARD BODY */}
      {isDraft && (
        <form onSubmit={handleFinalSubmit} className="space-y-8">
          {state.profile.status === 'Rejected' && (
            <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-tint p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
              <div className="text-sm">
                <p className="font-medium text-fg">Registration not approved</p>
                <p className="mt-1 text-fg-muted">
                  Some of your documents or bank details did not pass your buyer’s checks. Reason:
                </p>
                <p className="mt-1 text-fg">
                  &quot;{state.profile.rejectionReason || 'Your GST registration or bank details did not match.'}&quot;
                </p>
              </div>
            </div>
          )}

          {/* WHAT'S LEFT — the full remaining checklist, not just this step's */}
          {outstandingCount > 0 ? (
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div>
                <p className="text-sm font-medium text-fg">
                  {state.profile.status === 'Rejected' ? 'What to fix before resubmitting' : "What's left to complete your registration"}
                </p>
                <p className="text-sm text-fg-muted">
                  {outstandingCount} item{outstandingCount === 1 ? '' : 's'} still need{outstandingCount === 1 ? 's' : ''} your attention.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {outstandingByStep.map(group => (
                  <button
                    key={group.stepNum}
                    type="button"
                    onClick={() => setCurrentStep(group.stepNum)}
                    className="cursor-pointer rounded-md border border-border p-3 text-left hover:bg-subtle"
                  >
                    <span className="mb-1.5 block text-xs text-fg-muted">
                      Step {group.stepNum} &middot; {group.stepName}
                    </span>
                    <ul className="space-y-1">
                      {group.items.map((msg, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-sm text-fg">
                          <span className="mt-2 size-1 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                          <span>{msg}</span>
                        </li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-tint p-4">
              <CheckCircle2 className="size-5 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
              <p className="text-sm text-fg">Everything required is filled in. You can submit your registration.</p>
            </div>
          )}

          {/* STEP 1: COMPANY INFORMATION */}
          {currentStep === 1 && (
            <div className="space-y-10">
              <FormSection number="01" title="Company identity">
                <FieldCard label="Legal entity name" required error={validationErrors[1]?.companyName}>
                  <input type="text" maxLength={35} value={companyForm.companyName} onChange={e => handleFieldChange('companyName', e.target.value)} placeholder="Bharat Steel Alloys Pvt. Ltd." className="w-[39ch] max-w-full" />
                </FieldCard>
                <FieldCard label="Trade / brand name" required error={validationErrors[1]?.tradeName}>
                  <input type="text" maxLength={35} value={companyForm.tradeName} onChange={e => handleFieldChange('tradeName', e.target.value)} placeholder="Bharat Steel" className="w-[39ch] max-w-full" />
                </FieldCard>
                <FieldCard label="Business type" required error={validationErrors[1]?.businessType}>
                  <select value={companyForm.businessType} onChange={e => handleFieldChange('businessType', e.target.value)} className="w-[25ch] max-w-full">
                    <option value="" disabled>Select business type</option>
                    <option value="MFGR">Manufacturer (MFGR)</option>
                    <option value="TRDR">Trader / Distributor (TRDR)</option>
                    <option value="SRVC">Service Provider (SRVC)</option>
                    <option value="MSME">Micro Enterprise (MSME)</option>
                  </select>
                </FieldCard>
                <FieldCard label="Incorporation date" error={validationErrors[1]?.incorporationDate}>
                  <input type="date" value={companyForm.incorporationDate || ''} onChange={e => handleFieldChange('incorporationDate', e.target.value)} className="w-full" />
                </FieldCard>
              </FormSection>

              <FormSection number="02" title="Registered address">
                <FieldCard label="Street / area" required error={validationErrors[1]?.address}>
                  <input type="text" maxLength={35} value={companyForm.address} onChange={e => handleFieldChange('address', e.target.value)} placeholder="102, Mittal Chambers, Nariman Point" className="w-[39ch] max-w-full" />
                </FieldCard>
                <FieldCard label="City" required error={validationErrors[1]?.city}>
                  <input type="text" maxLength={35} value={companyForm.city} onChange={e => handleFieldChange('city', e.target.value)} placeholder="Mumbai" className="w-[39ch] max-w-full" />
                </FieldCard>
                <FieldCard label="Country" required error={validationErrors[1]?.country}>
                  <div className="w-[25ch] max-w-full">
                    <SearchableSelect
                      value={companyForm.country}
                      onChange={val => {
                        // Changing country invalidates whatever region was
                        // picked for the old one.
                        setCompanyForm(prev => ({ ...prev, country: val, region: '' }));
                      }}
                      options={COUNTRIES}
                      placeholder="Select Country"
                    />
                  </div>
                </FieldCard>
                <FieldCard label="State / Region" required error={validationErrors[1]?.region}>
                  <div className="w-[25ch] max-w-full">
                    <SearchableSelect
                      value={companyForm.region}
                      onChange={val => handleFieldChange('region', val)}
                      options={
                        companyForm.country === 'IN' && sapReference.regions
                          ? sapReference.regions.map(r => ({ code: r.code, name: r.label }))
                          : regionsForCountry(companyForm.country)
                      }
                      placeholder={
                        !companyForm.country ? 'Select a country first'
                          : companyForm.country === 'IN' && sapReference.status === 'loading' ? 'Loading regions…'
                          : 'Select State / Region'
                      }
                    />
                  </div>
                </FieldCard>
                <FieldCard
                  label="PIN code"
                  required
                  error={validationErrors[1]?.postalCode || (pincodeLookup.status === 'error' ? pincodeLookup.error : '')}
                  hint={pincodeLookup.status === 'loading' ? 'Looking up city & state...' : 'City, state & phone code auto-fill from PIN'}
                >
                  <input type="text" maxLength={6} value={companyForm.postalCode} onChange={e => handleFieldChange('postalCode', e.target.value.replace(/\D/g, ''))} placeholder="400021" className="mono w-[10ch] max-w-full" />
                </FieldCard>
                <FieldCard label="Contact email" required error={validationErrors[1]?.email}>
                  <input type="email" maxLength={241} value={companyForm.email} onChange={e => handleFieldChange('email', e.target.value)} placeholder="billing@company.com" />
                </FieldCard>
                <FieldCard label="Mobile / phone" required error={validationErrors[1]?.phone}>
                  <input type="tel" maxLength={16} value={companyForm.phone} onChange={e => handleFieldChange('phone', e.target.value)} placeholder="+91 22 2345 6789" className="w-[20ch] max-w-full" />
                </FieldCard>
              </FormSection>

              <FormSection number="03" title="Trade & payment terms">
                <FieldCard label="Payment terms" required error={validationErrors[1]?.paymentTerms} hint="Choose one of the options your buyer accepts">
                  <select
                    value={companyForm.paymentTerms || ''}
                    onChange={e => handleFieldChange('paymentTerms', e.target.value)}
                    disabled={sapReference.status !== 'ready'}
                    className="w-[20ch] max-w-full"
                  >
                    <option value="">
                      {sapReference.status === 'loading' ? 'Loading…' : sapReference.status === 'error' ? 'Unavailable — try reloading' : 'Select payment terms'}
                    </option>
                    {(sapReference.paymentTerms || []).map(code => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </FieldCard>
                <FieldCard label="Payment method" required error={validationErrors[1]?.paymentMethod} hint="Choose one of the options your buyer accepts">
                  <select
                    value={companyForm.paymentMethod || ''}
                    onChange={e => handleFieldChange('paymentMethod', e.target.value)}
                    disabled={sapReference.status !== 'ready'}
                    className="w-[25ch] max-w-full"
                  >
                    <option value="">
                      {sapReference.status === 'loading' ? 'Loading…' : sapReference.status === 'error' ? 'Unavailable — try reloading' : 'Select method'}
                    </option>
                    {(sapReference.paymentMethods || []).map(({ code, label }) => (
                      <option key={code} value={code}>{label} ({code})</option>
                    ))}
                   </select>
                </FieldCard>
                <FieldCard label="Currency" required error={validationErrors[1]?.currency} hint="Currency you invoice in">
                  <select value={companyForm.currency || ''} onChange={e => handleFieldChange('currency', e.target.value)} className="w-[20ch] max-w-full">
                    <option value="">Select currency</option>
                    <option value="INR">INR - Indian Rupee</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British Pound</option>
                    <option value="AED">AED - UAE Dirham</option>
                    <option value="SGD">SGD - Singapore Dollar</option>
                  </select>
                </FieldCard>
                <FieldCard label="Shipping terms 1" required error={validationErrors[1]?.incoterms1} hint="Incoterm, e.g. FOB">
                  <input type="text" maxLength={3} value={companyForm.incoterms1 || ''} onChange={e => handleFieldChange('incoterms1', e.target.value.toUpperCase())} placeholder="FOB" className="uppercase w-[10ch] max-w-full" />
                </FieldCard>
                <FieldCard label="Shipping terms 2" required error={validationErrors[1]?.incoterms2} hint="Named place, e.g. Mumbai Port — SAP requires this once Shipping terms 1 is set">
                  <input type="text" maxLength={35} value={companyForm.incoterms2 || ''} onChange={e => handleFieldChange('incoterms2', e.target.value)} placeholder="Mumbai Port" className="w-[25ch] max-w-full" />
                </FieldCard>
                <div className="flex flex-col justify-center gap-2">
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <input type="checkbox" checked={!!companyForm.doubleInvoiceCheck} onChange={e => handleFieldChange('doubleInvoiceCheck', e.target.checked)} />
                    Flag duplicate invoices
                  </label>
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <input type="checkbox" checked={!!companyForm.grBasedInvoiceVerification} onChange={e => handleFieldChange('grBasedInvoiceVerification', e.target.checked)} />
                    Require goods receipt before invoice
                  </label>
                </div>
              </FormSection>
            </div>
          )}

          {/* STEP 2: TAX & REGULATORY */}
          {currentStep === 2 && (
            <div className="space-y-10">
              <FormSection number="01" title="Indian tax IDs">
                  <FieldCard
                    label="PAN number"
                    required
                    error={validationErrors[2]?.pan}
                  >
                    <input
                      type="text"
                      maxLength={10}
                      value={companyForm.pan}
                      onChange={e => handleFieldChange('pan', e.target.value.toUpperCase())}
                      placeholder="AABCB1234F"
                      className="mono uppercase w-[14ch] max-w-full"
                    />
                  </FieldCard>
                  <FieldCard
                    label="GSTIN"
                    required
                    error={validationErrors[2]?.gstin}
                  >
                    <input
                      type="text"
                      maxLength={15}
                      value={companyForm.gstin}
                      onChange={e => handleFieldChange('gstin', e.target.value.toUpperCase())}
                      placeholder="27AABCB1234F1Z5"
                      className="mono uppercase w-[19ch] max-w-full"
                    />
                  </FieldCard>
                  <FieldCard
                    label="GST Registration Type"
                    required
                    error={validationErrors[2]?.gstType}
                  >
                    <select
                      value={companyForm.gstType}
                      onChange={e => handleFieldChange('gstType', e.target.value)}
                      className="w-[25ch] max-w-full"
                    >
                      <option value="" disabled>Select type</option>
                      <option value="01">Regular Taxpayer (01)</option>
                      <option value="02">Composition Scheme (02)</option>
                      <option value="03">SEZ Developer (03)</option>
                      <option value="04">Exempt / Unregistered (04)</option>
                    </select>
                  </FieldCard>
                  <FieldCard
                    label="CIN Number"
                    error={validationErrors[2]?.cin}
                  >
                    <input
                      type="text"
                      maxLength={21}
                      value={companyForm.cin}
                      onChange={e => handleFieldChange('cin', e.target.value.toUpperCase())}
                      placeholder="L01500MH1995PLC094858"
                      className="mono uppercase w-[25ch] max-w-full"
                    />
                  </FieldCard>
                  <FieldCard
                    label="MSME / Udyam Number"
                    error={validationErrors[2]?.msmeNumber}
                  >
                    <input
                      type="text"
                      maxLength={20}
                      value={companyForm.msmeNumber}
                      onChange={e => handleFieldChange('msmeNumber', e.target.value.toUpperCase())}
                      placeholder="UDYAM-MH-12-0012345"
                      className="mono uppercase w-[24ch] max-w-full"
                    />
                  </FieldCard>
                  <FieldCard
                    label="TDS Section"
                    required
                    error={validationErrors[2]?.tdsSection}
                  >
                    <select
                      value={companyForm.tdsSection}
                      onChange={e => handleFieldChange('tdsSection', e.target.value)}
                      className="w-[25ch] max-w-full"
                    >
                      <option value="" disabled>Select TDS section</option>
                      <option value="194C">194C - Contractor Payments</option>
                      <option value="194J">194J - Professional Service Fees</option>
                      <option value="194I">194I - Renting Clearances</option>
                      <option value="194Q">194Q - Goods Purchase Credits</option>
                      <option value="EXMP">EXMP - TDS Exempt status</option>
                    </select>
                  </FieldCard>
              </FormSection>
            </div>
          )}

          {/* STEP 3: BANK DETAILS */}
          {currentStep === 3 && (
            <div className="space-y-10">
              <FormSection number="01" title="Bank account">
                  <FieldCard
                    label="Account holder name"
                    required
                    error={validationErrors[3]?.accountName}
                  >
                    <input
                      type="text"
                      maxLength={60}
                      value={companyForm.accountName}
                      onChange={e => handleFieldChange('accountName', e.target.value)}
                      placeholder="Bharat Steel Alloys Pvt. Ltd."
                      className="w-[64ch] max-w-full" 
                    />
                  </FieldCard>

                  <FieldCard
                    label="Bank account number"
                    required
                    error={validationErrors[3]?.accountNumber}
                  >
                    <div className="relative w-[25ch] max-w-full">
                      <input
                        type={passVisible ? 'text' : 'password'}
                        maxLength={18}
                        value={companyForm.accountNumber}
                        onChange={e => handleFieldChange('accountNumber', e.target.value.replace(/\D/g, ''))}
                        placeholder="Enter Bank Account Number"
                        className="mono w-full pr-9!"
                      />
                      <button
                        type="button"
                        onClick={() => setPassVisible(!passVisible)}
                        aria-label={passVisible ? 'Hide account number' : 'Show account number'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-fg-subtle hover:text-fg"
                      >
                        {passVisible ? <EyeOff className="size-4" strokeWidth={1.5} /> : <Eye className="size-4" strokeWidth={1.5} />}
                      </button>
                    </div>
                  </FieldCard>
                  <FieldCard
                    label="IFSC code"
                    required
                    error={validationErrors[3]?.ifscCode}
                  >
                    <input
                      type="text"
                      maxLength={11}
                      value={companyForm.ifscCode}
                      onChange={e => handleFieldChange('ifscCode', e.target.value.toUpperCase())}
                      placeholder="HDFC0000060"
                      className="mono uppercase w-[15ch] max-w-full"
                    />
                  </FieldCard>

                  <FieldCard
                    label="Bank name (auto-fetched)"
                    required
                    error={validationErrors[3]?.bankName || (ifscLookup.status === 'error' ? ifscLookup.error : '')}
                  >
                    <div className="relative w-[64ch] max-w-full">
                      <input
                        type="text"
                        maxLength={60}
                        value={companyForm.bankName}
                        readOnly={bankFieldsLocked}
                        onChange={e => handleFieldChange('bankName', e.target.value)}
                        placeholder={ifscLookup.status === 'loading' ? 'Fetching bank details...' : bankFieldsLocked ? 'Auto-populated from IFSC' : 'Bank name'}
                        className={`${bankFieldsLocked ? 'bg-subtle! text-fg-muted' : ''} w-full pr-8`}
                      />
                      {ifscLookup.status === 'loading' && (
                        <RefreshCw className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                      )}
                    </div>
                  </FieldCard>
                  <FieldCard
                    label="Bank branch (auto-fetched)"
                    required
                    error={validationErrors[3]?.bankBranch}
                  >
                    <input
                      type="text"
                      maxLength={60}
                      value={companyForm.bankBranch}
                      readOnly={bankFieldsLocked}
                      onChange={e => handleFieldChange('bankBranch', e.target.value)}
                      placeholder={bankFieldsLocked ? 'Auto-populated from IFSC' : 'Bank branch'}
                      className={`${bankFieldsLocked ? 'bg-subtle! text-fg-muted' : ''} w-[64ch] max-w-full`}
                    />
                  </FieldCard>
                  <FieldCard
                    label="Account currency"
                  >
                    <select disabled className="w-[25ch] max-w-full">
                      <option value="INR">INR - Indian Rupee</option>
                    </select>
                  </FieldCard>

                  <div className="md:col-span-2 lg:col-span-3">
                    <FieldCard
                      label="Cancelled cheque copy"
                      required
                      error={validationErrors[3]?.cancelledCheque}
                    >
                      <DocumentUploadZone
                        fieldName="cancelledCheque"
                        value={companyForm.cancelledCheque}
                        onChange={val => handleFieldChange('cancelledCheque', val)}
                        error={validationErrors[3]?.cancelledCheque}
                      />
                    </FieldCard>
                  </div>
              </FormSection>
            </div>
          )}

          {/* STEP 4: DOCUMENT UPLOADS */}
          {/* Each document is a real upload (POST /uploads) whose
              { documentId, originalName, url } is what the profile stores —
              the same component the cancelled cheque on step 3 uses. */}
          {currentStep === 4 && (
            <div className="space-y-10">
              <FormSection number="01" title="Required for approval">
                {[
                  { id: 'panCardCopy', label: 'PAN card copy' },
                  { id: 'gstCertificate', label: 'GST certificate' },
                ].map(doc => (
                  <div key={doc.id} className="md:col-span-2 lg:col-span-3">
                    <FieldCard label={doc.label} required error={validationErrors[4]?.[doc.id]}>
                      <DocumentUploadZone
                        fieldName={doc.id}
                        value={companyForm[doc.id]}
                        onChange={val => handleFieldChange(doc.id, val)}
                        error={validationErrors[4]?.[doc.id]}
                      />
                    </FieldCard>
                  </div>
                ))}
              </FormSection>

              <FormSection number="02" title="Optional">
                <div className="md:col-span-2 lg:col-span-3">
                  <FieldCard label="MSME certificate">
                    <DocumentUploadZone
                      fieldName="msmeCertificate"
                      value={companyForm.msmeCertificate}
                      onChange={val => handleFieldChange('msmeCertificate', val)}
                    />
                  </FieldCard>
                </div>
              </FormSection>
            </div>
          )}

          {/* 6. STICKY ACTION FOOTER BAR */}
          <ActionFooter
            currentStep={currentStep}
            onBack={handleBack}
            onSaveDraft={handleTriggerSaveDraft}
            onContinue={handleContinue}
            onSubmit={handleFinalSubmit}
            draftSaving={draftSaving}
          />
        </form>
      )}

      {/* Awaiting the buyer's decision */}
      {isPending && (
        <div className="flex max-w-2xl items-start gap-4 rounded-lg border border-border bg-surface p-6">
          <Clock className="mt-0.5 size-5 shrink-0 text-fg-muted" strokeWidth={1.5} aria-hidden="true" />
          <div className="space-y-1.5">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
              Awaiting approval <StatusBadge label={state.profile.status} />
            </p>
            <p className="text-sm text-fg-muted">
              Your registration is with your buyer&apos;s team for review. Your supplier account is set up once they approve it — this page updates automatically when a decision is made.
            </p>
          </div>
        </div>
      )}

      {/* Approved: the supplier account summary */}
      {isApproved && (
        <div className="space-y-8">
          <div className="flex items-start gap-4 rounded-lg border border-border bg-surface p-5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
            <div className="space-y-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                Your supplier account is active <StatusBadge label="Active" />
              </p>
              <p className="text-sm text-fg-muted">
                Your tax and bank details have been accepted by your buyer. Supplier ID{' '}
                <span className="mono text-fg">{state.profile.sapVendorCode}</span>
                {' · '}approved {state.profile.approvedAt ? new Date(state.profile.approvedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
              </p>
            </div>
          </div>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-fg">Your registered details</h2>
            <dl className="grid grid-cols-1 gap-x-10 border-t border-border md:grid-cols-2">
              {[
                { label: 'Registered company name', val: state.profile.companyName },
                { label: 'Trade / brand name', val: state.profile.tradeName || 'Not provided' },
                { label: 'Type of business', val: state.profile.businessType || 'Not provided' },
                { label: 'Incorporation date', val: state.profile.incorporationDate || 'Not provided' },
                { label: 'Supplier ID', val: state.profile.sapVendorCode, isMono: true },
                { label: 'GSTIN', val: state.profile.gstin, isMono: true },
                { label: 'PAN', val: state.profile.pan, isMono: true },
                { label: 'CIN', val: state.profile.cin || 'Not applicable', isMono: !!state.profile.cin },
                { label: 'MSME registration number', val: state.profile.msmeNumber || 'Not applicable', isMono: !!state.profile.msmeNumber },
                { label: 'TDS section', val: state.profile.tdsSection || 'Not mapped' },
                { label: 'Finance contact email', val: state.profile.email },
                { label: 'Phone number', val: state.profile.phone },
                { label: 'Business address', val: `${state.profile.address}, ${state.profile.city}, ${state.profile.region || state.profile.state}, ${state.profile.country || ''} - ${state.profile.postalCode}` },
                { label: 'Cancelled cheque', val: documentName(state.profile.cancelledCheque), isFile: true },
                { label: 'PAN card copy', val: documentName(state.profile.panCardCopy), isFile: true },
                { label: 'GST certificate', val: documentName(state.profile.gstCertificate), isFile: true },
                { label: 'MSME certificate', val: documentName(state.profile.msmeCertificate), isFile: true }
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 text-sm">
                  <dt className="shrink-0 text-fg-muted">{row.label}</dt>
                  <dd className={`min-w-0 truncate text-right text-fg ${row.isMono ? 'mono' : ''}`} title={typeof row.val === 'string' ? row.val : undefined}>
                    {row.isFile && <FileText className="mr-1 inline size-3.5 align-[-2px] text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />}
                    {row.val}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Finding 4.2. The payout account used to be three read-only rows
              in the list above, with no way to ask for a change -- so the
              only route was emailing someone, on the one field issue #53
              built a whole review flow around. This card owns those rows now
              and adds the request. */}
          <BankChangeRequest profile={state.profile} onSubmit={requestBankChange} />
        </div>
      )}
    </div>
  );
}

// A compliance document is stored as { documentId, originalName, url }
// (uploadedDocumentSchema in backend/validators/vendor.validator.js); older
// profiles may still hold a bare filename.
function documentName(doc) {
  if (!doc) return 'Not Uploaded';
  if (typeof doc === 'string') return doc;
  return doc.originalName || doc.documentId || 'Uploaded';
}
