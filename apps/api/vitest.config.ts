import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Tests share one MongoDB database per worker file; run files serially for deterministic DB state.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
