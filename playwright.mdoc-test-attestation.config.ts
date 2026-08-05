import { defineConfig, devices } from '@playwright/test';

// One-off config for specs/webauthn/mdoc-test-attestation.spec.ts - see that
// file's header comment. Mirrors playwright.webauthn-ci.config.ts's browser
// setup (CDP virtual authenticator needs real Chrome, not headless_shell)
// without inheriting its hardcoded testMatch restriction.
export default defineConfig({
  testDir: './specs/webauthn',
  testMatch: ['mdoc-test-attestation.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },
  timeout: 90000,
  expect: { timeout: 15000 },
  projects: [
    {
      name: 'chromium-ci',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-experimental-web-platform-features',
            '--enable-blink-features=WebAuthenticationExtendedInfoMetrics',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],
  outputDir: 'test-results-ci',
});
