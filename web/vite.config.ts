import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest stubs every `.css` module to an empty string before Vite's own `?raw` handling runs,
    // so a test that reads a stylesheet as text gets `''` and asserts nothing. Scoped to
    // `src/styles/` rather than enabled wholesale: only `styles-contract.test.ts` reads CSS as
    // text, and everything else keeps the cheaper stub.
    css: { include: [/src\/styles\//] },
  },
});
