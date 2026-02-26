/**
 * End-to-end smoke test for Andy-Developer -> Jarvis Worker flow.
 *
 * Stages validated:
 * 1. Andy container starts on agent image and emits strict dispatch JSON.
 * 2. Dispatch payload is parsed and validated.
 * 3. Jarvis worker container starts on worker image and executes the task.
 * 4. Completion contract is parsed and validated.
 * 5. worker_runs row transitions to review_requested with completion artifacts.
 *
 * Run with: npx tsx scripts/test-worker-e2e.ts
 */
import { execSync } from 'child_process';

import { runContainerAgent } from '../src/container-runner.js';
import {
  parseCompletionContract,
  parseDispatchPayload,
  validateCompletionContract,
  validateDispatchPayload,
} from '../src/dispatch-validator.js';
import {
  _initTestDatabase,
  getWorkerRun,
  insertWorkerRun,
  updateWorkerRunCompletion,
  updateWorkerRunStatus,
} from '../src/db.js';
import { canIpcAccessTarget } from '../src/ipc.js';
import { RegisteredGroup } from '../src/types.js';

const ANDY_GROUP: RegisteredGroup = {
  name: 'Andy Developer',
  folder: 'andy-developer',
  trigger: '@andy',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  containerConfig: {
    timeout: 240_000,
  },
};

const WORKER_GROUP: RegisteredGroup = {
  name: 'Jarvis Worker 1',
  folder: 'jarvis-worker-1',
  trigger: '@jarvis',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  containerConfig: {
    timeout: 240_000,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inspectContainerImage(containerName: string): string {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const raw = execSync(`container inspect ${containerName}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const parsed = JSON.parse(raw) as Array<{
        configuration?: { image?: { reference?: string } };
      }>;
      return parsed[0]?.configuration?.image?.reference || 'unknown';
    } catch {
      // container may not be inspectable yet
    }
  }
  return 'unknown';
}

function formatWorkerPrompt(payload: {
  run_id: string;
  task_type: string;
  repo: string;
  branch: string;
  input: string;
  acceptance_tests: string[];
  output_contract: { required_fields: string[] };
}): string {
  const acceptance = payload.acceptance_tests.map((item) => `- ${item}`).join('\n');
  const required = payload.output_contract.required_fields.map((item) => `- ${item}`).join('\n');

  return [
    `Run ID: ${payload.run_id}`,
    `Task Type: ${payload.task_type}`,
    `Repository: ${payload.repo}`,
    `Branch: ${payload.branch}`,
    'Task:',
    payload.input,
    'Acceptance Tests (all must pass):',
    acceptance,
    'Output Contract (MUST be wrapped in <completion> JSON):',
    required,
    'Execution rules:',
    '- Run commands only inside /workspace/group.',
    '- Do not use /workspace/extra or other external directories.',
    '- Do not clone repositories for this smoke test.',
    '- Return exactly one <completion> block and no extra prose.',
  ].join('\n\n');
}

async function main() {
  const uniqueToken = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const smokeRunId = `smoke-${uniqueToken}`;
  const smokeBranch = `jarvis-smoke-${uniqueToken}`;
  const smokeFile = `smoke-flow-${uniqueToken}.txt`;
  const startMs = Date.now();

  _initTestDatabase();

  console.log('=== Andy -> Jarvis Worker Smoke Test ===');
  console.log(`run_id=${smokeRunId}`);

  const delegationAllowed = canIpcAccessTarget('andy-developer', false, WORKER_GROUP);
  console.log(`delegation_auth(andy->jarvis): ${delegationAllowed ? 'PASS' : 'FAIL'}`);
  if (!delegationAllowed) {
    throw new Error('andy-developer cannot delegate to jarvis-worker according to IPC auth gate');
  }

  const andyPrompt = [
    'You are Andy-Developer.',
    'Return ONLY one strict JSON object (no markdown).',
    'Create a worker dispatch payload with these exact values:',
    `- run_id: ${smokeRunId}`,
    '- task_type: code',
    '- repo: openclaw-gurusharan/nanoclaw',
    `- branch: ${smokeBranch}`,
    `- acceptance_tests: ["test -f ${smokeFile}","grep -q 'smoke' ${smokeFile}"]`,
    '- output_contract.required_fields must include:',
    '  ["run_id","branch","commit_sha","files_changed","test_result","risk","pr_skipped_reason"]',
    'The input field must instruct worker to:',
    `1) create ${smokeFile} containing "smoke"`,
    '2) run the acceptance tests',
    '3) respond with <completion> JSON only',
    '4) set commit_sha to "deadbeef" and pr_skipped_reason to "smoke test no PR"',
    `5) set files_changed to a JSON array containing "${smokeFile}" (not a number)`,
  ].join('\n');

  let andyImage = 'unknown';
  let andyContainerName = '';
  let andyText = '';
  const andyOutput = await runContainerAgent(
    ANDY_GROUP,
    {
      prompt: andyPrompt,
      groupFolder: ANDY_GROUP.folder,
      chatJid: 'smoke@andy',
      isMain: false,
      runId: `${smokeRunId}-andy`,
    },
    async (_proc, containerName) => {
      andyContainerName = containerName;
      await sleep(250);
      andyImage = inspectContainerImage(containerName);
    },
    async (result) => {
      if (result.result) {
        andyText = String(result.result);
        if (andyContainerName) {
          try {
            execSync(`container stop ${andyContainerName}`, {
              stdio: 'ignore',
            });
          } catch {
            // best-effort stop to avoid waiting for idle timeout
          }
        }
      }
    },
  );

  const andyResultText = andyText || (andyOutput.result ? String(andyOutput.result) : '');
  if (!andyResultText) {
    throw new Error(`andy-developer failed: ${andyOutput.error || 'no output'}`);
  }

  console.log(`andy_image: ${andyImage}`);
  console.log(`andy_output_preview: ${andyResultText.slice(0, 200).replace(/\n/g, ' ')}`);

  const dispatch = parseDispatchPayload(andyResultText);
  if (!dispatch) {
    throw new Error('failed to parse dispatch JSON from andy output');
  }
  const dispatchCheck = validateDispatchPayload(dispatch);
  if (!dispatchCheck.valid) {
    throw new Error(`dispatch validation failed: ${dispatchCheck.errors.join('; ')}`);
  }
  console.log('dispatch_validation: PASS');

  const insert = insertWorkerRun(dispatch.run_id, WORKER_GROUP.folder);
  if (insert === 'duplicate') {
    throw new Error(`unexpected duplicate run_id: ${dispatch.run_id}`);
  }
  updateWorkerRunStatus(dispatch.run_id, 'running');
  console.log(`worker_run_insert: ${insert}`);

  let workerImage = 'unknown';
  let workerContainerName = '';
  let workerText = '';
  const workerOutput = await runContainerAgent(
    WORKER_GROUP,
    {
      prompt: formatWorkerPrompt(dispatch),
      groupFolder: WORKER_GROUP.folder,
      chatJid: 'smoke@jarvis-worker-1',
      isMain: false,
      runId: dispatch.run_id,
    },
    async (_proc, containerName) => {
      workerContainerName = containerName;
      await sleep(250);
      workerImage = inspectContainerImage(containerName);
    },
    async (result) => {
      if (result.result) {
        workerText = String(result.result);
        if (workerContainerName) {
          try {
            execSync(`container stop ${workerContainerName}`, {
              stdio: 'ignore',
            });
          } catch {
            // best-effort stop to avoid waiting for idle timeout
          }
        }
      }
    },
  );

  if (workerOutput.status === 'error' && !workerText.trim()) {
    updateWorkerRunStatus(dispatch.run_id, 'failed');
    throw new Error(`worker execution failed: ${workerOutput.error || 'unknown error'}`);
  }
  if (!workerText.trim()) {
    updateWorkerRunStatus(dispatch.run_id, 'failed_contract');
    throw new Error('worker returned no output text');
  }

  console.log(`worker_image: ${workerImage}`);
  console.log(`worker_output_preview: ${workerText.slice(0, 220).replace(/\n/g, ' ')}`);

  const completion = parseCompletionContract(workerText);
  const completionCheck = validateCompletionContract(completion, { expectedRunId: dispatch.run_id });
  if (!completionCheck.valid || !completion) {
    updateWorkerRunStatus(dispatch.run_id, 'failed_contract');
    console.log('\n--- worker_output_full (first 5000 chars) ---');
    console.log(workerText.slice(0, 5000));
    throw new Error(`completion validation failed: ${completionCheck.missing.join(', ')}`);
  }

  updateWorkerRunCompletion(dispatch.run_id, {
    branch_name: completion.branch,
    pr_url: completion.pr_url,
    commit_sha: completion.commit_sha,
    files_changed: completion.files_changed,
    test_summary: completion.test_result,
    risk_summary: completion.risk,
  });
  updateWorkerRunStatus(dispatch.run_id, 'review_requested');
  console.log('completion_validation: PASS');

  const row = getWorkerRun(dispatch.run_id);
  if (!row) throw new Error('worker_runs row missing after completion update');

  console.log('\n--- worker_runs row ---');
  console.log(JSON.stringify(row, null, 2));

  if (row.status !== 'review_requested') {
    throw new Error(`unexpected final status: ${row.status}`);
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\nPASS in ${durationSec}s`);
}

main().catch((err) => {
  console.error('\nFAIL');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
