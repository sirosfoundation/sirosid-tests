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

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { ConformanceAPI, type TestState } from '../../helpers/conformance-api';
import { acceptCredentialOffer } from '../../helpers/wallet-automation';
import { registerUserViaUI, loginUserViaUI } from '../../helpers/ui-actions';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';
import { isSoftFidoAvailable, resetSoftFidoCredentials, generateTestUsername } from '../../helpers/softfido';

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
      vci_grant_type: 'pre-authorized_code',
      vci_credential_issuance_mode: 'immediate',
      vci_credential_offer_parameter_variant: 'by_value',
      sender_constrain: 'dpop',
      vci_credential_encryption: 'plain',
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
  let tenantId: string;
  let testUsername: string;
  let softFidoAvailable: boolean;
  let conformanceReady: boolean;

  test.beforeAll(async () => {
    softFidoAvailable = isSoftFidoAvailable();
    if (!softFidoAvailable) {
      console.log('soft-fido2 not available, tests will be skipped');
      return;
    }

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
  // VCI Conformance Tests
  // ===========================================================================

  test.describe('VCI Conformance Tests', () => {
    let userId: string | undefined;

    test.beforeAll(async ({ browser }) => {
      if (!softFidoAvailable || !conformanceReady) return;

      tenantId = generateTestId('conf-vci');
      await createTenant(tenantId, `Conformance VCI ${tenantId}`);

      // Register a new user via WebAuthn
      testUsername = generateTestUsername('conf-vci');
      const page = await browser.newPage();
      try {
        resetSoftFidoCredentials();

        const regResult = await registerUserViaUI(page, {
          username: testUsername,
          tenantId,
        });
        if (!regResult.success) {
          console.log('Registration failed:', regResult.error);
          return;
        }
        userId = regResult.userId;
        console.log(`Registered user: ${testUsername} (${userId})`);
      } finally {
        await page.close();
      }
    });

    test.afterAll(async () => {
      if (tenantId) {
        await deleteTenant(tenantId).catch(() => {});
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

        test('should pass all VCI conformance modules', async ({ page }) => {
          test.setTimeout(300000); // 5 minute timeout for all modules

          expect(planId).toBeDefined();
          expect(planModules.length).toBeGreaterThan(0);

          // Login the user
          const loginResult = await loginUserViaUI(page, { tenantId });
          expect(loginResult.success).toBe(true);

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
              const offerResult = await acceptCredentialOffer(page, interactionUrl);

              if (!offerResult.success) {
                console.log(`Module ${moduleName}: wallet offer acceptance failed: ${offerResult.error}`);
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

          console.log(`\nFull results: ${api.getPlanDetailUrl(planId)}`);

          expect(failed.length, `${failed.length} modules failed: ${failed.map((r) => r.module).join(', ')}`).toBe(0);
        });
      });
    }
  });
});
