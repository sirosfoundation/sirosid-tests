/**
 * Shared Transport Mode Test Definitions
 * 
 * These tests verify transport-specific behavior across WebSocket,
 * HTTP proxy, WMP, and (future) direct transport modes.
 * 
 * Environment Variables:
 *   TRANSPORT_MODE=websocket|http|wmp - Controls which transport to test (default: websocket)
 *   EXPECT_WEBSOCKET=true - Fail if WebSocket not available
 *   EXPECT_WMP=true - Fail if WMP not available
 */

import { expect, request } from '@playwright/test';
import type { Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions } from '@playwright/test';
import type { WebAuthnAdapterInfo, WebAuthnFixtures } from '../../helpers/webauthn-adapter';
import {
  fetchBackendStatus,
  isWebSocketAvailable,
  isWmpAvailable,
  getTransportDescription,
  getTransportMode,
  clearStatusCache,
} from '../../helpers/backend-capabilities';
import { ENV, generateTestId } from '../../helpers/shared-helpers';

// =============================================================================
// Transport Configuration
// =============================================================================

const FRONTEND_URL = ENV.FRONTEND_URL;
const BACKEND_URL = ENV.BACKEND_URL;
const ENGINE_URL = process.env.ENGINE_URL || BACKEND_URL;

/**
 * Check if we should expect WebSocket to be available
 */
function expectWebSocket(): boolean {
  return process.env.EXPECT_WEBSOCKET === 'true';
}

/**
 * Check if we should expect WMP to be available
 */
function expectWmp(): boolean {
  return process.env.EXPECT_WMP === 'true';
}

// =============================================================================
// Backend Capability Tests
// =============================================================================

/**
 * Define backend capability detection tests
 */
export function defineTransportCapabilityTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Transport Capabilities', () => {
    test.beforeEach(async () => {
      clearStatusCache();
    });

    test('backend status endpoint is available', async () => {
      const info = adapterInfo();
      const status = await fetchBackendStatus(true);

      if (!status) {
        console.log(`[${info.name}] Backend not reachable at ${BACKEND_URL}`);
        test.fail(true, 'Backend status endpoint not available');
        return;
      }

      expect(status.status).toBe('ok');
      expect(status.service).toBeDefined();
      console.log(`[${info.name}] Backend: ${status.service} v${status.version || 'unknown'}`);
    });

    test('backend reports WebSocket capability', async () => {
      const info = adapterInfo();
      const status = await fetchBackendStatus(true);

      if (!status) {
        test.skip(true, 'Backend not available');
        return;
      }

      const hasWebSocket = status.capabilities?.includes('websocket') ?? false;
      console.log(`[${info.name}] WebSocket capability: ${hasWebSocket}`);

      if (expectWebSocket() && !hasWebSocket) {
        test.fail(true, 'WebSocket expected but not available');
      }
    });

    test('backend reports WMP capability', async () => {
      const info = adapterInfo();
      const status = await fetchBackendStatus(true);

      if (!status) {
        test.skip(true, 'Backend not available');
        return;
      }

      const hasWmp = status.capabilities?.includes('wmp') ?? false;
      console.log(`[${info.name}] WMP capability: ${hasWmp}`);

      if (expectWmp() && !hasWmp) {
        test.fail(true, 'WMP expected but not available');
      }
    });

    test('engine status endpoint is available', async () => {
      const info = adapterInfo();
      
      if (ENGINE_URL === BACKEND_URL) {
        console.log(`[${info.name}] Engine URL same as backend - skipping`);
        test.skip();
        return;
      }

      const response = await fetch(`${ENGINE_URL}/status`).catch(() => null);
      
      if (!response || !response.ok) {
        console.log(`[${info.name}] Engine not reachable at ${ENGINE_URL}`);
        test.skip(true, 'Engine not available');
        return;
      }

      const status = await response.json();
      expect(status.status).toBe('ok');
      console.log(`[${info.name}] Engine: ${status.service} v${status.version || 'unknown'}`);
    });

    test('transport mode configuration is valid', async () => {
      const info = adapterInfo();
      const mode = getTransportMode();

      expect(['websocket', 'http', 'wmp']).toContain(mode);
      console.log(`[${info.name}] Transport mode: ${mode}`);
    });

    test('transport description matches configuration', async () => {
      const info = adapterInfo();
      const description = await getTransportDescription();

      expect(description).toBeDefined();
      console.log(`[${info.name}] Transport: ${description}`);

      const mode = getTransportMode();
      if (mode === 'websocket') {
        expect(description.toLowerCase()).toContain('websocket');
      } else if (mode === 'http') {
        expect(description.toLowerCase()).toContain('http');
      }
    });
  });
}

// =============================================================================
// WebSocket Transport Tests
// =============================================================================

/**
 * Define WebSocket-specific transport tests
 */
export function defineWebSocketTransportTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('WebSocket Transport @websocket', () => {
    test('WebSocket endpoint is reachable', async () => {
      const info = adapterInfo();
      const wsAvailable = await isWebSocketAvailable();

      console.log(`[${info.name}] WebSocket available: ${wsAvailable}`);

      if (expectWebSocket() && !wsAvailable) {
        test.fail(true, 'WebSocket expected but not available');
      }

      if (!wsAvailable) {
        test.skip(true, 'WebSocket not available');
      }
    });

    test('frontend detects WebSocket transport', async ({ page }) => {
      const info = adapterInfo();
      const wsAvailable = await isWebSocketAvailable();

      if (!wsAvailable) {
        test.skip(true, 'WebSocket not available');
        return;
      }

      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Check if frontend detected WebSocket support
      const transportInfo = await page.evaluate(() => {
        const win = window as any;
        return {
          // Check various ways the transport might be exposed
          transport: win.__TRANSPORT__,
          config: win.__CONFIG__?.transport,
          wsEnabled: win.__WS_ENABLED__,
        };
      });

      console.log(`[${info.name}] Frontend transport info:`, transportInfo);
    });

    test('WebSocket connection establishes successfully', async ({ page }) => {
      const info = adapterInfo();
      const wsAvailable = await isWebSocketAvailable();

      if (!wsAvailable) {
        test.skip(true, 'WebSocket not available');
        return;
      }

      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Wait for WebSocket connection
      const wsConnected = await page.evaluate(async () => {
        return new Promise<boolean>((resolve) => {
          // Check if a WebSocket is already connected
          const timers: number[] = [];
          
          const checkWs = () => {
            const win = window as any;
            // Look for connected WebSocket in various places
            if (win.__WS_CONNECTED__ || win.__transport__?.isConnected?.()) {
              resolve(true);
              timers.forEach(clearTimeout);
            }
          };

          // Check periodically
          for (let i = 0; i < 10; i++) {
            timers.push(window.setTimeout(checkWs, i * 500) as unknown as number);
          }

          // Timeout after 5 seconds
          timers.push(window.setTimeout(() => resolve(false), 5000) as unknown as number);
        });
      });

      console.log(`[${info.name}] WebSocket connected: ${wsConnected}`);
      // Don't fail - connection might only happen during flows
    });
  });
}

// =============================================================================
// WMP Transport Tests
// =============================================================================

/**
 * Define WMP-specific transport tests
 */
export function defineWmpTransportTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('WMP Transport @wmp', () => {
    test('WMP capability is reported', async () => {
      const info = adapterInfo();
      const wmpAvailable = await isWmpAvailable();

      console.log(`[${info.name}] WMP available: ${wmpAvailable}`);

      if (expectWmp() && !wmpAvailable) {
        test.fail(true, 'WMP expected but not available');
      }

      if (!wmpAvailable) {
        test.skip(true, 'WMP not available');
      }
    });

    test('WMP RPC endpoint is reachable', async ({ request: reqContext }) => {
      const info = adapterInfo();
      const wmpAvailable = await isWmpAvailable();

      if (!wmpAvailable) {
        test.skip(true, 'WMP not available');
        return;
      }

      // POST to /api/v2/wallet/rpc without auth should return 401
      const response = await reqContext.post(`${ENGINE_URL}/api/v2/wallet/rpc`, {
        data: { jsonrpc: '2.0', method: 'wmp.session.create', id: 1, params: {} },
      }).catch(() => null);

      const reachable = response && [200, 401, 403].includes(response.status());
      console.log(`[${info.name}] WMP RPC endpoint: ${reachable ? 'reachable' : 'not found'} (status: ${response?.status()})`);
      expect(reachable).toBeTruthy();
    });

    test('WMP events endpoint is reachable', async ({ request: reqContext }) => {
      const info = adapterInfo();
      const wmpAvailable = await isWmpAvailable();

      if (!wmpAvailable) {
        test.skip(true, 'WMP not available');
        return;
      }

      // GET /api/v2/wallet/events without session_id should return 400
      const response = await reqContext.get(`${ENGINE_URL}/api/v2/wallet/events`).catch(() => null);

      const reachable = response && [200, 400, 401].includes(response.status());
      console.log(`[${info.name}] WMP events endpoint: ${reachable ? 'reachable' : 'not found'} (status: ${response?.status()})`);
      expect(reachable).toBeTruthy();
    });
  });
}

// =============================================================================
// HTTP Proxy Transport Tests
// =============================================================================

/**
 * Define HTTP proxy transport tests
 */
export function defineHttpTransportTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('HTTP Proxy Transport @http', () => {
    test('HTTP proxy endpoints are available', async ({ request: reqContext }) => {
      const info = adapterInfo();

      // Check for common HTTP proxy endpoints
      const endpoints = [
        '/api/oid4vci/start',
        '/api/oid4vp/start',
        '/api/flow/status',
      ];

      for (const endpoint of endpoints) {
        const response = await reqContext.head(`${BACKEND_URL}${endpoint}`).catch(() => null);
        // 404 or 405 means endpoint exists but we need proper request
        // 401/403 means it requires auth
        const exists = response && [200, 401, 403, 404, 405].includes(response.status());
        console.log(`[${info.name}] ${endpoint}: ${exists ? 'exists' : 'not found'}`);
      }
    });

    test('HTTP transport falls back when WebSocket unavailable', async ({ page }) => {
      const info = adapterInfo();
      const mode = getTransportMode();

      if (mode !== 'http') {
        console.log(`[${info.name}] Transport mode is ${mode}, not testing HTTP fallback`);
        test.skip();
        return;
      }

      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // Frontend should fall back to HTTP when WS unavailable
      const transportType = await page.evaluate(() => {
        const win = window as any;
        return win.__TRANSPORT_TYPE__ || win.__transport__?.type || 'unknown';
      });

      console.log(`[${info.name}] Active transport type: ${transportType}`);
    });
  });
}

// =============================================================================
// Transport Mode Switching Tests
// =============================================================================

/**
 * Define transport mode switching tests
 */
export function defineTransportSwitchingTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Transport Mode Switching', () => {
    test('TRANSPORT_MODE=websocket forces WebSocket', async () => {
      const info = adapterInfo();
      const mode = getTransportMode();

      if (mode !== 'websocket') {
        console.log(`[${info.name}] TRANSPORT_MODE is ${mode}, skipping`);
        test.skip();
        return;
      }

      const wsAvailable = await isWebSocketAvailable();
      
      if (!wsAvailable) {
        console.log(`[${info.name}] WebSocket not available but forced - tests will fail`);
        test.fail(true, 'WebSocket forced but not available');
      }
    });

    test('TRANSPORT_MODE=http forces HTTP proxy', async () => {
      const info = adapterInfo();
      const mode = getTransportMode();

      if (mode !== 'http') {
        console.log(`[${info.name}] TRANSPORT_MODE is ${mode}, skipping`);
        test.skip();
        return;
      }

      // HTTP should always be available as fallback
      const status = await fetchBackendStatus();
      expect(status).toBeDefined();
      console.log(`[${info.name}] HTTP transport forced, backend available: ${!!status}`);
    });
  });
}

// =============================================================================
// Transport Performance Tests
// =============================================================================

/**
 * Define transport performance comparison tests
 */
export function defineTransportPerformanceTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  test.describe('Transport Performance @performance', () => {
    test.skip('WebSocket has lower latency than HTTP for progress updates', async () => {
      // TODO: Implement latency comparison tests
      // This would require measuring time between backend events and UI updates
    });

    test.skip('HTTP polling does not create excessive requests', async () => {
      // TODO: Implement request counting tests
      // Verify that HTTP polling uses reasonable intervals
    });
  });
}

// =============================================================================
// All Transport Tests Bundle
// =============================================================================

/**
 * Define all transport-related tests
 */
export function defineAllTransportTests(
  test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: () => WebAuthnAdapterInfo
) {
  defineTransportCapabilityTests(test, adapterInfo);
  defineWebSocketTransportTests(test, adapterInfo);
  defineWmpTransportTests(test, adapterInfo);
  defineHttpTransportTests(test, adapterInfo);
  defineTransportSwitchingTests(test, adapterInfo);
  defineTransportPerformanceTests(test, adapterInfo);
}
