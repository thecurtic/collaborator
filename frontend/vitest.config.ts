import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Standalone config (instead of reusing vite.config.ts) so tests don't load
// the PWA/React plugins — the suite is pure-logic only.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
  },
});
