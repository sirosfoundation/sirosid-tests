/**
 * OpenID4VCI Wallet Conformance Tests (Native Android)
 *
 * Uses the OpenID Conformance Suite as issuer and delivers interaction URLs
 * to a native Android wallet via adb deep links.
 *
 * Required env vars:
 *   - ANDROID_WALLET_PACKAGE (default: org.sirosfoundation.sdk.sample)
 * Optional env vars:
 *   - ADB_PATH
 *   - ANDROID_DEVICE_SERIAL
 *   - ANDROID_WALLET_ACTIVITY
 *   - CONFORMANCE_ANDROID_TENANT (default: default)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ConformanceAPI, type TestState } from '../../helpers/conformance-api';
import {
  ANDROID_ENV,
  ensureAndroidWalletReady,
  sendInteractionUrlToAndroidWallet,
  startAndroidWallet,
} from '../../helpers/android-wallet';
import { ENV } from '../../helpers/shared-helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFORMANCE_URL = process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/';
const CONFORMANCE_ANDROID_TENANT = process.env.CONFORMANCE_ANDROID_TENANT || 'default';
const VCI_CONFIG_PATH = path.resolve(__dirname, '../../configs/conformance/vci-wallet-config.json');
const VCI_PLAN_NAME = 'oid4vci-1_0-wallet-test-plan';

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

test.describe('OID4VCI Wallet Conformance Suite (Native Android)', () => {
  const api = new ConformanceAPI(CONFORMANCE_URL);
  let conformanceReady = false;

  test.beforeAll(async () => {
    await api.waitForServerReady(30000);
    conformanceReady = true;
    ensureAndroidWalletReady();
    startAndroidWallet();
  });

  test.beforeEach(() => {
    test.skip(!conformanceReady, 'Conformance suite not available');
  });

  for (const variantConfig of VCI_VARIANTS) {
    test(`should pass all VCI modules on Android (${variantConfig.name})`, async () => {
      test.setTimeout(360000);

      const configJsonRaw = fs.readFileSync(VCI_CONFIG_PATH, 'utf-8');
      const configJson = JSON.parse(configJsonRaw) as {
        alias?: string;
        client?: {
          client_id?: string;
          private_key?: unknown;
          jwks?: { keys?: Array<Record<string, unknown>> };
        };
      };

      const plan = await api.createTestPlan(VCI_PLAN_NAME, configJsonRaw, variantConfig.variant);
      const modules = plan.modules.map((m) => m.testModule);
      expect(modules.length).toBeGreaterThan(0);

      // Register conformance issuer in the tenant used by the Android wallet.
      const conformanceClientId = configJson.client?.client_id || 'siros-wallet-test';
      const conformanceIssuerUrl =
        CONFORMANCE_URL.replace(/\/$/, '') + '/test/a/' + (configJson.alias || 'siros-wallet-vci-test') + '/';
      const clientKeyWithPrivate =
        configJson.client?.private_key || configJson.client?.jwks?.keys?.find((k) => 'd' in k);
      const clientPrivateKeyJwk = clientKeyWithPrivate ? JSON.stringify(clientKeyWithPrivate) : null;

      const issuerResp = await fetch(`${ENV.ADMIN_URL}/admin/tenants/${CONFORMANCE_ANDROID_TENANT}/issuers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ENV.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          credential_issuer_identifier: conformanceIssuerUrl,
          client_id: conformanceClientId,
          client_jwk: clientPrivateKeyJwk,
          visible: true,
        }),
      });

      expect([200, 201, 409]).toContain(issuerResp.status());

      const failures: string[] = [];

      for (const moduleName of modules) {
        const moduleInfo = await api.createTestFromPlan(plan.id, moduleName);
        const moduleId = moduleInfo.id;

        let state: TestState;
        try {
          state = await api.waitForState(moduleId, ['WAITING', 'FINISHED'], 60000);
        } catch (error) {
          failures.push(`${moduleName}: timeout waiting for WAITING/FINISHED (${(error as Error).message})`);
          continue;
        }

        if (state === 'FINISHED') {
          const done = await api.getModuleInfo(moduleId);
          if (done.result !== 'PASSED') {
            failures.push(`${moduleName}: ${done.result || 'UNKNOWN_RESULT'}`);
          }
          continue;
        }

        const interactionUrl = await api.getWalletInteractionUrl(moduleId);
        if (!interactionUrl) {
          failures.push(`${moduleName}: no interaction URL provided by conformance suite`);
          continue;
        }

        // Feed the conformance interaction URL to the native wallet app via deep link.
        try {
          sendInteractionUrlToAndroidWallet(interactionUrl);
        } catch (error) {
          failures.push(`${moduleName}: adb deep-link failed (${(error as Error).message})`);
          continue;
        }

        try {
          await api.waitForState(moduleId, ['FINISHED'], 120000);
        } catch {
          failures.push(`${moduleName}: did not finish after delivering interaction URL`);
          continue;
        }

        const finalInfo = await api.getModuleInfo(moduleId);
        if (finalInfo.result !== 'PASSED') {
          failures.push(`${moduleName}: ${finalInfo.result || 'UNKNOWN_RESULT'}`);
        }
      }

      expect(
        failures,
        `Android conformance failures for package ${ANDROID_ENV.WALLET_PACKAGE}:\n${failures.join('\n')}`
      ).toEqual([]);
    });
  }
});