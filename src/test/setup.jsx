import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { navigation, socketRef, resetNavigation, resetSocket } from './testState';

// Runs for every test file (vitest.config.mjs setupFiles).

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// Both are hoisted, so they apply to every file without each one repeating
// them. They read from testState rather than closing over a value, which is
// what lets a test change the current route or push a socket event after the
// module graph has already been built.

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation,
  useParams: () => navigation.params,
  useSearchParams: () => navigation.searchParams,
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  initSocket: () => socketRef.current,
  getSocket: () => socketRef.current,
  closeSocket: vi.fn(),
}));

// next/link renders an <a> and nothing else here; its real implementation
// wants a router context this tree does not build.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => <a href={typeof href === 'string' ? href : '#'} {...rest}>{children}</a>,
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetNavigation();
  resetSocket();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// jsdom gaps
// ---------------------------------------------------------------------------
// jsdom implements none of these, and the design system's components call
// them. Absent them a render throws for a reason that has nothing to do with
// the behaviour under test.

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
