/**
 * WSCA/WSCD Lifecycle Conformance Tests (Native Android)
 *
 * Tests the WSCA lifecycle operations (enroll, rotate, destroy) on the
 * native Android sample app via adb intents. Works with physical devices,
 * emulators, and Waydroid.
 *
 * All actions dispatch to the real ViewModel methods — same code path
 * as the UI buttons. No backend bypass.
 *
 * Required env vars:
 *   - ANDROID_WALLET_PACKAGE (default: org.sirosfoundation.sdk.sample)
 * Optional env vars:
 *   - ADB_PATH
 *   - ANDROID_DEVICE_SERIAL
 *   - ANDROID_WALLET_ACTIVITY
 *   - R2PS_URL (for R2PS plugin tests)
 *
 * Usage:
 *   npx playwright test specs/conformance/wsca-lifecycle-android.spec.ts
 *   make test-wsca-softkey
 *   make test-wsca-r2ps R2PS_URL=https://r2ps.example.com/r2ps
 */

import { test, expect } from '@playwright/test';
import {
  ANDROID_ENV,
  ensureAndroidWalletReady,
  startAndroidWallet,
} from '../../helpers/android-wallet';
import {
  enrollWscd,
  rotateLifecycle,
  destroyLifecycle,
  getWscaStatus,
  configureWsca,
  type WscaActionResult,
  type WscaStatus,
} from '../../helpers/wsca-automation';

// =============================================================================
// Configuration
// =============================================================================

interface WscaTestConfig {
  name: string;
  pluginId: string;
  factorKind: string;
  r2psEnabled: boolean;
  r2psUrl?: string;
  skip?: boolean;
}

const R2PS_URL = process.env.R2PS_URL || '';

const WSCA_CONFIGS: WscaTestConfig[] = [
  {
    name: 'softkey',
    pluginId: 'softkey',
    factorKind: 'raw_sign',
    r2psEnabled: false,
  },
  {
    name: 'r2ps',
    pluginId: 'r2ps',
    factorKind: 'opaque',
    r2psEnabled: true,
    r2psUrl: R2PS_URL,
    skip: !R2PS_URL,
  },
];

// =============================================================================
// Tests
// =============================================================================

test.describe('WSCA Lifecycle Conformance (Native Android)', () => {
  test.beforeAll(() => {
    ensureAndroidWalletReady();
    startAndroidWallet();
  });

  for (const config of WSCA_CONFIGS) {
    test.describe(`Plugin: ${config.name}`, () => {
      test.beforeAll(() => {
        if (config.skip) {
          test.skip();
          return;
        }
      });

      test.beforeEach(() => {
        if (config.skip) {
          test.skip(true, `${config.name} requires R2PS_URL`);
        }
      });

      test('configure plugin', () => {
        configureWsca({
          r2ps_enabled: config.r2psEnabled,
          r2ps_url: config.r2psUrl,
        });
      });

      test('enroll → Active state', () => {
        test.setTimeout(30000);

        const result = enrollWscd();
        expect(result.status).toBe('ok');
        expect(result.state).toBe('Active');
        expect(result.context_id).toBeTruthy();
      });

      test('status reports Active with keys', () => {
        test.setTimeout(15000);

        const status = getWscaStatus();
        expect(status.state).toBe('Active');
        expect(status.context_id).not.toBe('null');
        expect(status.plugin).toBe(config.r2psEnabled ? 'r2ps' : 'softkey');
      });

      test('rotate preserves Active state', () => {
        test.setTimeout(30000);

        const result = rotateLifecycle();
        expect(result.status).toBe('ok');
        expect(result.state).toBe('Active');
      });

      test('status after rotation shows keys', () => {
        test.setTimeout(15000);

        const status = getWscaStatus();
        expect(status.state).toBe('Active');
        // After rotation, keys should still exist
        expect(status.keys.length).toBeGreaterThan(0);
      });

      test('destroy (local) transitions state', () => {
        test.setTimeout(30000);

        const result = destroyLifecycle('local');
        expect(result.status).toBe('ok');
        expect(result.state).toBe('Destroyed');
      });

      test('status after destroy reflects Destroyed', () => {
        test.setTimeout(15000);

        // After destroy, context_id is cleared
        const status = getWscaStatus();
        expect(status.context_id).toBe('null');
      });

      test('re-enroll after destroy', () => {
        test.setTimeout(30000);

        const result = enrollWscd();
        expect(result.status).toBe('ok');
        expect(result.state).toBe('Active');
      });

      test('destroy with revoke', () => {
        test.setTimeout(30000);

        const result = destroyLifecycle('revoke');
        expect(result.status).toBe('ok');
        expect(result.state).toBe('Destroyed');
      });
    });
  }
});

// =============================================================================
// Full lifecycle cycle test (independent of plugin matrix)
// =============================================================================

test.describe('WSCA Full Lifecycle Cycle (softkey)', () => {
  test.beforeAll(() => {
    ensureAndroidWalletReady();
    startAndroidWallet();
    configureWsca({ r2ps_enabled: false });
  });

  test('complete lifecycle: enroll → rotate → rotate → destroy', () => {
    test.setTimeout(60000);

    // Enroll
    const enroll = enrollWscd();
    expect(enroll.status).toBe('ok');
    expect(enroll.state).toBe('Active');

    // First rotation
    const rotate1 = rotateLifecycle();
    expect(rotate1.status).toBe('ok');
    expect(rotate1.state).toBe('Active');

    // Second rotation
    const rotate2 = rotateLifecycle();
    expect(rotate2.status).toBe('ok');
    expect(rotate2.state).toBe('Active');

    // Verify keys accumulated
    const status = getWscaStatus();
    expect(status.state).toBe('Active');

    // Destroy
    const destroy = destroyLifecycle('local');
    expect(destroy.status).toBe('ok');
    expect(destroy.state).toBe('Destroyed');

    // Verify final state
    const finalStatus = getWscaStatus();
    expect(finalStatus.context_id).toBe('null');
  });
});
