/**
 * Structured progress events for conformance spec runs
 *
 * Printed as single stdout lines so a parent process (sirosid-dev's
 * conformance-runner, driving `npx playwright test` as a child process) can
 * tail them and relay live progress to a dashboard, without any other
 * coupling between the two repos - this file has no side effects beyond
 * writing to stdout.
 *
 * @module helpers/conformance-progress
 */

import type { ConformanceAPI } from './conformance-api';

const MARKER = '##CONFORMANCE-EVENT##';

export type ConformanceEventType = 'plan_created' | 'module_start' | 'module_result' | 'run_summary';

export function emitEvent(type: ConformanceEventType, payload: Record<string, unknown>): void {
  console.log(`${MARKER} ${JSON.stringify({ type, ...payload })}`);
}

interface ModuleResultEntry {
  module: string;
  status: string;
  result: string;
  passed: boolean;
}

/**
 * Records a module result (spec files already push this to their own local
 * `results` array) and emits the matching module_result event, best-effort
 * attaching the module's raw conformance-suite log - a log fetch failure
 * shouldn't fail the test itself.
 */
export async function emitModuleResult(
  api: ConformanceAPI,
  moduleId: string,
  entry: ModuleResultEntry
): Promise<void> {
  let log: unknown = null;
  try {
    log = await api.getTestLog(moduleId);
  } catch {
    // best-effort only
  }
  emitEvent('module_result', { ...entry, moduleId, log });
}
