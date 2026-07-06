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
      setCount((await api.listDrafts({ status: 'pending' })).length);
    } catch {
      // Endpoint missing/unreachable (older backend, offline) — keep quiet;
      // the badge just stays at its last value.
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { count, refresh };
}
