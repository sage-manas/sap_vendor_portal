// Which workspace a signed-out screen is about, when the address does not say.
//
// Under account tenancy (ADR-0044) one address serves every tenant, so a
// tenant's administrator shares `/sign-in?workspace=<slug>` or
// `/sign-up?workspace=<slug>`. That link only picks the branding on screen and
// the tenant a self-registration lands in; the account that signs in decides
// which workspace it belongs to. Once someone has signed in, the slug is kept
// for the pages after the sign-in screen, and dropped when the session ends.

const KEY = 'vc_workspace';

// The shape provisioning enforces. Anything else is ignored, so a value read
// from a URL or from storage is never sent on as something it is not.
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const clean = (value) => {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SLUG.test(slug) ? slug : null;
};

const slugFromUrl = () => {
  if (typeof window === 'undefined') return null;
  try {
    return clean(new URLSearchParams(window.location.search).get('workspace'));
  } catch {
    return null;
  }
};

const storedSlug = () => {
  try {
    return clean(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
};

/** The link's slug, else the one remembered from this browser's last sign-in. */
export const currentSlug = () => slugFromUrl() || storedSlug();

export const rememberWorkspace = (slug) => {
  try {
    const value = clean(slug);
    if (value) window.localStorage.setItem(KEY, value);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable (private windows); the screens work without it.
  }
};

export const forgetStoredWorkspace = () => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // See rememberWorkspace.
  }
};

/** `/sign-up` -> `/sign-up?workspace=acme`, so the next screen knows too. */
export const withWorkspace = (path, slug) => {
  const value = clean(slug);
  if (!value) return path;
  return `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(value)}`;
};
