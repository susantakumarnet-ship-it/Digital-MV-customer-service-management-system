import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5610,
    strictPort: true,
    // Same-origin proxy so the HttpOnly refresh cookie and CSRF cookie work without CORS credentials.
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:4610', changeOrigin: false },
    },
  },
  // `vite preview` serves the production build (used by E2E tests) with the same /api proxy.
  preview: {
    port: 5611,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:4610', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          query: ['@tanstack/react-query', 'axios'],
        },
      },
    },
  },
});
