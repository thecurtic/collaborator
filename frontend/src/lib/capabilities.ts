import { useSyncExternalStore } from 'react';
import { api } from '@/api/collaborator';
import type { ServerCapabilities } from '@/domain/models';

/**
 * App-wide cache of the backend's voice capabilities (GET /api/health
 * `capabilities`, 9acc3d1). All-false until the first successful probe, so
 * server engine options stay hidden rather than 503ing on older backends.
 *
 * Populated by probeCapabilities() once at app load and refreshed by the
 * health poller whenever it runs (the flags only change on a backend
 * reconfigure + restart, so staleness is a non-issue in practice).
 */
const NONE: ServerCapabilities = {
  sttStream: false,
  ttsStream: false,
  phrases: false,
};

let current: ServerCapabilities = NONE;
const listeners = new Set<() => void>();

export function setCapabilities(caps: ServerCapabilities): void {
  if (
    caps.sttStream === current.sttStream &&
    caps.ttsStream === current.ttsStream &&
    caps.phrases === current.phrases
  ) {
    return;
  }
  current = caps;
  listeners.forEach((l) => l());
}

export function getCapabilities(): ServerCapabilities {
  return current;
}

export function useCapabilities(): ServerCapabilities {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getCapabilities,
    () => NONE,
  );
}

/** One-shot probe at app load; failures are ignored (flags stay false). */
export function probeCapabilities(): void {
  api
    .health()
    .then((h) => setCapabilities(h.capabilities))
    .catch(() => {});
}
