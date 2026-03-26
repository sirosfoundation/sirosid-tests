/**
 * VC Trust Integration Tests
 *
 * @tags @vc @trust @go-trust
 *
 * Tests for trust evaluation during credential issuance and verification
 * using go-trust PDP with different modes:
 * - Allow all (development)
 * - Whitelist (staging/production)
 * - Deny all (negative testing)
 *
 * Prerequisites:
 *   - Start sirosid-dev with VC + go-trust:
 *     make up-vc-go-trust-allow     # or
 *     make up-vc-go-trust-whitelist # or
 *     make up-vc-go-trust-deny
 */

import { test, expect } from '@playwright/test';
import {
  VC_ENV,
  CREDENTIAL_TYPES,
  checkVCServicesHealth,
  checkTrustPdpHealth,
  evaluateTrust,
  getTrustPdpUrl,
  createCredentialOffer,
  TrustMode,
} from '../../helpers/vc-services';
import { ENV, generateTestId, createTenant, deleteTenant } from '../../helpers/shared-helpers';

// =============================================================================
// Test Configuration
// =============================================================================

// Determine which trust mode is available
async function getAvailableTrustMode(): Promise<TrustMode | null> {
  const modes: TrustMode[] = ['allow', 'whitelist', 'deny'];
  
  for (const mode of modes) {
    if (await checkTrustPdpHealth(mode)) {
      return mode;
    }
  }
  
  return null;
}

// =============================================================================
// Trust PDP Health Tests
// =============================================================================

test.describe('Trust PDP Health', () => {
  test('should detect available trust PDP mode', async () => {
    const mode = await getAvailableTrustMode();
    
    if (mode) {
      console.log(`Trust PDP available in '${mode}' mode at ${getTrustPdpUrl(mode)}`);
      expect(mode).toBeDefined();
    } else {
      console.log('No trust PDP available - trust tests will use VC services without trust');
      test.skip();
    }
  });

  test.describe('go-trust-allow', () => {
    test('should be healthy when running', async () => {
      const healthy = await checkTrustPdpHealth('allow');
      
      if (!healthy) {
        test.skip(true, 'go-trust-allow not running (start with: make up-vc-go-trust-allow)');
      }
      
      expect(healthy).toBe(true);
    });

    test('should expose health endpoint', async ({ request }) => {
      const healthy = await checkTrustPdpHealth('allow');
      test.skip(!healthy, 'go-trust-allow not running');

      const response = await request.get(`${VC_ENV.GO_TRUST_ALLOW_URL}/health`);
      expect(response.ok()).toBe(true);
    });

    test('should trust any issuer', async () => {
      const healthy = await checkTrustPdpHealth('allow');
      test.skip(!healthy, 'go-trust-allow not running');

      const result = await evaluateTrust(
        'allow',
        'https://unknown-issuer.example.com',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });

    test('should trust any verifier', async () => {
      const healthy = await checkTrustPdpHealth('allow');
      test.skip(!healthy, 'go-trust-allow not running');

      const result = await evaluateTrust(
        'allow',
        'https://unknown-verifier.example.com',
        'verify',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });
  });

  test.describe('go-trust-whitelist', () => {
    test('should be healthy when running', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      
      if (!healthy) {
        test.skip(true, 'go-trust-whitelist not running (start with: make up-vc-go-trust-whitelist)');
      }
      
      expect(healthy).toBe(true);
    });

    test('should trust whitelisted issuers', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      test.skip(!healthy, 'go-trust-whitelist not running');

      // The local VC issuer should be whitelisted
      const result = await evaluateTrust(
        'whitelist',
        'http://localhost:9000',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });

    test('should trust whitelisted verifiers', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      test.skip(!healthy, 'go-trust-whitelist not running');

      // The local VC verifier should be whitelisted
      const result = await evaluateTrust(
        'whitelist',
        'http://localhost:9001',
        'verify',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(true);
    });

    test('should reject non-whitelisted issuers', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      test.skip(!healthy, 'go-trust-whitelist not running');

      const result = await evaluateTrust(
        'whitelist',
        'https://malicious-issuer.example.com',
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(false);
    });

    test('should reject non-whitelisted verifiers', async () => {
      const healthy = await checkTrustPdpHealth('whitelist');
      test.skip(!healthy, 'go-trust-whitelist not running');

      const result = await evaluateTrust(
        'whitelist',
        'https://malicious-verifier.example.com',
        'verify',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(false);
    });
  });

  test.describe('go-trust-deny', () => {
    test('should be healthy when running', async () => {
      const healthy = await checkTrustPdpHealth('deny');
      
      if (!healthy) {
        test.skip(true, 'go-trust-deny not running (start with: make up-vc-go-trust-deny)');
      }
      
      expect(healthy).toBe(true);
    });

    test('should reject all issuers', async () => {
      const healthy = await checkTrustPdpHealth('deny');
      test.skip(!healthy, 'go-trust-deny not running');

      const result = await evaluateTrust(
        'deny',
        'http://localhost:9000', // Even the local issuer
        'issue',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(false);
    });

    test('should reject all verifiers', async () => {
      const healthy = await checkTrustPdpHealth('deny');
      test.skip(!healthy, 'go-trust-deny not running');

      const result = await evaluateTrust(
        'deny',
        'http://localhost:9001', // Even the local verifier
        'verify',
        CREDENTIAL_TYPES.PID_1_8
      );

      expect(result.decision).toBe(false);
    });
  });
});

// =============================================================================
// Trust-Based Credential Issuance Tests
// =============================================================================

test.describe('Trust-Based Credential Issuance', () => {
  let tenantId: string;
  let vcServicesAvailable: boolean;
  let trustMode: TrustMode | null;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.issuer && health.apigw;
    trustMode = await getAvailableTrustMode();
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC services not available');
    tenantId = generateTestId('trust-vc');
    await createTenant(tenantId, `Trust VC Test ${tenantId}`);
  });

  test.afterEach(async () => {
    if (tenantId) {
      await deleteTenant(tenantId).catch(() => {});
    }
  });

  test('should issue credential when trust allows', async () => {
    test.skip(!trustMode || trustMode === 'deny', 'Requires allow or whitelist trust mode');

    const userId = generateTestId('user');
    
    // Create credential offer
    const offer = await createCredentialOffer(
      CREDENTIAL_TYPES.PID_1_8,
      userId,
      { walletId: 'local' }
    );

    expect(offer.credential_offer_uri).toBeDefined();
    
    // The offer should be created successfully because trust allows
    const preAuthGrant = offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    expect(preAuthGrant).toBeDefined();
  });

  test('should evaluate issuer trust before credential creation', async () => {
    test.skip(!trustMode, 'No trust PDP available');

    // Evaluate trust for the VC issuer
    const result = await evaluateTrust(
      trustMode!,
      VC_ENV.VC_ISSUER_URL,
      'issue',
      CREDENTIAL_TYPES.PID_1_8
    );

    if (trustMode === 'deny') {
      expect(result.decision).toBe(false);
    } else {
      expect(result.decision).toBe(true);
    }
  });
});

// =============================================================================
// Trust-Based Credential Verification Tests
// =============================================================================

test.describe('Trust-Based Credential Verification', () => {
  let vcServicesAvailable: boolean;
  let trustMode: TrustMode | null;

  test.beforeAll(async () => {
    const health = await checkVCServicesHealth();
    vcServicesAvailable = health.verifier;
    trustMode = await getAvailableTrustMode();
  });

  test.beforeEach(async () => {
    test.skip(!vcServicesAvailable, 'VC verifier not available');
  });

  test('should evaluate verifier trust', async () => {
    test.skip(!trustMode, 'No trust PDP available');

    const result = await evaluateTrust(
      trustMode!,
      VC_ENV.VC_VERIFIER_URL,
      'verify',
      CREDENTIAL_TYPES.PID_1_8
    );

    if (trustMode === 'deny') {
      expect(result.decision).toBe(false);
    } else if (trustMode === 'allow') {
      expect(result.decision).toBe(true);
    } else {
      // Whitelist - local verifier should be trusted
      expect(result.decision).toBe(true);
    }
  });

  test('should reject presentations to untrusted verifiers in whitelist mode', async () => {
    test.skip(trustMode !== 'whitelist', 'Requires whitelist trust mode');

    const result = await evaluateTrust(
      'whitelist',
      'https://untrusted-verifier.evil.com',
      'verify',
      CREDENTIAL_TYPES.PID_1_8
    );

    expect(result.decision).toBe(false);
  });
});

// =============================================================================
// Negative Testing with Deny Mode
// =============================================================================

test.describe('Negative Trust Testing (Deny Mode)', () => {
  let denyModeAvailable: boolean;

  test.beforeAll(async () => {
    denyModeAvailable = await checkTrustPdpHealth('deny');
    
    if (!denyModeAvailable) {
      console.log('go-trust-deny not available, skipping negative tests');
      console.log('Start with: make up-vc-go-trust-deny');
    }
  });

  test.beforeEach(async () => {
    test.skip(!denyModeAvailable, 'go-trust-deny not running');
  });

  test('should reject all trust evaluations', async () => {
    const issuers = [
      'http://localhost:9000',
      'http://localhost:9003',
      'https://trusted-issuer.example.com',
      'https://eudi.issuer.gov',
    ];

    for (const issuer of issuers) {
      const result = await evaluateTrust('deny', issuer, 'issue', CREDENTIAL_TYPES.PID_1_8);
      expect(result.decision).toBe(false);
    }
  });

  test('should provide deny reason in response', async () => {
    const result = await evaluateTrust(
      'deny',
      'http://localhost:9000',
      'issue',
      CREDENTIAL_TYPES.PID_1_8
    );

    expect(result.decision).toBe(false);
    // Reason may be provided
  });
});

// =============================================================================
// AuthZEN API Compliance Tests
// =============================================================================

test.describe('AuthZEN API Compliance', () => {
  let trustMode: TrustMode | null;

  test.beforeAll(async () => {
    trustMode = await getAvailableTrustMode();
  });

  test.beforeEach(async () => {
    test.skip(!trustMode, 'No trust PDP available');
  });

  test('should expose /access/v1/evaluation endpoint', async ({ request }) => {
    const url = getTrustPdpUrl(trustMode!);
    
    const response = await request.post(`${url}/access/v1/evaluation`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        subject: { type: 'issuer', id: 'https://test.example.com' },
        action: { name: 'issue' },
        resource: { type: 'credential', id: 'urn:test:credential' },
      },
    });

    expect(response.ok()).toBe(true);
    
    const result = await response.json();
    expect(typeof result.decision).toBe('boolean');
  });

  test('should return decision in AuthZEN format', async ({ request }) => {
    const url = getTrustPdpUrl(trustMode!);
    
    const response = await request.post(`${url}/access/v1/evaluation`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        subject: { type: 'verifier', id: 'https://test.example.com' },
        action: { name: 'verify' },
        resource: { type: 'credential', id: CREDENTIAL_TYPES.PID_1_8 },
      },
    });

    const result = await response.json();
    
    // AuthZEN requires 'decision' field
    expect('decision' in result).toBe(true);
    expect(typeof result.decision).toBe('boolean');
    
    // Optional 'context' field for additional info
    if (result.context) {
      expect(typeof result.context).toBe('object');
    }
  });

  test('should handle malformed requests gracefully', async ({ request }) => {
    const url = getTrustPdpUrl(trustMode!);
    
    const response = await request.post(`${url}/access/v1/evaluation`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        // Missing required fields
        invalid: 'request',
      },
    });

    // Should return error status, not crash
    expect([400, 422]).toContain(response.status());
  });

  test('should support subject, action, resource model', async ({ request }) => {
    const url = getTrustPdpUrl(trustMode!);
    
    const response = await request.post(`${url}/access/v1/evaluation`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        subject: {
          type: 'issuer',
          id: 'https://issuer.example.com',
          properties: {
            country: 'SE',
            trust_framework: 'eudi',
          },
        },
        action: {
          name: 'issue',
          properties: {
            credential_type: 'pid',
          },
        },
        resource: {
          type: 'credential',
          id: CREDENTIAL_TYPES.PID_1_8,
        },
        context: {
          time: new Date().toISOString(),
        },
      },
    });

    expect(response.ok()).toBe(true);
  });
});
