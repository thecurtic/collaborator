import { useSyncExternalStore } from 'react';

/**
 * Client-side UI preferences (localStorage), separate from backend settings.
 * Currently just the developer diagnostics toggle used by call mode.
 */
const DEBUG_KEY = 'collaborator_debug';

type Listener = () => void;
const listeners = new Set<Listener>();

export function getDebugEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDebugEnabled(value: boolean): void {
  try {
    localStorage.setItem(DEBUG_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive hook so toggling in Settings updates the call screen live. */
export function useDebugEnabled(): boolean {
  return useSyncExternalStore(subscribe, getDebugEnabled, () => false);
}
