import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import type { AppSettings } from '@/domain/models';

type Status = 'loading' | 'ready' | 'error';

/**
 * Loads settings when `active` becomes true (e.g. the settings sheet opens) and
 * saves changes. Kept optimistic on save so the UI reflects the new value even
 * if the backend's GET doesn't echo it back immediately.
 */
export function useSettings(active: boolean) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const s = await api.getSettings();
        if (!cancelled) {
          setSettings(s);
          setStatus('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load settings');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const save = useCallback(
    async (patch: Partial<AppSettings>): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const updated = await api.updateSettings(patch);
        // Optimistic merge: trust what we sent over the GET echo.
        setSettings((prev) => ({ ...prev, ...updated, ...patch }) as AppSettings);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save settings');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return { settings, status, error, saving, save };
}
