/**
 * OpenID4VCI Issuer Conformance Tests
 *
 * @tags @conformance @oid4vci @issuer
 *
 * Runs the OpenID Foundation Conformance Suite OID4VCI issuer test plan.
 * The conformance suite acts as a wallet and tests our VC issuer's
 * compliance with OpenID4VCI.
 *
 * Prerequisites:
 *   - Conformance suite running: cd sirosid-dev && make up-conformance
 *   - VC services running (issuer, apigw, mockas, registry)
 *   - /etc/hosts entry: 127.0.0.1 localhost.emobix.co.uk
 *
 * Run:
 *   cd sirosid-tests && make test-conformance-issuer
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
 * The issuer discovery URL that the conformance suite will use.
 * In Docker, the conformance suite reaches our issuer via the Docker network.
 * From host, it's http://localhost:9003. From Docker, it's http://vc-apigw:8080.
 *
 * When running with docker-compose, the conformance suite and VC services
 * share the e2e-test-network. The issuer metadata is served by the API Gateway
 * (vc-apigw) which exposes the OpenID4VCI credential issuer metadata.
 *
 * ISSUER_CONFORMANCE_URL should point to the issuer as reachable from the
 * conformance suite container. Defaults to using Docker service name.
 */
const ISSUER_CONFORMANCE_URL =
  process.env.ISSUER_CONFORMANCE_URL || 'http://vc-apigw:8080';

/** OID4VCI issuer test plan variants */
const VCI_ISSUER_VARIANTS = [
  {
    name: 'sd_jwt_vc / pre-authorized_code / immediate',
    variant: {
      credential_format: 'sd_jwt_vc',
      vci_grant_type: 'pre_authorization_code',
      vci_credential_issuance_mode: 'immediate',
      sender_constrain: 'dpop',
      fapi_profile: 'vci',
    },
  },
];

/** Conformance suite test plan name for issuer testing */
const VCI_ISSUER_PLAN_NAME = 'oid4vci-1_0-issuer-test-plan';

/** Config template path */
const VCI_ISSUER_CONFIG_PATH = path.resolve(
  __dirname,
  '../../configs/conformance/vci-issuer-config.json'
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Load and interpolate the issuer config template.
 * Replaces ${ISSUER_DISCOVERY_URL} and ${ISSUER_RESOURCE_URL} placeholders.
 */
function loadIssuerConfig(): string {
  let config = fs.readFileSync(VCI_ISSUER_CONFIG_PATH, 'utf-8');
  const discoveryUrl = `${ISSUER_CONFORMANCE_URL}/.well-known/openid-credential-issuer`;
  const resourceUrl = ISSUER_CONFORMANCE_URL;
  config = config.replace(/\$\{ISSUER_DISCOVERY_URL\}/g, discoveryUrl);
  config = config.replace(/\$\{ISSUER_RESOURCE_URL\}/g, resourceUrl);
  return config;
}

// =============================================================================
// Tests
// =============================================================================

test.describe('OID4VCI Issuer Conformance Suite', () => {
  const api = new ConformanceAPI(CONFORMANCE_URL);
  let conformanceReady = false;
  let issuerReady = false;

  test.beforeAll(async () => {
    // Check conformance suite
    try {
      await api.waitForServerReady(30000);
      conformanceReady = true;
    } catch (error) {
      console.log('Conformance suite not available:', (error as Error).message);
      console.log('Start with: cd sirosid-dev && make up-conformance');
    }

    // Check issuer (via host-accessible URL)
    try {
      const health = await checkVCServicesHealth();
      issuerReady = health.issuer && health.apigw;
      if (!issuerReady) {
        console.log('VC issuer/apigw not available');
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
    if (!issuerReady) {
      test.skip(true, 'VC issuer services not available');
      return;
    }
  });

  // ===========================================================================
  // Issuer Conformance Tests
  // ===========================================================================

  for (const variantConfig of VCI_ISSUER_VARIANTS) {
    test.describe(`Variant: ${variantConfig.name}`, () => {
      let planId: string;
      let planModules: string[];

      test.beforeAll(async () => {
        if (!conformanceReady || !issuerReady) return;

        const configJson = loadIssuerConfig();
        console.log(`Creating issuer test plan with config targeting: ${ISSUER_CONFORMANCE_URL}`);

        const plan = await api.createTestPlan(
          VCI_ISSUER_PLAN_NAME,
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

      test('should pass all issuer conformance modules', async ({ page, browser }) => {
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
          console.log(`\n=== Running issuer module: ${moduleName} ===`);

          const moduleInfo = await api.createTestFromPlan(planId, moduleName);
          const moduleId = moduleInfo.id;
          console.log(`Module ${moduleName} created: ${moduleId}`);

          // For issuer tests, the conformance suite drives the interaction.
          // Some modules may need browser interaction (e.g., authorization code flow
          // where the user must authenticate at our mock AS).
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

          // Module is WAITING — the conformance suite needs browser interaction.
          // This happens in authorization code flows where the user must authenticate
          // at the mock AS. Get the browser interaction URL and handle it.
          const browserUrl = await api.getBrowserInteractionUrl(moduleId);
          if (browserUrl) {
            console.log(`Module ${moduleName}: browser interaction at ${browserUrl.slice(0, 100)}`);

            // Navigate to the authorization URL. The mock AS auto-approves in e2e mode.
            await page.goto(browserUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(3000);

            // Handle mock AS login/approval if needed
            // The mockas auto-approve mode should handle this automatically,
            // but if there's a login form, fill it
            const loginInput = page.locator('input[name="username"], input[type="text"]').first();
            if (await loginInput.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log(`Module ${moduleName}: filling mock AS login form`);
              await loginInput.fill('test-user-001');
              const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
              if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await submitBtn.click();
                await page.waitForTimeout(3000);
              }
            }

            // Handle consent/approve button if present
            const approveBtn = page.locator(
              'button:has-text("Approve"), button:has-text("Allow"), button:has-text("Authorize")'
            ).first();
            if (await approveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log(`Module ${moduleName}: clicking approve`);
              await approveBtn.click();
              await page.waitForTimeout(3000);
            }
          } else {
            console.log(`Module ${moduleName}: WAITING but no browser URL found`);
          }

          // Wait for the module to finish
          try {
            await api.waitForState(moduleId, ['FINISHED'], 60000);
          } catch {
            console.log(`Module ${moduleName} did not finish in time after interaction`);
          }

          const finalInfo = await api.getModuleInfo(moduleId);
          console.log(`Module ${moduleName} result: ${finalInfo.result}`);

          // Fetch detailed log on failure for diagnostics
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
              // Log retrieval is best-effort
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
        console.log('\n=== Issuer Conformance Results ===');
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

        expect(
          failed.length,
          `${failed.length} issuer modules failed: ${failed.map((r) => r.module).join(', ')}`
        ).toBe(0);
      });
    });
  }
});
