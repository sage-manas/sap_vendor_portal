import { vi } from 'vitest';

// Mutable state shared between the module mocks installed in setup.js and the
// harness in renderWithPortal.jsx. It lives in its own module so setup.js can
// mock `next/navigation` and `@/lib/socket` without importing the provider
// tree — a setup file that pulls in every provider would run that import cost
// for the pure-function suites too.

export const navigation = {
  pathname: '/',
  params: {},
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

export const resetNavigation = (pathname = '/', params = {}) => {
  navigation.pathname = pathname;
  navigation.params = params;
  navigation.searchParams = new URLSearchParams();
  navigation.push = vi.fn();
  navigation.replace = vi.fn();
  navigation.back = vi.fn();
  navigation.forward = vi.fn();
  navigation.refresh = vi.fn();
  navigation.prefetch = vi.fn();
};

// lib/socket.js keeps a module-scope singleton and opens a real websocket.
// This stands in for it and, unlike a bare stub, lets a test drive the
// server-push side of the UI: socket.emitServerEvent('po:new', { … }).
export const createFakeSocket = () => {
  const handlers = new Map();

  return {
    connected: true,
    id: 'socket-test',
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return this;
    },
    off(event, handler) {
      if (handler) handlers.get(event)?.delete(handler);
      else handlers.delete(event);
      return this;
    },
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners() { handlers.clear(); return this; },
    /** Deliver an event as if the server had pushed it. */
    emitServerEvent(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    /** How many listeners the UI registered for an event. */
    listenerCount: (event) => handlers.get(event)?.size ?? 0,
  };
};

// The socket the current test's UI is wired to. Replaced per test so listeners
// never leak from one render into the next.
export const socketRef = { current: createFakeSocket() };

export const resetSocket = () => {
  socketRef.current = createFakeSocket();
  return socketRef.current;
};
