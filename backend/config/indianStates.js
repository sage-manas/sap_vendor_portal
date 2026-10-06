// The states a GST registration can belong to, with the two-digit code the
// GSTIN itself begins with.
//
// Finding 4.4: `Client.gstin`/`Client.state` were real columns that nothing
// could set, so `services/gst.service.js` could never derive a place of supply
// and every invoice's tax split fell back to "state unknown". Giving the
// platform console two text boxes would have closed that only on paper: the
// split is decided by `isIntraState`, which compares the tenant's state to the
// supplier's as trimmed, lower-cased *strings*. A supplier picks their state
// from a fixed list on the registration form; an operator typing 'MH' or
// 'Maharashtra ' for the tenant produces a value that never matches it, and
// the failure is silent — every intra-state invoice quietly billed as IGST.
//
// So the tenant's state comes from the same vocabulary the supplier's does,
// and this registry is where that vocabulary lives. Backend-owned and served
// through `GET /api/meta/indian-states`, the pattern meta.controller.js
// already uses for the SAP field limits: "read from the same registry the
// backend enforces rather than a second, driftable copy in the frontend".
//
// `name` matches `INDIAN_STATES` in src/features/profile/components/RegistrationView.jsx
// exactly, character for character, because that is the list suppliers already
// chose from and existing Vendor.state rows hold those spellings. That
// frontend copy is now the driftable duplicate and should be replaced by this
// endpoint — see issue #221; not done here, because it is the supplier
// registration form and this change is about the platform console.
//
// `gstCode` is the real GST state code (the first two digits of a GSTIN), used
// only to check that a GSTIN an operator enters agrees with the state they
// picked. Codes with no entry in the list above are deliberately absent
// rather than guessed: 25 (Daman & Diu, merged into 26 in 2020) and 26
// (Dadra & Nagar Haveli and Daman & Diu) are one jurisdiction now, and the
// list still carries the two pre-merger names separately, so both are mapped
// to what a GSTIN issued today would actually say.
const INDIAN_STATES = [
  { code: 'AN', gstCode: '35', name: 'Andaman & Nicobar Islands' },
  { code: 'AP', gstCode: '37', name: 'Andhra Pradesh' },
  { code: 'AR', gstCode: '12', name: 'Arunachal Pradesh' },
  { code: 'AS', gstCode: '18', name: 'Assam' },
  { code: 'BR', gstCode: '10', name: 'Bihar' },
  { code: 'CH', gstCode: '04', name: 'Chandigarh' },
  { code: 'CG', gstCode: '22', name: 'Chhattisgarh' },
  { code: 'DN', gstCode: '26', name: 'Dadra & Nagar Haveli' },
  { code: 'DD', gstCode: '26', name: 'Daman & Diu' },
  { code: 'DL', gstCode: '07', name: 'Delhi' },
  { code: 'GA', gstCode: '30', name: 'Goa' },
  { code: 'GJ', gstCode: '24', name: 'Gujarat' },
  { code: 'HR', gstCode: '06', name: 'Haryana' },
  { code: 'HP', gstCode: '02', name: 'Himachal Pradesh' },
  { code: 'JK', gstCode: '01', name: 'Jammu & Kashmir' },
  { code: 'JH', gstCode: '20', name: 'Jharkhand' },
  { code: 'KA', gstCode: '29', name: 'Karnataka' },
  { code: 'KL', gstCode: '32', name: 'Kerala' },
  { code: 'LA', gstCode: '38', name: 'Ladakh' },
  { code: 'LD', gstCode: '31', name: 'Lakshadweep' },
  { code: 'MP', gstCode: '23', name: 'Madhya Pradesh' },
  { code: 'MH', gstCode: '27', name: 'Maharashtra' },
  { code: 'MN', gstCode: '14', name: 'Manipur' },
  { code: 'ML', gstCode: '17', name: 'Meghalaya' },
  { code: 'MZ', gstCode: '15', name: 'Mizoram' },
  { code: 'NL', gstCode: '13', name: 'Nagaland' },
  { code: 'OD', gstCode: '21', name: 'Odisha' },
  { code: 'PY', gstCode: '34', name: 'Puducherry' },
  { code: 'PB', gstCode: '03', name: 'Punjab' },
  { code: 'RJ', gstCode: '08', name: 'Rajasthan' },
  { code: 'SK', gstCode: '11', name: 'Sikkim' },
  { code: 'TN', gstCode: '33', name: 'Tamil Nadu' },
  { code: 'TS', gstCode: '36', name: 'Telangana' },
  { code: 'TR', gstCode: '16', name: 'Tripura' },
  { code: 'UP', gstCode: '09', name: 'Uttar Pradesh' },
  { code: 'UK', gstCode: '05', name: 'Uttarakhand' },
  { code: 'WB', gstCode: '19', name: 'West Bengal' },
];

const STATE_NAMES = INDIAN_STATES.map((entry) => entry.name);

// Matched the way gst.service.js's isIntraState matches, so "accepted here"
// and "compares equal there" cannot disagree.
const normalise = (value) => String(value ?? '').trim().toLowerCase();

const BY_NORMALISED_NAME = new Map(INDIAN_STATES.map((entry) => [normalise(entry.name), entry]));

// Returns the registry's own spelling for a name given in any casing or with
// surrounding whitespace, or null. Callers store what this returns, so one
// stored tenant state is byte-identical to the supplier states it is compared
// against.
const canonicalStateName = (value) => BY_NORMALISED_NAME.get(normalise(value))?.name ?? null;

const isKnownStateName = (value) => canonicalStateName(value) !== null;

// Which states a GSTIN's leading two digits could name. A list, not one
// entry: 26 covers both pre-merger names the state list still carries
// separately.
const statesForGstin = (gstin) => {
  const prefix = String(gstin ?? '').slice(0, 2);
  return INDIAN_STATES.filter((entry) => entry.gstCode === prefix);
};

// Does this GSTIN's state code agree with this state name? `true` when either
// is missing — "not stated" is not a contradiction, and the schema decides
// separately whether a field is required.
const gstinMatchesState = (gstin, state) => {
  const canonical = canonicalStateName(state);
  if (!gstin || !canonical) return true;
  const candidates = statesForGstin(gstin);
  // A GSTIN whose prefix is not in the registry at all is not contradicted by
  // the state — it is a GSTIN this list cannot speak about (a new union
  // territory, or the 97/99 codes used for non-resident and OIDAR
  // registrations). The GSTIN regex has already vouched for its shape.
  if (!candidates.length) return true;
  return candidates.some((entry) => entry.name === canonical);
};

module.exports = {
  INDIAN_STATES,
  STATE_NAMES,
  canonicalStateName,
  isKnownStateName,
  statesForGstin,
  gstinMatchesState,
};
