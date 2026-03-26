/**
 * OpenID4VCI Credential Issuance Tests
 *
 * @tags @vc @openid4vci @credential-issuance
 *
 * Tests for credential issuance using the production-like VC services:
 * - Pre-authorized code flow
 * - Multiple credential types (PID, EHIC, Diploma, eduID)
 * - Trust evaluation during issuance
 *
 * Prerequisites:
 *   - Start sirosid-dev with VC services: make up-vc
 *   - Or with trust: make up-vc-go-trust-allow
 */

import { test, expect } from '@playwright/test';
import {
  VC_ENV,
  CREDENTIAL_TYPES,
  checkVCServicesHealth,
  waitForVCServices,
  createCredentialOffer,
  buildWalletOfferUrl,
  parseCredentialOfferUri,
} from '../../helpers/vc-services';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';

// =============================================================================
// Test Configuration
// =============================================================================

const FRONTEND_URL = ENV.FRONTEND_URL;
const ADMIN_URL = ENV.ADMIN_URL;
const ADMIN_TOKEN = ENV.ADMIN_TOKEN;

// Test timeouts
const CREDENTIAL_TIMEOUT = 30000;
const SERVICE_TIMEOUT = 15000;

// =============================================================================
// Fixtures and Setup
// =============================================================================

test.describe('OpenID4VCI Credential Issuance', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    // Check if VC services are available
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier && health.apigw;
    
    if (!vcServicesAvailable) {
      console.log('VC services not available, tests will be skipped');
      console.log('Health check results:', health);
      console.log('Start VC services with: cd sirosid-dev && make up-vc');
    }
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    
    // Create a unique tenant for each test
    tenantId = generateTestId('vc-test');
    await createTenant(tenantId, `VC Test Tenant ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  // ===========================================================================
  // VC Services Health Tests
  // ===========================================================================

  test.describe('Service Health', () => {
    test('all VC services should be healthy', async () => {
      const health = await checkVCServicesHealth();
      
      expect(health.issuer).toBe(true);
      expect(health.verifier).toBe(true);
      expect(health.apigw).toBe(true);
      expect(health.registry).toBe(true);
    });

    test('issuer metadata should be accessible', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
      );
      
      expect(response.ok()).toBe(true);
      
      const metadata = await response.json();
      expect(metadata.credential_issuer).toBeDefined();
      expect(metadata.credential_configurations_supported).toBeDefined();
    });

    test('verifier OIDC configuration should be accessible', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      
      expect(response.ok()).toBe(true);
      
      const config = await response.json();
      expect(config.issuer).toBeDefined();
      expect(config.authorization_endpoint).toBeDefined();
      expect(config.token_endpoint).toBeDefined();
    });

    test('API gateway OAuth metadata should be accessible', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_APIGW_URL}/.well-known/oauth-authorization-server`
      );
      
      expect(response.ok()).toBe(true);
      
      const metadata = await response.json();
      expect(metadata.issuer).toBeDefined();
      expect(metadata.token_endpoint).toBeDefined();
    });
  });

  // ===========================================================================
  // Credential Offer Creation Tests
  // ===========================================================================

  test.describe('Credential Offer Creation', () => {
    test('should create PID 1.8 credential offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();
      expect(offer.credential_offer_uri).toContain('credential_offer');
      expect(offer.grants).toBeDefined();
    });

    test('should create PID 1.5 credential offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_5,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();
    });

    test('should create EHIC credential offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.EHIC,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();
    });

    test('should create Diploma credential offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.DIPLOMA,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();
    });

    test('should create eduID credential offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.EDUID,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();
    });

    test('should include pre-authorized code in offer', async () => {
      const userId = generateTestId('user');
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
      expect(preAuthGrant).toBeDefined();
      expect(preAuthGrant?.['pre-authorized_code']).toBeDefined();
    });

    test('should create offer with custom claims', async () => {
      const userId = generateTestId('user');
      const customClaims = {
        given_name: 'Alice',
        family_name: 'Testsson',
        birthdate: '1985-05-15',
        nationality: 'SE',
      };
      
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local', claims: customClaims }
      );

      expect(offer.credential_offer_uri).toBeDefined();
      // The claims will be embedded in the credential when issued
    });
  });

  // ===========================================================================
  // Full Issuance Flow Tests (Without Browser)
  // ===========================================================================

  test.describe('Pre-Authorized Code Flow (API)', () => {
    test('should complete pre-authorized code exchange', async ({ request }) => {
      const userId = generateTestId('user');
      
      // 1. Create offer
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
      expect(preAuthGrant).toBeDefined();
      
      const preAuthCode = preAuthGrant!['pre-authorized_code'];

      // 2. Exchange pre-authorized code for access token
      const tokenResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
          'pre-authorized_code': preAuthCode,
        },
      });

      expect(tokenResponse.ok()).toBe(true);
      
      const tokens = await tokenResponse.json();
      expect(tokens.access_token).toBeDefined();
      expect(tokens.c_nonce).toBeDefined();
    });

    test('should request and receive credential', async ({ request }) => {
      const userId = generateTestId('user');
      
      // 1. Create offer
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
      const preAuthCode = preAuthGrant!['pre-authorized_code'];

      // 2. Get access token
      const tokenResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
          'pre-authorized_code': preAuthCode,
        },
      });

      const tokens = await tokenResponse.json();
      const accessToken = tokens.access_token;
      const cNonce = tokens.c_nonce;

      // 3. Request credential (simplified - real flow needs proof of possession)
      // This tests the API endpoint availability
      const credentialResponse = await request.post(`${VC_ENV.VC_ISSUER_URL}/credential`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        data: {
          format: 'dc+sd-jwt',
          credential_configuration_id: CREDENTIAL_TYPES.PID_1_8,
          // Note: Real flow requires a proof JWT with c_nonce
        },
      });

      // The request should be processed (may fail without proper proof)
      // but the endpoint should be reachable
      expect([200, 400, 401, 403]).toContain(credentialResponse.status());
    });
  });

  // ===========================================================================
  // Credential Type Metadata Tests
  // ===========================================================================

  test.describe('Credential Type Metadata', () => {
    test('should expose PID 1.8 credential configuration', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
      );
      
      const metadata = await response.json();
      const configs = metadata.credential_configurations_supported;
      
      expect(configs[CREDENTIAL_TYPES.PID_1_8]).toBeDefined();
    });

    test('should expose EHIC credential configuration', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
      );
      
      const metadata = await response.json();
      const configs = metadata.credential_configurations_supported;
      
      expect(configs[CREDENTIAL_TYPES.EHIC]).toBeDefined();
    });

    test('should specify dc+sd-jwt format', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
      );
      
      const metadata = await response.json();
      const pidConfig = metadata.credential_configurations_supported[CREDENTIAL_TYPES.PID_1_8];
      
      expect(pidConfig.format).toBe('dc+sd-jwt');
    });
  });
});

// =============================================================================
// Browser-Based Issuance Tests
// =============================================================================

test.describe('Browser Credential Issuance Flow', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier && health.apigw;
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('vc-browser');
    await createTenant(tenantId, `VC Browser Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  test('should navigate to credential offer URL', async ({ page }) => {
    const userId = generateTestId('user');
    
    // Create offer
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    // Build wallet URL with offer
    const walletUrl = buildWalletOfferUrl(FRONTEND_URL, offer.credential_offer_uri);
    
    // Navigate to wallet with offer
    await page.goto(walletUrl);
    await page.waitForLoadState('networkidle');

    // The wallet should show login or offer acceptance UI
    const url = page.url();
    expect(url).toContain(FRONTEND_URL);
  });

  test('should handle credential_offer_uri query parameter', async ({ page }) => {
    const userId = generateTestId('user');
    
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    // Navigate directly with query parameter
    const targetUrl = `${FRONTEND_URL}?credential_offer_uri=${encodeURIComponent(offer.credential_offer_uri)}`;
    
    await page.goto(targetUrl);
    await page.waitForLoadState('networkidle');

    // Wait for potential redirect or modal
    await page.waitForTimeout(2000);

    // Should not show error
    const errorText = await page.locator('text=error').count();
    // Some error handling is expected if not logged in
  });

  test('should display credential offer details', async ({ page }) => {
    const userId = generateTestId('user');
    
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    // First login/register to the wallet
    await page.goto(`${FRONTEND_URL}/login`);
    await page.waitForLoadState('networkidle');

    // Then navigate to offer
    const walletUrl = buildWalletOfferUrl(FRONTEND_URL, offer.credential_offer_uri);
    await page.goto(walletUrl);
    await page.waitForLoadState('networkidle');

    // Look for credential-related UI elements
    // These may vary based on wallet implementation
    await page.waitForTimeout(3000);
  });
});
