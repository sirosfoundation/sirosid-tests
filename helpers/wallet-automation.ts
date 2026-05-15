/**
 * Wallet automation helpers for OpenID conformance suite tests.
 *
 * Provides functions to drive the wallet UI through credential offer acceptance
 * and credential presentation flows triggered by the conformance suite.
 *
 * @module helpers/wallet-automation
 */

import { Page, expect } from '@playwright/test';
import {
  CREDENTIAL_TYPES,
  type CredentialType,
  createCredentialOffer,
  buildWalletOfferUrl,
  checkVCServicesHealth,
} from './vc-services';
import { ENV } from './shared-helpers';

const FRONTEND_URL = process.env.WALLET_FRONTEND_URL || ENV.FRONTEND_URL;

// =============================================================================
// Credential Pre-loading (setup for VP tests)
// =============================================================================

/**
 * Issue a credential from the mock issuer and load it into the wallet.
 *
 * This creates a credential offer via the VC API Gateway, then navigates
 * the wallet to accept it. The wallet must be logged in before calling this.
 *
 * @param page - Playwright page (must be logged in to the wallet)
 * @param credentialType - Type of credential to issue (default: PID_1_8)
 * @param options - Additional options
 * @returns Whether the credential was successfully loaded
 */
export async function issueCredentialToWallet(
  page: Page,
  credentialType: CredentialType = CREDENTIAL_TYPES.PID_1_8,
  options: {
    walletId?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  const { walletId = 'local', timeoutMs = 30000 } = options;

  try {
    // 1. Create a credential offer via the API Gateway
    const userId = `conf-setup-${Date.now()}`;
    console.log(`[WalletAutomation] Creating ${credentialType} offer for wallet setup...`);

    const offer = await createCredentialOffer(credentialType, userId, { walletId });
    if (!offer.credential_offer_uri) {
      return { success: false, error: 'No credential_offer_uri in response' };
    }

    console.log(`[WalletAutomation] Offer created: ${offer.credential_offer_uri.slice(0, 80)}...`);

    // 2. Build the wallet URL and navigate to it
    const walletUrl = buildWalletOfferUrl(FRONTEND_URL, offer.credential_offer_uri);
    console.log(`[WalletAutomation] Navigating wallet to accept offer...`);

    await page.goto(walletUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForTimeout(3000);

    // 3. The wallet processes pre-authorized code offers automatically.
    //    Wait for the credential to be stored.
    //    Look for success indicators or the credential in the wallet.

    // Handle transaction code popup if it appears
    const txCodeInput = page.locator('input[type="text"], input[type="number"]');
    if (await txCodeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Our mock issuer typically doesn't require a tx_code, but handle it
      console.log('[WalletAutomation] Transaction code popup detected (unexpected for mock issuer)');
      return { success: false, error: 'Unexpected transaction code popup from mock issuer' };
    }

    // Wait for the credential to appear - the wallet navigates to the credential
    // page or shows a success notification after accepting the offer
    await page.waitForTimeout(5000);

    // Check for any error popups or messages
    const errorElement = page.locator('[class*="error" i], [role="alert"]').first();
    const errorText = await errorElement.textContent({ timeout: 2000 }).catch(() => null);
    if (errorText && errorText.toLowerCase().includes('error')) {
      return { success: false, error: `Wallet error during issuance: ${errorText}` };
    }

    // Navigate to wallet home to verify credential exists
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(2000);

    console.log(`[WalletAutomation] Credential offer accepted successfully`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: `Credential issuance failed: ${error.message}` };
  }
}

/**
 * Check if VC services (mock issuer) are available for credential pre-loading.
 */
export async function isVCServicesAvailable(): Promise<boolean> {
  const health = await checkVCServicesHealth();
  return health.issuer && health.apigw;
}

// =============================================================================
// Credential Offer Acceptance (OID4VCI)
// =============================================================================

/**
 * Accept a credential offer by navigating the wallet to the offer URI.
 *
 * The conformance suite provides a credential_offer or credential_offer_uri
 * that the wallet processes. The wallet-frontend handles this automatically
 * for pre-authorized code flows (no user interaction needed beyond login).
 *
 * For authorization code flows, the wallet redirects to the issuer's
 * authorization endpoint and returns to /cb?code=... to complete issuance.
 *
 * @param page - Playwright page (must be logged in)
 * @param offerUrl - The credential offer URL from the conformance suite
 * @param options - Additional options
 * @returns Whether the credential was successfully accepted
 */
export async function acceptCredentialOffer(
  page: Page,
  offerUrl: string,
  options: {
    txCode?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  const { txCode, timeoutMs = 30000 } = options;

  try {
    // Convert the offer URL to a wallet callback URL
    const walletUrl = convertToWalletCallbackUrl(offerUrl);
    console.log(`[WalletAutomation] Navigating to credential offer: ${walletUrl.slice(0, 100)}...`);

    // Navigate to the offer
    await page.goto(walletUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForTimeout(2000);

    // Handle transaction code popup if required
    if (txCode) {
      const txCodeInput = page.locator('input[type="text"], input[type="number"]');
      if (await txCodeInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await txCodeInput.fill(txCode);
        const submitButton = page.locator('button:has-text("Submit"), button:has-text("Send")');
        if (await submitButton.isVisible({ timeout: 2000 })) {
          await submitButton.click();
        }
      }
    }

    // Wait for credential to appear in wallet (check for success indicators)
    // The wallet processes credential offers automatically and shows a success
    // toast or navigates to the credentials page
    await page.waitForTimeout(5000);

    // Check for error messages
    const errorElement = page.locator('[class*="error"], [class*="Error"], [role="alert"]').first();
    const errorText = await errorElement.textContent({ timeout: 2000 }).catch(() => null);
    if (errorText && errorText.toLowerCase().includes('error')) {
      return { success: false, error: errorText };
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// =============================================================================
// Credential Presentation (OID4VP)
// =============================================================================

/**
 * Present a credential by navigating the wallet to the VP request URI.
 *
 * The conformance suite provides a URL with client_id and request_uri params.
 * The wallet shows a SelectCredentialsPopup with three steps:
 *   1. Preview (shows verifier info) → click "Next"
 *   2. Select credential → click credential card, then "Next"
 *   3. Summary → click "Send"
 *
 * @param page - Playwright page (must be logged in with a credential)
 * @param requestUrl - The VP request URL from the conformance suite
 * @param options - Additional options
 * @returns Whether the presentation was successfully sent
 */
export async function presentCredential(
  page: Page,
  requestUrl: string,
  options: {
    credentialIndex?: number;
    timeoutMs?: number;
    tenantId?: string;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  const { credentialIndex = 0, timeoutMs = 30000, tenantId } = options;

  try {
    // Convert to wallet callback URL
    const walletUrl = convertToWalletCallbackUrl(requestUrl, tenantId);
    console.log(`[WalletAutomation] Navigating to VP request: ${walletUrl.slice(0, 100)}...`);

    // Navigate to the VP request
    await page.goto(walletUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForTimeout(5000);

    // Check for "Insufficient Credentials" error
    const insufficientError = page.locator('text=Insufficient Credentials');
    if (await insufficientError.isVisible({ timeout: 3000 }).catch(() => false)) {
      return { success: false, error: 'Insufficient Credentials - no matching credential in wallet' };
    }

    // Check for "Non-Trusted Verifier" error
    const nonTrustedError = page.locator('text=Non-Trusted Verifier');
    if (await nonTrustedError.isVisible({ timeout: 2000 }).catch(() => false)) {
      return { success: false, error: 'Non-Trusted Verifier - verifier not trusted' };
    }

    // Step 1: Preview screen → click "Next"
    const nextButton = page.locator('#next-select-credentials');
    await expect(nextButton).toBeVisible({ timeout: 10000 });
    await nextButton.click();
    await page.waitForTimeout(1000);

    // Step 2: Select credential → click credential card, then "Next"
    // Try to click the credential card by index
    const credentialCards = page.locator('[id^="slider-select-credentials-"]');
    const cardCount = await credentialCards.count();
    if (cardCount === 0) {
      return { success: false, error: 'No credential cards found in presentation popup' };
    }

    const targetIndex = Math.min(credentialIndex, cardCount - 1);
    await credentialCards.nth(targetIndex).click();
    await page.waitForTimeout(500);

    // Click "Next" again
    await expect(nextButton).toBeVisible({ timeout: 5000 });
    await nextButton.click();
    await page.waitForTimeout(1000);

    // Step 3: Summary → click "Send"
    const sendButton = page.locator('#send-select-credentials');
    await expect(sendButton).toBeVisible({ timeout: 5000 });
    await sendButton.click();

    // Handle consent popup if it appears
    const consentButton = page.locator('#consent');
    if (await consentButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await consentButton.click();
    }

    // Wait for presentation to complete
    await page.waitForTimeout(3000);

    // Check for error after sending
    const errorAfterSend = page.locator('[class*="error"], [class*="Error"]').first();
    const errorTextAfterSend = await errorAfterSend.textContent({ timeout: 2000 }).catch(() => null);
    if (errorTextAfterSend && errorTextAfterSend.toLowerCase().includes('error')) {
      return { success: false, error: errorTextAfterSend };
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// =============================================================================
// URL Helpers
// =============================================================================

/**
 * Convert a conformance suite URL into a wallet /cb callback URL.
 *
 * The wallet frontend handles:
 * - /cb?credential_offer=...
 * - /cb?credential_offer_uri=...
 * - /cb?client_id=...&request_uri=...
 *
 * The conformance suite may provide:
 * - openid-credential-offer://?credential_offer=...
 * - https://...?credential_offer_uri=...
 * - A URL with client_id and request_uri params
 */
export function convertToWalletCallbackUrl(url: string, tenantId?: string): string {
  const base = tenantId ? `${FRONTEND_URL}/id/${tenantId}` : FRONTEND_URL;

  // If it's already a wallet URL, return as-is
  if (url.startsWith(FRONTEND_URL)) {
    return url;
  }

  // Handle openid-credential-offer:// scheme
  if (url.startsWith('openid-credential-offer://')) {
    const params = url.replace('openid-credential-offer://?', '');
    return `${base}/cb?${params}`;
  }

  // Handle openid4vp:// scheme
  if (url.startsWith('openid4vp://')) {
    const params = url.replace('openid4vp://?', '');
    return `${base}/cb?${params}`;
  }

  // For https:// URLs from the conformance suite, extract the query params
  // and redirect through the wallet's /cb endpoint
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    // Credential offer
    if (params.has('credential_offer') || params.has('credential_offer_uri')) {
      return `${base}/cb?${params.toString()}`;
    }

    // VP request
    if (params.has('client_id') && params.has('request_uri')) {
      return `${base}/cb?${params.toString()}`;
    }

    // Fallback: just redirect the full URL through /cb
    return `${base}/cb?${params.toString()}`;
  } catch {
    // If URL parsing fails, try to use it as-is
    return url;
  }
}
