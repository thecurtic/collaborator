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
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        // Installed-PWA share sheet → Scratch (App reads the query params
        // and captures; the Android shell forwards SEND intents the same
        // way from MainActivity).
        share_target: {
          action: '/',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
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
        // Exclude the heavy ML chunks (TF.js / ONNX / speech-commands / Piper /
        // Transformers.js + the whisper worker) from the precache — they're
        // lazy-loaded only when the relevant voice feature is used.
        globIgnores: [
          '**/tf-*.js',
          '**/ort*.js',
          '**/speech-commands*.js',
          '**/piper-*.js',
          '**/transformers*.js',
          '**/whisperWorker*.js',
          '**/assets/worker-*.js',
        ],
        // Don't let the SW intercept API calls — always go to the network.
        navigateFallbackDenylist: [/^\/api/],
        // Cache the on-device Whisper model weights (Hugging Face CDN) so the
        // model only downloads once. Audio is never sent anywhere — this is just
        // the model files.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.hostname === 'huggingface.co' ||
              url.hostname.endsWith('.hf.co') ||
              url.hostname.includes('cdn-lfs'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'hf-models',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
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
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // speech-commands imports Node's util.promisify — shim it for the browser.
      {
        find: /^util$/,
        replacement: path.resolve(__dirname, './src/shims/node-util.ts'),
      },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // Give TF.js (incl. speech-commands) a stable chunk name so the SW can
        // exclude it from precache; otherwise it lands in a generic index chunk.
        manualChunks(id) {
          if (id.includes('@tensorflow')) return 'tf';
        },
      },
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
    // ws:true upgrades WS /api/transcribe/stream (streaming transcription).
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
