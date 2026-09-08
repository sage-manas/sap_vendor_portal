// Which plane a path belongs to.
//
// The supplier portal's shell, session redirect and API client all assume every
// route is theirs. Two route groups are not: the platform console and the
// tenant workspace each have their own layout, navigation and session, so each
// of those three has to know where its territory ends. That "where" is here,
// once.

export const PLATFORM_ROOT = '/platform';
export const WORKSPACE_ROOT = '/workspace';

const under = (root) => (pathname = '') =>
  pathname === root || pathname.startsWith(`${root}/`);

export const isPlatformPath = under(PLATFORM_ROOT);

export const isWorkspacePath = under(WORKSPACE_ROOT);

// True for anything that renders its own chrome rather than the supplier
// portal's sidebar, header and BAPI console.
export const hasOwnChrome = (pathname = '') =>
  isPlatformPath(pathname) || isWorkspacePath(pathname);

// The screens you reach without a session: they render centered, in "auth
// mode", and the session redirect must not bounce you off them. The layout and
// the provider both need this answer and used to carry a copy each, which is
// how a new public route ends up redirecting to /sign-in on one of them only.
const AUTH_PATHS = new Set([
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  // Where an invited colleague or supplier lands from their email.
  '/accept-invitation',
]);

export const isAuthPath = (pathname = '') => AUTH_PATHS.has(pathname);
