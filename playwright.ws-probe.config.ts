import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './specs/webauthn',
  testMatch: ['ws-probe.spec.ts'],
  reporter: [['list']],
  use: { headless: true },
  timeout: 30000,
  projects: [{ name: 'chromium-ci', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
});
