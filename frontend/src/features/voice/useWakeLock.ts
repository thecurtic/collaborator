import { useEffect } from 'react';

type WakeSentinel = { release: () => Promise<void> };
type WakeLockNav = {
  wakeLock?: { request(type: 'screen'): Promise<WakeSentinel> };
};

/**
 * Hold a screen wake lock while `active` so the screen stays on during
 * recording/calls — otherwise the screen locks, the tab is throttled, and audio
 * capture dies. Re-acquires when the page becomes visible again (the lock is
 * auto-released on hide). No-op where the API is unavailable. This keeps the
 * screen ON; true screen-off capture needs the native wrapper.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const wl = (navigator as unknown as WakeLockNav).wakeLock;
    if (!wl) return;

    let sentinel: WakeSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        sentinel = await wl.request('screen');
      } catch {
        /* denied / unsupported — ignore */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
