import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell configuration — REMOTE-URL MODE by design: the WebView loads
 * the served PWA, so the app updates with every deploy (the existing service
 * worker + 60s update polling) and the APK is built once. The native layer
 * exists only for what the web platform can't do — the microphone foreground
 * service that keeps calls alive with the screen off.
 *
 * The server URL is a setting in the app (long-press the launcher icon →
 * Server URL, or Android's App info → Additional settings in the app). This
 * value is only the default it starts from; without one the app asks on
 * first launch. To bake one in:
 *
 *   COLLABORATOR_URL=https://collaborator.example.com npm run android:sync
 *
 * MainActivity rewrites server.url / allowNavigation at runtime from the
 * saved setting (see ServerUrl.java).
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
