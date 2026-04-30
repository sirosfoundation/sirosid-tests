/**
 * OpenID Conformance Suite API Client
 *
 * TypeScript client for the OpenID Foundation Conformance Suite REST API.
 * Ported from the Python scripts/conformance.py in the conformance-suite repo.
 *
 * Usage:
 *   const api = new ConformanceAPI('https://localhost.emobix.co.uk:8443');
 *   await api.waitForServerReady();
 *   const plan = await api.createTestPlan('oid4vp-1final-wallet-test-plan', configJson, variant);
 *   const module = await api.createTestFromPlan(plan.id, 'oid4vp-1final-wallet-happy-flow');
 *   const state = await api.waitForState(module.id, ['WAITING', 'FINISHED']);
 *
 * @module helpers/conformance-api
 */

// =============================================================================
// Configuration
// =============================================================================

export const CONFORMANCE_ENV = {
  /** Base URL of the conformance suite (with trailing slash) */
  CONFORMANCE_URL: process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/',
  /** API token for authenticated access (not needed in devmode) */
  CONFORMANCE_TOKEN: process.env.CONFORMANCE_TOKEN || '',
};

// Ensure trailing slash
if (!CONFORMANCE_ENV.CONFORMANCE_URL.endsWith('/')) {
  CONFORMANCE_ENV.CONFORMANCE_URL += '/';
}

// =============================================================================
// Types
// =============================================================================

export interface TestPlanInfo {
  id: string;
  modules: TestModuleEntry[];
  [key: string]: unknown;
}

export interface TestModuleEntry {
  testModule: string;
  variant?: Record<string, string>;
  [key: string]: unknown;
}

export interface TestModuleInfo {
  id: string;
  testId?: string;
  testName?: string;
  status?: string;
  result?: string;
  [key: string]: unknown;
}

export interface ModuleInfo {
  id: string;
  testName: string;
  status: string;
  result: string;
  variant?: Record<string, string>;
  [key: string]: unknown;
}

export interface LogEntry {
  src?: string;
  msg?: string;
  result?: string;
  blockId?: string;
  startBlock?: boolean;
  [key: string]: unknown;
}

export type TestState = 'CREATED' | 'CONFIGURED' | 'WAITING' | 'RUNNING' | 'FINISHED' | 'INTERRUPTED';

// =============================================================================
// API Client
// =============================================================================

export class ConformanceAPI {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = baseUrl || CONFORMANCE_ENV.CONFORMANCE_URL;
    if (!this.baseUrl.endsWith('/')) {
      this.baseUrl += '/';
    }

    this.headers = { 'Content-Type': 'application/json' };
    const apiToken = token || CONFORMANCE_ENV.CONFORMANCE_TOKEN;
    if (apiToken) {
      this.headers['Authorization'] = `Bearer ${apiToken}`;
    }
  }

  /**
   * Make an HTTP request with retry logic for transient failures.
   */
  private async request(
    method: string,
    url: string,
    options: {
      body?: string;
      params?: Record<string, string>;
      expectedStatus?: number;
      timeout?: number;
    } = {}
  ): Promise<any> {
    const { body, params, expectedStatus, timeout = 20000 } = options;

    let fullUrl = url;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      fullUrl += (fullUrl.includes('?') ? '&' : '?') + searchParams.toString();
    }

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions: RequestInit = {
          method,
          headers: { ...this.headers },
          signal: controller.signal,
        };

        if (body) {
          fetchOptions.body = body;
        }

        // Skip TLS verification for self-signed certs
        const response = await fetch(fullUrl, fetchOptions);
        clearTimeout(timeoutId);

        if (expectedStatus !== undefined && response.status !== expectedStatus) {
          const text = await response.text().catch(() => '');
          if (response.status >= 500 && attempt < maxAttempts) {
            console.log(`[ConformanceAPI] ${method} ${fullUrl} returned ${response.status}, retrying (attempt ${attempt})`);
            await this.sleep(2000 * attempt);
            continue;
          }
          throw new Error(
            `${method} ${url} failed: HTTP ${response.status} - ${text.slice(0, 200)}`
          );
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await response.json();
        }
        return await response.text();
      } catch (error: any) {
        lastError = error;
        if (error.name === 'AbortError') {
          throw new Error(`${method} ${url} timed out after ${timeout}ms`);
        }
        if (attempt < maxAttempts) {
          console.log(`[ConformanceAPI] ${method} ${fullUrl} failed (attempt ${attempt}): ${error.message}`);
          await this.sleep(2000 * attempt);
          continue;
        }
      }
    }
    throw lastError || new Error(`${method} ${url} failed after ${maxAttempts} attempts`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // Server Status
  // ===========================================================================

  /**
   * Wait for the conformance suite server to be ready.
   */
  async waitForServerReady(timeoutMs = 120000): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeoutMs) {
      attempt++;
      try {
        const url = `${this.baseUrl}api/runner/available`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
          headers: this.headers,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 200) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          console.log(`[ConformanceAPI] Server ready after ${elapsed}s (${attempt} attempts)`);
          return;
        }
        console.log(`[ConformanceAPI] Server returned ${response.status} (attempt ${attempt})`);
      } catch (error: any) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[ConformanceAPI] Server not ready (attempt ${attempt}, ${elapsed}s): ${error.message}`);
      }

      await this.sleep(5000);
    }

    throw new Error(`Conformance suite did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Get all available test modules.
   */
  async getAllTestModules(): Promise<any[]> {
    return await this.request('GET', `${this.baseUrl}api/runner/available`, {
      expectedStatus: 200,
    });
  }

  // ===========================================================================
  // Test Plan Management
  // ===========================================================================

  /**
   * Create a new test plan.
   *
   * @param planName - Name of the test plan (e.g. 'oid4vp-1final-wallet-test-plan')
   * @param configuration - JSON configuration string
   * @param variant - Optional variant parameters
   */
  async createTestPlan(
    planName: string,
    configuration: string,
    variant?: Record<string, string>
  ): Promise<TestPlanInfo> {
    const params: Record<string, string> = { planName };
    if (variant) {
      params['variant'] = JSON.stringify(variant);
    }

    return await this.request('POST', `${this.baseUrl}api/plan`, {
      params,
      body: configuration,
      expectedStatus: 201,
    });
  }

  // ===========================================================================
  // Test Module Management
  // ===========================================================================

  /**
   * Create a test module from an existing plan.
   */
  async createTestFromPlan(planId: string, testName: string): Promise<TestModuleInfo> {
    return await this.request('POST', `${this.baseUrl}api/runner`, {
      params: { test: testName, plan: planId },
      expectedStatus: 201,
    });
  }

  /**
   * Create a test module from a plan with a specific variant.
   */
  async createTestFromPlanWithVariant(
    planId: string,
    testName: string,
    variant?: Record<string, string>
  ): Promise<TestModuleInfo> {
    const params: Record<string, string> = { test: testName, plan: planId };
    if (variant) {
      params['variant'] = JSON.stringify(variant);
    }

    return await this.request('POST', `${this.baseUrl}api/runner`, {
      params,
      expectedStatus: 201,
    });
  }

  /**
   * Start a test module that is in CONFIGURED state.
   */
  async startTest(moduleId: string): Promise<any> {
    return await this.request('POST', `${this.baseUrl}api/runner/${moduleId}`, {
      expectedStatus: 200,
    });
  }

  // ===========================================================================
  // Test Status & Results
  // ===========================================================================

  /**
   * Get module info (status, result, etc.).
   */
  async getModuleInfo(moduleId: string): Promise<ModuleInfo> {
    return await this.request('GET', `${this.baseUrl}api/info/${moduleId}`, {
      expectedStatus: 200,
    });
  }

  /**
   * Get detailed log entries for a test module.
   */
  async getTestLog(moduleId: string): Promise<LogEntry[]> {
    return await this.request('GET', `${this.baseUrl}api/log/${moduleId}`, {
      expectedStatus: 200,
    });
  }

  /**
   * Poll until the test module reaches one of the required states.
   *
   * @param moduleId - The test module ID
   * @param requiredStates - States to wait for
   * @param timeoutMs - Maximum wait time
   * @returns The state the module reached
   */
  async waitForState(
    moduleId: string,
    requiredStates: TestState[],
    timeoutMs = 240000
  ): Promise<TestState> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus: string | null = null;
    const pollInterval = 1000;

    while (Date.now() < deadline) {
      const info = await this.getModuleInfo(moduleId);
      const status = info.status as TestState;

      if (status !== lastStatus) {
        console.log(`[ConformanceAPI] Module ${moduleId} status: ${status}`);
        lastStatus = status;
      }

      if (requiredStates.includes(status)) {
        return status;
      }

      if (status === 'INTERRUPTED') {
        throw new Error(`Test module ${moduleId} was interrupted`);
      }

      await this.sleep(pollInterval);
    }

    throw new Error(
      `Timed out waiting for module ${moduleId} to reach ${requiredStates.join('|')} (last: ${lastStatus})`
    );
  }

  // ===========================================================================
  // Convenience Helpers
  // ===========================================================================

  /**
   * Get the browser interaction URL for a test module (for wallet tests,
   * this is the URL the wallet needs to visit).
   */
  getLogDetailUrl(moduleId: string): string {
    return `${this.baseUrl}log-detail.html?log=${moduleId}`;
  }

  /**
   * Get the plan detail URL.
   */
  getPlanDetailUrl(planId: string): string {
    return `${this.baseUrl}plan-detail.html?plan=${planId}`;
  }

  /**
   * Extract the authorization request or credential offer URI from the
   * conformance suite's exposed endpoints. The suite exposes this in the
   * module's browser interaction or via the test log.
   *
   * For wallet tests, the conformance suite typically provides a URL that
   * the wallet needs to process. This is found in the test logs as a
   * redirect or request_uri.
   */
  async getWalletInteractionUrl(moduleId: string): Promise<string | null> {
    const logs = await this.getTestLog(moduleId);

    // Look for the URL that the wallet should visit
    for (const entry of logs) {
      const msg = entry.msg || '';

      // OID4VP: look for authorization request URL
      if (msg.includes('request_uri=') || msg.includes('client_id=')) {
        const match = msg.match(/https?:\/\/[^\s"']+request_uri=[^\s"']+/);
        if (match) return match[0];
      }

      // OID4VCI: look for credential offer
      if (msg.includes('credential_offer_uri=') || msg.includes('openid-credential-offer')) {
        const match = msg.match(/(openid-credential-offer:\/\/[^\s"']+|https?:\/\/[^\s"']+credential_offer[^\s"']+)/);
        if (match) return match[0];
      }
    }

    // Fallback: check exposed values in module info
    const info = await this.getModuleInfo(moduleId);
    if (info && typeof info === 'object') {
      // The conformance suite may expose the URL in the module's exposed values
      const exposed = (info as any).exposed;
      if (exposed) {
        for (const [key, value] of Object.entries(exposed)) {
          if (typeof value === 'string' && (
            value.includes('request_uri') ||
            value.includes('credential_offer') ||
            value.includes('openid-credential-offer')
          )) {
            return value;
          }
        }
      }
    }

    return null;
  }

  /**
   * Get the browser interaction URL that the wallet should visit.
   * For wallet tests, the conformance suite provides a "visit" URL
   * that redirects to the authorization/offer endpoint.
   */
  async getBrowserInteractionUrl(moduleId: string): Promise<string | null> {
    const info = await this.getModuleInfo(moduleId);
    // The conformance suite exposes browser_interaction URLs
    const urls = (info as any).urls;
    if (urls) {
      // Look for the authorization endpoint URL
      for (const urlEntry of Object.values(urls)) {
        if (typeof urlEntry === 'string' && urlEntry.includes('/test/')) {
          return urlEntry;
        }
      }
    }

    // The conformance suite also exposes the URL via the redirect
    // in test/a/<alias>/authorize or similar
    const alias = (info as any).alias;
    if (alias) {
      return `${this.baseUrl}test/a/${alias}/authorize`;
    }

    return null;
  }
}
