import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against the PUBLISHED site: the static files in
 * <repo root>/claude-lifetime, served the way GitHub Pages serves them (plain files,
 * directory indexes, no rewrites). Run `npm run publish:site` first.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // Every test gets a fresh browser context, and with it an empty local database.
  fullyParallel: true,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node scripts/serve-static.mjs ../.. ${PORT}`,
    url: `http://localhost:${PORT}/claude-lifetime/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
