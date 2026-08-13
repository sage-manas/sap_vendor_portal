// Field-level validation for the vendor registration form.
// Extracted from RegistrationView so it can be unit-tested; returns '' when valid.
//
// A supplier can be created two ways — they register themselves, or a tenant
// adds them from its directory — and both go through the rules below. The
// tenant's form asks for the identifying half only (the supplier still owns
// their banking details and documents), so that half is named once, here, and
// read by whoever renders it.
export const validateField = (field, value) => {
  switch (field) {
    case 'companyName':
      if (!value || !value.trim()) return 'Legal Entity Name is required';
      return '';
    case 'businessType':
      if (!value) return 'Business Type is required';
      return '';
    case 'address':
      if (!value || !value.trim()) return 'Street address is required';
      return '';
    case 'city':
      if (!value || !value.trim()) return 'City is required';
      return '';
    case 'state':
      if (!value) return 'State registration is required';
      return '';
    case 'postalCode':
      if (!value || !value.trim()) return 'PIN code is required';
      if (!/^\d{6}$/.test(value)) return 'PIN code must be exactly 6 digits';
      return '';
    case 'email':
      if (!value || !value.trim()) return 'Contact Email is required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address';
      return '';
    case 'phone':
      if (!value || !value.trim()) return 'Mobile / Phone is required';
      if (!/^\+?[\d\s-]{10,15}$/.test(value)) return 'Phone number must be between 10 and 15 digits';
      return '';
    case 'pan':
      if (!value || !value.trim()) return 'PAN Number is required';
      if (!/^[A-Z]{5}\d{4}[A-Z]$/i.test(value)) return 'PAN must follow standard format (e.g. ABCDE1234F)';
      return '';
    case 'gstin':
      if (!value || !value.trim()) return 'GSTIN is required';
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/i.test(value)) return 'GSTIN must follow standard format (e.g. 27AABCB1234F1Z5)';
      return '';
    case 'gstType':
      if (!value) return 'GST Registration Type is required';
      return '';
    case 'tdsSection':
      if (!value) return 'TDS Section mapping is required';
      return '';
    case 'accountName':
      if (!value || !value.trim()) return 'Account Holder Name is required';
      return '';
    case 'accountNumber':
      if (!value || !value.trim()) return 'Account Number is required';
      if (!/^\d{9,18}$/.test(value)) return 'Account Number must be 9 to 18 digits';
      return '';
    case 'ifscCode':
      if (!value || !value.trim()) return 'IFSC Code is required';
      if (!/^[A-Z]{4}0[A-Z\d]{6}$/i.test(value)) return 'IFSC Code must follow standard format (e.g. HDFC0000060)';
      return '';
    case 'bankName':
      if (!value || !value.trim()) return 'Bank Name is required';
      return '';
    case 'bankBranch':
      if (!value || !value.trim()) return 'Bank Branch is required';
      return '';
    case 'cancelledCheque':
      if (!value) return 'Cancelled Cheque document copy is required';
      return '';
    case 'panCardCopy':
      if (!value) return 'PAN Card document copy is required';
      return '';
    case 'gstCertificate':
      if (!value) return 'GST Certificate document copy is required';
      return '';
    case 'incorporationCertificate':
      if (!value) return 'Certificate of Incorporation is required';
      return '';
    default:
      return '';
  }
};

// What a tenant fills in when it adds a supplier itself. Labels sit beside the
// field names because the form has no list of its own to keep in step.
export const SUPPLIER_IDENTITY_FIELDS = [
  { name: 'companyName', label: 'Legal entity name' },
  { name: 'email', label: 'Contact email', type: 'email' },
  { name: 'phone', label: 'Mobile / phone' },
  { name: 'gstin', label: 'GSTIN' },
  { name: 'pan', label: 'PAN' },
  { name: 'address', label: 'Street address' },
  { name: 'city', label: 'City' },
  { name: 'state', label: 'State' },
  { name: 'postalCode', label: 'PIN code' },
];

/**
 * Runs `validateField` over a set of fields and returns a { field: message }
 * map of the ones that failed — the same shape the API returns for a schema
 * failure, so a form renders both the same way.
 */
export const validateFields = (fields, values = {}) =>
  fields.reduce((errors, field) => {
    const name = typeof field === 'string' ? field : field.name;
    const message = validateField(name, values[name]);
    return message ? { ...errors, [name]: message } : errors;
  }, {});
