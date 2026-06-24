/**
 * WSCA Test Automation Helpers for Android
 *
 * Drives WSCA/WSCD lifecycle operations on the native Android sample app
 * via adb intents. Works with physical devices, emulators, and Waydroid.
 *
 * The sample app handles the WSCA_TEST action in MainActivity (debug builds)
 * and dispatches to the real ViewModel methods — same code path as the UI.
 * Results are emitted as structured JSON to logcat with tag WSCA_TEST_RESULT.
 *
 * @module helpers/wsca-automation
 */

import { spawnSync } from 'child_process';
import { ANDROID_ENV } from './android-wallet';

// =============================================================================
// Constants
// =============================================================================

const WSCA_TEST_ACTION = 'org.sirosfoundation.sdk.sample.WSCA_TEST';
const WSCA_TEST_TAG = 'WSCA_TEST_RESULT';
const DEFAULT_RESULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

// =============================================================================
// Types
// =============================================================================

export interface WscaKeyInfo {
  kid: string;
  alg: string;
  plugin: string;
  created: number;
}

export interface WscaStatus {
  action: string;
  state: string;
  context_id: string;
  plugin: string;
  r2ps_enabled: boolean;
  keys: WscaKeyInfo[];
}

export interface WscaActionResult {
  action: string;
  status: 'ok' | 'error' | 'dispatching';
  state?: string;
  context_id?: string;
  mode?: string;
  error?: string;
}

// =============================================================================
// ADB Helpers
// =============================================================================

function runAdb(args: string[], timeoutMs = 30000): { stdout: string; stderr: string; status: number } {
  const withSerial = ANDROID_ENV.DEVICE_SERIAL
    ? ['-s', ANDROID_ENV.DEVICE_SERIAL, ...args]
    : args;

  const result = spawnSync(ANDROID_ENV.ADB_PATH, withSerial, {
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.error ? result.error.message : (result.stderr || ''),
    status: result.status ?? -1,
  };
}

function clearLogcat(): void {
  runAdb(['logcat', '-c'], 5000);
}

/**
 * Read logcat lines matching the WSCA test result tag.
 * Returns parsed JSON objects from matching lines.
 */
function readWscaLogcatResults(): WscaActionResult[] {
  const result = runAdb(['logcat', '-d', '-s', `${WSCA_TEST_TAG}:*`], 10000);
  if (result.status !== 0) return [];

  const results: WscaActionResult[] = [];
  for (const line of result.stdout.split('\n')) {
    // logcat format: "06-24 12:34:56.789  1234  5678 I WSCA_TEST_RESULT: {...}"
    const jsonMatch = line.match(/WSCA_TEST_RESULT:\s*(\{.+\})/);
    if (jsonMatch) {
      try {
        results.push(JSON.parse(jsonMatch[1]));
      } catch {
        // skip malformed lines
      }
    }
  }
  return results;
}

// =============================================================================
// WSCA Intent Dispatch
// =============================================================================

/**
 * Send a WSCA test action intent to the sample app.
 *
 * @param action - The wsca_action value (enroll, rotate, destroy, status, config, refresh)
 * @param extras - Additional string extras to pass with the intent
 */
export function sendWscaIntent(action: string, extras: Record<string, string> = {}): void {
  const args = [
    'shell', 'am', 'start',
    '-n', `${ANDROID_ENV.WALLET_PACKAGE}/${ANDROID_ENV.WALLET_ACTIVITY}`,
    '-a', WSCA_TEST_ACTION,
    '--es', 'wsca_action', action,
  ];

  for (const [key, value] of Object.entries(extras)) {
    args.push('--es', key, value);
  }

  const result = runAdb(args, 15000);
  if (result.status !== 0) {
    throw new Error(`adb WSCA intent failed (status=${result.status}): ${result.stdout} ${result.stderr}`);
  }
}

/**
 * Send a WSCA action and wait for the result in logcat.
 *
 * Clears logcat, sends the intent, then polls for a result line
 * matching the action with a terminal status (ok or error).
 */
export function sendWscaActionAndWait(
  action: string,
  extras: Record<string, string> = {},
  timeoutMs = DEFAULT_RESULT_TIMEOUT_MS,
): WscaActionResult {
  clearLogcat();
  sendWscaIntent(action, extras);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const results = readWscaLogcatResults();
    // Find a terminal result (ok or error) for this action
    const terminal = results.find(
      (r) => r.action === action && (r.status === 'ok' || r.status === 'error'),
    );
    if (terminal) return terminal;

    // Sleep before next poll
    spawnSync('sleep', ['0.5']);
  }

  throw new Error(`Timeout waiting for WSCA action '${action}' result after ${timeoutMs}ms`);
}

// =============================================================================
// High-Level WSCA Operations
// =============================================================================

/**
 * Enroll the WSCD (register + activate lifecycle).
 * Calls the same enrollWscd() method as the UI button.
 */
export function enrollWscd(): WscaActionResult {
  return sendWscaActionAndWait('enroll');
}

/**
 * Rotate lifecycle keys.
 */
export function rotateLifecycle(): WscaActionResult {
  return sendWscaActionAndWait('rotate');
}

/**
 * Destroy the lifecycle context.
 * @param mode - 'local' | 'revoke' | 'strict'
 */
export function destroyLifecycle(mode: 'local' | 'revoke' | 'strict' = 'local'): WscaActionResult {
  return sendWscaActionAndWait('destroy', { mode });
}

/**
 * Query current WSCA status (lifecycle state + key inventory).
 */
export function getWscaStatus(): WscaStatus {
  clearLogcat();
  sendWscaIntent('status');

  const deadline = Date.now() + DEFAULT_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const results = readWscaLogcatResults();
    const statusResult = results.find((r) => r.action === 'status');
    if (statusResult) return statusResult as unknown as WscaStatus;
    spawnSync('sleep', ['0.5']);
  }

  throw new Error('Timeout waiting for WSCA status');
}

/**
 * Configure the WSCA plugin settings.
 */
export function configureWsca(config: { r2ps_enabled?: boolean; r2ps_url?: string }): void {
  const extras: Record<string, string> = {};
  if (config.r2ps_enabled !== undefined) extras.r2ps_enabled = String(config.r2ps_enabled);
  if (config.r2ps_url !== undefined) extras.r2ps_url = config.r2ps_url;
  sendWscaIntent('config', extras);
  // Config is synchronous; small delay for logcat to flush
  spawnSync('sleep', ['0.5']);
}
