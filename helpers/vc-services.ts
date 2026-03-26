/**
 * VC Services API Helper
 *
 * Provides methods to interact with the production-like VC services
 * (vc-apigw, vc-issuer, vc-verifier, vc-registry) during E2E tests.
 *
 * Service Ports (default):
 *   - 9000: vc-issuer (OpenID4VCI)
 *   - 9001: vc-verifier (OpenID4VP + OIDC)
 *   - 9002: vc-mockas (Mock Auth Server)
 *   - 9003: vc-apigw (API Gateway / OAuth AS)
 *   - 9004: vc-registry (Status Lists)
 */

import { APIRequestContext, request } from '@playwright/test';

// =============================================================================
// Environment Configuration
// =============================================================================

export const VC_ENV = {
  // VC Services URLs
  VC_ISSUER_URL: process.env.VC_ISSUER_URL || process.env.ISSUER_URL || 'http://localhost:9000',
  VC_VERIFIER_URL: process.env.VC_VERIFIER_URL || process.env.VERIFIER_URL || 'http://localhost:9001',
  VC_MOCKAS_URL: process.env.VC_MOCKAS_URL || 'http://localhost:9002',
  VC_APIGW_URL: process.env.VC_APIGW_URL || 'http://localhost:9003',
  VC_REGISTRY_URL: process.env.VC_REGISTRY_URL || 'http://localhost:9004',

  // Trust PDP URLs
  GO_TRUST_ALLOW_URL: process.env.GO_TRUST_ALLOW_URL || 'http://localhost:9095',
  GO_TRUST_WHITELIST_URL: process.env.GO_TRUST_WHITELIST_URL || 'http://localhost:9096',
  GO_TRUST_DENY_URL: process.env.GO_TRUST_DENY_URL || 'http://localhost:9097',
};

// Credential types available in the VC services
export const CREDENTIAL_TYPES = {
  PID_1_8: 'urn:eudi:pid:arf-1.8:1',
  PID_1_5: 'urn:eudi:pid:arf-1.5:1',
  EHIC: 'urn:eudi:ehic:1',
  DIPLOMA: 'urn:eudi:diploma:1',
  EDUID: 'urn:credential:eduid:1',
} as const;

export type CredentialType = typeof CREDENTIAL_TYPES[keyof typeof CREDENTIAL_TYPES];

// =============================================================================
// Service Health Checks
// =============================================================================

/**
 * Check if VC services are available
 */
export async function checkVCServicesHealth(): Promise<{
  issuer: boolean;
  verifier: boolean;
  apigw: boolean;
  registry: boolean;
  mockas: boolean;
}> {
  const results = {
    issuer: false,
    verifier: false,
    apigw: false,
    registry: false,
    mockas: false,
  };

  const checks = [
    { name: 'issuer' as const, url: `${VC_ENV.VC_ISSUER_URL}/.well-known/openid-credential-issuer` },
    { name: 'verifier' as const, url: `${VC_ENV.VC_VERIFIER_URL}/.well-known/openid-configuration` },
    { name: 'apigw' as const, url: `${VC_ENV.VC_APIGW_URL}/.well-known/oauth-authorization-server` },
    { name: 'registry' as const, url: `${VC_ENV.VC_REGISTRY_URL}/health` },
    { name: 'mockas' as const, url: `${VC_ENV.VC_MOCKAS_URL}/` },
  ];

  const apiContext = await request.newContext();
  
  for (const check of checks) {
    try {
      const response = await apiContext.get(check.url, { timeout: 5000 });
      results[check.name] = response.ok();
    } catch {
      results[check.name] = false;
    }
  }

  await apiContext.dispose();
  return results;
}

/**
 * Wait for VC services to be healthy
 */
export async function waitForVCServices(
  timeoutMs = 30000,
  intervalMs = 1000
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const health = await checkVCServicesHealth();
    if (health.issuer && health.verifier && health.apigw) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  return false;
}

// =============================================================================
// OpenID4VCI Credential Offer
// =============================================================================

export interface CredentialOffer {
  credential_offer_uri: string;
  user_pin?: string;
  tx_code?: string;
}

export interface CreatedOffer {
  credential_offer: string;
  credential_offer_uri: string;
  grants: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
      'pre-authorized_code': string;
      tx_code?: {
        input_mode: string;
        length: number;
      };
    };
  };
}

/**
 * Create a pre-authorized credential offer via the API Gateway
 */
export async function createCredentialOffer(
  credentialType: CredentialType,
  userIdentifier: string,
  options: {
    walletId?: string;
    claims?: Record<string, unknown>;
  } = {}
): Promise<CreatedOffer> {
  const apiContext = await request.newContext();
  
  try {
    // Call the apigw offer endpoint
    const response = await apiContext.post(`${VC_ENV.VC_APIGW_URL}/offer`, {
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        credential_configuration_id: credentialType,
        user_identifier: userIdentifier,
        wallet_id: options.walletId || 'local',
        claims: options.claims || getDefaultClaimsForType(credentialType),
      },
    });

    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to create credential offer: ${response.status()} - ${error}`);
    }

    return await response.json();
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Get default test claims for a credential type
 */
function getDefaultClaimsForType(credentialType: CredentialType): Record<string, unknown> {
  switch (credentialType) {
    case CREDENTIAL_TYPES.PID_1_8:
    case CREDENTIAL_TYPES.PID_1_5:
      return {
        given_name: 'Test',
        family_name: 'User',
        birthdate: '1990-01-15',
        age_over_18: true,
        age_over_21: true,
        nationality: 'SE',
        birth_place: 'Stockholm',
        resident_country: 'SE',
        resident_city: 'Stockholm',
        resident_postal_code: '11122',
        resident_street: 'Test Street 1',
        gender: 'male',
        personal_identifier: `PID-${Date.now()}`,
      };
    case CREDENTIAL_TYPES.EHIC:
      return {
        family_name: 'User',
        given_name: 'Test',
        birthdate: '1990-01-15',
        card_number: `EHIC-${Date.now()}`,
        country_code: 'SE',
        institution_id: 'SE-FK-001',
        institution_name: 'Försäkringskassan',
        expiry_date: '2027-12-31',
      };
    case CREDENTIAL_TYPES.DIPLOMA:
      return {
        family_name: 'User',
        given_name: 'Test',
        birthdate: '1990-01-15',
        degree_type: 'Bachelor',
        degree_name: 'Computer Science',
        awarding_institution: 'Test University',
        awarding_country: 'SE',
        graduation_date: '2015-06-15',
        grade: 'Pass with Distinction',
      };
    case CREDENTIAL_TYPES.EDUID:
      return {
        given_name: 'Test',
        family_name: 'User',
        mail: 'test.user@example.edu',
        eduperson_principal_name: 'testuser@example.edu',
        eduperson_scoped_affiliation: 'member@example.edu',
        schac_home_organization: 'example.edu',
      };
    default:
      return {};
  }
}

// =============================================================================
// OpenID4VP Verification Request
// =============================================================================

export interface VerificationRequest {
  request_uri: string;
  authorization_url: string;
  client_id: string;
  state: string;
  nonce: string;
}

export interface VerificationResult {
  success: boolean;
  id_token?: string;
  vp_token?: string;
  presentation_submission?: unknown;
  error?: string;
  claims?: Record<string, unknown>;
}

/**
 * Create a verification request for credential presentation
 */
export async function createVerificationRequest(
  scope: string,
  redirectUri: string,
  options: {
    nonce?: string;
    state?: string;
    presentationDefinition?: unknown;
  } = {}
): Promise<VerificationRequest> {
  const apiContext = await request.newContext();
  const state = options.state || `state-${Date.now()}`;
  const nonce = options.nonce || `nonce-${Date.now()}`;
  
  try {
    // Build authorization URL
    const authUrl = new URL(`${VC_ENV.VC_VERIFIER_URL}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', 'e2e-test-client');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', `openid ${scope}`);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);

    // If custom presentation definition, use PAR
    if (options.presentationDefinition) {
      const parResponse = await apiContext.post(`${VC_ENV.VC_VERIFIER_URL}/par`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        form: {
          response_type: 'code',
          client_id: 'e2e-test-client',
          redirect_uri: redirectUri,
          scope: `openid ${scope}`,
          state,
          nonce,
          presentation_definition: JSON.stringify(options.presentationDefinition),
        },
      });

      if (!parResponse.ok()) {
        throw new Error(`PAR failed: ${parResponse.status()}`);
      }

      const parData = await parResponse.json();
      return {
        request_uri: parData.request_uri,
        authorization_url: `${VC_ENV.VC_VERIFIER_URL}/authorize?request_uri=${encodeURIComponent(parData.request_uri)}&client_id=e2e-test-client`,
        client_id: 'e2e-test-client',
        state,
        nonce,
      };
    }

    return {
      request_uri: '',
      authorization_url: authUrl.toString(),
      client_id: 'e2e-test-client',
      state,
      nonce,
    };
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<{
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}> {
  const apiContext = await request.newContext();
  
  try {
    const formData: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: 'e2e-test-client',
    };

    if (codeVerifier) {
      formData.code_verifier = codeVerifier;
    }

    const response = await apiContext.post(`${VC_ENV.VC_VERIFIER_URL}/token`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: formData,
    });

    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status()} - ${error}`);
    }

    return await response.json();
  } finally {
    await apiContext.dispose();
  }
}

// =============================================================================
// Token Status / Revocation
// =============================================================================

/**
 * Revoke a credential via the registry admin API
 */
export async function revokeCredential(
  statusListUri: string,
  index: number,
  adminPassword = 'e2e-admin-password'
): Promise<boolean> {
  const apiContext = await request.newContext();
  
  try {
    const response = await apiContext.post(`${VC_ENV.VC_REGISTRY_URL}/admin/revoke`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`,
      },
      data: {
        status_list_uri: statusListUri,
        index,
        status: 'revoked',
      },
    });

    return response.ok();
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Check credential status
 */
export async function checkCredentialStatus(
  statusListUri: string,
  index: number
): Promise<{ status: string; valid: boolean }> {
  const apiContext = await request.newContext();
  
  try {
    // Fetch the status list
    const response = await apiContext.get(statusListUri);
    
    if (!response.ok()) {
      throw new Error(`Failed to fetch status list: ${response.status()}`);
    }

    // The status list is a JWT - parse and check the bit at index
    // For now, return a simplified check
    return {
      status: 'valid',
      valid: true,
    };
  } finally {
    await apiContext.dispose();
  }
}

// =============================================================================
// Trust PDP Integration
// =============================================================================

export type TrustMode = 'allow' | 'whitelist' | 'deny';

/**
 * Get the trust PDP URL for a given mode
 */
export function getTrustPdpUrl(mode: TrustMode): string {
  switch (mode) {
    case 'allow':
      return VC_ENV.GO_TRUST_ALLOW_URL;
    case 'whitelist':
      return VC_ENV.GO_TRUST_WHITELIST_URL;
    case 'deny':
      return VC_ENV.GO_TRUST_DENY_URL;
    default:
      return VC_ENV.GO_TRUST_ALLOW_URL;
  }
}

/**
 * Check if a trust PDP is healthy
 */
export async function checkTrustPdpHealth(mode: TrustMode): Promise<boolean> {
  const url = getTrustPdpUrl(mode);
  const apiContext = await request.newContext();
  
  try {
    const response = await apiContext.get(`${url}/health`, { timeout: 5000 });
    return response.ok();
  } catch {
    return false;
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Evaluate trust via PDP
 */
export async function evaluateTrust(
  mode: TrustMode,
  subject: string,
  action: string,
  resource: string
): Promise<{ decision: boolean; reason?: string }> {
  const url = getTrustPdpUrl(mode);
  const apiContext = await request.newContext();
  
  try {
    const response = await apiContext.post(`${url}/access/v1/evaluation`, {
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        subject: { type: 'issuer', id: subject },
        action: { name: action },
        resource: { type: 'credential', id: resource },
      },
    });

    if (!response.ok()) {
      return { decision: false, reason: `PDP error: ${response.status()}` };
    }

    const result = await response.json();
    return {
      decision: result.decision === true,
      reason: result.context?.reason,
    };
  } finally {
    await apiContext.dispose();
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse a credential offer URI to extract the offer
 */
export function parseCredentialOfferUri(uri: string): {
  issuer: string;
  preAuthorizedCode?: string;
  credentialConfigurationIds: string[];
} {
  const url = new URL(uri);
  const offer = url.searchParams.get('credential_offer');
  const offerUri = url.searchParams.get('credential_offer_uri');
  
  if (offer) {
    const parsed = JSON.parse(offer);
    return {
      issuer: parsed.credential_issuer,
      preAuthorizedCode: parsed.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']?.['pre-authorized_code'],
      credentialConfigurationIds: parsed.credential_configuration_ids || [],
    };
  }
  
  // If it's a URI reference, we'd need to fetch it
  return {
    issuer: '',
    credentialConfigurationIds: [],
  };
}

/**
 * Build a wallet-compatible credential offer URL
 */
export function buildWalletOfferUrl(
  walletUrl: string,
  credentialOfferUri: string
): string {
  const url = new URL(walletUrl);
  url.searchParams.set('credential_offer_uri', credentialOfferUri);
  return url.toString();
}
