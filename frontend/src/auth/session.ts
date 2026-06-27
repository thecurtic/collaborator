/**
 * Passkey session state, framework-agnostic so both the HTTP client and React
 * can use it. The passkey lives in localStorage (key `collaborator_passkey`,
 * per API-SPEC.md) and is attached as the `X-Passkey` header on every request.
 *
 * When any request comes back 403, the HTTP layer calls `notifyForbidden()`,
 * which clears the stored passkey and fires listeners so the UI can lock.
 */

const STORAGE_KEY = 'collaborator_passkey';

type Listener = () => void;
const forbiddenListeners = new Set<Listener>();

export function getPasskey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setPasskey(passkey: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, passkey);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export function clearPasskey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Subscribe to 403 events. Returns an unsubscribe function. */
export function onForbidden(listener: Listener): () => void {
  forbiddenListeners.add(listener);
  return () => forbiddenListeners.delete(listener);
}

/** Called by the HTTP layer on a 403: clears the passkey and notifies the UI. */
export function notifyForbidden(): void {
  clearPasskey();
  for (const listener of forbiddenListeners) listener();
}
