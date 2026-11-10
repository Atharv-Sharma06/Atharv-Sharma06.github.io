import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Scratch tests written during code review live in review-scratch/ (git-ignored), so
// they never run with, or get mistaken for, the real suite in tests/.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['review-scratch/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
