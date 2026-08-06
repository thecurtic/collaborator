import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';

/**
 * App-level badge state: how many note drafts await review. Refreshed on
 * demand (after synthesis, inbox decisions, or chat proposals) — no polling.
 */
export function usePendingDrafts(enabled: boolean) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      // Scratch-born drafts live on their scratch card, not in the inbox
      // (7444138) — they must not count toward the Mind badge either.
      setCount(
        (await api.listDrafts({ status: 'pending' })).filter(
          (d) => !d.runId.startsWith('scratch-'),
        ).length,
      );
    } catch {
      // Endpoint missing/unreachable (older backend, offline) — keep quiet;
      // the badge just stays at its last value.
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // Recount whenever the app returns to the foreground: drafts can appear
  // with no client-side event (aborted voice turns, other devices, backend
  // work finishing after a disconnect).
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, refresh]);

  return { count, refresh };
}
