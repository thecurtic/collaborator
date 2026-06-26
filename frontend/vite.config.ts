import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Backend dev server (see api-spec/API-SPEC.md). The backend CORS allow-list
// includes http://localhost:3000, so we run the dev server there.
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'http://localhost:8001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    // Proxy /api to the backend so the browser sees same-origin requests in dev.
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
});
