import React, { useState, useEffect, useRef } from 'react';
import { validateField } from '../validation';
import { profileService } from '../services/profileService';
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  Check,
  Upload,
  Trash2,
  Calendar,
  FileText,
  ChevronRight,
  ChevronLeft,
  Eye,
  EyeOff,
  Search,
  HelpCircle,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import FileUploadZone from '@/components/shared/FileUploadZone';

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

// 1. Section Header Component
function SectionHeader({ title, number }) {
  return (
    <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border select-none">
      {number && (
        <span className="inline-flex items-center justify-center text-[11px] font-bold font-mono text-primary bg-primary/10 rounded px-2 py-1 tabular-nums shrink-0">
          {number}
        </span>
      )}
      <h3 className="text-[15px] font-bold text-text-primary">{title}</h3>
    </div>
  );
}

// 2. Card wrapper for a bordered, numbered form section
function FormSection({ number, title, children }) {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-xs">
      <SectionHeader number={number} title={title} />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 p-4">
        {children}
      </div>
    </div>
  );
}

const FIELD_INPUT_OVERRIDES = "[&_input]:!rounded-md [&_input]:!border [&_input]:!border-border [&_input]:!bg-surface [&_input]:!px-2.5 [&_input]:!py-1.5 [&_input]:!text-[13px] [&_input]:placeholder:!text-text-tertiary/50 [&_input:focus]:!border-primary [&_input:focus]:!bg-surface [&_input:focus]:!outline-none [&_select]:!rounded-md [&_select]:!border [&_select]:!border-border [&_select]:!bg-surface [&_select]:!px-2.5 [&_select]:!py-1.5 [&_select]:!text-[13px] [&_select:focus]:!border-primary [&_select:focus]:!bg-surface [&_select:focus]:!outline-none [&_textarea]:!rounded-md [&_textarea]:!border [&_textarea]:!border-border [&_textarea]:!bg-surface [&_textarea]:!px-2.5 [&_textarea]:!py-1.5 [&_textarea]:!text-[13px] [&_textarea]:placeholder:!text-text-tertiary/50 [&_textarea:focus]:!border-primary [&_textarea:focus]:!bg-surface [&_textarea:focus]:!outline-none";

function EnterpriseFieldCard({ label, required, error, hint, children }) {
  return (
    <div className={`flex items-start gap-1.5 select-none w-full ${FIELD_INPUT_OVERRIDES}`}>
      <label className="text-[13px] font-semibold text-text-secondary shrink-0 w-28 pt-1.5" title={label}>
        {label} {required && <span className="text-rose-500 font-bold ml-0.5">*</span>}
      </label>
      <div className="flex-1 flex flex-col min-w-0">
        {children}
        {hint && !error && (
          <span className="text-[11px] text-text-tertiary mt-1">{hint}</span>
        )}
        {error && (
          <span className="text-[11px] font-bold text-rose-500 mt-1">{error}</span>
        )}
      </div>
    </div>
  );
}

// 5. Accessible Searchable Dropdown
function SearchableSelect({ value, onChange, options, placeholder, error }) {
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
        onClick={() => {
          setIsOpen(!isOpen);
          setSearch('');
        }}
        className="w-full flex items-center justify-between bg-surface border border-border rounded-md py-1.5 px-2.5 text-[13px] outline-none text-text-primary text-left transition-colors duration-150"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={selectedOpt ? 'text-text-primary font-medium' : 'text-text-tertiary'}>
          {selectedOpt ? `${selectedOpt.name} (${selectedOpt.code})` : placeholder}
        </span>
        <ChevronRight className={`size-3 text-text-tertiary transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-surface border border-border rounded-none shadow-[0_1px_4px_rgba(10,15,46,0.08)] max-h-56 overflow-y-auto custom-scrollbar animate-slide-down">
          <div className="p-1.5 border-b border-border sticky top-0 bg-surface flex items-center gap-1.5">
            <Search className="size-3.5 text-text-tertiary shrink-0" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
              placeholder="Search..."
              className="w-full text-xs outline-none text-text-primary bg-transparent py-0.5"
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
                  className={`px-3 py-1.5 text-xs cursor-pointer flex items-center justify-between hover:bg-surface2 text-text-secondary transition-colors duration-150 ${opt.code === value ? 'bg-surface2 text-text-primary font-semibold' : ''
                    }`}
                >
                  <span>{opt.name}</span>
                  <span className="font-mono text-[10px] text-text-tertiary">{opt.code}</span>
                </li>
              ))
            ) : (
              <li className="px-3 py-2 text-xs text-text-tertiary text-center select-none">No states found</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// 6. Accessible Interactive Date Picker (Calendar)
function CustomDatePicker({ value, onChange, placeholder }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const years = [];
  const startYear = new Date().getFullYear() - 50;
  const endYear = new Date().getFullYear() + 10;
  for (let y = startYear; y <= endYear; y++) {
    years.push(y);
  }

  const handleYearChange = (year) => {
    setCurrentDate(new Date(year, currentDate.getMonth(), 1));
  };

  const handleMonthChange = (month) => {
    setCurrentDate(new Date(currentDate.getFullYear(), month, 1));
  };

  const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
  const firstDayIndex = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();

  const handleSelectDay = (day) => {
    const selected = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    const yyyy = selected.getFullYear();
    const mm = String(selected.getMonth() + 1).padStart(2, '0');
    const dd = String(selected.getDate()).padStart(2, '0');
    onChange(`${yyyy}-${mm}-${dd}`);
    setIsOpen(false);
  };

  const renderDays = () => {
    const dayElements = [];
    for (let i = 0; i < firstDayIndex; i++) {
      dayElements.push(<div key={`empty-${i}`} className="h-6"></div>);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const formattedDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isSelected = value === formattedDate;
      dayElements.push(
        <button
          key={day}
          type="button"
          onClick={() => handleSelectDay(day)}
          className={`h-6 w-full rounded-none text-[11px] font-medium flex items-center justify-center transition-colors duration-150 ${isSelected
            ? 'text-white font-bold'
            : 'text-text-secondary hover:bg-surface2 hover:text-text-primary'
            }`}
          style={isSelected ? { backgroundColor: 'rgb(var(--color-emerald-default-rgb))' } : undefined}
        >
          {day}
        </button>
      );
    }
    return dayElements;
  };

  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  return (
    <div className="relative w-full" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between bg-surface border border-border rounded-md py-1.5 px-2.5 text-[13px] outline-none text-text-primary text-left transition-colors duration-150"
      >
        <span className={value ? 'text-text-primary font-medium' : 'text-text-tertiary'}>
          {value ? value : placeholder}
        </span>
        <Calendar className="size-3.5 text-text-tertiary shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute z-50 left-0 mt-1 bg-surface border border-border rounded-none shadow-[0_1px_4px_rgba(10,15,46,0.08)] p-3 w-64 animate-slide-down">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))}
              className="p-1 hover:bg-surface2 rounded-none text-text-secondary transition-colors duration-150"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <div className="flex items-center gap-1">
              <select
                value={currentDate.getMonth()}
                onChange={(e) => handleMonthChange(Number(e.target.value))}
                className="text-[11px] font-semibold text-text-secondary bg-transparent border-none outline-none cursor-pointer py-0.5 px-1 rounded hover:bg-surface2"
              >
                {MONTHS.map((m, idx) => (
                  <option key={idx} value={idx}>{m}</option>
                ))}
              </select>
              <select
                value={currentDate.getFullYear()}
                onChange={(e) => handleYearChange(Number(e.target.value))}
                className="text-[11px] font-semibold text-text-secondary bg-transparent border-none outline-none cursor-pointer py-0.5 px-1 rounded hover:bg-surface2"
              >
                {years.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))}
              className="p-1 hover:bg-surface2 rounded-none text-text-secondary transition-colors duration-150"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-text-tertiary mb-1 select-none border-b border-border pb-1">
            <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {renderDays()}
          </div>
        </div>
      )}
    </div>
  );
}

// 7. Drag and Drop Document Upload Zone Component
function DocumentUploadZone({ fieldName, value, onChange, label, error }) {
  const fileValue = value
    ? (typeof value === 'object' && value.documentId
        ? value
        : { documentId: value, originalName: typeof value === 'object' ? value.originalName || 'file.pdf' : value, url: typeof value === 'object' ? value.url || '#' : '#' })
    : null;

  return (
    <FileUploadZone
      label={label}
      value={fileValue}
      onUploadComplete={(result) => onChange(result)}
      onFileRemoved={() => onChange(null)}
      linkedTo="Profile"
      accept=".pdf,.png,.jpg,.jpeg"
    />
  );
}

// 8. Wizard Progress Indicator (Stepper)
function ProgressIndicator({ steps, currentStep, onStepClick, errors }) {
  return (
    <div className="sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-border py-4 select-none">
      <div className="max-w-4xl mx-auto px-4 md:px-6 flex items-center justify-between">
        {steps.map((step, idx) => {
          const stepNum = idx + 1;
          const isActive = currentStep === stepNum;
          const isCompleted = currentStep > stepNum;
          const stepHasErrors = errors[stepNum] && Object.keys(errors[stepNum]).length > 0;
          const isLast = idx === steps.length - 1;

          return (
            <React.Fragment key={stepNum}>
              <div 
                onClick={() => onStepClick && onStepClick(stepNum)}
                className="flex items-center gap-2.5 cursor-pointer group shrink-0"
              >
                <div className={`size-7 rounded-full text-[12px] flex items-center justify-center font-bold transition-colors ${
                  isActive 
                    ? 'text-white shadow-sm' 
                    : isCompleted
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : stepHasErrors
                        ? 'bg-rose-50 text-rose-600 border border-rose-200'
                        : 'bg-surface2 text-text-tertiary border border-border group-hover:border-text-tertiary'
                }`}
                style={isActive ? { backgroundColor: 'rgb(var(--color-emerald-default-rgb))' } : undefined}
                >
                  {isCompleted ? <Check className="size-4 stroke-[3]" /> : stepNum}
                </div>
                <span className={`text-[13px] hidden md:block transition-colors ${
                  isActive ? 'text-text-primary font-bold' 
                  : isCompleted ? 'text-emerald-700 font-medium'
                  : stepHasErrors ? 'text-rose-600 font-medium'
                  : 'text-text-tertiary font-medium'
                }`}>
                  {step.name}
                </span>
              </div>
              {!isLast && (
                <div className={`flex-1 h-[2px] mx-4 transition-colors ${
                  isCompleted ? 'bg-emerald-400' : 'bg-border-subtle'
                }`} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// 9. Sticky action footer component
function ActionFooter({ currentStep, onBack, onSaveDraft, onContinue, onSubmit, draftSaving }) {
  return (
    <footer className="sticky bottom-0 z-30 bg-surface border-t border-border py-3.5 px-4 md:px-6 select-none animate-slide-down">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
        {/* Left Action Elements */}
        <div className="flex items-center gap-2 sm:gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={currentStep === 1}
            onClick={onBack}
          >
            <ChevronLeft className="size-4" /> Back
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onSaveDraft}
            disabled={draftSaving}
          >
            {draftSaving ? (
              <>
                <RefreshCw className="size-3.5 animate-spin mr-1" />
                Saving...
              </>
            ) : 'Save Draft'}
          </Button>
        </div>

        {/* Right Action Elements */}
        <div className="flex items-center gap-2">
          {currentStep < 4 ? (
            <Button
              type="button"
              variant="default"
              onClick={onContinue}
            >
              Save &amp; Continue <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              onClick={onSubmit}
            >
              Submit Registration
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}


// --- MAIN MODULE RENDERING VIEW ---
export default function RegistrationView({
  state,
  companyForm,
  setCompanyForm,
  handleCompanySubmit,
  saveDraft,
  submitRegistration
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
        { title: 'REGISTERED ADDRESS', fields: ['address', 'city', 'country', 'region', 'postalCode', 'email', 'phone'] }
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
      .catch(err => {
        if (cancelled) return;
        setCompanyForm(prev => ({ ...prev, bankName: '', bankBranch: '' }));
        setIfscLookup({ status: 'error', error: err.message || 'Could not fetch bank details for this IFSC code' });
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
    submitRegistration(companyForm);
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

  // Compute stats for current step header
  const currentStepConfig = stepConfigs[currentStep - 1];
  const currentFieldsCount = currentStepConfig.sections.reduce((acc, s) => acc + s.fields.length, 0);
  const currentSectionsCount = currentStepConfig.sections.length;

  return (
    <div className="space-y-4 max-w-full pb-8 animate-fade-in relative">
      {/* 1. TOAST NOTIFICATION FOR SAVE DRAFT */}
      {showSaveToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 bg-white text-slate-900 border border-slate-200 px-4 py-2.5 rounded-lg shadow-xl animate-slide-down">
          <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />
          <span className="font-semibold select-none text-xs">Draft onboarding configurations saved successfully</span>
        </div>
      )}

      {/* 2. COMPONENT WIZARD HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4 select-none">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="page-title">Vendor Registration</h2>
            <ProgressBadge count={`${currentStep} / 4`} />
          </div>
          <div className="flex items-center gap-2 text-text-tertiary text-xs font-semibold">
            <span className="bg-surface2 border border-border text-text-secondary px-2 py-0.5 rounded font-mono uppercase tracking-wide">
              Vendor
            </span>

          </div>
        </div>

        {/* 3. BUSINESS VIEW VS TECHNICAL VIEW TOGGLE REMOVED */}
      </div>

      {/* 4. TABBED PROGRESS INDICATOR */}
      {isDraft && (
        <ProgressIndicator
          steps={stepConfigs}
          currentStep={currentStep}
          onStepClick={handleStepClick}
          errors={validationErrors}
        />
      )}

      {blockedStepAlert && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 bg-rose-900/90 border border-rose-700 text-white text-xs px-4 py-2.5 rounded-none shadow-[0_1px_4px_rgba(10,15,46,0.08)] animate-slide-down">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="font-semibold select-none">{blockedStepAlert}</span>
        </div>
      )}

      {/* 5. DRAFT STATE: 4-STEP WIZARD BODY */}
      {isDraft && (
        <form onSubmit={handleFinalSubmit} className="space-y-4">
          {state.profile.status === 'Rejected' && (
            <div className="p-4.5 rounded-none border border-rose-900/50 bg-rose-900/20 text-rose-400 flex items-start gap-3 shadow-sm select-none">
              <AlertTriangle className="size-5 shrink-0 mt-0.5 text-rose-400" />
              <div>
                <h4 className="font-bold text-sm">Registration not approved</h4>
                <p className="text-xs mt-1 text-rose-400/80">
                  Some of your documents or bank details did not pass your buyer’s checks. Reason:
                  <span className="font-semibold block mt-0.5 text-rose-300 italic">
                    &quot;{state.profile.rejectionReason || 'Your GST registration or bank details did not match.'}&quot;
                  </span>
                </p>
              </div>
            </div>
          )}

          {/* WHAT'S LEFT — the full remaining checklist, not just this step's */}
          {outstandingCount > 0 ? (
            <div className="p-4.5 rounded-none border border-amber-300 bg-amber-50 text-amber-900 space-y-3 shadow-sm select-none">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 shrink-0 mt-0.5 text-amber-600" />
                <div>
                  <h4 className="font-bold text-sm">
                    {state.profile.status === 'Rejected' ? 'What to fix before resubmitting' : "What's left to complete your registration"}
                  </h4>
                  <p className="text-xs mt-0.5 text-amber-800/80">
                    {outstandingCount} item{outstandingCount === 1 ? '' : 's'} still need{outstandingCount === 1 ? 's' : ''} your attention.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-8">
                {outstandingByStep.map(group => (
                  <button
                    key={group.stepNum}
                    type="button"
                    onClick={() => setCurrentStep(group.stepNum)}
                    className="text-left p-3 rounded-md border border-amber-200 bg-white/60 hover:bg-white transition-colors duration-150 cursor-pointer"
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wide text-amber-700 mb-1.5">
                      Step {group.stepNum} &middot; {group.stepName}
                    </p>
                    <ul className="space-y-1">
                      {group.items.map((msg, i) => (
                        <li key={i} className="text-xs text-amber-900 flex items-start gap-1.5">
                          <span className="mt-1.5 size-1 rounded-full bg-amber-500 shrink-0" />
                          <span>{msg}</span>
                        </li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-none border border-emerald-300 bg-emerald-50 text-emerald-900 flex items-center gap-3 shadow-sm select-none">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
              <p className="text-xs font-semibold">Everything required is filled in. You can submit your registration.</p>
            </div>
          )}

          {/* STEP 1: COMPANY INFORMATION */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <FormSection number="01" title="Company identity">
                <EnterpriseFieldCard label="Legal entity name" required error={validationErrors[1]?.companyName}>
                  <input type="text" maxLength={35} value={companyForm.companyName} onChange={e => handleFieldChange('companyName', e.target.value)} placeholder="Bharat Steel Alloys Pvt. Ltd." className="w-[39ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Trade / brand name" error={validationErrors[1]?.tradeName}>
                  <input type="text" maxLength={35} value={companyForm.tradeName} onChange={e => handleFieldChange('tradeName', e.target.value)} placeholder="Bharat Steel" className="w-[39ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Business type" required error={validationErrors[1]?.businessType}>
                  <select value={companyForm.businessType} onChange={e => handleFieldChange('businessType', e.target.value)} className="w-[25ch] max-w-full">
                    <option value="" disabled className="text-text-tertiary">Select Business Type</option>
                    <option value="MFGR">Manufacturer (MFGR)</option>
                    <option value="TRDR">Trader / Distributor (TRDR)</option>
                    <option value="SRVC">Service Provider (SRVC)</option>
                    <option value="MSME">Micro Enterprise (MSME)</option>
                  </select>
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Incorporation date" error={validationErrors[1]?.incorporationDate}>
                  <input type="date" value={companyForm.incorporationDate || ''} onChange={e => handleFieldChange('incorporationDate', e.target.value)} className="w-full" />
                </EnterpriseFieldCard>
              </FormSection>

              <FormSection number="02" title="Registered address">
                <EnterpriseFieldCard label="Street / area" required error={validationErrors[1]?.address}>
                  <input type="text" maxLength={35} value={companyForm.address} onChange={e => handleFieldChange('address', e.target.value)} placeholder="102, Mittal Chambers, Nariman Point" className="w-[39ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="City" required error={validationErrors[1]?.city}>
                  <input type="text" maxLength={35} value={companyForm.city} onChange={e => handleFieldChange('city', e.target.value)} placeholder="Mumbai" className="w-[39ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Country" required error={validationErrors[1]?.country}>
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
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="State / Region" required error={validationErrors[1]?.region}>
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
                </EnterpriseFieldCard>
                <EnterpriseFieldCard
                  label="PIN code"
                  required
                  error={validationErrors[1]?.postalCode || (pincodeLookup.status === 'error' ? pincodeLookup.error : '')}
                  hint={pincodeLookup.status === 'loading' ? 'Looking up city & state...' : 'City, state & phone code auto-fill from PIN'}
                >
                  <input type="text" maxLength={6} value={companyForm.postalCode} onChange={e => handleFieldChange('postalCode', e.target.value.replace(/\D/g, ''))} placeholder="400021" className="font-mono w-[10ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Contact email" required error={validationErrors[1]?.email}>
                  <input type="email" maxLength={241} value={companyForm.email} onChange={e => handleFieldChange('email', e.target.value)} placeholder="billing@company.com" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Mobile / phone" required error={validationErrors[1]?.phone}>
                  <input type="tel" maxLength={16} value={companyForm.phone} onChange={e => handleFieldChange('phone', e.target.value)} placeholder="+91 22 2345 6789" className="w-[20ch] max-w-full" />
                </EnterpriseFieldCard>
              </FormSection>

              <FormSection number="03" title="Trade & payment terms">
                <EnterpriseFieldCard label="Payment terms" hint="Choose one of the options your buyer accepts">
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
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Payment method" hint="Choose one of the options your buyer accepts">
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
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Currency" hint="Currency you invoice in">
                  <select value={companyForm.currency || ''} onChange={e => handleFieldChange('currency', e.target.value)} className="w-[20ch] max-w-full">
                    <option value="">Select currency</option>
                    <option value="INR">INR - Indian Rupee</option>
                    <option value="USD">USD - US Dollar</option>
                    <option value="EUR">EUR - Euro</option>
                    <option value="GBP">GBP - British Pound</option>
                    <option value="AED">AED - UAE Dirham</option>
                    <option value="SGD">SGD - Singapore Dollar</option>
                  </select>
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Shipping terms 1" hint="Incoterm, e.g. FOB">
                  <input type="text" maxLength={3} value={companyForm.incoterms1 || ''} onChange={e => handleFieldChange('incoterms1', e.target.value.toUpperCase())} placeholder="FOB" className="uppercase w-[10ch] max-w-full" />
                </EnterpriseFieldCard>
                <EnterpriseFieldCard label="Shipping terms 2" hint="Named place, e.g. Mumbai Port">
                  <input type="text" maxLength={35} value={companyForm.incoterms2 || ''} onChange={e => handleFieldChange('incoterms2', e.target.value)} placeholder="Mumbai Port" className="w-[25ch] max-w-full" />
                </EnterpriseFieldCard>
                <div className="flex flex-col gap-2 justify-center">
                  <label className="flex items-center gap-2 text-[13px] text-text-secondary select-none">
                    <input type="checkbox" checked={!!companyForm.doubleInvoiceCheck} onChange={e => handleFieldChange('doubleInvoiceCheck', e.target.checked)} />
                    Flag duplicate invoices
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-text-secondary select-none">
                    <input type="checkbox" checked={!!companyForm.grBasedInvoiceVerification} onChange={e => handleFieldChange('grBasedInvoiceVerification', e.target.checked)} />
                    Require goods receipt before invoice
                  </label>
                </div>
              </FormSection>
            </div>
          )}

          {/* STEP 2: TAX & REGULATORY */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <FormSection number="01" title="Indian tax IDs">
                  <EnterpriseFieldCard
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
                      className="uppercase font-mono w-[14ch] max-w-full"
                    />
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
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
                      className="uppercase font-mono w-[19ch] max-w-full"
                    />
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="GST Registration Type"
                    required
                    error={validationErrors[2]?.gstType}
                  >
                    <select
                      value={companyForm.gstType}
                      onChange={e => handleFieldChange('gstType', e.target.value)}
                      className="w-[25ch] max-w-full"
                    >
                      <option value="" disabled className="text-text-tertiary">Select Type</option>
                      <option value="01">Regular Taxpayer (01)</option>
                      <option value="02">Composition Scheme (02)</option>
                      <option value="03">SEZ Developer (03)</option>
                      <option value="04">Exempt / Unregistered (04)</option>
                    </select>
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="CIN Number"
                    error={validationErrors[2]?.cin}
                  >
                    <input
                      type="text"
                      maxLength={21}
                      value={companyForm.cin}
                      onChange={e => handleFieldChange('cin', e.target.value.toUpperCase())}
                      placeholder="L01500MH1995PLC094858"
                      className="uppercase font-mono w-[25ch] max-w-full"
                    />
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="MSME / Udyam Number"
                    error={validationErrors[2]?.msmeNumber}
                  >
                    <input
                      type="text"
                      maxLength={20}
                      value={companyForm.msmeNumber}
                      onChange={e => handleFieldChange('msmeNumber', e.target.value.toUpperCase())}
                      placeholder="UDYAM-MH-12-0012345"
                      className="uppercase font-mono w-[24ch] max-w-full"
                    />
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="TDS Section"
                    required
                    error={validationErrors[2]?.tdsSection}
                  >
                    <select
                      value={companyForm.tdsSection}
                      onChange={e => handleFieldChange('tdsSection', e.target.value)}
                      className="w-[25ch] max-w-full"
                    >
                      <option value="" disabled className="text-text-tertiary">Select TDS mapping</option>
                      <option value="194C">194C - Contractor Payments</option>
                      <option value="194J">194J - Professional Service Fees</option>
                      <option value="194I">194I - Renting Clearances</option>
                      <option value="194Q">194Q - Goods Purchase Credits</option>
                      <option value="EXMP">EXMP - TDS Exempt status</option>
                    </select>
                  </EnterpriseFieldCard>
              </FormSection>
            </div>
          )}

          {/* STEP 3: BANK DETAILS */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <FormSection number="01" title="Bank account">
                  <EnterpriseFieldCard
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
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard
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
                        className="font-mono pr-8 w-full"
                      />
                      <button
                        type="button"
                        onClick={() => setPassVisible(!passVisible)}
                        className="absolute right-2 top-[7px] hover:bg-surface2 rounded text-text-tertiary hover:text-text-primary transition-colors duration-150"
                      >
                        {passVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
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
                      className="uppercase font-mono w-[15ch] max-w-full"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard
                    label="Bank name (auto-fetched)"
                    required
                    error={validationErrors[3]?.bankName || (ifscLookup.status === 'error' ? ifscLookup.error : '')}
                  >
                    <div className="relative w-[64ch] max-w-full">
                      <input
                        type="text"
                        maxLength={60}
                        value={companyForm.bankName}
                        readOnly
                        placeholder={ifscLookup.status === 'loading' ? 'Fetching bank details...' : 'Auto-populated from IFSC'}
                        className="bg-surface2 text-text-secondary select-none w-full pr-8"
                      />
                      {ifscLookup.status === 'loading' && (
                        <RefreshCw className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-text-tertiary animate-spin" />
                      )}
                    </div>
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="Bank branch (auto-fetched)"
                    required
                    error={validationErrors[3]?.bankBranch}
                  >
                    <input
                      type="text"
                      maxLength={60}
                      value={companyForm.bankBranch}
                      readOnly
                      placeholder="Auto-populated from IFSC"
                      className="bg-surface2 text-text-secondary select-none w-[64ch] max-w-full"
                    />
                  </EnterpriseFieldCard>
                  <EnterpriseFieldCard
                    label="Account currency"
                  >
                    <select disabled className="bg-surface2 text-text-secondary cursor-not-allowed w-[25ch] max-w-full">
                      <option value="INR">INR - Indian Rupee</option>
                    </select>
                  </EnterpriseFieldCard>

                  <div className="lg:col-span-3 mt-2">
                    <EnterpriseFieldCard
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
                    </EnterpriseFieldCard>
                  </div>
              </FormSection>
            </div>
          )}

          {/* STEP 4: DOCUMENT UPLOADS */}
          {currentStep === 4 && (
            <div className="space-y-4">
              {/* GLOBAL DROP-ZONE */}
              <div className="w-full bg-surface2 border-2 border-dashed border-border-em rounded p-4 text-center hover:bg-surface2/70 transition-colors cursor-pointer">
                <Upload className="size-5 text-text-tertiary mx-auto mb-2" />
                <p className="text-[13px] font-semibold text-text-primary">Drag and drop files here to auto-categorize and upload</p>
                <p className="text-[11px] text-text-tertiary mt-1">Supports PDF, DOCX, JPG, PNG up to 5MB</p>
              </div>

              {/* CATEGORIZED DATA GRID */}
              <div className="border border-border rounded overflow-hidden bg-surface text-left">
                {/* Header Row */}
                <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_1fr] gap-4 px-4 py-2.5 bg-surface2 border-b border-border text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
                  <div>Document Name</div>
                  <div>Requirement</div>
                  <div>File Size</div>
                  <div>Status</div>
                  <div className="text-right">Actions</div>
                </div>
                
                <div className="flex flex-col">
                  {/* GROUP 1: REQUIRED */}
                  {[
                    { id: 'panCardCopy', name: 'PAN Card Copy', req: 'Required for Approval' },
                    { id: 'gstCertificate', name: 'GST Certificate', req: 'Required for Approval' }
                  ].map(doc => (
                    <div key={doc.id} className="grid grid-cols-[2fr_1.5fr_1fr_1fr_1fr] gap-4 px-4 py-3 items-center hover:bg-surface2/50 transition-colors even:bg-surface2/30">
                      <div className="text-[13px] font-medium text-text-primary">{doc.name}</div>
                      <div className="text-[12px] text-text-secondary">{doc.req}</div>
                      <div className="text-[12px] text-text-secondary font-mono">{companyForm[doc.id] ? '1.2 MB' : '--'}</div>
                      <div>
                        {companyForm[doc.id] ? (
                          <span className="status-badge status-badge-active">Uploaded</span>
                        ) : (
                          <span className="status-badge status-badge-warn">Pending</span>
                        )}
                      </div>
                      <div className="text-right">
                        <label className="text-primary hover:underline text-[12px] font-semibold cursor-pointer">
                          {companyForm[doc.id] ? 'Replace' : 'Upload'}
                          <input type="file" className="hidden" onChange={(e) => handleFieldChange(doc.id, 'uploaded_file.pdf')} />
                        </label>
                      </div>
                    </div>
                  ))}
                  {/* GROUP 2: OPTIONAL */}
                  {[
                    { id: 'msmeCertificate', name: 'MSME Certificate', req: 'Supplemental/Optional' }
                  ].map(doc => (
                    <div key={doc.id} className="grid grid-cols-[2fr_1.5fr_1fr_1fr_1fr] gap-4 px-4 py-3 items-center hover:bg-surface2/50 transition-colors even:bg-surface2/30">
                      <div className="text-[13px] font-medium text-text-primary">{doc.name}</div>
                      <div className="text-[12px] text-text-secondary">{doc.req}</div>
                      <div className="text-[12px] text-text-secondary font-mono">{companyForm[doc.id] ? '2.4 MB' : '--'}</div>
                      <div>
                        {companyForm[doc.id] ? (
                          <span className="status-badge status-badge-active">Uploaded</span>
                        ) : (
                          <span className="status-badge bg-surface2 text-text-tertiary border-border">Empty</span>
                        )}
                      </div>
                      <div className="text-right">
                        <label className="text-primary hover:underline text-[12px] font-semibold cursor-pointer">
                          {companyForm[doc.id] ? 'Replace' : 'Upload'}
                          <input type="file" className="hidden" onChange={(e) => handleFieldChange(doc.id, 'uploaded_file.pdf')} />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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

      {/* 6. PENDING APPROVAL COMPLIANCE CARD */}
      {isPending && (
        <div className="p-8 card text-center space-y-6 flex flex-col items-center max-w-lg mx-auto">
          <div className="size-14 rounded-full bg-surface2 border border-border flex items-center justify-center text-text-secondary">
            <Clock className="size-6 animate-pulse" />
          </div>
          <div className="space-y-2">
            <h3 className="text-base font-bold text-text-primary">Awaiting Approval</h3>
            <p className="text-xs text-text-tertiary max-w-sm mx-auto leading-relaxed">
              Your registration is with your buyer&apos;s team for review. Your supplier account is set up once they approve it — this page updates automatically when a decision is made.
            </p>
          </div>
          <div className="w-full bg-surface2 h-1.5 rounded-full overflow-hidden border border-border">
            <div className="h-full w-2/3 rounded-full animate-[pulse_1.5s_infinite]" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}></div>
          </div>
        </div>
      )}

      {/* 7. APPROVED / COMPLETED VIEW (supplier account summary) */}
      {isApproved && (
        <div className="space-y-6 animate-fade-in select-none">
          <div className="p-6 card flex items-start gap-4">
            <div className="size-11 rounded-full text-emerald-400 flex items-center justify-center shrink-0 border border-border" style={{ backgroundColor: 'var(--color-emerald-dim)' }}>
              <CheckCircle2 className="size-5.5 stroke-[2.5]" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-text-primary">Your supplier account is active</h3>
              <p className="text-xs text-text-tertiary leading-normal">
                Your tax and bank details have been accepted by your buyer. Your supplier ID:
                <span className="font-mono text-text-primary font-bold bg-surface2 border border-border px-2 py-0.5 rounded ml-1.5 text-xs tabular-nums">
                  {state.profile.sapVendorCode}
                </span>
              </p>
              <div className="flex items-center gap-4 text-[10px] text-text-tertiary mt-2.5 font-semibold font-mono">
                <span className="tabular-nums">APPROVED: {new Date(state.profile.approvedAt || '').toLocaleString()}</span>
                <span>&bull;</span>
                <span className="text-emerald-400 px-1.5 py-0.5 border border-border rounded text-[9px] font-bold" style={{ backgroundColor: 'var(--color-emerald-dim)' }}>STATUS: ACTIVE</span>
              </div>
            </div>
          </div>

          {/* DETAILED LEDGER PROFILE INFORMATION */}
          <div className="p-6 card space-y-4">
            <h3 className="label mb-0 border-b border-border pb-2">
              Your registered details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3.5 text-xs text-text-secondary">
              {[
                { label: 'Registered company name', val: state.profile.companyName },
                { label: 'Trade / Brand Name', val: state.profile.tradeName || 'Not Provided' },
                { label: 'Type of business', val: state.profile.businessType || 'Not Provided' },
                { label: 'Incorporation Date', val: state.profile.incorporationDate || 'Not Provided' },
                { label: 'Supplier ID', val: state.profile.sapVendorCode, isMono: true, isGreen: true },
                { label: 'GSTIN / Tax Registration', val: state.profile.gstin, isMono: true },
                { label: 'PAN number', val: state.profile.pan, isMono: true },
                { label: 'CIN number', val: state.profile.cin || 'Not Applicable', isMono: true },
                { label: 'MSME Registration Number', val: state.profile.msmeNumber || 'Not Applicable', isMono: true },
                { label: 'TDS Section', val: state.profile.tdsSection || 'Not Mapped' },
                { label: 'Finance contact email', val: state.profile.email },
                { label: 'Phone number', val: state.profile.phone },
                { label: 'Bank', val: state.profile.bankName },
                { label: 'Bank branch', val: state.profile.bankBranch || 'Not Mapped' },
                { label: 'Bank account', val: `••••${state.profile.accountNumber?.slice(-4)} (${state.profile.ifscCode})`, isMono: true },
                { label: 'Business address', val: `${state.profile.address}, ${state.profile.city}, ${state.profile.region || state.profile.state}, ${state.profile.country || ''} - ${state.profile.postalCode}` },
                { label: 'Cancelled Cheque Copy Document', val: state.profile.cancelledCheque || 'Not Uploaded', isFile: true },
                { label: 'PAN Card Copy Document', val: state.profile.panCardCopy || 'Not Uploaded', isFile: true },
                { label: 'GST Certificate Document', val: state.profile.gstCertificate || 'Not Uploaded', isFile: true },
                { label: 'MSME Compliance Certificate', val: state.profile.msmeCertificate || 'Not Uploaded', isFile: true }
              ].map((row, idx) => (
                <div key={idx} className="flex justify-between items-center border-b border-border-subtle pb-2 gap-4">
                  <span className="text-text-secondary font-bold shrink-0">{row.label}</span>
                  <span className={`font-semibold text-right truncate max-w-[220px] ${row.isMono || row.isFile ? 'font-mono' : ''
                    } ${row.isGreen ? 'text-text-primary font-bold' : 'text-text-primary'
                    } ${row.isFile ? 'text-emerald-400 bg-surface2 px-2 py-0.5 border border-border rounded text-[10px] flex items-center gap-1 select-none font-semibold' : ''
                    }`}>
                    {row.isFile && <FileText className="size-3 text-emerald-400 inline shrink-0" />}
                    {row.val}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 10. Progress badge component for UI header
function ProgressBadge({ count }) {
  return (
    <span className="bg-surface2 text-text-primary border border-border text-[10px] font-bold font-mono px-2 py-0.5 rounded-full select-none shrink-0 tabular-nums">
      {count}
    </span>
  );
}
