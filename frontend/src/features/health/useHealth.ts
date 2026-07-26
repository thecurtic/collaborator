import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { setCapabilities } from '@/lib/capabilities';
import type { HealthStatus } from '@/domain/models';

type HealthState =
  | { status: 'checking' }
  | { status: 'online'; health: HealthStatus }
  | { status: 'offline'; error: string };

const POLL_MS = 15_000;

export function useHealth() {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  const check = useCallback(async () => {
    try {
      const health = await api.health();
      setCapabilities(health.capabilities); // keep the app-wide flags fresh
      setState({ status: 'online', health });
    } catch (err) {
      setState({
        status: 'offline',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  return state;
}
