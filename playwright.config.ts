import { defineConfig } from '@playwright/test';

const mockPort = process.env.MOCK_SITES_PORT ?? '4173';
const mockUrl = `http://127.0.0.1:${mockPort}`;

export default defineConfig({
  webServer: {
    command: 'pnpm mocks:start',
    url: `${mockUrl}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  testDir: '.',
  testMatch: ['packages/extension/tests/**/*.spec.ts', 'bench/mock-sites/tests/**/*.spec.ts'],
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: { baseURL: mockUrl, headless: true, viewport: { width: 1280, height: 720 } },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
