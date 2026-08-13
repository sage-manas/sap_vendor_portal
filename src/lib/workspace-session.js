'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiClient } from './api-client';

// The tenant workspace's session: who is signed in, which workspace they are
// in, and what they may do.
//
// The server is the authority on all three — `GET /api/auth/me` returns the
// permissions its own guards will enforce, so a tab is hidden by exactly the
// rule that would have refused the request. Nothing here is derived from the
// token, so an account that has been suspended or had its role changed
// elsewhere discovers that on the next page load.

const WorkspaceSessionContext = createContext(null);

export const STAGE = {
  LOADING: 'loading',
  SIGNED_OUT: 'signed_out',
  // Signed in, but on the supplier plane: the back office is not theirs.
  WRONG_PLANE: 'wrong_plane',
  WORKSPACE: 'workspace',
};

const stageFor = (session) => {
  if (!session?.auth) return STAGE.SIGNED_OUT;
  if (session.auth.plane !== 'tenant') return STAGE.WRONG_PLANE;
  return STAGE.WORKSPACE;
};

export function WorkspaceSessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [stage, setStage] = useState(STAGE.LOADING);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // apiClient drops the token and redirects to /sign-in on a 401, so the
      // only cases to handle here are "no session" and "some other failure",
      // which are the same signed-out state as far as this screen goes.
      const me = await apiClient.get('/auth/me').catch(() => null);
      if (cancelled) return;
      setSession(me);
      setStage(stageFor(me));
    })();

    return () => { cancelled = true; };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const value = useMemo(() => ({
    stage,
    user: session?.user || null,
    workspace: session?.workspace || null,
    permissions: session?.auth?.permissions || [],
    can: (permission) => Boolean(session?.auth?.permissions?.includes(permission)),
    refresh,
  }), [stage, session, refresh]);

  return (
    <WorkspaceSessionContext.Provider value={value}>
      {children}
    </WorkspaceSessionContext.Provider>
  );
}

export const useWorkspaceSession = () => {
  const context = useContext(WorkspaceSessionContext);
  if (!context) throw new Error('useWorkspaceSession must be used inside the /workspace layout');
  return context;
};
