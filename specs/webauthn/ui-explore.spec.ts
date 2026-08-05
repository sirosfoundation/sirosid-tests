import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { WebAuthnHelper } from '../../helpers/webauthn';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sirosid-mdoc-test-wallet-frontend.fly.dev';

const webauthnTest = test.extend<{ webauthn: WebAuthnHelper }>({
  webauthn: async ({ page }, use) => {
    const webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
    await use(webauthn);
    await webauthn.cleanup();
  },
});

async function registerUserViaUI(page: Page, username: string) {
  const loginUrl = `${FRONTEND_URL}/id/default/login`;
  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signUpSwitch.click();
    await page.waitForTimeout(500);
  }
  const nameInput = page.locator('input[name="name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(username);

  const responsePromise = page.waitForResponse((r) => r.url().includes('passkey/register/finish'), { timeout: 15000 });
  const visibleButton = page.locator('[id*="signUpPasskey"][id*="submit"]').first();
  await expect(visibleButton).toBeVisible({ timeout: 10000 });
  await visibleButton.click();
  await page.waitForTimeout(1500);
  const continueButton = page.locator('button:has-text("Continue")');
  if (await continueButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await continueButton.click();
  }
  await responsePromise;
  await page.waitForTimeout(1500);
}

webauthnTest('explore Add Credentials UI', async ({ page, webauthn }) => {
  page.on('console', (msg) => console.log('CONSOLE', msg.type(), msg.text()));

  await registerUserViaUI(page, `explore-${Math.random().toString(36).slice(2, 8)}`);
  console.log('AFTER_REGISTER_URL', page.url());

  // Dismiss onboarding tour modal if present.
  const dismissBtn = page.locator('button:has-text("Dismiss")');
  if (await dismissBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await dismissBtn.click();
    await page.waitForTimeout(500);
  }

  await page.screenshot({ path: 'test-results/explore-01-dashboard.png', fullPage: true });

  // Click "Add Credentials" (sidebar or main button).
  const addBtn = page.locator('text=Add Credentials').or(page.locator('text=Add New Credential')).first();
  await addBtn.waitFor({ state: 'visible', timeout: 10000 });
  await addBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/explore-02-add-credentials.png', fullPage: true });
  console.log('ADD_CREDENTIALS_URL', page.url());
  console.log('ADD_CREDENTIALS_BODY', (await page.locator('body').innerText()).slice(0, 1500));
});
