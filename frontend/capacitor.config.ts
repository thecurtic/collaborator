import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell configuration — REMOTE-URL MODE by design: the WebView loads
 * the served PWA, so the app updates with every deploy (the existing service
 * worker + 60s update polling) and the APK is built once. The native layer
 * exists only for what the web platform can't do — the microphone foreground
 * service that keeps calls alive with the screen off.
 *
 * Point the shell at YOUR deployment before `npm run android:sync`:
 *
 *   COLLABORATOR_URL=https://collaborator.example.com npm run android:sync
 *
 * The value is baked into the APK at sync time; rebuild after changing it.
 */
const SERVER_URL = process.env.COLLABORATOR_URL ?? 'https://collaborator.example.com';

const config: CapacitorConfig = {
  appId: 'org.collaborator.app',
  appName: 'Collaborator',
  // Required by the CLI even in remote mode (assets are copied but unused).
  webDir: 'dist',
  server: {
    url: SERVER_URL,
    allowNavigation: [new URL(SERVER_URL).hostname],
  },
};

export default config;
