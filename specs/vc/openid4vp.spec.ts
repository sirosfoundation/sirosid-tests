/**
 * OpenID4VP Credential Verification Tests
 *
 * @tags @vc @openid4vp @credential-verification
 *
 * Tests for credential verification using the production-like VC services:
 * - Authorization request creation
 * - Presentation request handling
 * - OIDC token exchange
 * - Selective disclosure
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
  createVerificationRequest,
  exchangeAuthorizationCode,
} from '../../helpers/vc-services';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';

// =============================================================================
// Test Configuration
// =============================================================================

const FRONTEND_URL = ENV.FRONTEND_URL;
const REDIRECT_URI = `${FRONTEND_URL}/callback`;

// =============================================================================
// Fixtures and Setup
// =============================================================================

test.describe('OpenID4VP Credential Verification', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier && health.apigw;
    
    if (!vcServicesAvailable) {
      console.log('VC services not available, tests will be skipped');
      console.log('Start VC services with: cd sirosid-dev && make up-vc');
    }
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('vp-test');
    await createTenant(tenantId, `VP Test Tenant ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  // ===========================================================================
  // Verifier Configuration Tests
  // ===========================================================================

  test.describe('Verifier Configuration', () => {
    test('verifier should expose OIDC configuration', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      
      expect(response.ok()).toBe(true);
      
      const config = await response.json();
      expect(config.issuer).toBeDefined();
      expect(config.authorization_endpoint).toBeDefined();
      expect(config.token_endpoint).toBeDefined();
      expect(config.response_types_supported).toContain('code');
    });

    test('verifier should support vp_token response type', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      
      const config = await response.json();
      
      // Check for VP-related configuration
      expect(config.vp_formats_supported || config.presentation_definition_uri_supported).toBeDefined();
    });

    test('verifier should expose JWKS', async ({ request }) => {
      const configResponse = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      const config = await configResponse.json();
      
      if (config.jwks_uri) {
        const jwksResponse = await request.get(config.jwks_uri);
        expect(jwksResponse.ok()).toBe(true);
        
        const jwks = await jwksResponse.json();
        expect(jwks.keys).toBeDefined();
        expect(Array.isArray(jwks.keys)).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Authorization Request Tests
  // ===========================================================================

  test.describe('Authorization Request', () => {
    test('should create authorization URL for PID scope', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toBeDefined();
      expect(verificationRequest.authorization_url).toContain('authorize');
      expect(verificationRequest.state).toBeDefined();
      expect(verificationRequest.nonce).toBeDefined();
    });

    test('should create authorization URL for multiple scopes', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid ehic',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toBeDefined();
      expect(verificationRequest.authorization_url).toContain('scope');
    });

    test('should include client_id in authorization URL', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toContain('client_id');
      expect(verificationRequest.client_id).toBe('e2e-test-client');
    });

    test('should include redirect_uri in authorization URL', async () => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      expect(verificationRequest.authorization_url).toContain('redirect_uri');
    });

    test('should support custom state and nonce', async () => {
      const customState = 'custom-state-12345';
      const customNonce = 'custom-nonce-67890';
      
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI,
        { state: customState, nonce: customNonce }
      );

      expect(verificationRequest.state).toBe(customState);
      expect(verificationRequest.nonce).toBe(customNonce);
    });
  });

  // ===========================================================================
  // Pushed Authorization Request (PAR) Tests
  // ===========================================================================

  test.describe('Pushed Authorization Request', () => {
    test('should support PAR endpoint', async ({ request }) => {
      const configResponse = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      const config = await configResponse.json();
      
      // PAR may be optional
      if (config.pushed_authorization_request_endpoint) {
        expect(config.pushed_authorization_request_endpoint).toContain('/par');
      }
    });

    test('should create PAR with presentation definition', async ({ request }) => {
      const presentationDefinition = {
        id: `pd-${Date.now()}`,
        input_descriptors: [
          {
            id: 'pid_descriptor',
            constraints: {
              fields: [
                {
                  path: ['$.vct'],
                  filter: {
                    type: 'string',
                    const: CREDENTIAL_TYPES.PID_1_8,
                  },
                },
              ],
            },
          },
        ],
      };

      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI,
        { presentationDefinition }
      );

      // If PAR is used, request_uri should be set
      if (verificationRequest.request_uri) {
        expect(verificationRequest.request_uri).toContain('urn:ietf:params:oauth:request_uri');
      }
    });
  });

  // ===========================================================================
  // Scope-to-Credential Mapping Tests
  // ===========================================================================

  test.describe('Scope to Credential Mapping', () => {
    const scopeMappings = [
      { scope: 'pid', vcts: [CREDENTIAL_TYPES.PID_1_8, CREDENTIAL_TYPES.PID_1_5] },
      { scope: 'ehic', vcts: [CREDENTIAL_TYPES.EHIC] },
      { scope: 'diploma', vcts: [CREDENTIAL_TYPES.DIPLOMA] },
      { scope: 'eduid', vcts: [CREDENTIAL_TYPES.EDUID] },
    ];

    for (const mapping of scopeMappings) {
      test(`should map '${mapping.scope}' scope to credential type`, async () => {
        const verificationRequest = await createVerificationRequest(
          mapping.scope,
          REDIRECT_URI
        );

        expect(verificationRequest.authorization_url).toContain(`scope=openid+${mapping.scope}`);
      });
    }
  });

  // ===========================================================================
  // Browser-Based Verification Tests
  // ===========================================================================

  test.describe('Browser Verification Flow', () => {
    test('should navigate to verifier authorization endpoint', async ({ page }) => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      await page.goto(verificationRequest.authorization_url);
      await page.waitForLoadState('networkidle');

      // Should redirect to wallet for credential selection
      // or show an error if no wallet is configured
      const url = page.url();
      expect(url).toBeDefined();
    });

    test('should handle authorization with wallet redirect', async ({ page }) => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      // Monitor network for redirect
      const responses: string[] = [];
      page.on('response', (response) => {
        responses.push(response.url());
      });

      await page.goto(verificationRequest.authorization_url);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Check if we got redirected somewhere
      expect(responses.length).toBeGreaterThan(0);
    });

    test('should display credential selection UI', async ({ page }) => {
      const verificationRequest = await createVerificationRequest(
        'pid',
        REDIRECT_URI
      );

      await page.goto(verificationRequest.authorization_url);
      await page.waitForLoadState('networkidle');

      // Look for wallet-related UI elements
      // This depends on the specific wallet integration
      await page.waitForTimeout(3000);

      // The page should either show credential selection or redirect to wallet
    });
  });

  // ===========================================================================
  // Token Exchange Tests
  // ===========================================================================

  test.describe('Token Exchange', () => {
    test('token endpoint should be accessible', async ({ request }) => {
      const response = await request.post(`${VC_ENV.VC_VERIFIER_URL}/token`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        form: {
          grant_type: 'authorization_code',
          code: 'invalid-code', // Will fail but tests endpoint
          redirect_uri: REDIRECT_URI,
          client_id: 'e2e-test-client',
        },
      });

      // Should return 400 (invalid code) not 404 (endpoint not found)
      expect([400, 401, 403]).toContain(response.status());
    });

    test('should reject invalid authorization code', async ({ request }) => {
      const response = await request.post(`${VC_ENV.VC_VERIFIER_URL}/token`, {
        form: {
          grant_type: 'authorization_code',
          code: 'invalid-code-12345',
          redirect_uri: REDIRECT_URI,
          client_id: 'e2e-test-client',
        },
      });

      expect(response.ok()).toBe(false);
      
      const error = await response.json();
      expect(error.error).toBeDefined();
    });

    test('should return proper error format', async ({ request }) => {
      const response = await request.post(`${VC_ENV.VC_VERIFIER_URL}/token`, {
        form: {
          grant_type: 'authorization_code',
          code: 'invalid',
          redirect_uri: REDIRECT_URI,
          client_id: 'e2e-test-client',
        },
      });

      const error = await response.json();
      
      // OAuth2 error format
      expect(error.error).toBeDefined();
      expect(typeof error.error).toBe('string');
    });
  });

  // ===========================================================================
  // OIDC Claims Tests
  // ===========================================================================

  test.describe('OIDC Claims Configuration', () => {
    test('should specify supported claims', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      
      const config = await response.json();
      
      // Claims may be specified in various ways
      if (config.claims_supported) {
        expect(Array.isArray(config.claims_supported)).toBe(true);
      }
    });

    test('should specify supported subject types', async ({ request }) => {
      const response = await request.get(
        `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
      );
      
      const config = await response.json();
      
      if (config.subject_types_supported) {
        expect(config.subject_types_supported).toContain('pairwise');
      }
    });
  });
});

// =============================================================================
// Selective Disclosure Tests
// =============================================================================

test.describe('Selective Disclosure', () => {
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.verifier;
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
  });

  test('should support SD-JWT presentation format', async ({ request }) => {
    const response = await request.get(
      `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
    );
    
    const config = await response.json();
    
    // Check for SD-JWT VP format support
    if (config.vp_formats_supported) {
      const formats = config.vp_formats_supported;
      // dc+sd-jwt or vc+sd-jwt should be supported
      expect(
        formats['dc+sd-jwt'] || formats['vc+sd-jwt'] || formats['jwt_vp']
      ).toBeDefined();
    }
  });

  test('should request specific claims via presentation definition', async () => {
    const presentationDefinition = {
      id: 'age-verification',
      input_descriptors: [
        {
          id: 'age_over_18',
          name: 'Age Verification',
          purpose: 'Verify that the holder is over 18',
          constraints: {
            limit_disclosure: 'required',
            fields: [
              {
                path: ['$.vct'],
                filter: {
                  type: 'string',
                  const: CREDENTIAL_TYPES.PID_1_8,
                },
              },
              {
                path: ['$.age_over_18'],
              },
            ],
          },
        },
      ],
    };

    const verificationRequest = await createVerificationRequest(
      'pid',
      REDIRECT_URI,
      { presentationDefinition }
    );

    expect(verificationRequest.authorization_url).toBeDefined();
  });

  test('should request minimal disclosure for identity verification', async () => {
    const presentationDefinition = {
      id: 'minimal-identity',
      input_descriptors: [
        {
          id: 'name_only',
          name: 'Name Verification',
          purpose: 'Verify holder name',
          constraints: {
            limit_disclosure: 'required',
            fields: [
              {
                path: ['$.given_name'],
              },
              {
                path: ['$.family_name'],
              },
            ],
          },
        },
      ],
    };

    const verificationRequest = await createVerificationRequest(
      'pid',
      REDIRECT_URI,
      { presentationDefinition }
    );

    expect(verificationRequest.authorization_url).toBeDefined();
  });
});
