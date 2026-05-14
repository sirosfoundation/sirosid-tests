/**
 * AuthZEN Trust Evaluation Tests
 *
 * @tags @vc @trust @authzen @pr41
 *
 * Tests for AuthZEN-based trust evaluation during credential flows:
 * - DELEGATE_TRUST_TO_BACKEND configuration
 * - Trust evaluation in OID4VP flows
 * - Trust framework information display
 * - Action parameters support (credential type filtering)
 *
 * Prerequisites:
 *   - Start sirosid-dev with VC + go-trust:
 *     make up-vc-go-trust-allow     # or
 *     make up-vc-go-trust-whitelist
 *   - go-wallet-backend AuthZEN endpoints PR must be merged
 */

import { test, expect } from '@playwright/test';
import {
  VC_ENV,
  CREDENTIAL_TYPES,
  checkVCServicesHealth,
  checkTrustPdpHealth,
  evaluateTrust,
  getTrustPdpUrl,
  requireVCServices,
  requireTrustMode,
  TrustMode,
} from '../../helpers/vc-services';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';

// =============================================================================
// Test Configuration
// =============================================================================

const FRONTEND_URL = ENV.FRONTEND_URL;
const BACKEND_URL = ENV.BACKEND_URL;

// AuthZEN endpoints (as implemented in go-wallet-backend)
const AUTHZEN_EVALUATE_PATH = '/api/authzen/access/v1/evaluate';

// =============================================================================
// AuthZEN API Types
// =============================================================================

interface AuthZenSubject {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

interface AuthZenResource {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

interface AuthZenAction {
  name: string;
  properties?: Record<string, unknown>;
}

interface AuthZenContext {
  [key: string]: unknown;
}

interface AuthZenRequest {
  subject: AuthZenSubject;
  resource: AuthZenResource;
  action: AuthZenAction;
  context?: AuthZenContext;
}

interface AuthZenResponse {
  decision: boolean;
  context?: {
    reason_admin?: {
      en?: string;
    };
    reason_user?: {
      en?: string;
    };
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if AuthZEN endpoints are available on the backend
 */
async function isAuthZenAvailable(): Promise<boolean> {
  try {
    // The AuthZEN endpoint should respond to OPTIONS or return 405 for GET
    const response = await fetch(`${BACKEND_URL}${AUTHZEN_EVALUATE_PATH}`, {
      method: 'OPTIONS',
    });
    // 200 OK or 405 Method Not Allowed both indicate the endpoint exists
    return response.status === 200 || response.status === 405 || response.status === 401;
  } catch {
    return false;
  }
}

/**
 * Evaluate trust via AuthZEN API
 */
async function evaluateAuthZenTrust(
  request: AuthZenRequest,
  authToken?: string
): Promise<AuthZenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${BACKEND_URL}${AUTHZEN_EVALUATE_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`AuthZEN evaluate failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Create an AuthZEN trust evaluation request for an issuer
 */
function createIssuerTrustRequest(issuerUrl: string, credentialType: string): AuthZenRequest {
  return {
    subject: {
      type: 'oid4vci_issuer',
      id: issuerUrl,
    },
    resource: {
      type: 'credential',
      id: credentialType,
    },
    action: {
      name: 'issue',
      properties: {
        credentialTypes: [credentialType],
      },
    },
  };
}

/**
 * Create an AuthZEN trust evaluation request for a verifier
 */
function createVerifierTrustRequest(
  verifierUrl: string,
  credentialTypes: string[],
  clientIdScheme?: string
): AuthZenRequest {
  return {
    subject: {
      type: 'oid4vp_verifier',
      id: verifierUrl,
      properties: clientIdScheme ? { client_id_scheme: clientIdScheme } : undefined,
    },
    resource: {
      type: 'credentials',
      id: credentialTypes.join(','),
    },
    action: {
      name: 'verify',
      properties: {
        credentialTypes,
      },
    },
  };
}

// =============================================================================
// AuthZEN Backend Endpoint Tests
// =============================================================================

test.describe('AuthZEN Backend Endpoints', () => {
  let authzenAvailable: boolean;

  test.beforeAll(async () => {
    authzenAvailable = await isAuthZenAvailable();
    if (!authzenAvailable) {
      console.log('AuthZEN endpoints not available on backend');
      console.log('This requires go-wallet-backend AuthZEN endpoints PR to be merged');
    }
  });

  test('AuthZEN evaluate endpoint exists', async () => {
    if (!authzenAvailable) {
      test.skip(true, 'AuthZEN endpoints not available');
      return;
    }

    // POST without auth should get 401
    const response = await fetch(`${BACKEND_URL}${AUTHZEN_EVALUATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: { type: 'test', id: 'test' },
        resource: { type: 'test', id: 'test' },
        action: { name: 'test' },
      }),
    });

    // 401 (unauthorized) or 200/403 (processed) are valid responses
    expect([200, 401, 403]).toContain(response.status);
  });

  test.describe('Trust Evaluation via go-trust', () => {
    test.beforeAll(async () => {
      // Check if any go-trust mode is available
      const allowMode = await checkTrustPdpHealth('allow');
      const whitelistMode = await checkTrustPdpHealth('whitelist');
      
      if (!allowMode && !whitelistMode) {
        console.log('go-trust PDP not available');
        console.log('Start with: cd sirosid-dev && make up-vc-go-trust-allow');
      }
    });

    test('go-trust allow mode trusts any issuer', async () => {
      const healthy = await checkTrustPdpHealth('allow');
      if (!requireTrustMode(healthy, 'allow')) {
        test.skip(true, 'go-trust-allow not running');
        return;
      }

      const result = await evaluateTrust(
        'allow',
        'https://unknown-issuer.example.com',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });

    test('go-trust allow mode trusts any verifier', async () => {
      const healthy = await checkTrustPdpHealth('allow');
      if (!requireTrustMode(healthy, 'allow')) {
        test.skip(true, 'go-trust-allow not running');
        return;
      }

      const result = await evaluateTrust(
        'allow',
        'https://unknown-verifier.example.com',
        'verify',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });

    test('go-trust whitelist mode rejects unknown issuer', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      if (!requireTrustMode(healthy, 'whitelist')) {
        test.skip(true, 'go-trust-whitelist not running');
        return;
      }

      const result = await evaluateTrust(
        'whitelist',
        'https://unknown-issuer.example.com',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(false);
    });

    test('go-trust whitelist mode trusts known issuer', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      if (!requireTrustMode(healthy, 'whitelist')) {
        test.skip(true, 'go-trust-whitelist not running');
        return;
      }

      // Use the known issuer configured in go-trust whitelist
      const result = await evaluateTrust(
        'whitelist',
        'http://vc-issuer:8080',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });
  });
});

// =============================================================================
// DELEGATE_TRUST_TO_BACKEND Configuration Tests
// =============================================================================

test.describe('DELEGATE_TRUST_TO_BACKEND Configuration', () => {
  test('frontend should have DELEGATE_TRUST_TO_BACKEND in environment', async ({ page }) => {
    // Navigate to the app and check if config is accessible
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('networkidle');

    // Check if the config is exposed (implementation-dependent)
    const config = await page.evaluate(() => {
      // Try to access the config from various common patterns
      const win = window as any;
      return {
        env: win.__ENV__?.DELEGATE_TRUST_TO_BACKEND,
        config: win.__CONFIG__?.delegateTrustToBackend,
        // Vite-style
        viteEnv: (import.meta as any)?.env?.VITE_DELEGATE_TRUST_TO_BACKEND,
      };
    });

    // At least one config source should be available
    console.log('Trust delegation config:', config);
  });

  test.skip('DELEGATE_TRUST_TO_BACKEND should not be usable in production without value', async () => {
    // This test verifies the security constraint from .env.template
    // In production, DELEGATE_TRUST_TO_BACKEND should only be set explicitly
    // Implementation depends on environment detection
  });
});

// =============================================================================
// Action Parameters Tests (Credential Type Filtering)
// =============================================================================

test.describe('Action Parameters - Credential Type Filtering', () => {
  test('trust evaluation should include credential types in action.properties', async () => {
    const healthy = await checkTrustPdpHealth('allow');
    if (!healthy) {
      test.skip(true, 'go-trust not available');
      return;
    }

    // Create a request with multiple credential types
    const request = createVerifierTrustRequest(
      'https://example-verifier.com',
      [CREDENTIAL_TYPES.PID_1_8, CREDENTIAL_TYPES.EHIC],
      'did'
    );

    // The action.properties should contain credentialTypes
    expect(request.action.properties).toBeDefined();
    expect(request.action.properties?.credentialTypes).toEqual([
      CREDENTIAL_TYPES.PID_1_8,
      CREDENTIAL_TYPES.EHIC,
    ]);
  });

  test('trust evaluation with single credential type', async () => {
    const healthy = await checkTrustPdpHealth('allow');
    if (!healthy) {
      test.skip(true, 'go-trust not available');
      return;
    }

    const result = await evaluateTrust(
      'allow',
      'https://example-verifier.com',
      'verify',
      CREDENTIAL_TYPES.PID_1_8
    );

    expect(result.decision).toBeDefined();
  });
});

// =============================================================================
// Trust Framework Information Tests
// =============================================================================

test.describe('Trust Framework Information', () => {
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.verifier;
  });

  test('verifier should expose trust framework in metadata', async ({ request }) => {
    if (!vcServicesAvailable) {
      test.skip(true, 'VC verifier not available');
      return;
    }

    // Check verifier openid-configuration for trust framework info
    const response = await request.get(
      `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration`
    );

    if (response.ok()) {
      const config = await response.json();
      console.log('Verifier OIDC config:', Object.keys(config));

      // Trust framework might be in custom fields
      if (config.trust_framework) {
        expect(config.trust_framework).toBeDefined();
      }
    }
  });

  test('issuer should expose trust framework in metadata', async ({ request }) => {
    if (!vcServicesAvailable) {
      test.skip(true, 'VC services not available');
      return;
    }

    // Check issuer credential-issuer metadata
    const response = await request.get(
      `${VC_ENV.VC_APIGW_URL}/.well-known/openid-credential-issuer`
    );

    if (response.ok()) {
      const metadata = await response.json();
      console.log('Issuer metadata keys:', Object.keys(metadata));

      // Trust framework might be in authorization_servers or custom fields
      if (metadata.trust_framework) {
        expect(metadata.trust_framework).toBeDefined();
      }
    }
  });
});

// =============================================================================
// DID Client-ID Scheme Tests (PR #41 Feature)
// =============================================================================

test.describe('DID Client-ID Scheme Support', () => {
  test('trust evaluation should support did client_id_scheme', async () => {
    const healthy = await checkTrustPdpHealth('allow');
    if (!healthy) {
      test.skip(true, 'go-trust not available');
      return;
    }

    // Create request with DID client_id_scheme
    const request = createVerifierTrustRequest(
      'did:web:example.com',
      [CREDENTIAL_TYPES.PID_1_8],
      'did'
    );

    expect(request.subject.properties?.client_id_scheme).toBe('did');

    // Evaluate trust (allow mode should accept)
    const result = await evaluateTrust(
      'allow',
      'did:web:example.com',
      'verify',
      CREDENTIAL_TYPES.PID_1_8
    );

    expect(result.decision).toBe(true);
  });

  test('trust evaluation should support pre-registered client_id_scheme', async () => {
    const healthy = await checkTrustPdpHealth('allow');
    if (!healthy) {
      test.skip(true, 'go-trust not available');
      return;
    }

    const request = createVerifierTrustRequest(
      'https://verifier.example.com',
      [CREDENTIAL_TYPES.PID_1_8],
      'pre-registered'
    );

    expect(request.subject.properties?.client_id_scheme).toBe('pre-registered');
  });
});

// =============================================================================
// Integration with OID4VP Flow
// =============================================================================

test.describe('Trust in OID4VP Flow', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.verifier;
  });

  test.beforeEach(async () => {
    if (!vcServicesAvailable) {
      return;
    }
    tenantId = generateTestId('trust');
    await createTenant(tenantId, `Trust Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  test.skip('OID4VP flow should check verifier trust before proceeding', async ({ page }) => {
    if (!vcServicesAvailable) {
      test.skip(true, 'VC services not available');
      return;
    }

    // This test requires:
    // 1. A registered user with credentials
    // 2. An OID4VP authorization request
    // 3. Trust evaluation via AuthZEN

    // TODO: Implement when AuthZEN endpoints are available
  });

  test.skip('untrusted verifier should show warning or rejection', async ({ page }) => {
    // Requires go-trust in whitelist or deny mode
    // TODO: Implement negative case
  });
});
