/**
 * One-off E2E probe against the real `mdoc-test` Fly environment: registers a
 * fresh wallet-frontend user via a CDP virtual authenticator (no real
 * hardware), then drives vc-apigw's own /offers UI to request an mdl
 * credential and accept it in the wallet - the point being to observe
 * whether vc-apigw authorizes the PAR/token request via the wallet's
 * OAuth-Client-Attestation (WIA) alone, with no pre-registered client_id
 * ever involved, per apigw.trust.wallet_attestation being enabled for this
 * environment. Not meant to be added to CI - it targets one specific live
 * deployment, not the local docker-compose stack.
 *
 * Usage:
 *   FRONTEND_URL=https://sirosid-mdoc-test-wallet-frontend.fly.dev \
 *   APIGW_URL=https://sirosid-mdoc-test-vc-apigw.fly.dev \
 *   npx playwright test specs/webauthn/mdoc-test-attestation.spec.ts \
 *     --config=playwright.webauthn-ci.config.ts --headed=false
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { WebAuthnHelper } from '../../helpers/webauthn';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sirosid-mdoc-test-wallet-frontend.fly.dev';
const APIGW_URL = process.env.APIGW_URL || 'https://sirosid-mdoc-test-vc-apigw.fly.dev';

function generateTestId(): string {
  return Math.random().toString(36).slice(2, 8);
}

interface WebAuthnTestFixtures {
  webauthn: WebAuthnHelper;
}

const webauthnTest = test.extend<WebAuthnTestFixtures>({
  webauthn: async ({ page }, use) => {
    const webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();
    await use(webauthn);
    await webauthn.cleanup();
  },
});

async function registerUserViaUI(
  page: Page,
  username: string
): Promise<{ success: boolean; error?: string }> {
  page.on('console', (msg) => console.log('BROWSER_CONSOLE', msg.type(), msg.text()));
  page.on('requestfailed', (req) => console.log('REQUEST_FAILED', req.url(), req.failure()?.errorText));
  page.on('pageerror', (err) => console.log('PAGE_ERROR', String(err)));
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('register-webauthn') || u.includes('/user/') || u.includes('/auth/')) {
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      console.log('RESPONSE', res.status(), u, body);
    }
  });

  const loginUrl = `${FRONTEND_URL}/id/default/login`;
  await page.goto(loginUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  let finishResponse: any = null;
  let apiError: string | undefined;
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('passkey/register/finish')) {
      try {
        const data = await response.json();
        if (response.status() === 200) finishResponse = data;
        else apiError = data.error || `HTTP ${response.status()}`;
      } catch {
        /* ignore */
      }
    } else if (url.includes('passkey/register/begin') && !response.ok()) {
      try {
        const data = await response.json();
        apiError = data.error || `Begin failed: HTTP ${response.status()}`;
      } catch {
        apiError = `Begin failed: HTTP ${response.status()}`;
      }
    }
  });

  const signUpSwitch = page.locator('#signUp-switch-loginsignup');
  if (await signUpSwitch.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signUpSwitch.click();
    await page.waitForTimeout(500);
  }

  const nameInput = page.locator('input[name="name"]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(username);

  const WEBAUTHN_TIMEOUT = 15000;
  try {
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('passkey/register/finish'),
      { timeout: WEBAUTHN_TIMEOUT }
    );
    const visibleButton = page.locator('[id*="signUpPasskey"][id*="submit"]').first();
    await expect(visibleButton).toBeVisible({ timeout: 10000 });
    await visibleButton.click();

    await page.waitForTimeout(2000);
    const continueButton = page.locator('button:has-text("Continue")');
    if (await continueButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await continueButton.click();
    }
    await responsePromise;
  } catch (error) {
    return { success: false, error: apiError || String(error) };
  }

  if (apiError) return { success: false, error: apiError };
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  if (finishResponse || !currentUrl.includes('/login')) return { success: true };
  return { success: false, error: 'did not navigate away from login page' };
}

webauthnTest.describe('mdoc-test attestation-only issuance probe', () => {
  webauthnTest('register, request mdl offer, observe attestation-based auth', async ({ page, webauthn }) => {
    const username = `user-${generateTestId()}`;

    const reg = await registerUserViaUI(page, username);
    console.log('REGISTER_RESULT', JSON.stringify(reg));
    expect(reg.success, `registration failed: ${reg.error}`).toBe(true);

    // Broad network trace for the offer-acceptance phase, to see whether
    // /v1/resolve (AS metadata) and /op/par actually get called at all.
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/v1/resolve') || u.includes('/v1/evaluate') || u.includes('/op/par') || u.includes('/authorize') || u.includes('/wallet-provider')) {
        console.log('REQ', r.method(), u, JSON.stringify(r.postData()?.slice(0, 300)));
      }
    });
    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/v1/resolve') || u.includes('/v1/evaluate') || u.includes('/op/par') || u.includes('/wallet-provider')) {
        let body = '';
        try { body = (await res.text()).slice(0, 800); } catch { /* ignore */ }
        console.log('RESP', res.status(), u, body);
      }
    });

    // Drive vc-apigw's own /offers UI to build a credential offer.
    await page.goto(`${APIGW_URL}/offers`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const credentialSelect = page.locator('select#credential');
    await expect(credentialSelect).toBeVisible({ timeout: 10000 });
    const credOptions = await credentialSelect.locator('option').allTextContents();
    const credValues = await credentialSelect.locator('option').evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value)
    );
    console.log('CREDENTIAL_OPTIONS', JSON.stringify(credOptions), JSON.stringify(credValues));

    // mdl is mso_mdoc-format and vc-apigw's /offers UI has its own unrelated
    // bug there ("scope is an mso_mdoc credential (no VCTM)") - beside the
    // point of this probe (attestation-based auth, not mdoc specifically),
    // so use an SD-JWT/VCTM-backed scope instead to get past offer creation.
    // siros_id specifically fails later with "credential type 'siros_id' has
    // no data source configured" - a pre-existing, unrelated issuer-side
    // config gap - so diploma is used instead to keep this probe scoped to
    // attestation-based auth.
    const credIdx = credOptions.findIndex((t) => /diploma/i.test(t));
    expect(credIdx, `no Diploma option found among ${JSON.stringify(credOptions)}`).toBeGreaterThanOrEqual(0);
    await credentialSelect.selectOption(credValues[credIdx]);

    const walletRadios = page.locator('input[type="radio"][name="wallet"]');
    const walletCount = await walletRadios.count();
    const walletValues: string[] = [];
    for (let i = 0; i < walletCount; i++) {
      walletValues.push(await walletRadios.nth(i).getAttribute('value') || '');
    }
    console.log('WALLET_OPTIONS', JSON.stringify(walletValues));

    const localIdx = walletValues.findIndex((v) => /local|web/i.test(v));
    const chosenIdx = localIdx >= 0 ? localIdx : 0;
    await walletRadios.nth(chosenIdx).check();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const submitBtn = page.getByRole('button', { name: 'Submit' });
    await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
    await submitBtn.click({ timeout: 15000 });
    await page.waitForTimeout(3000);

    console.log('AFTER_OFFER_SUBMIT_URL', page.url());
    await page.screenshot({ path: 'test-results/mdoc-test-attestation-after-offer.png', fullPage: true });
    const proceedBtn = page.getByRole('button', { name: 'Proceed' });
    if (await proceedBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await proceedBtn.click({ timeout: 15000 });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
    }

    // Follow through if it landed on wallet-frontend for acceptance.
    if (page.url().includes(new URL(FRONTEND_URL).host)) {
      await page.waitForTimeout(12000);
      await page.screenshot({ path: 'test-results/mdoc-test-attestation-frontend.png', fullPage: true });
      console.log('FRONTEND_LANDING_URL', page.url());
      console.log('FRONTEND_BODY_TEXT', (await page.locator('body').innerText().catch(() => '')).slice(0, 1000));

      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("Add"), button:has-text("Continue")').first();
      if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await acceptBtn.click();
        await page.waitForTimeout(4000);
        await page.screenshot({ path: 'test-results/mdoc-test-attestation-final.png', fullPage: true });
        console.log('FINAL_URL', page.url());
      }
    }
  });
});
