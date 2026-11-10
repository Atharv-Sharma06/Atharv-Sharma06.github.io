import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // Each test file boots a real PostgreSQL (PGlite/WASM) instance.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
