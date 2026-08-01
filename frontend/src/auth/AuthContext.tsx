import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/api/collaborator';
import { ApiRequestError } from '@/api/http';
import { deviceLabel } from '@/lib/deviceLabel';
import { clearSessionToken, onForbidden, storeSessionToken } from './session';

/**
 * - `checking` — verifying access on load (or after a change)
 * - `open`     — auth disabled, or a valid device session is in place
 * - `locked`   — login required (no session, or a request returned 403)
 */
type Gate = 'checking' | 'open' | 'locked';

type SubmitResult = { ok: true } | { ok: false; error: string };

interface AuthContextValue {
  gate: Gate;
  submitPasskey: (passkey: string) => Promise<SubmitResult>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isAuthError(err: unknown): boolean {
  return (
    err instanceof ApiRequestError &&
    (err.status === 403 || err.status === 401)
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking');

  useEffect(() => {
    let cancelled = false;
    // Register before the probe so a fast 403 can't slip past us.
    const off = onForbidden(() => {
      if (!cancelled) setGate('locked');
    });

    void (async () => {
      try {
        await api.verifyAuth();
        if (!cancelled) setGate('open');
      } catch (err) {
        if (cancelled) return;
        // Only an actual 403/401 means "needs login". Network/other errors
        // leave the app open so the chat + health indicator surface them.
        if (isAuthError(err)) {
          setGate('locked');
        } else {
          setGate('open');
        }
      }
    })();

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  /**
   * Exchange the passkey for a device session (b60da69). The passkey itself
   * is never stored: browsers get an httpOnly cookie; the Android shell
   * stores the returned session token (storeSessionToken no-ops elsewhere).
   */
  const submitPasskey = useCallback(
    async (passkey: string): Promise<SubmitResult> => {
      try {
        const session = await api.login(passkey, deviceLabel());
        storeSessionToken(session.token);
        setGate('open');
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 429) {
          const wait = err.retryAfterS ?? 60;
          return {
            ok: false,
            error: `Too many attempts — locked out. Try again in ${wait}s.`,
          };
        }
        if (isAuthError(err)) {
          return { ok: false, error: 'Wrong passkey. Please try again.' };
        }
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Could not sign in. Check your connection.',
        };
      }
    },
    [],
  );

  const signOut = useCallback(() => {
    // Best-effort server revoke (also clears the cookie); lock regardless.
    void api.logout().catch(() => {});
    clearSessionToken();
    setGate('locked');
  }, []);

  return (
    <AuthContext.Provider value={{ gate, submitPasskey, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
