import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './packages/extension/tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: { headless: true, viewport: { width: 1280, height: 720 } },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
