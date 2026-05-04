/**
 * Tenant Setup Fixture for Playwright Tests
 *
 * Provides a reusable fixture that creates a tenant and registers a user
 * via the UI with a CDP virtual authenticator, and tears everything down
 * after the test worker finishes.
 *
 * Usage:
 *   import { test } from '../../helpers/tenant-setup-fixture';
 *
 *   test('my test', async ({ tenantContext, page }) => {
 *     // tenantContext.tenantId, tenantContext.userId, etc. are available
 *   });
 */

import { test as base } from '@playwright/test';
import { createTenant, deleteTenant, generateTestId } from './shared-helpers';
import { registerUserViaUI } from './ui-actions';
import { generateTestUsername } from './softfido';
import { WebAuthnHelper } from './webauthn';

export interface TenantContext {
  tenantId: string;
  username: string;
  userId?: string;
  appToken?: string;
  ready: boolean;
  error?: string;
  /** WebAuthn credentials from registration (for replaying in login) */
  credentials?: any[];
}

/**
 * Worker-scoped fixture that creates a tenant and registers a user once
 * per worker, shared across all tests in that worker.
 */
export const test = base.extend<{}, { tenantContext: TenantContext }>({
  tenantContext: [async ({ browser }, use) => {
    const ctx: TenantContext = {
      tenantId: '',
      username: '',
      ready: false,
    };

    // Create tenant
    ctx.tenantId = generateTestId('conf');
    ctx.username = generateTestUsername('conf');
    await createTenant(ctx.tenantId, `Conformance ${ctx.tenantId}`);

    // Register a user via the UI with CDP virtual authenticator
    const page = await browser.newPage();
    try {
      // Set up CDP virtual authenticator for headless WebAuthn
      const webauthn = new WebAuthnHelper(page);
      await webauthn.initialize();
      await webauthn.injectPrfMock();
      await webauthn.addPlatformAuthenticator();

      const regResult = await registerUserViaUI(page, {
        username: ctx.username,
        tenantId: ctx.tenantId,
      });

      if (!regResult.success) {
        ctx.error = `Registration failed: ${regResult.error}`;
        await use(ctx);
        // Still clean up the tenant
        await deleteTenant(ctx.tenantId).catch(() => {});
        return;
      }

      ctx.userId = regResult.userId;
      ctx.appToken = regResult.appToken;
      ctx.ready = true;
      // Save credentials for later login
      ctx.credentials = await webauthn.getCredentials();
      console.log(`[TenantFixture] Registered user: ${ctx.username} (${ctx.userId}) in tenant ${ctx.tenantId}`);

      await webauthn.cleanup();
    } finally {
      await page.close();
    }

    await use(ctx);

    // Teardown
    await deleteTenant(ctx.tenantId).catch(() => {});
    console.log(`[TenantFixture] Cleaned up tenant ${ctx.tenantId}`);
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
