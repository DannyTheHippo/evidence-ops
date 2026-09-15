import { useEffect, useState } from 'react';
import type { Me } from '../api/client';
import { ensureSession, getCachedSession, subscribeSession, unsubscribeSession } from './auth';

export type SessionState =
  { status: 'loading'; me: null } | { status: 'authed'; me: Me } | { status: 'anon'; me: null };

const LOADING: SessionState = { status: 'loading', me: null };
const ANON: SessionState = { status: 'anon', me: null };

function toState(me: Me | null | undefined): SessionState | null {
  if (me === undefined) return null;
  return me ? { status: 'authed', me } : ANON;
}

// Thin reactive shell over auth.ts's cache — seeded from the cache so a warm session (e.g. a
// second mount after login) never renders a spurious 'loading' pass, and subscribed for the rest
// of its life so a client-side setSession/clearSession (login/logout without a reload) updates
// every mounted instance. A notification of `undefined` (clearSession, or a probe superseded
// before it settled) means "unprobed", not "anon" — it re-probes in the background rather than
// flashing 'loading' over whatever is currently shown. Fails CLOSED the same way ensureSession
// does: a rejected probe lands on 'anon', never on 'authed'.
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(() => toState(getCachedSession()) ?? LOADING);

  useEffect(() => {
    let cancelled = false;
    const probe = (): void => {
      ensureSession()
        .then((me) => {
          if (!cancelled) setState(me ? { status: 'authed', me } : ANON);
        })
        .catch(() => {
          if (!cancelled) setState(ANON);
        });
    };
    const listener = (me: Me | null | undefined): void => {
      if (cancelled) return;
      const next = toState(me);
      if (next) setState(next);
      else probe();
    };
    subscribeSession(listener);
    probe();
    return () => {
      cancelled = true;
      unsubscribeSession(listener);
    };
  }, []);

  return state;
}
