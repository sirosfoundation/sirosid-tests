/**
 * OpenID4VP Wallet Conformance Tests
 *
 * @tags @conformance @oid4vp @wallet
 *
 * Runs the OpenID Foundation Conformance Suite OID4VP wallet test plan.
 * The conformance suite acts as a verifier and the wallet must respond
 * to authorization requests.
 *
 * Prerequisites:
 *   - Conformance suite running: cd sirosid-dev && make up-conformance
 *   - Wallet stack running with allow-all trust: make up-vc-go-trust-allow
 *   - /etc/hosts entry: 127.0.0.1 localhost.emobix.co.uk
 *   - A credential must be pre-loaded in the wallet for VP tests
 *
 * Run:
 *   cd sirosid-tests && make test-conformance-vp
 */

import { test, expect } from '../../helpers/tenant-setup-fixture';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ConformanceAPI, type TestState } from '../../helpers/conformance-api';
import { presentCredential, convertToWalletCallbackUrl, issueCredentialToWallet, isVCServicesAvailable } from '../../helpers/wallet-automation';
import { loginUserViaUI } from '../../helpers/ui-actions';
import { ENV } from '../../helpers/shared-helpers';
import { isSoftFidoAvailable } from '../../helpers/softfido';
import { CREDENTIAL_TYPES } from '../../helpers/vc-services';

// =============================================================================
// Configuration
// =============================================================================

const CONFORMANCE_URL = process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/';
const FRONTEND_URL = ENV.FRONTEND_URL;

/** OID4VP test plan variants to run */
const VP_VARIANTS = [
  {
    name: 'sd_jwt_vc / x509_san_dns / direct_post / request_uri_signed',
    variant: {
      credential_format: 'sd_jwt_vc',
      client_id_prefix: 'x509_san_dns',
      response_mode: 'direct_post',
      request_method: 'request_uri_signed',
    },
  },
];

/** Test plan to use */
const VP_PLAN_NAME = 'oid4vp-1final-wallet-test-plan';

/** Config file path */
const VP_CONFIG_PATH = path.resolve(__dirname, '../../configs/conformance/vp-wallet-config.json');

// =============================================================================
// Tests
// =============================================================================

test.describe('OID4VP Wallet Conformance Suite', () => {
  const api = new ConformanceAPI(CONFORMANCE_URL);
  let softFidoAvailable: boolean;
  let conformanceReady: boolean;

  test.beforeAll(async () => {
    // Check soft-fido2 availability
    softFidoAvailable = isSoftFidoAvailable();
    if (!softFidoAvailable) {
      console.log('soft-fido2 not available, tests will be skipped');
      return;
    }

    // Check conformance suite availability
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
    if (!softFidoAvailable) {
      test.skip(true, 'soft-fido2 not available');
      return;
    }
    if (!conformanceReady) {
      test.skip(true, 'Conformance suite not available');
      return;
    }
  });

  // ===========================================================================
  // Setup: Login user and pre-load credential
  // ===========================================================================

  test.describe('VP Conformance Tests', () => {
    let credentialLoaded = false;

    test.beforeAll(async ({ browser, tenantContext }) => {
      if (!softFidoAvailable || !conformanceReady) return;
      if (!tenantContext.ready) return;

      // Check VC services availability for credential pre-loading
      const vcAvailable = await isVCServicesAvailable();
      if (!vcAvailable) {
        console.log('VC services not available - cannot pre-load credential for VP tests');
        console.log('Start VC services with: cd sirosid-dev && make up-conformance');
        return;
      }

      // Login and pre-load credential
      const page = await browser.newPage();
      try {
        const loginResult = await loginUserViaUI(page, { tenantId: tenantContext.tenantId });
        if (!loginResult.success) {
          console.log('Login failed for credential pre-loading:', loginResult.error);
          return;
        }

        // Pre-load a PID credential from the VC issuer
        console.log('Pre-loading PID credential from VC issuer...');
        const issueResult = await issueCredentialToWallet(page, CREDENTIAL_TYPES.PID_1_8);
        if (!issueResult.success) {
          console.log('Credential pre-loading failed:', issueResult.error);
          return;
        }
        credentialLoaded = true;
        console.log('PID credential successfully loaded into wallet');
      } finally {
        await page.close();
      }
    });

    test.beforeEach(async ({ tenantContext }) => {
      if (!tenantContext.ready) {
        test.skip(true, tenantContext.error || 'Tenant setup failed');
        return;
      }
    });

    // =========================================================================
    // Run each variant
    // =========================================================================

    for (const variantConfig of VP_VARIANTS) {
      test.describe(`Variant: ${variantConfig.name}`, () => {
        let planId: string;
        let planModules: string[];

        test.beforeAll(async () => {
          if (!conformanceReady) return;

          // Load config
          const configJson = fs.readFileSync(VP_CONFIG_PATH, 'utf-8');

          // Create test plan
          const plan = await api.createTestPlan(
            VP_PLAN_NAME,
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

        // Run each module as a separate test
        // Note: We don't know the exact module names at code time, so we
        // run a dynamic test that iterates over the plan modules.
        test('should pass all VP conformance modules', async ({ page, tenantContext }) => {
          test.setTimeout(300000); // 5 minute timeout for all modules

          expect(planId).toBeDefined();
          expect(planModules.length).toBeGreaterThan(0);

          if (!credentialLoaded) {
            test.skip(true, 'No credential pre-loaded - VC services may not be available');
            return;
          }

          // Login the user
          const loginResult = await loginUserViaUI(page, { tenantId: tenantContext.tenantId });
          expect(loginResult.success).toBe(true);

          const results: Array<{
            module: string;
            status: string;
            result: string;
            passed: boolean;
          }> = [];

          for (const moduleName of planModules) {
            console.log(`\n=== Running module: ${moduleName} ===`);

            // Create and start the test module
            const moduleInfo = await api.createTestFromPlan(planId, moduleName);
            const moduleId = moduleInfo.id;
            console.log(`Module ${moduleName} created: ${moduleId}`);

            // Wait for the module to reach WAITING state
            // (the conformance suite is waiting for the wallet to interact)
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
              // Module finished without needing wallet interaction
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

            // Module is WAITING - get the wallet interaction URL
            const interactionUrl = await api.getWalletInteractionUrl(moduleId);
            if (!interactionUrl) {
              // Try browser interaction URL as fallback
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
              // Navigate to the browser interaction URL, which should redirect
              // to the wallet with the proper params
              console.log(`Module ${moduleName}: using browser URL: ${browserUrl}`);
              await page.goto(browserUrl, { waitUntil: 'networkidle', timeout: 15000 });
            } else {
              // Drive the wallet to present the credential
              console.log(`Module ${moduleName}: presenting credential via ${interactionUrl.slice(0, 80)}...`);
              const vpResult = await presentCredential(page, interactionUrl);

              if (!vpResult.success) {
                console.log(`Module ${moduleName}: wallet VP failed: ${vpResult.error}`);
              }
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

          // Plan detail URL for full results
          console.log(`\nFull results: ${api.getPlanDetailUrl(planId)}`);

          // Assert all modules passed
          expect(failed.length, `${failed.length} modules failed: ${failed.map((r) => r.module).join(', ')}`).toBe(0);
        });
      });
    }
  });
});
