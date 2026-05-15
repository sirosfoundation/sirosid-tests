/**
 * OpenID4VCI Wallet Conformance Tests
 *
 * @tags @conformance @oid4vci @wallet
 *
 * Runs the OpenID Foundation Conformance Suite OID4VCI wallet test plan.
 * The conformance suite acts as an issuer and the wallet must accept
 * credential offers.
 *
 * Prerequisites:
 *   - Conformance suite running: cd sirosid-dev && make up-conformance
 *   - Wallet stack running with allow-all trust: make up-vc-go-trust-allow
 *   - /etc/hosts entry: 127.0.0.1 localhost.emobix.co.uk
 *
 * Run:
 *   cd sirosid-tests && make test-conformance-vci
 */

import { test, expect } from '../../helpers/tenant-setup-fixture';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ConformanceAPI, type TestState } from '../../helpers/conformance-api';
import { acceptCredentialOffer } from '../../helpers/wallet-automation';
import { loginUserViaUI } from '../../helpers/ui-actions';
import { ENV } from '../../helpers/shared-helpers';
import { WebAuthnHelper } from '../../helpers/webauthn';

// =============================================================================
// Configuration
// =============================================================================

const CONFORMANCE_URL = process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/';
const FRONTEND_URL = ENV.FRONTEND_URL;

/** OID4VCI test plan variants to run */
const VCI_VARIANTS = [
  {
    name: 'sd_jwt_vc / pre-authorized_code / immediate / by_value',
    variant: {
      credential_format: 'sd_jwt_vc',
      vci_grant_type: 'pre_authorization_code',
      vci_credential_issuance_mode: 'immediate',
      vci_credential_offer_variant: 'by_value',
      sender_constrain: 'dpop',
      vci_credential_encryption: 'plain',
      fapi_profile: 'vci',
      fapi_request_method: 'unsigned',
      client_auth_type: 'private_key_jwt',
      authorization_request_type: 'simple',
      vci_authorization_code_flow_variant: 'issuer_initiated',
    },
  },
];

/** Test plan to use */
const VCI_PLAN_NAME = 'oid4vci-1_0-wallet-test-plan';

/** Config file path */
const VCI_CONFIG_PATH = path.resolve(__dirname, '../../configs/conformance/vci-wallet-config.json');

// =============================================================================
// Tests
// =============================================================================

test.describe('OID4VCI Wallet Conformance Suite', () => {
  const api = new ConformanceAPI(CONFORMANCE_URL);
  let conformanceReady: boolean;

  test.beforeAll(async () => {
    try {
      await api.waitForServerReady(30000);
      conformanceReady = true;
    } catch (error) {
      console.log('Conformance suite not available:', (error as Error).message);
      console.log('Start with: cd sirosid-dev && make up-conformance');
      conformanceReady = false;
    }
  });

  test.beforeEach(async () => {
    if (!conformanceReady) {
      test.skip(true, 'Conformance suite not available');
      return;
    }
  });

  // ===========================================================================
  // VCI Conformance Tests
  // ===========================================================================

  test.describe('VCI Conformance Tests', () => {
    test.beforeEach(async ({ tenantContext }) => {
      if (!tenantContext.ready) {
        test.skip(true, tenantContext.error || 'Tenant setup failed');
        return;
      }
    });

    // =========================================================================
    // Run each variant
    // =========================================================================

    for (const variantConfig of VCI_VARIANTS) {
      test.describe(`Variant: ${variantConfig.name}`, () => {
        let planId: string;
        let planModules: string[];

        test.beforeAll(async () => {
          if (!conformanceReady) return;

          const configJson = fs.readFileSync(VCI_CONFIG_PATH, 'utf-8');

          const plan = await api.createTestPlan(
            VCI_PLAN_NAME,
            configJson,
            variantConfig.variant
          );
          planId = plan.id;
          planModules = plan.modules.map((m) => m.testModule);

          console.log(`Created plan ${planId} with ${planModules.length} modules:`);
          planModules.forEach((m) => console.log(`  - ${m}`));
        });

        test('should have created a test plan', () => {
          expect(planId).toBeDefined();
          expect(planModules.length).toBeGreaterThan(0);
        });

        test('should pass all VCI conformance modules', async ({ page, tenantContext }) => {
          test.setTimeout(300000); // 5 minute timeout for all modules

          expect(planId).toBeDefined();
          expect(planModules.length).toBeGreaterThan(0);

          // Register the conformance suite issuer for this tenant so the wallet uses the correct client_id
          const configJson = JSON.parse(fs.readFileSync(VCI_CONFIG_PATH, 'utf-8'));
          const conformanceClientId = configJson.client?.client_id || 'siros-wallet-test';
          const conformanceIssuerUrl = CONFORMANCE_URL.replace(/\/$/, '') + '/test/a/' + (configJson.alias || 'siros-wallet-vci-test') + '/';

          // Extract the client private key JWK for private_key_jwt authentication
          // Check client.private_key first (separate from client.jwks which has public keys only),
          // then fall back to finding a key with 'd' parameter in client.jwks.keys
          const clientKeyWithPrivate = configJson.client?.private_key ||
            configJson.client?.jwks?.keys?.find((k: any) => k.d);
          const clientPrivateKeyJwk = clientKeyWithPrivate ? JSON.stringify(clientKeyWithPrivate) : null;

          const issuerResp = await fetch(`${ENV.ADMIN_URL}/admin/tenants/${tenantContext.tenantId}/issuers`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ENV.ADMIN_TOKEN}`,
            },
            body: JSON.stringify({
              credential_issuer_identifier: conformanceIssuerUrl,
              client_id: conformanceClientId,
              client_jwk: clientPrivateKeyJwk,
              visible: true,
            }),
          });
          console.log(`Registered conformance issuer for tenant: ${issuerResp.status} (client_id=${conformanceClientId}, has_jwk=${!!clientPrivateKeyJwk})`);

          // Set up CDP virtual authenticator for headless WebAuthn
          const webauthn = new WebAuthnHelper(page);
          await webauthn.initialize();
          await webauthn.injectPrfMock();
          await webauthn.addPlatformAuthenticator();

          // Inject credentials from registration so login works
          if (tenantContext.credentials) {
            for (const cred of tenantContext.credentials) {
              await webauthn.addCredential(cred);
            }
          }

          // Login the user
          const loginResult = await loginUserViaUI(page, { tenantId: tenantContext.tenantId });
          expect(loginResult.success).toBe(true);

          // Wait for the wallet to fully initialize after login
          // The frontend needs time to process the login response, open keystore, and navigate
          await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(3000);
          
          // Verify we're on the home/credentials page (not login)
          const afterLoginUrl = page.url();
          console.log(`After login URL: ${afterLoginUrl}`);
          if (afterLoginUrl.includes('/login')) {
            // Login didn't complete at the frontend level
            console.log('WARNING: Still on login page. Checking PRF retry...');
            const continueBtn = page.locator('button:has-text("Continue")');
            if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log('PRF retry dialog found, clicking Continue...');
              await continueBtn.click();
              await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
              await page.waitForTimeout(2000);
            }
          }
          console.log(`Final URL after login: ${page.url()}`);

          // Dismiss "Welcome to wwWallet!" tour if it appears after login
          const welcomeDismiss = page.locator('button:has-text("Dismiss")');
          if (await welcomeDismiss.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('Dismissing Welcome tour after initial login...');
            await welcomeDismiss.click();
            await page.waitForTimeout(1000);
          }

          // Forward browser console to test output
          page.on('console', msg => {
            const text = msg.text();
            const type = msg.type();
            if (type === 'error' || type === 'warning') {
              console.log(`[BROWSER ${type.toUpperCase()}] ${text.substring(0, 500)}`);
            } else if (text.includes('Schema validation failed')) {
              console.log(`[BROWSER] ${text.substring(0, 2000)}`);
            } else if (text.includes('Uri Handler') || text.includes('credential') || text.includes('Generating') || text.includes('syncing') || text.includes('Sync') || text.includes('Actually') || text.includes('token') || text.includes('Token') || text.includes('request') || text.includes('Request') || text.includes('error') || text.includes('Error') || text.includes('DPoP') || text.includes('dpop') || text.includes('grant') || text.includes('pre-authorized') || text.includes('issuer')) {
              console.log(`[BROWSER] ${text.substring(0, 500)}`);
            }
          });
          page.on('pageerror', err => {
            console.log(`[PAGE ERROR] ${err.message.substring(0, 500)}`);
          });

          // Register dialog handler once before the module loop
          page.on('dialog', async (dialog) => {
            console.log(`[Dialog] ${dialog.type()}: ${dialog.message()}`);
            if (dialog.type() === 'prompt') {
              await dialog.accept('123456');
            } else {
              await dialog.accept();
            }
          });

          // Log proxy requests/responses to see token/credential exchanges
          page.on('request', async (request) => {
            const url = request.url();
            if (url.includes('/proxy') && request.method() === 'POST') {
              try {
                const postData = request.postData();
                if (postData) {
                  const parsed = JSON.parse(postData);
                  console.log(`[PROXY REQ] ${parsed.method || 'GET'} ${parsed.url?.substring(0, 120)}`);
                  if (parsed.headers) {
                    const hdrs = Object.entries(parsed.headers).map(([k, v]) => `${k}: ${String(v).substring(0, 80)}`).join(', ');
                    console.log(`[PROXY REQ HEADERS] ${hdrs}`);
                  }
                  if (parsed.data) {
                    console.log(`[PROXY REQ BODY] ${typeof parsed.data === 'string' ? parsed.data.substring(0, 500) : JSON.stringify(parsed.data).substring(0, 500)}`);
                  }
                }
              } catch { /* */ }
            }
          });
          page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/proxy')) {
              try {
                const body = await response.text();
                const parsed = JSON.parse(body);
                if (parsed.status && parsed.status >= 400) {
                  console.log(`[PROXY ERROR ${parsed.status}] ${JSON.stringify(parsed.data).substring(0, 1000)}`);
                  console.log(`[PROXY ERROR HEADERS] ${JSON.stringify(parsed.headers).substring(0, 500)}`);
                } else {
                  console.log(`[PROXY ${parsed.status || response.status()}] data keys: ${parsed.data ? Object.keys(parsed.data).join(',') : 'none'}`);
                }
              } catch { /* response body may not be available */ }
            }
          });

          const results: Array<{
            module: string;
            status: string;
            result: string;
            passed: boolean;
          }> = [];

          for (const moduleName of planModules) {
            console.log(`\n=== Running module: ${moduleName} ===`);

            const moduleInfo = await api.createTestFromPlan(planId, moduleName);
            const moduleId = moduleInfo.id;
            console.log(`Module ${moduleName} created: ${moduleId}`);

            // Wait for WAITING state
            let state: TestState;
            try {
              state = await api.waitForState(moduleId, ['WAITING', 'FINISHED'], 60000);
            } catch (error) {
              console.log(`Module ${moduleName} failed to reach WAITING: ${(error as Error).message}`);
              results.push({
                module: moduleName,
                status: 'ERROR',
                result: 'TIMEOUT',
                passed: false,
              });
              continue;
            }

            if (state === 'FINISHED') {
              const info = await api.getModuleInfo(moduleId);
              console.log(`Module ${moduleName} finished immediately: ${info.result}`);
              results.push({
                module: moduleName,
                status: info.status,
                result: info.result,
                passed: info.result === 'PASSED',
              });
              continue;
            }

            // Module is WAITING - get the credential offer URL
            const interactionUrl = await api.getWalletInteractionUrl(moduleId);
            if (!interactionUrl) {
              const browserUrl = await api.getBrowserInteractionUrl(moduleId);
              if (!browserUrl) {
                console.log(`Module ${moduleName}: no interaction URL found`);
                results.push({
                  module: moduleName,
                  status: 'ERROR',
                  result: 'NO_URL',
                  passed: false,
                });
                continue;
              }
              console.log(`Module ${moduleName}: using browser URL: ${browserUrl}`);
              await page.goto(browserUrl, { waitUntil: 'networkidle', timeout: 15000 });
            } else {
              // Drive the wallet to accept the credential offer
              console.log(`Module ${moduleName}: accepting offer via ${interactionUrl.slice(0, 80)}...`);

              // Extract credential_offer params from the openid-credential-offer:// URL
              const offerParams = interactionUrl.replace('openid-credential-offer://?', '');

              // SPA navigation: pushState to the current tenant path with credential_offer params.
              // The UriHandlerProvider watches useLocation() for credential_offer params
              // and navigates to /cb when detected. This preserves the in-memory keystore.
              const tenantBasePath = `/id/${tenantContext.tenantId}/`;
              console.log(`Module ${moduleName}: injecting credential offer via SPA pushState...`);
              await page.evaluate(({ basePath, params }) => {
                window.history.pushState(null, '', `${basePath}?${params}`);
                window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
              }, { basePath: tenantBasePath, params: offerParams });

              // Wait for the UriHandlerProvider to detect the offer and navigate to /cb
              let spaNavigationWorked = false;
              try {
                await page.waitForURL((url) => url.pathname.includes('/cb'), { timeout: 10000 });
                spaNavigationWorked = true;
                console.log(`Module ${moduleName}: SPA navigation to /cb succeeded: ${page.url().slice(0, 100)}`);
              } catch {
                console.log(`Module ${moduleName}: SPA navigation to /cb timed out, trying full navigation...`);
              }

              if (!spaNavigationWorked) {
                // Fallback: full page navigation (loses keystore, requires re-login)
                const cbUrl = `${FRONTEND_URL}/id/${tenantContext.tenantId}/cb?${offerParams}`;
                await page.goto(cbUrl, { waitUntil: 'networkidle', timeout: 30000 });
                await page.waitForTimeout(2000);

                // Re-login with WebAuthn after session loss
                const loginBtn = page.locator('button:has-text("Log in with a Passkey")');
                if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                  console.log(`Module ${moduleName}: re-logging in after redirect...`);
                  await loginBtn.click();
                  await page.waitForTimeout(5000);
                }
              }

              // Handle UI popups during credential processing
              // 1. Dismiss "Welcome to wwWallet!" tour if it appears
              const dismissBtn = page.locator('button:has-text("Dismiss")');
              if (await dismissBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                console.log(`Module ${moduleName}: dismissing Welcome tour...`);
                await dismissBtn.click();
                await page.waitForTimeout(1000);
              }

              // 2. Handle "Transaction Code Required" popup if it appears
              const txCodeInput = page.locator('input[placeholder*="character code"]');
              const txSubmitBtn = page.locator('button:has-text("Submit")');
              // Wait for the TX code dialog or credential processing to complete
              try {
                await txCodeInput.waitFor({ state: 'visible', timeout: 15000 });
                console.log(`Module ${moduleName}: filling TX code 123456...`);
                await txCodeInput.fill('123456');
                await txSubmitBtn.click();
                console.log(`Module ${moduleName}: TX code submitted`);
              } catch {
                console.log(`Module ${moduleName}: no TX code popup appeared`);
              }

              // Wait for credential processing to complete
              await page.waitForTimeout(15000);
            }

            // Wait for the module to finish
            try {
              await api.waitForState(moduleId, ['FINISHED'], 60000);
            } catch {
              console.log(`Module ${moduleName} did not finish in time`);
            }

            const finalInfo = await api.getModuleInfo(moduleId);
            console.log(`Module ${moduleName} result: ${finalInfo.result}`);

            results.push({
              module: moduleName,
              status: finalInfo.status,
              result: finalInfo.result,
              passed: finalInfo.result === 'PASSED',
            });

            // Navigate back to wallet home between modules
            await page.goto(`${FRONTEND_URL}/`, { waitUntil: 'networkidle', timeout: 10000 });
            await page.waitForTimeout(1000);
          }

          // Report results
          console.log('\n=== Conformance Test Results ===');
          const passed = results.filter((r) => r.passed);
          const failed = results.filter((r) => !r.passed);

          console.log(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

          if (failed.length > 0) {
            console.log('\nFailed modules:');
            failed.forEach((r) =>
              console.log(`  ✗ ${r.module}: ${r.result} (${r.status})`)
            );
          }

          if (passed.length > 0) {
            console.log('\nPassed modules:');
            passed.forEach((r) => console.log(`  ✓ ${r.module}`));
          }

          console.log(`\nFull results: ${api.getPlanDetailUrl(planId)}`);

          expect(failed.length, `${failed.length} modules failed: ${failed.map((r) => r.module).join(', ')}`).toBe(0);
        });
      });
    }
  });
});
