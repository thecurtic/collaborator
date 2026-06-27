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

export function setupPWA(): void {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const checkForUpdate = () => {
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
