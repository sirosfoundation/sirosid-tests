/**
 * API Integration Tests for wallet-frontend ↔ go-wallet-backend compatibility
 *
 * @tags @api
 *
 * These tests verify that the data formats exchanged between frontend and backend
 * are compatible, without requiring the full WebAuthn PRF flow.
 *
 * Auth contract under test (go-wallet-backend #100/#429/#436):
 *  - session mode: /auth/passkey/{register,login}/{begin,finish} with
 *    `X-Token-Mode: session`, then POST /auth/token for an access token.
 *  - legacy HMAC endpoints (/user/*-webauthn-*, /user/session/refresh and
 *    /auth/passkey/* without the header) are asserted ONLY according to the
 *    target backend: HTTP 410 `legacy_tokens_disabled` when legacy is off,
 *    the original tagged-binary contract when it is still enabled. The mode
 *    is auto-detected; set LEGACY_AUTH=enabled|disabled to force (and fail
 *    on mismatch) instead of auto-detecting.
 */

import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

import {
  SESSION_MODE_HEADERS,
  detectLegacyAuth,
  type LegacyAuthStatus,
} from '../../helpers/auth-endpoints';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

// Endpoints of the AS passkey flow (session mode) and the legacy HMAC AS.
const SESSION = {
  registerBegin: '/auth/passkey/register/begin',
  registerFinish: '/auth/passkey/register/finish',
  loginBegin: '/auth/passkey/login/begin',
  loginFinish: '/auth/passkey/login/finish',
  token: '/auth/token',
};
const LEGACY = {
  registerBegin: '/user/register-webauthn-begin',
  registerFinish: '/user/register-webauthn-finish',
  loginBegin: '/user/login-webauthn-begin',
  loginFinish: '/user/login-webauthn-finish',
  refresh: '/user/session/refresh',
};

// Helper to generate test data in the same format the frontend uses
function toBase64Url(buffer: Uint8Array | ArrayBuffer): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64Url(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildMockPrivateData(mockRawId: Uint8Array) {
  return {
      mainKey: {
        publicKey: {
          importKey: {
            format: 'raw',
            keyData: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(65))) },
            algorithm: { name: 'ECDH', namedCurve: 'P-256' },
          },
        },
        unwrapKey: {
          format: 'raw',
          unwrapAlgo: 'AES-KW',
          unwrappedKeyAlgo: { name: 'AES-GCM', length: 256 },
        },
      },
      prfKeys: [{
        credentialId: { $b64u: toBase64Url(mockRawId) },
        transports: [],
        prfSalt: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) },
        hkdfSalt: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) },
        hkdfInfo: { $b64u: toBase64Url(new TextEncoder().encode('test')) },
        algorithm: { name: 'AES-GCM', length: 256 },
        keypair: {
          publicKey: {
            importKey: {
              format: 'raw',
              keyData: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(65))) },
              algorithm: { name: 'ECDH', namedCurve: 'P-256' },
            },
          },
          privateKey: {
            unwrapKey: {
              format: 'jwk',
              wrappedKey: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(256))) },
              unwrapAlgo: {
                name: 'AES-GCM',
                iv: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) },
              },
              unwrappedKeyAlgo: { name: 'ECDH', namedCurve: 'P-256' },
            },
          },
        },
        unwrapKey: {
          wrappedKey: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(40))) },
          unwrappingKey: {
            deriveKey: {
              algorithm: { name: 'ECDH' },
              derivedKeyAlgorithm: { name: 'AES-KW', length: 256 },
            },
          },
        },
      }],
      jwe: 'dummy.jwe.value',
    };
}

function buildMockRegistration(challengeB64u: string) {
  const mockRawId = crypto.getRandomValues(new Uint8Array(32));
  const mockAttestationObject = crypto.getRandomValues(new Uint8Array(128));
  const mockClientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.create',
    challenge: challengeB64u,
    origin: 'http://localhost:3000',
    crossOrigin: false,
  }));
  return {
    displayName: 'Test User',
    privateData: buildMockPrivateData(mockRawId),
    credential: {
      type: 'public-key',
      id: toBase64Url(mockRawId),
      rawId: { $b64u: toBase64Url(mockRawId) },
      response: {
        attestationObject: { $b64u: toBase64Url(mockAttestationObject) },
        clientDataJSON: { $b64u: toBase64Url(mockClientDataJSON) },
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    },
  };
}

function buildMockLogin(challengeB64u: string) {
  const mockRawId = crypto.getRandomValues(new Uint8Array(32));
  const mockUserHandle = crypto.getRandomValues(new Uint8Array(16));
  const mockAuthenticatorData = crypto.getRandomValues(new Uint8Array(37));
  const mockSignature = crypto.getRandomValues(new Uint8Array(64));
  const mockClientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get',
    challenge: challengeB64u,
    origin: 'http://localhost:3000',
    crossOrigin: false,
  }));
  return {
    credential: {
      type: 'public-key',
      id: toBase64Url(mockRawId),
      rawId: { $b64u: toBase64Url(mockRawId) },
      response: {
        authenticatorData: { $b64u: toBase64Url(mockAuthenticatorData) },
        clientDataJSON: { $b64u: toBase64Url(mockClientDataJSON) },
        signature: { $b64u: toBase64Url(mockSignature) },
        userHandle: { $b64u: toBase64Url(mockUserHandle) },
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    },
  };
}

function expectTaggedRegisterOptions(data: any) {
  // Verify tagged binary format for challenge
  expect(data.createOptions.publicKey.challenge).toHaveProperty('$b64u');
  const challengeB64u = data.createOptions.publicKey.challenge.$b64u;
  expect(typeof challengeB64u).toBe('string');
  expect(fromBase64Url(challengeB64u).length).toBeGreaterThan(0);

  // Verify user.id is also tagged binary
  expect(data.createOptions.publicKey.user.id).toHaveProperty('$b64u');
  expect(typeof data.createOptions.publicKey.user.id.$b64u).toBe('string');
}

function expectTaggedLoginOptions(data: any) {
  expect(data.getOptions.publicKey.challenge).toHaveProperty('$b64u');
  const challengeB64u = data.getOptions.publicKey.challenge.$b64u;
  expect(typeof challengeB64u).toBe('string');
  expect(fromBase64Url(challengeB64u).length).toBeGreaterThan(0);
}

/** A failed finish must be a clean client error: no 5xx, no token material, no session cookie. */
async function expectCleanFinishRejection(resp: import('@playwright/test').APIResponse) {
  expect(resp.status()).toBeGreaterThanOrEqual(400);
  expect(resp.status()).toBeLessThan(500);
  const text = await resp.text();
  expect(text).not.toMatch(/appToken|refreshToken|access_token/);
  expect(resp.headers()['set-cookie'] ?? '').toBe('');
}

test.describe('Tagged Binary Format Compatibility @api', () => {
  let request: APIRequestContext;
  let legacy: LegacyAuthStatus;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
    legacy = await detectLegacyAuth(request);
    console.log(`Legacy HMAC auth endpoints ${legacy.enabled ? 'ENABLED' : 'DISABLED (410)'} on ${BACKEND_URL}`);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ---------------------------------------------------------------------------
  // Session mode (the supported contract; must hold on every backend)
  // ---------------------------------------------------------------------------

  test.describe('session mode (/auth/passkey/* + X-Token-Mode: session)', () => {
    test('register/begin returns correct tagged binary format', async () => {
      const response = await request.post(SESSION.registerBegin, {
        headers: SESSION_MODE_HEADERS,
        data: {},
      });
      expect(response.ok()).toBe(true);

      const data = await response.json();
      expect(typeof data.challengeId).toBe('string');
      expectTaggedRegisterOptions(data);
    });

    test('login/begin returns correct tagged binary format', async () => {
      const response = await request.post(SESSION.loginBegin, {
        headers: SESSION_MODE_HEADERS,
        data: {},
      });
      expect(response.ok()).toBe(true);

      const data = await response.json();
      expect(typeof data.challengeId).toBe('string');
      expectTaggedLoginOptions(data);
    });

    test('register/finish accepts tagged binary credential (and rejects the mock attestation cleanly)', async () => {
      const beginResp = await request.post(SESSION.registerBegin, {
        headers: SESSION_MODE_HEADERS,
        data: {},
      });
      expect(beginResp.ok()).toBe(true);
      const beginData = await beginResp.json();

      const finishResp = await request.post(SESSION.registerFinish, {
        headers: SESSION_MODE_HEADERS,
        data: {
          challengeId: beginData.challengeId,
          ...buildMockRegistration(beginData.createOptions.publicKey.challenge.$b64u),
        },
      });

      // Invalid attestation: expect a client error, NOT a 5xx (parsing error)
      // and never a session / token.
      console.log('session register/finish status:', finishResp.status());
      await expectCleanFinishRejection(finishResp);
    });

    test('login/finish accepts tagged binary credential (and rejects the unknown credential cleanly)', async () => {
      const beginResp = await request.post(SESSION.loginBegin, {
        headers: SESSION_MODE_HEADERS,
        data: {},
      });
      expect(beginResp.ok()).toBe(true);
      const beginData = await beginResp.json();

      const finishResp = await request.post(SESSION.loginFinish, {
        headers: SESSION_MODE_HEADERS,
        data: {
          challengeId: beginData.challengeId,
          ...buildMockLogin(beginData.getOptions.publicKey.challenge.$b64u),
        },
      });

      console.log('session login/finish status:', finishResp.status());
      await expectCleanFinishRejection(finishResp);
    });

    test('POST /auth/token without a session cookie is refused with 401', async () => {
      const response = await request.post(SESSION.token, {
        headers: SESSION_MODE_HEADERS,
        data: { aud: 'wallet-backend', tac: 'rwlid', tenant_id: 'default' },
      });
      expect(response.status()).toBe(401);
      const text = await response.text();
      expect(text).not.toContain('access_token');
    });

    test('POST /auth/token requires an audience', async () => {
      const response = await request.post(SESSION.token, {
        headers: SESSION_MODE_HEADERS,
        data: { tenant_id: 'default' },
      });
      expect(response.status()).toBe(400);
    });

    test('register/begin for a non-existent tenant returns 404', async () => {
      const response = await request.post(SESSION.registerBegin, {
        headers: { ...SESSION_MODE_HEADERS, 'X-Tenant-ID': 'this-tenant-does-not-exist' },
        data: {},
      });
      expect(response.status()).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy HMAC endpoints, backend with legacy ENABLED (pre-#436 behaviour)
  // ---------------------------------------------------------------------------

  test.describe('legacy endpoints on a legacy-enabled backend', () => {
    test.beforeEach(() => {
      test.skip(!legacy.enabled, 'backend has the legacy HMAC AS disabled (see the 410 tests below)');
    });

    test('registration-begin returns correct tagged binary format', async () => {
      const response = await request.post(LEGACY.registerBegin, { data: {} });
      expect(response.ok()).toBe(true);
      expectTaggedRegisterOptions(await response.json());
    });

    test('login-begin returns correct tagged binary format', async () => {
      const response = await request.post(LEGACY.loginBegin, { data: {} });
      expect(response.ok()).toBe(true);
      expectTaggedLoginOptions(await response.json());
    });

    test('register-webauthn-finish accepts tagged binary credential', async () => {
      const beginResp = await request.post(LEGACY.registerBegin, { data: {} });
      expect(beginResp.ok()).toBe(true);
      const beginData = await beginResp.json();

      const finishResp = await request.post(LEGACY.registerFinish, {
        data: {
          challengeId: beginData.challengeId,
          ...buildMockRegistration(beginData.createOptions.publicKey.challenge.$b64u),
        },
      });

      // We expect this to fail validation (invalid attestation), but NOT with 500 (parsing error)
      expect(finishResp.status()).not.toBe(500);
      console.log('register-webauthn-finish status:', finishResp.status());
    });

    test('login-webauthn-finish accepts tagged binary credential', async () => {
      const beginResp = await request.post(LEGACY.loginBegin, { data: {} });
      expect(beginResp.ok()).toBe(true);
      const beginData = await beginResp.json();

      const finishResp = await request.post(LEGACY.loginFinish, {
        data: {
          challengeId: beginData.challengeId,
          ...buildMockLogin(beginData.getOptions.publicKey.challenge.$b64u),
        },
      });

      // We expect this to fail (no registered credential), but NOT with 500
      expect(finishResp.status()).not.toBe(500);
      console.log('login-webauthn-finish status:', finishResp.status());
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy HMAC endpoints, backend with legacy DISABLED (post-#436 behaviour)
  // ---------------------------------------------------------------------------

  test.describe('legacy endpoints on a backend with legacy disabled', () => {
    test.beforeEach(() => {
      test.skip(legacy.enabled, 'backend still has the legacy HMAC AS enabled');
    });

    for (const path of [
      LEGACY.registerBegin,
      LEGACY.registerFinish,
      LEGACY.loginBegin,
      LEGACY.loginFinish,
      LEGACY.refresh,
    ]) {
      test(`${path} answers 410 legacy_tokens_disabled`, async () => {
        const response = await request.post(path, { data: {} });
        expect(response.status()).toBe(410);
        const data = await response.json();
        expect(data.error).toBe('legacy_tokens_disabled');
      });
    }

    for (const path of [SESSION.registerBegin, SESSION.loginBegin]) {
      test(`${path} without X-Token-Mode: session answers 410 legacy_tokens_disabled`, async () => {
        const response = await request.post(path, { data: {} });
        expect(response.status()).toBe(410);
        const data = await response.json();
        expect(data.error).toBe('legacy_tokens_disabled');
      });
    }
  });

  test('backend /status endpoint responds correctly', async () => {
    const response = await request.get('/status');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    console.log('Backend status:', JSON.stringify(data, null, 2));

    expect(data.status).toBe('ok');
    expect(data.service).toBe('wallet-backend');
  });
});
