// Which plane a path belongs to.
//
// The supplier portal's shell, session redirect and API client all assume every
// route is theirs. The platform console is not: it has its own layout, its own
// token and its own sign-in flow, so each of those three has to know where its
// territory ends. That "where" is here, once.

export const PLATFORM_ROOT = '/platform';

export const isPlatformPath = (pathname = '') =>
  pathname === PLATFORM_ROOT || pathname.startsWith(`${PLATFORM_ROOT}/`);
