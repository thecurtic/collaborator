import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// Backend dev server (see api-spec/API-SPEC.md). The backend CORS allow-list
// includes http://localhost:3000, so we run the dev server there.
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'http://localhost:8001';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // We register manually in src/pwa.ts to add periodic update checks.
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Collaborator',
        short_name: 'Collaborator',
        description: 'Self-hosted personal chat with visible, editable memory.',
        theme_color: '#0a0e1a',
        background_color: '#0a0e1a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Don't let the SW intercept API calls — always go to the network.
        navigateFallbackDenylist: [/^\/api/],
        // Take control immediately and drop stale precache on each new version
        // so an updated build never serves the old app shell.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
      },
      // SW is intentionally OFF in dev: an active dev service worker caches the
      // app shell and serves stale code across reloads (it's why the passkey
      // screen didn't appear). Test PWA install against a production build
      // (`npm run build && npm run preview`) instead.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    // Expose on the LAN so a phone can load http://<your-ip>:3000 for testing.
    host: true,
    // Allow access via a Tailscale MagicDNS name (e.g. `tailscale serve`),
    // which gives a real HTTPS cert — required to install the PWA on a phone.
    allowedHosts: ['.ts.net'],
    // Proxy /api to the backend so the browser sees same-origin requests in dev.
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
});
