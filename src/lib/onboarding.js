// Whether a supplier has finished onboarding, and what the portal shows them
// until they have.
//
// The server is the boundary — backend/middleware/requireOnboarded.js refuses
// the transacting modules outright — and this is the matching UX: a supplier who
// cannot bid should not be shown a bidding tab. The two lists are checked
// against each other in onboarding.test.js, the same way the nav registries are,
// so hiding a tab and refusing the request stay one rule.

// Mirrors VENDOR_PRE_SUBMISSION in backend/config/statuses.js.
export const PRE_SUBMISSION_STATUSES = ['Draft', 'Pending', 'Rejected'];

// The one module a supplier still owes us a registration for may reach.
export const ONBOARDING_MODULE = 'registration';

// True while the supplier still has to complete and submit the form. An unknown
// or absent status reads as "not yet onboarding-gated": the profile has not
// loaded, and blanking the navigation on every page load would be worse than
// showing a tab whose request the server will refuse anyway.
export const isOnboarding = (profile) =>
  Boolean(profile?.status) && PRE_SUBMISSION_STATUSES.includes(profile.status);

// True once a supplier's vendor master exists in SAP.
export const isRegistrationComplete = (profile) => profile?.status === 'Approved';

// The modules to show. Suppliers mid-onboarding get the registration tab alone;
// everyone else — approved suppliers and all tenant staff — gets the full list.
//
// Approved suppliers used to lose the registration tab ("nothing left to do
// there"). It stays: it is their company profile — bank details, documents,
// the record their buyer approved — and the redesign gives it a permanent
// place at the foot of the sidebar (product decision, 2026-10-16).
export const modulesFor = (modules, { isSupplier, profile }) => {
  if (isSupplier && isOnboarding(profile)) {
    return modules.filter((item) => item.id === ONBOARDING_MODULE);
  }
  return modules;
};
