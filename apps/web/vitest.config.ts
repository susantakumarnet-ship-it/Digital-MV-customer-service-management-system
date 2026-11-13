import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: vitest 2 ships its own Vite 5 types, which clash with the app's Vite 6 plugin types.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    css: false,
    // Multi-step form tests can be slow when the machine is busy (e.g. API tests running in parallel).
    testTimeout: 30_000,
  },
});
