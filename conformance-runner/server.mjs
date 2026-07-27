/**
 * Conformance runner - drives sirosid-tests' own Playwright conformance
 * specs (specs/conformance/*.spec.ts) as child processes and relays their
 * progress to a dashboard over the REST+SSE contract that sirosid-dev's
 * startup.html (and its Fly-dashboard port) already expects.
 *
 * This process does NOT talk to the OpenID conformance suite itself - the
 * specs (via helpers/conformance-api.ts) own that. This is purely a
 * process-spawner + stdout-relay, kept deliberately thin so there is one
 * source of truth for "how to drive the wallet/mock-IdP through a flow."
 */
import express from 'express';
import { spawn } from 'child_process';
import { createInterface } from 'node:readline';

const PORT = process.env.PORT || 3001;
const CONFORMANCE_URL = (process.env.CONFORMANCE_URL || 'https://localhost.emobix.co.uk:8443/')
  .replace(/\/+$/, '') + '/';
const REPO_ROOT = process.env.SIROSID_TESTS_ROOT || process.cwd();

const PLANS = [
  { id: 'oid4vci-wallet', label: 'OID4VCI Wallet', phase: 2, planName: 'oid4vci-1_0-wallet-test-plan', specFile: 'specs/conformance/oid4vci-wallet.spec.ts' },
  { id: 'oid4vp-wallet', label: 'OID4VP Wallet', phase: 2, planName: 'oid4vp-1final-wallet-test-plan', specFile: 'specs/conformance/oid4vp-wallet.spec.ts' },
  { id: 'oid4vci-issuer', label: 'OID4VCI Issuer', phase: 1, planName: 'oid4vci-1_0-issuer-test-plan', specFile: 'specs/conformance/oid4vci-issuer.spec.ts' },
  { id: 'oid4vp-verifier', label: 'OID4VP Verifier', phase: 1, planName: 'oid4vp-1final-verifier-test-plan', specFile: 'specs/conformance/oid4vp-verifier.spec.ts' },
];

const app = express();
app.use(express.json());

/** id -> run state (in-memory, process-lifetime only) */
const runs = new Map();
/** moduleId -> { info, log } - keyed globally (not per-run), matching the
 *  dashboard's existing /api/info/:moduleId + /api/log/:moduleId contract,
 *  which has no runId in the path. */
const moduleData = new Map();
let activeRunId = null;
let runCounter = 0;

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/api/status', async (_req, res) => {
  try {
    const r = await fetch(`${CONFORMANCE_URL}api/runner/available`, { signal: AbortSignal.timeout(5000) });
    res.json({ conformance_suite: r.ok ? 'connected' : 'unavailable', url: CONFORMANCE_URL });
  } catch {
    res.json({ conformance_suite: 'unavailable', url: CONFORMANCE_URL });
  }
});

app.get('/api/plans', (_req, res) => {
  res.json(PLANS.map(({ id, label, phase, planName }) => ({ id, label, phase, planName })));
});

app.get('/api/runs', (_req, res) => {
  res.json([...runs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)));
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  for (const run of runs.values()) {
    res.write(`event: run_state\ndata: ${JSON.stringify(run)}\n\n`);
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/info/:moduleId', (req, res) => {
  const entry = moduleData.get(req.params.moduleId);
  if (!entry) return res.status(404).json({ error: 'module not found' });
  res.json(entry.info);
});

app.get('/api/log/:moduleId', (req, res) => {
  const entry = moduleData.get(req.params.moduleId);
  if (!entry) return res.status(404).json({ error: 'module not found' });
  res.json(entry.log || []);
});

app.post('/api/runs', (req, res) => {
  const { planType } = req.body || {};
  const plan = PLANS.find((p) => p.id === planType);
  if (!plan) {
    return res.status(400).json({ error: `unknown planType: ${planType}` });
  }
  if (activeRunId) {
    return res.status(409).json({ error: `a run (${activeRunId}) is already in progress` });
  }

  const id = `run-${++runCounter}-${Date.now()}`;
  const run = {
    id, planType, label: plan.label, status: 'creating', startedAt: Date.now(),
    modules: [], results: [], currentModule: null,
  };
  runs.set(id, run);
  activeRunId = id;

  res.status(201).json({ id, planType });
  broadcast('run_start', { id, planType, label: plan.label });

  const child = spawn('npx', ['playwright', 'test', plan.specFile, '--reporter=list'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: 'true' },
  });

  let sawSummary = false;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = line.match(/^##CONFORMANCE-EVENT## (.+)$/);
    if (!m) return;
    let evt;
    try {
      evt = JSON.parse(m[1]);
    } catch {
      return;
    }
    if (evt.type === 'run_summary') sawSummary = true;
    handleEvent(run, evt);
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  child.on('close', (code) => {
    if (activeRunId === id) activeRunId = null;
    if (!sawSummary) {
      run.status = 'error';
      run.error = `process exited with code ${code}` + (stderrTail ? `: ${stderrTail.slice(-500)}` : '');
      run.finishedAt = Date.now();
      broadcast('run_error', { id: run.id, error: run.error });
    }
  });
});

function handleEvent(run, evt) {
  switch (evt.type) {
    case 'plan_created':
      run.status = 'running';
      run.modules = evt.modules || [];
      run.planId = evt.planId;
      run.planDetailUrl = evt.planDetailUrl;
      broadcast('run_update', {
        id: run.id, status: 'running', modules: run.modules,
        planId: run.planId, planDetailUrl: run.planDetailUrl,
      });
      break;
    case 'module_start':
      run.currentModule = evt.module;
      broadcast('module_event', { type: 'module_start', runId: run.id, module: evt.module });
      break;
    case 'module_result': {
      const entry = { module: evt.module, status: evt.status, result: evt.result, moduleId: evt.moduleId };
      const idx = run.results.findIndex((r) => r.module === evt.module);
      if (idx >= 0) run.results[idx] = entry;
      else run.results.push(entry);
      run.currentModule = null;
      if (evt.moduleId) {
        moduleData.set(evt.moduleId, {
          info: { result: evt.result, status: evt.status, testModule: evt.module },
          log: evt.log || [],
        });
      }
      broadcast('module_event', {
        type: 'module_result', runId: run.id, module: evt.module,
        status: evt.status, result: evt.result, moduleId: evt.moduleId,
      });
      break;
    }
    case 'run_summary':
      run.status = 'finished';
      run.passed = evt.passed;
      run.failed = evt.failed;
      run.total = evt.total;
      run.finishedAt = Date.now();
      run.planDetailUrl = evt.planDetailUrl || run.planDetailUrl;
      broadcast('run_finished', {
        id: run.id, passed: run.passed, failed: run.failed,
        total: run.total, planDetailUrl: run.planDetailUrl,
      });
      break;
  }
}

app.listen(PORT, () => console.log(`conformance-runner listening on :${PORT}, suite at ${CONFORMANCE_URL}`));
