import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/db/migrate.ts', 'src/db/seeds/run.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: true,
  // Bundle the workspace package; keep npm dependencies external.
  noExternal: ['@mv/shared'],
});
