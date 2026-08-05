import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './specs/webauthn',
  testMatch: ['ui-explore.spec.ts'],
  reporter: [['list']],
  use: { headless: true },
  timeout: 60000,
  projects: [{ name: 'chromium-ci', use: { ...devices['Desktop Chrome'], channel: 'chrome',
    launchOptions: { args: ['--enable-experimental-web-platform-features', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] } } }],
});
