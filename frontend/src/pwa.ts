import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker registration with aggressive update checks.
 *
 * With `registerType: 'autoUpdate'`, vite-plugin-pwa activates a new SW and
 * reloads the page once one is detected. The catch is *detection*: by default
 * that only happens on navigation. A desktop tab left open (or one serving a
 * cached shell) can keep running the old version. So we explicitly poll for a
 * new SW on an interval and whenever the tab regains focus, which makes a
 * redeploy propagate without the user manually clearing the service worker.
 */
const UPDATE_INTERVAL_MS = 60_000;

// While > 0, skip update checks entirely. With autoUpdate, *detecting* a new SW
// activates it and reloads the page — which would drop an active call or
// recording mid-flight. Holders pause detection; checks resume on release.
let updateHolds = 0;

/** Pause PWA update checks (e.g. during a call). Returns a release function. */
export function holdPwaUpdates(): () => void {
  updateHolds++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      updateHolds--;
    }
  };
}

export function setupPWA(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const checkForUpdate = () => {
        if (updateHolds > 0) return;
        // update() rejects when offline; ignore — we'll try again next tick.
        registration.update().catch(() => {});
      };

      setInterval(checkForUpdate, UPDATE_INTERVAL_MS);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
      window.addEventListener('online', checkForUpdate);
    },
  });
}
