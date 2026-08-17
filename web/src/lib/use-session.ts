import { useEffect, useState } from 'react';
import type { Me } from '../api/client';
import { ensureSession } from './auth';

export type SessionState =
  { status: 'loading'; me: null } | { status: 'authed'; me: Me } | { status: 'anon'; me: null };

const LOADING: SessionState = { status: 'loading', me: null };
const ANON: SessionState = { status: 'anon', me: null };

// Thin reactive shell over ensureSession()'s cache — every mount re-checks the cache/in-flight
// probe rather than trusting a stale render, and fails CLOSED the same way ensureSession does:
// a rejected probe lands on 'anon', never on 'authed'.
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(LOADING);

  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then((me) => {
        if (!cancelled) setState(me ? { status: 'authed', me } : ANON);
      })
      .catch(() => {
        if (!cancelled) setState(ANON);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
