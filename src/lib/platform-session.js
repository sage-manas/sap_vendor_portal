'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { platformApi, platformToken } from './platform-client';

// The console's session: who is signed in, what they may do, and — the part
// that is specific to this plane — how far through the second factor they are.
//
// The server is the authority on all three. This asks it once on load and after
// every step of the sign-in flow, rather than deriving state from the token,
// so a session that has been suspended or had its MFA reset elsewhere
// discovers that on the next page load.

const PlatformSessionContext = createContext(null);

// Where the sign-in flow currently stands. `console` is the only state in which
// the rest of the app renders.
export const STAGE = {
  LOADING: 'loading',
  SIGNED_OUT: 'signed_out',
  CHANGE_PASSWORD: 'change_password',
  ENROL_MFA: 'enrol_mfa',
  VERIFY_MFA: 'verify_mfa',
  CONSOLE: 'console',
};

const stageFor = (session) => {
  if (!session) return STAGE.SIGNED_OUT;
  if (session.mustChangePassword) return STAGE.CHANGE_PASSWORD;
  if (!session.mfa?.enrolled) return STAGE.ENROL_MFA;
  if (!session.mfa?.verified) return STAGE.VERIFY_MFA;
  return STAGE.CONSOLE;
};

// Asks the server who this token belongs to. Returns null for "nobody" —
// no token, or a token the API no longer accepts.
const loadSession = async () => {
  if (!platformToken.get()) return null;
  try {
    return await platformApi.me();
  } catch {
    // The client has already dropped the token on a 401; anything else that
    // prevents identifying the caller is equally a signed-out state.
    platformToken.clear();
    return null;
  }
};

export function PlatformSessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [stage, setStage] = useState(STAGE.LOADING);
  // Bumped whenever the session must be re-read: on mount, and after every
  // step of the sign-in flow.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const me = await loadSession();
      if (cancelled) return;
      setSession(me);
      setStage(stageFor(me));
    })();

    return () => { cancelled = true; };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  // Each step of the flow hands back a fresh token; adopting it and re-asking
  // the server keeps one code path for "what happens next".
  const adopt = useCallback((token) => {
    if (token) platformToken.set(token);
    setNonce((value) => value + 1);
  }, []);

  const signOut = useCallback(() => {
    platformToken.clear();
    setSession(null);
    setStage(STAGE.SIGNED_OUT);
  }, []);

  const value = useMemo(() => ({
    stage,
    operator: session?.operator || null,
    permissions: session?.auth?.permissions || [],
    can: (permission) => Boolean(session?.auth?.permissions?.includes(permission)),
    adopt,
    refresh,
    signOut,
  }), [stage, session, adopt, refresh, signOut]);

  return (
    <PlatformSessionContext.Provider value={value}>
      {children}
    </PlatformSessionContext.Provider>
  );
}

export const usePlatformSession = () => {
  const context = useContext(PlatformSessionContext);
  if (!context) throw new Error('usePlatformSession must be used inside the /platform layout');
  return context;
};
