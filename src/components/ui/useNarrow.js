'use client';

import { useSyncExternalStore } from 'react';

// True below 768px, where tables render as card lists. One layout at a time,
// rather than both in the DOM with CSS hiding one: duplicated rows would be
// read twice by anything that ignores CSS. The server (and a test DOM without
// matchMedia) gets the wide layout.
const NARROW = '(max-width: 767px)';

const subscribe = (onChange) => {
  const query = window.matchMedia?.(NARROW);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const isNarrow = () => Boolean(window.matchMedia?.(NARROW).matches);

export const useNarrow = () => useSyncExternalStore(subscribe, isNarrow, () => false);
