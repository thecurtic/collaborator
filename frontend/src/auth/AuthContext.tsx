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
import { clearPasskey, onForbidden, setPasskey } from './session';

/**
 * - `checking` — verifying access on load (or after a change)
 * - `open`     — auth disabled, or a valid passkey is in place
 * - `locked`   — a passkey is required (a request returned 403)
 */
type Gate = 'checking' | 'open' | 'locked';

type SubmitResult = { ok: true } | { ok: false; error: string };

interface AuthContextValue {
  gate: Gate;
  submitPasskey: (passkey: string) => Promise<SubmitResult>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
        // Only an actual 403 means "needs passkey". Network/other errors leave
        // the app open so the chat + health indicator can surface them instead.
        if (err instanceof ApiRequestError && err.status === 403) {
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

  const submitPasskey = useCallback(
    async (passkey: string): Promise<SubmitResult> => {
      setPasskey(passkey);
      try {
        await api.verifyAuth();
        setGate('open');
        return { ok: true };
      } catch (err) {
        clearPasskey(); // also cleared by notifyForbidden on 403; harmless
        if (err instanceof ApiRequestError && err.status === 403) {
          return {
            ok: false,
            error: 'Invalid or expired passkey. Please try again.',
          };
        }
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Could not verify passkey. Check your connection.',
        };
      }
    },
    [],
  );

  const signOut = useCallback(() => {
    clearPasskey();
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
