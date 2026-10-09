/**
 * Auth session state (b60da69), framework-agnostic so both the HTTP client
 * and React can use it.
 *
 * Browser/PWA: the credential is an httpOnly cookie set by POST
 * /api/auth/login — JS can never read it, so nothing is stored here and XSS
 * can't steal it.
 *
 * Android shell (Capacitor remote-URL mode): WebView/API cookie behavior is
 * unreliable, so the login response's session TOKEN is stored and attached
 * as `X-Session` on every request. Unlike the old forever-passkey, the token
 * expires and is revocable from any device (phase B moves it to
 * biometric-gated secure storage).
 *
 * The legacy `collaborator_passkey` is deleted on load — passkeys are never
 * stored client-side anymore.
 */
import { isNativeShell } from '@/native/nativeShell';

const TOKEN_KEY = 'collaborator_session_token';
const LEGACY_PASSKEY_KEY = 'collaborator_passkey';

try {
  localStorage.removeItem(LEGACY_PASSKEY_KEY);
} catch {
  /* ignore */
}

/** Session token for the X-Session header — Android shell only. */
export function getSessionToken(): string | null {
  if (!isNativeShell()) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** No-op in browsers (the httpOnly cookie is the credential there). */
export function storeSessionToken(token: string): void {
  if (!isNativeShell()) return;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

type Listener = () => void;
const forbiddenListeners = new Set<Listener>();

/** Subscribe to 403 events. Returns an unsubscribe function. */
export function onForbidden(listener: Listener): () => void {
  forbiddenListeners.add(listener);
  return () => forbiddenListeners.delete(listener);
}

/**
 * Called by the HTTP layer on a 403/401: the session is gone (expired or
 * revoked) — drop the shell token and let the UI lock.
 */
export function notifyForbidden(): void {
  clearSessionToken();
  for (const listener of forbiddenListeners) listener();
}
