import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { setCapabilities } from '@/lib/capabilities';
import type { HealthStatus } from '@/domain/models';

type HealthState =
  | { status: 'checking' }
  | { status: 'online'; health: HealthStatus; model: string }
  /** Backend up, but the LLM behind it isn't reachable (inference box down). */
  | { status: 'model-offline'; health: HealthStatus; error: string }
  | { status: 'offline'; error: string };

const POLL_MS = 15_000;

/**
 * Two-stage probe: /api/health says the BACKEND is alive; /api/models says
 * the MODEL is reachable (it queries LM Studio live and 500s when the
 * inference machine is down). "online" means messages will actually get a
 * reply — a healthy backend with a crashed model is its own distinct state,
 * because that's the failure that actually happens in practice.
 */
export function useHealth() {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  const check = useCallback(async () => {
    let health: HealthStatus;
    try {
      health = await api.health();
      setCapabilities(health.capabilities); // keep the app-wide flags fresh
    } catch (err) {
      setState({
        status: 'offline',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return;
    }
    try {
      const models = await api.getModels();
      setState({ status: 'online', health, model: models.current });
    } catch (err) {
      setState({
        status: 'model-offline',
        health,
        error: err instanceof Error ? err.message : 'Model unreachable',
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
