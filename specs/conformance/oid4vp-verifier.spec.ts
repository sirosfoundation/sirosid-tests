/**
 * OpenID4VP Verifier/RP Conformance Tests
 *
 * @tags @conformance @oid4vp @verifier
 *
 * Runs the OpenID Foundation Conformance Suite OID4VP RP test plan.
 * The conformance suite acts as a wallet and tests our VC verifier's
 * compliance with OpenID4VP.
 *
 * Flow:
 *   1. Create a conformance test plan pointing to our verifier
 *   2. For each module, the conformance suite provides interaction URLs
 *   3. Our test triggers verification requests at our verifier
 *   4. The conformance suite (as wallet) responds with VP tokens
 *   5. Results are collected and validated
 *
 * Prerequisites:
 *   - Conformance suite running: cd sirosid-dev && make up-conformance
 *   - VC services running (verifier, registry)
 *   - /etc/hosts entry: 127.0.0.1 localhost.emobix.co.uk
 *
 * Run:
 *   cd sirosid-tests && make test-conformance-verifier
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ConformanceAPI, type TestState } from '../../helpers/conformance-api';
import { ENV } from '../../helpers/shared-helpers';
import { VC_ENV, checkVCServicesHealth } from '../../helpers/vc-services';

// =============================================================================
// Configuration
// =============================================================================

const CONFORMANCE_URL = process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/';

/**
 * The verifier URL as reachable from the conformance suite container.
 * In Docker, the conformance suite and VC services share the e2e-test-network,
 * so the verifier is reachable via its Docker service name.
 */
const VERIFIER_CONFORMANCE_URL =
  process.env.VERIFIER_CONFORMANCE_URL || 'http://vc-verifier:8080';

/**
 * The verifier URL as reachable from the host (for triggering verification requests).
 */
const VERIFIER_HOST_URL = VC_ENV.VC_VERIFIER_URL;

/** OID4VP RP test plan variants */
const VP_VERIFIER_VARIANTS = [
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

/** Conformance suite test plan name for verifier/RP testing */
const VP_RP_PLAN_NAME = 'oid4vp-1final-rp-test-plan';

/** Config template path */
const VP_VERIFIER_CONFIG_PATH = path.resolve(
  __dirname,
  '../../configs/conformance/vp-verifier-config.json'
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Load and interpolate the verifier config template.
 */
function loadVerifierConfig(): string {
  let config = fs.readFileSync(VP_VERIFIER_CONFIG_PATH, 'utf-8');
  const discoveryUrl = `${VERIFIER_CONFORMANCE_URL}/.well-known/openid-configuration`;
  const resourceUrl = VERIFIER_CONFORMANCE_URL;
  config = config.replace(/\$\{VERIFIER_DISCOVERY_URL\}/g, discoveryUrl);
  config = config.replace(/\$\{VERIFIER_RESOURCE_URL\}/g, resourceUrl);
  return config;
}

/**
 * Trigger a verification request at our verifier.
 * This creates an OID4VP authorization request that the conformance suite
 * (acting as wallet) will respond to.
 *
 * @returns The authorization request URL, or null if not applicable
 */
async function triggerVerificationRequest(
  scope = 'pid'
): Promise<{ authorizationUrl?: string; requestUri?: string; error?: string }> {
  try {
    // The VC verifier exposes an OIDC authorization endpoint.
    // Creating a verification session returns the authorization request
    // that a wallet should process.
    const response = await fetch(
      `${VERIFIER_HOST_URL}/authorize?` +
        new URLSearchParams({
          response_type: 'vp_token',
          client_id: 'e2e-test-client',
          redirect_uri: 'http://localhost:3000/cb',
          scope,
          nonce: `conformance-${Date.now()}`,
          state: `state-${Date.now()}`,
        }),
      { redirect: 'manual' }
    );

    // The verifier typically redirects to the wallet with the authorization request
    const location = response.headers.get('location');
    if (location) {
      return { authorizationUrl: location };
    }

    // Or returns the request_uri in the response body
    if (response.ok) {
      const body = await response.json();
      return { requestUri: body.request_uri || body.authorization_endpoint };
    }

    return { error: `Unexpected response: ${response.status}` };
  } catch (error: any) {
    return { error: `Failed to trigger verification: ${error.message}` };
  }
}

// =============================================================================
// Tests
// =============================================================================

test.describe('OID4VP Verifier/RP Conformance Suite', () => {
  const api = new ConformanceAPI(CONFORMANCE_URL);
  let conformanceReady = false;
  let verifierReady = false;

  test.beforeAll(async () => {
    // Check conformance suite
    try {
      await api.waitForServerReady(30000);
      conformanceReady = true;
    } catch (error) {
      console.log('Conformance suite not available:', (error as Error).message);
      console.log('Start with: cd sirosid-dev && make up-conformance');
    }

    // Check verifier
    try {
      const health = await checkVCServicesHealth();
      verifierReady = health.verifier;
      if (!verifierReady) {
        console.log('VC verifier not available');
        console.log('Start with: cd sirosid-dev && make up-conformance');
      }
    } catch (error) {
      console.log('VC services health check failed:', (error as Error).message);
    }
  });

  test.beforeEach(async () => {
    if (!conformanceReady) {
      test.skip(true, 'Conformance suite not available');
      return;
    }
    if (!verifierReady) {
      test.skip(true, 'VC verifier not available');
      return;
    }
  });

  // ===========================================================================
  // Verifier Conformance Tests
  // ===========================================================================

  for (const variantConfig of VP_VERIFIER_VARIANTS) {
    test.describe(`Variant: ${variantConfig.name}`, () => {
      let planId: string;
      let planModules: string[];

      test.beforeAll(async () => {
        if (!conformanceReady || !verifierReady) return;

        const configJson = loadVerifierConfig();
        console.log(
          `Creating verifier test plan with config targeting: ${VERIFIER_CONFORMANCE_URL}`
        );

        const plan = await api.createTestPlan(
          VP_RP_PLAN_NAME,
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

      test('should pass all verifier conformance modules', async ({ page }) => {
        test.setTimeout(300000); // 5 min timeout

        expect(planId).toBeDefined();
        expect(planModules.length).toBeGreaterThan(0);

        const results: Array<{
          module: string;
          status: string;
          result: string;
          passed: boolean;
        }> = [];

        for (const moduleName of planModules) {
          console.log(`\n=== Running verifier module: ${moduleName} ===`);

          const moduleInfo = await api.createTestFromPlan(planId, moduleName);
          const moduleId = moduleInfo.id;
          console.log(`Module ${moduleName} created: ${moduleId}`);

          // For RP/verifier tests, the conformance suite acts as the wallet.
          // The flow depends on the test module:
          //   - Some modules test the verifier's metadata/discovery
          //   - Some modules need the verifier to initiate a verification request
          //   - The conformance suite then responds as a wallet
          let state: TestState;
          try {
            state = await api.waitForState(moduleId, ['WAITING', 'FINISHED'], 120000);
          } catch (error) {
            console.log(`Module ${moduleName} timed out: ${(error as Error).message}`);
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
            console.log(`Module ${moduleName} finished: ${info.result}`);
            results.push({
              module: moduleName,
              status: info.status,
              result: info.result,
              passed: info.result === 'PASSED',
            });
            continue;
          }

          // Module is WAITING — may need browser interaction or verification trigger.
          // For RP tests, the conformance suite might provide a URL for the verifier
          // to redirect to, or it might be waiting for the verifier to initiate.
          const browserUrl = await api.getBrowserInteractionUrl(moduleId);
          if (browserUrl) {
            console.log(
              `Module ${moduleName}: browser interaction at ${browserUrl.slice(0, 100)}`
            );
            // Navigate to the interaction URL — this triggers the verifier's
            // authorization flow with the conformance suite acting as wallet
            await page.goto(browserUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(5000);

            // Handle any UI interactions (consent forms, etc.)
            const approveBtn = page.locator(
              'button:has-text("Approve"), button:has-text("Allow"), button:has-text("Authorize"), button:has-text("Submit")'
            ).first();
            if (await approveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log(`Module ${moduleName}: clicking approve/submit`);
              await approveBtn.click();
              await page.waitForTimeout(3000);
            }
          } else {
            // No browser URL — try triggering a verification request
            console.log(`Module ${moduleName}: no browser URL, attempting to trigger verification`);
            const verifyResult = await triggerVerificationRequest();
            if (verifyResult.error) {
              console.log(`Module ${moduleName}: trigger failed: ${verifyResult.error}`);
            } else if (verifyResult.authorizationUrl) {
              console.log(
                `Module ${moduleName}: triggered verification, auth URL: ${verifyResult.authorizationUrl.slice(0, 100)}`
              );
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

          // Fetch detailed log on failure
          if (finalInfo.result !== 'PASSED') {
            try {
              const logs = await api.getTestLog(moduleId);
              const failures = logs.filter(
                (l) => l.result === 'FAILURE' || l.result === 'WARNING'
              );
              if (failures.length > 0) {
                console.log(`Module ${moduleName} failure details:`);
                for (const f of failures.slice(0, 5)) {
                  console.log(`  [${f.result}] ${f.src}: ${(f.msg || '').slice(0, 300)}`);
                }
              }
            } catch {
              // Best-effort
            }
          }

          results.push({
            module: moduleName,
            status: finalInfo.status,
            result: finalInfo.result,
            passed: finalInfo.result === 'PASSED',
          });
        }

        // Report results
        console.log('\n=== Verifier Conformance Results ===');
        const passed = results.filter((r) => r.passed);
        const failed = results.filter((r) => !r.passed);

        console.log(
          `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`
        );

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

        expect(
          failed.length,
          `${failed.length} verifier modules failed: ${failed.map((r) => r.module).join(', ')}`
        ).toBe(0);
      });
    });
  }
});
