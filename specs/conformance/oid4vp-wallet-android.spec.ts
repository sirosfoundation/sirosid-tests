/**
 * OpenID4VP Wallet Conformance Tests (Native Android)
 *
 * Uses the OpenID Conformance Suite as verifier and delivers interaction URLs
 * to a native Android wallet via adb deep links.
 *
 * Required env vars:
 *   - ANDROID_WALLET_PACKAGE (default: org.sirosfoundation.sdk.sample)
 * Optional env vars:
 *   - ADB_PATH
 *   - ANDROID_DEVICE_SERIAL
 *   - ANDROID_WALLET_ACTIVITY
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
import {
  CREDENTIAL_TYPES,
  checkVCServicesHealth,
  createCredentialOffer,
} from '../../helpers/vc-services';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFORMANCE_URL = process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/';
const VP_CONFIG_PATH = path.resolve(__dirname, '../../configs/conformance/vp-wallet-config.json');
const VP_PLAN_NAME = 'oid4vp-1final-wallet-test-plan';
const ANDROID_PRELOAD_WAIT_MS = Number(process.env.ANDROID_PRELOAD_WAIT_MS || '15000');
const ANDROID_MODULE_FINISH_WAIT_MS = Number(process.env.ANDROID_MODULE_FINISH_WAIT_MS || '30000');

const VP_VARIANTS = [
  {
    name: 'sd_jwt_vc / x509_san_dns / direct_post / request_uri_signed / plain_vp',
    variant: {
      credential_format: 'sd_jwt_vc',
      client_id_prefix: 'x509_san_dns',
      response_mode: 'direct_post',
      request_method: 'request_uri_signed',
      vp_profile: 'plain_vp',
    },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('OID4VP Wallet Conformance Suite (Native Android)', () => {
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

  for (const variantConfig of VP_VARIANTS) {
    test(`should pass all VP modules on Android (${variantConfig.name})`, async () => {
      test.setTimeout(900000);

      const vcHealth = await checkVCServicesHealth();
      expect(vcHealth.apigw && vcHealth.issuer).toBe(true);

      // Pre-load one PID credential into the native wallet before VP modules.
      const preload = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        `vp-android-preload-${Date.now()}`,
        { walletId: 'local' }
      );
      expect(preload.credential_offer_uri).toBeTruthy();

      sendInteractionUrlToAndroidWallet(preload.credential_offer_uri);
      await sleep(ANDROID_PRELOAD_WAIT_MS);

      const configJsonRaw = fs.readFileSync(VP_CONFIG_PATH, 'utf-8');
      const plan = await api.createTestPlan(VP_PLAN_NAME, configJsonRaw, variantConfig.variant);
      const modules = plan.modules.map((m) => m.testModule);
      expect(modules.length).toBeGreaterThan(0);

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

        try {
          sendInteractionUrlToAndroidWallet(interactionUrl);
        } catch (error) {
          failures.push(`${moduleName}: adb deep-link failed (${(error as Error).message})`);
          continue;
        }

        try {
          await api.waitForState(moduleId, ['FINISHED'], ANDROID_MODULE_FINISH_WAIT_MS);
        } catch {
          const stuckInfo = await api.getModuleInfo(moduleId).catch(() => null);
          failures.push(
            `${moduleName}: did not finish after delivering interaction URL (status=${stuckInfo?.status || 'UNKNOWN'})`
          );
          continue;
        }

        const finalInfo = await api.getModuleInfo(moduleId);
        if (finalInfo.result !== 'PASSED') {
          failures.push(`${moduleName}: ${finalInfo.result || 'UNKNOWN_RESULT'}`);
        }
      }

      expect(
        failures,
        `Android VP conformance failures for package ${ANDROID_ENV.WALLET_PACKAGE}:\n${failures.join('\n')}`
      ).toEqual([]);
    });
  }
});
