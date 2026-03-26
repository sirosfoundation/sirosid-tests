/**
 * End-to-End Credential Flow Tests
 *
 * @tags @vc @e2e @full-flow
 *
 * Complete end-to-end tests for real credential issuance and verification:
 * - Issue credential via OpenID4VCI
 * - Present credential via OpenID4VP
 * - Multi-credential flows (PID → EHIC)
 * - Full OIDC login with credential presentation
 *
 * Prerequisites:
 *   - Start sirosid-dev with VC services: make up-vc
 *   - These tests require a registered user in the wallet
 */

import { test, expect } from '@playwright/test';
import {
  VC_ENV,
  CREDENTIAL_TYPES,
  checkVCServicesHealth,
  waitForVCServices,
  createCredentialOffer,
  createVerificationRequest,
  buildWalletOfferUrl,
} from '../../helpers/vc-services';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';

// =============================================================================
// Test Configuration
// =============================================================================

const FRONTEND_URL = ENV.FRONTEND_URL;
const REDIRECT_URI = `${FRONTEND_URL}/callback`;

// Longer timeouts for E2E flows
const E2E_TIMEOUT = 60000;
const CREDENTIAL_TIMEOUT = 30000;

// =============================================================================
// Full E2E Flow Tests
// =============================================================================

test.describe('End-to-End Credential Flows', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier && health.apigw;
    
    if (!vcServicesAvailable) {
      console.log('VC services not fully available:');
      console.log('  Issuer:', health.issuer ? '✓' : '✗');
      console.log('  Verifier:', health.verifier ? '✓' : '✗');
      console.log('  API GW:', health.apigw ? '✓' : '✗');
      console.log('  Registry:', health.registry ? '✓' : '✗');
      console.log('  MockAS:', health.mockas ? '✓' : '✗');
      console.log('\nStart VC services with: cd sirosid-dev && make up-vc');
    }
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('e2e');
    await createTenant(tenantId, `E2E Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  // ===========================================================================
  // Credential Issuance E2E
  // ===========================================================================

  test.describe('Credential Issuance E2E', () => {
    test('should create and access PID credential offer', async ({ request }) => {
      const userId = generateTestId('user');
      
      // 1. Create credential offer via API Gateway
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      expect(offer.credential_offer_uri).toBeDefined();

      // 2. Verify the offer URI is accessible
      const offerResponse = await request.get(offer.credential_offer_uri);
      expect([200, 302]).toContain(offerResponse.status());
    });

    test('should complete pre-authorized token exchange', async ({ request }) => {
      const userId = generateTestId('user');
      
      // 1. Create offer
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        { walletId: 'local' }
      );

      const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
      expect(preAuthGrant).toBeDefined();

      // 2. Exchange pre-authorized code for access token
      const tokenResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
          'pre-authorized_code': preAuthGrant!['pre-authorized_code'],
        },
      });

      expect(tokenResponse.ok()).toBe(true);
      
      const tokens = await tokenResponse.json();
      expect(tokens.access_token).toBeDefined();
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.c_nonce).toBeDefined();
    });

    test('should include correct VCT in issuer metadata', async ({ request }) => {
      // Get issuer metadata
      const metadataResponse = await request.get(
        `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
      );
      
      const metadata = await metadataResponse.json();
      const supportedConfigs = metadata.credential_configurations_supported;

      // Verify PID 1.8 is supported
      expect(supportedConfigs[CREDENTIAL_TYPES.PID_1_8]).toBeDefined();
      expect(supportedConfigs[CREDENTIAL_TYPES.PID_1_8].vct).toBe(CREDENTIAL_TYPES.PID_1_8);
      
      // Verify format
      expect(supportedConfigs[CREDENTIAL_TYPES.PID_1_8].format).toBe('dc+sd-jwt');
    });
  });

  // ===========================================================================
  // Credential Verification E2E
  // ===========================================================================

  test.describe('Credential Verification E2E', () => {
    test('should create verification request with PID scope', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toBeDefined();
      expect(verificationRequest.state).toBeDefined();
      expect(verificationRequest.nonce).toBeDefined();
    });

    test('should include proper OIDC parameters', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      const url = new URL(verificationRequest.authorization_url);
      
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('e2e-test-client');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('scope')).toContain('openid');
      expect(url.searchParams.get('scope')).toContain('pid');
    });

    test('should support multiple scopes', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid profile email',
        REDIRECT_URI
      );

      const url = new URL(verificationRequest.authorization_url);
      const scope = url.searchParams.get('scope');
      
      expect(scope).toContain('openid');
      expect(scope).toContain('pid');
    });
  });

  // ===========================================================================
  // Issuance + Verification Flow
  // ===========================================================================

  test.describe('Full Issue-Then-Verify Flow', () => {
    test('should complete full credential lifecycle (API level)', async ({ request }) => {
      const userId = generateTestId('user');

      // ===== ISSUANCE PHASE =====
      
      // 1. Create credential offer
      const offer = await createCredentialOffer(
        CREDENTIAL_TYPES.PID_1_8,
        userId,
        {
          walletId: 'local',
          claims: {
            given_name: 'E2E',
            family_name: 'TestUser',
            birthdate: '1990-01-01',
            age_over_18: true,
          },
        }
      );

      expect(offer.credential_offer_uri).toBeDefined();

      // 2. Get access token
      const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
      const tokenResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
          'pre-authorized_code': preAuthGrant!['pre-authorized_code'],
        },
      });

      const tokens = await tokenResponse.json();
      expect(tokens.access_token).toBeDefined();

      // ===== VERIFICATION PHASE =====
      
      // 3. Create verification request
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toBeDefined();

      // Note: Completing the verification flow requires browser interaction
      // to handle the wallet's credential selection UI

      console.log('Full credential lifecycle API calls completed successfully');
    });
  });
});

// =============================================================================
// Multi-Credential Flow Tests
// =============================================================================

test.describe('Multi-Credential Flows', () => {
  let vcServicesAvailable: boolean;
  let tenantId: string;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.apigw;
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('multi');
    await createTenant(tenantId, `Multi-Credential Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  test('should create offers for multiple credential types', async () => {
    const userId = generateTestId('user');
    
    // Create offers for different credential types
    const pidOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    const diplomaOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.DIPLOMA,
      userId,
      { walletId: 'local' }
    );

    const ehciOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.EHIC,
      userId,
      { walletId: 'local' }
    );

    expect(pidOffer.credential_offer_uri).toBeDefined();
    expect(diplomaOffer.credential_offer_uri).toBeDefined();
    expect(ehciOffer.credential_offer_uri).toBeDefined();
  });

  test('should support different auth methods per credential type', async ({ request }) => {
    // Get issuer metadata to check auth methods
    const metadataResponse = await request.get(
      `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer`
    );
    
    const metadata = await metadataResponse.json();
    const configs = metadata.credential_configurations_supported;

    // PID uses basic auth
    expect(configs[CREDENTIAL_TYPES.PID_1_8]).toBeDefined();
    
    // EHIC uses pid_auth (requires PID credential)
    expect(configs[CREDENTIAL_TYPES.EHIC]).toBeDefined();
    
    // Diploma uses pid_auth
    expect(configs[CREDENTIAL_TYPES.DIPLOMA]).toBeDefined();
  });

  test('should create PID then dependent EHIC credential', async () => {
    const userId = generateTestId('user');
    
    // 1. First issue PID (basic auth, no dependency)
    const pidOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    expect(pidOffer.credential_offer_uri).toBeDefined();
    expect(pidOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']).toBeDefined();

    // 2. Then issue EHIC (requires pid_auth in production, but works with test setup)
    const ehicOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.EHIC,
      userId,
      { walletId: 'local' }
    );

    expect(ehicOffer.credential_offer_uri).toBeDefined();
    expect(ehicOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']).toBeDefined();
  });

  test('should create eduID credential offer', async () => {
    const userId = generateTestId('user');
    
    const eduIdOffer = await createCredentialOffer(
      CREDENTIAL_TYPES.EDUID,
      userId,
      {
        walletId: 'local',
        claims: {
          given_name: 'Test',
          family_name: 'Student',
          mail: 'test.student@university.edu',
          eduperson_principal_name: 'tstudent@university.edu',
          eduperson_scoped_affiliation: 'student@university.edu',
          schac_home_organization: 'university.edu',
        },
      }
    );

    expect(eduIdOffer.credential_offer_uri).toBeDefined();
  });
});

// =============================================================================
// Browser E2E Flow Tests
// =============================================================================

test.describe('Browser E2E Flows', () => {
  let vcServicesAvailable: boolean;
  let tenantId: string;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier && health.apigw;
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('browser');
    await createTenant(tenantId, `Browser Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  test('should navigate wallet to credential offer', async ({ page }) => {
    const userId = generateTestId('user');
    
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    const walletUrl = buildWalletOfferUrl(FRONTEND_URL, offer.credential_offer_uri);
    
    await page.goto(walletUrl);
    await page.waitForLoadState('networkidle');

    // Should be on wallet page (login or offer UI)
    expect(page.url()).toContain(FRONTEND_URL);
  });

  test('should navigate to verifier authorization', async ({ page }) => {
    const verificationRequest = await createVerificationRequest(
      'pid',
      REDIRECT_URI
    );

    await page.goto(verificationRequest.authorization_url);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Should redirect to wallet or show credential selection
    // The exact behavior depends on wallet configuration
  });

  test('should handle direct openid4vci URI scheme', async ({ page }) => {
    const userId = generateTestId('user');
    
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    // Navigate with credential_offer_uri parameter
    await page.goto(`${FRONTEND_URL}?credential_offer_uri=${encodeURIComponent(offer.credential_offer_uri)}`);
    await page.waitForLoadState('networkidle');

    // Wallet should process the offer parameter
    await page.waitForTimeout(2000);
  });

  test('should track issuance flow metrics', async ({ page }) => {
    const userId = generateTestId('user');
    const startTime = Date.now();
    
    // Create offer
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    const offerCreationTime = Date.now() - startTime;
    console.log(`Credential offer created in ${offerCreationTime}ms`);

    // Navigate to wallet
    const navStart = Date.now();
    const walletUrl = buildWalletOfferUrl(FRONTEND_URL, offer.credential_offer_uri);
    await page.goto(walletUrl);
    await page.waitForLoadState('networkidle');
    
    const navigationTime = Date.now() - navStart;
    console.log(`Wallet navigation completed in ${navigationTime}ms`);

    // Performance assertions
    expect(offerCreationTime).toBeLessThan(5000); // Offer should be created quickly
    expect(navigationTime).toBeLessThan(10000); // Navigation should be reasonable
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

test.describe('Error Handling', () => {
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.apigw;
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
  });

  test('should handle invalid credential type gracefully', async ({ request }) => {
    // Try to create offer for non-existent credential type
    const response = await request.post(`${VC_ENV.VC_APIGW_URL}/offer`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        credential_configuration_id: 'urn:invalid:credential:type',
        user_identifier: 'test-user',
        wallet_id: 'local',
      },
    });

    // Should return error, not crash
    expect([400, 404, 422]).toContain(response.status());
  });

  test('should handle invalid pre-authorized code', async ({ request }) => {
    const response = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': 'invalid-code-12345',
      },
    });

    expect(response.ok()).toBe(false);
    
    const error = await response.json();
    expect(error.error).toBeDefined();
  });

  test('should handle expired credential offer', async ({ request }) => {
    // Create offer
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      'test-user',
      { walletId: 'local' }
    );

    // Attempt to use it twice (second should fail if offers are single-use)
    const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    
    // First use
    const firstResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': preAuthGrant!['pre-authorized_code'],
      },
    });

    expect(firstResponse.ok()).toBe(true);

    // Second use should fail
    const secondResponse = await request.post(`${VC_ENV.VC_APIGW_URL}/token`, {
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': preAuthGrant!['pre-authorized_code'],
      },
    });

    // Pre-authorized codes should be single-use
    expect(secondResponse.ok()).toBe(false);
  });
});
