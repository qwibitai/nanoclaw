#!/usr/bin/env npx tsx
/**
 * overnight-dent-run — Execute a single make-a-dent run with real-time observability.
 *
 * Called by the trampoline (overnight-dent.sh). Re-read from disk each
 * iteration, so merged improvements take effect on the next run.
 *
 * Usage: npx tsx scripts/overnight-dent-run.ts <state-file>
 *
 * Reads batch config and cross-run state from state.json.
 * Spawns claude with --output-format stream-json for real-time milestones.
 * Writes results back after the run completes.
 *
 * Stop mechanism: if Claude outputs "OVERNIGHT_STOP: <reason>" in its
 * response, this sets stop_reason in state.json so the trampoline stops.
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BatchState {
  batch_id: string;
  batch_start: number;
  batch_end?: number;
  guidance: string;
  max_runs: number;
  cooldown: number;
  budget: string;
  max_failures: number;
  run: number;
  prs: string[];
  issues_filed: string[];
  issues_closed: string[];
  cases: string[];
  consecutive_failures: number;
  current_cooldown: number;
  stop_reason: string;
  last_issue: string;
  last_pr: string;
  last_case: string;
  last_branch: string;
  last_worktree: string;
  progress_issue?: string;
  test_task?: boolean;
  experiment?: boolean;
}

export interface RunResult {
  prs: string[];
  issuesFiled: string[];
  issuesClosed: string[];
  cases: string[];
  cost: number;
  toolCalls: number;
  stopRequested: boolean;
  stopReason?: string;
}

// ── State I/O ────────────────────────────────────────────────────────────────

function readState(stateFile: string): BatchState {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function writeState(stateFile: string, state: BatchState): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

// ── Resolve repo root ────────────────────────────────────────────────────────

function getRepoRoot(): string {
  try {
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return resolve(dirname(new URL(import.meta.url).pathname), '..');
  }
}

// ── Prompt building ──────────────────────────────────────────────────────────

export function buildPrompt(state: BatchState, runNum: number): string {
  const runTag = `${state.batch_id}/run-${runNum}`;

  let prompt: string;

  if (state.test_task) {
    // Synthetic fast task for pipeline testing (kaizen #322)
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    prompt = `You are running a synthetic test task for pipeline validation.

Run tag: ${runTag}

## Task

1. Create a new branch from HEAD: \`test-probe-${runTag.replace(/\//g, '-')}\`
2. Create a file \`test-probe-${timestamp}.md\` with this content:
   \`\`\`
   # Test Probe
   Run tag: ${runTag}
   Timestamp: ${new Date().toISOString()}
   \`\`\`
3. Commit with message: "test: probe ${runTag}"
4. Create a PR: \`gh pr create --title "test: probe ${runTag}" --body "Synthetic test task for pipeline validation. Run tag: ${runTag}" --repo Garsson-io/nanoclaw\`
5. Queue auto-merge: \`gh pr merge <url> --repo Garsson-io/nanoclaw --squash --delete-branch --auto\`

Do not ask for confirmation. Complete all steps.`;
  } else {
    prompt = `Use /make-a-dent with this guidance: ${state.guidance}`;
  }

  prompt += `

Run tag: ${runTag}
Include this run tag in any PR descriptions or commit messages you create.

## Batch Context

You are running inside an overnight-dent batch loop (run ${runNum}${state.max_runs > 0 ? ` of ${state.max_runs}` : ''}).
After this run completes, the loop will start another run with fresh context.
Run to completion. Do not ask for confirmation — make autonomous decisions.`;

  if (state.issues_closed.length > 0) {
    prompt += `\n\nIssues already addressed in previous runs (do not rework): ${state.issues_closed.join(' ')}`;
  }

  if (state.prs.length > 0) {
    prompt += `\n\nPRs already created in this batch (avoid overlapping work): ${state.prs.join(' ')}`;
  }

  prompt += `

## Merge & Labeling Policy

After creating a PR, you MUST queue it for auto-merge:
  gh pr merge <url> --repo Garsson-io/nanoclaw --squash --delete-branch --auto
Do NOT leave PRs open for manual review — this is an unattended batch.
The harness will also attempt auto-merge as a safety net, but do it yourself first.

## Stopping the Loop

If you determine there is no more meaningful work to do matching the guidance
(backlog exhausted, all relevant issues claimed, or remaining issues are
blocked/too risky), include this exact marker in your final response:

OVERNIGHT_STOP: <reason>

For example: "OVERNIGHT_STOP: backlog exhausted — no more open issues matching 'hooks reliability'"
This will gracefully stop the batch loop. Only use this when you've genuinely
run out of work — not when a single run is complete.

When done, summarize what was accomplished. List all PRs created, issues filed,
and issues closed with full URLs.`;

  return prompt;
}

// ── Stream-JSON parsing ──────────────────────────────────────────────────────

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

export function formatToolUse(
  name: string,
  input: Record<string, any>,
): string {
  switch (name) {
    case 'Read':
      return `Read ${truncate(input?.file_path || '?', 60)}`;
    case 'Edit':
      return `Edit ${truncate(input?.file_path || '?', 60)}`;
    case 'Write':
      return `Write ${truncate(input?.file_path || '?', 60)}`;
    case 'Bash':
      return `$ ${truncate(input?.command || input?.description || '?', 70)}`;
    case 'Grep':
      return `Grep "${truncate(input?.pattern || '?', 30)}" ${input?.path || ''}`;
    case 'Glob':
      return `Glob ${truncate(input?.pattern || '?', 50)}`;
    case 'Skill':
      return `Skill /${input?.skill_name || '?'}`;
    case 'Agent':
      return `Agent: ${truncate(input?.description || '?', 50)}`;
    case 'TaskCreate':
      return `Task+ ${truncate(input?.subject || '?', 50)}`;
    case 'TaskUpdate':
      return `Task~ #${input?.taskId || '?'} -> ${input?.status || '?'}`;
    default:
      return name;
  }
}

export function extractArtifacts(text: string, result: RunResult): void {
  for (const m of text.matchAll(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g,
  )) {
    if (!result.prs.includes(m[0])) result.prs.push(m[0]);
  }
  for (const m of text.matchAll(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/g,
  )) {
    if (!result.issuesFiled.includes(m[0])) result.issuesFiled.push(m[0]);
  }
  for (const m of text.matchAll(
    /(?:closes?|closed|fix(?:es|ed)?|resolves?)\s+(#\d+)/gi,
  )) {
    if (!result.issuesClosed.includes(m[1])) result.issuesClosed.push(m[1]);
  }
  // Extract kaizen issue references from PR titles, commit messages, and agent text (kaizen #299)
  // Pattern: "kaizen #N" — common in PR titles like "fix: xyz (kaizen #204)"
  // These indicate the issue is being addressed even without explicit "closes #N"
  for (const m of text.matchAll(/kaizen\s+#(\d+)/gi)) {
    const ref = `#${m[1]}`;
    if (!result.issuesClosed.includes(ref)) result.issuesClosed.push(ref);
  }
  for (const m of text.matchAll(/case[:\s]+(\d{6}-\d{4}-[\w-]+)/g)) {
    if (!result.cases.includes(m[1])) result.cases.push(m[1]);
  }
}

export function checkStopSignal(text: string, result: RunResult): void {
  const match = text.match(/OVERNIGHT_STOP:\s*(.+)/);
  if (match) {
    result.stopRequested = true;
    result.stopReason = match[1].trim();
  }
}

export function processStreamMessage(
  msg: Record<string, any>,
  result: RunResult,
  runStart: number,
): void {
  const elapsed = formatElapsed(runStart);

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        console.log(
          `  [${elapsed}]  Session ${(msg.session_id || '').slice(0, 8)}... | model: ${msg.model || 'default'}`,
        );
      }
      break;

    case 'assistant':
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            result.toolCalls++;
            console.log(
              `  [${elapsed}]  ${formatToolUse(block.name, block.input)}`,
            );
          }
          if (block.type === 'text' && block.text) {
            extractArtifacts(block.text, result);
            checkStopSignal(block.text, result);
          }
        }
      }
      break;

    case 'result':
      if (msg.total_cost_usd) {
        result.cost = msg.total_cost_usd;
      }
      if (msg.result) {
        extractArtifacts(msg.result, result);
        checkStopSignal(msg.result, result);
      }
      console.log(
        `  [${elapsed}]  ${msg.subtype === 'success' ? 'done' : `error: ${msg.subtype}`} | $${result.cost?.toFixed(2) || '?'} | ${result.toolCalls} tool calls`,
      );
      break;
  }
}

// ── Post-run hygiene ──────────────────────────────────────────────────────

function ghExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) {
    console.log(
      `  [hygiene] warning: ${cmd.slice(0, 80)}… → ${e.message?.split('\n')[0] || 'failed'}`,
    );
    return '';
  }
}

export type MergeStatus =
  | 'merged'
  | 'auto_queued'
  | 'open'
  | 'closed'
  | 'unknown';

export function checkMergeStatus(prUrl: string): MergeStatus {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return 'unknown';
  try {
    const json = ghExec(
      `gh pr view ${m[2]} --repo ${m[1]} --json state,mergeStateStatus,autoMergeRequest`,
    );
    if (!json) return 'unknown';
    const data = JSON.parse(json);
    if (data.state === 'MERGED') return 'merged';
    if (data.state === 'CLOSED') return 'closed';
    if (data.autoMergeRequest) return 'auto_queued';
    return 'open';
  } catch {
    return 'unknown';
  }
}

export function labelArtifacts(result: RunResult): void {
  for (const pr of result.prs) {
    const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) {
      ghExec(`gh pr edit ${m[2]} --repo ${m[1]} --add-label overnight-dent`);
      console.log(`  [hygiene] labeled PR ${pr}`);
    }
  }
  for (const issue of result.issuesFiled) {
    const m = issue.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    if (m) {
      ghExec(`gh issue edit ${m[2]} --repo ${m[1]} --add-label overnight-dent`);
      console.log(`  [hygiene] labeled issue ${issue}`);
    }
  }
}

export function queueAutoMerge(result: RunResult): void {
  for (const pr of result.prs) {
    const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) {
      const out = ghExec(
        `gh pr merge ${m[2]} --repo ${m[1]} --squash --delete-branch --auto`,
      );
      if (out) {
        console.log(`  [hygiene] queued auto-merge for PR ${pr}`);
      }
    }
  }
}

export function ensureBatchProgressIssue(
  state: BatchState,
  stateFile: string,
): string {
  if (state.progress_issue) return state.progress_issue;

  const title = `[Batch] ${state.batch_id}: ${state.guidance.slice(0, 60)}`;
  const body = [
    `## Overnight-Dent Batch Progress`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Batch ID** | \`${state.batch_id}\` |`,
    `| **Guidance** | ${state.guidance} |`,
    `| **Max runs** | ${state.max_runs || 'unlimited'} |`,
    `| **Budget/run** | ${state.budget ? '$' + state.budget : 'none'} |`,
    `| **Started** | ${new Date(state.batch_start * 1000).toISOString()} |`,
    '',
    'Run-by-run updates will be posted as comments below.',
    '',
    '_This issue is auto-managed by the overnight-dent harness._',
  ].join('\n');

  const url = ghExec(
    `gh issue create --repo Garsson-io/kaizen --title ${JSON.stringify(title)} --label overnight-dent,kaizen --body ${JSON.stringify(body)}`,
  );

  if (url) {
    console.log(`  [hygiene] created batch progress issue: ${url}`);
    // Persist to state so subsequent runs find it
    const freshState = readState(stateFile);
    freshState.progress_issue = url;
    writeState(stateFile, freshState);
    return url;
  }
  return '';
}

export function updateBatchProgressIssue(
  progressIssue: string,
  runNum: number,
  exitCode: number,
  duration: number,
  result: RunResult,
): void {
  if (!progressIssue) return;

  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return;
  const issueNum = m[1];

  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const lines = [
    `### Run #${runNum} — ${status}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Duration** | ${mins}m ${secs}s |`,
    `| **Cost** | $${result.cost.toFixed(2)} |`,
    `| **Tool calls** | ${result.toolCalls} |`,
  ];

  if (result.prs.length > 0) {
    lines.push(`| **PRs** | ${result.prs.join(', ')} |`);
  }
  if (result.issuesFiled.length > 0) {
    lines.push(`| **Issues filed** | ${result.issuesFiled.join(', ')} |`);
  }
  if (result.issuesClosed.length > 0) {
    lines.push(`| **Issues closed** | ${result.issuesClosed.join(' ')} |`);
  }
  if (result.cases.length > 0) {
    lines.push(
      `| **Cases** | ${result.cases.map((c) => '`' + c + '`').join(', ')} |`,
    );
  }
  if (result.stopRequested) {
    lines.push('', `**STOP requested:** ${result.stopReason}`);
  }

  const comment = lines.join('\n');
  ghExec(
    `gh issue comment ${issueNum} --repo Garsson-io/kaizen --body ${JSON.stringify(comment)}`,
  );
  console.log(`  [hygiene] updated progress issue with run #${runNum}`);
}

export function closeBatchProgressIssue(
  progressIssue: string,
  state: BatchState,
): void {
  if (!progressIssue) return;
  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return;

  const elapsed = Math.floor(Date.now() / 1000) - state.batch_start;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const summary = [
    `### Batch Complete`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Runs** | ${state.run} |`,
    `| **Duration** | ${hours}h ${mins}m |`,
    `| **Stop reason** | ${state.stop_reason || 'completed'} |`,
    `| **PRs** | ${state.prs.length > 0 ? state.prs.join(', ') : 'none'} |`,
    `| **Issues filed** | ${state.issues_filed.length > 0 ? state.issues_filed.join(', ') : 'none'} |`,
    `| **Issues closed** | ${state.issues_closed.length > 0 ? state.issues_closed.join(' ') : 'none'} |`,
  ].join('\n');

  ghExec(
    `gh issue comment ${m[1]} --repo Garsson-io/kaizen --body ${JSON.stringify(summary)}`,
  );
  ghExec(`gh issue close ${m[1]} --repo Garsson-io/kaizen --reason completed`);
  console.log(`  [hygiene] closed batch progress issue`);
}

// ── Execute Claude ───────────────────────────────────────────────────────────

async function runClaude(
  state: BatchState,
  runNum: number,
  logFile: string,
  repoRoot: string,
): Promise<{ exitCode: number; duration: number; result: RunResult }> {
  const result: RunResult = {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
  };

  const prompt = buildPrompt(state, runNum);
  const nonce = `${new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(2, 12)}-${Math.random().toString(16).slice(2, 6)}`;

  const args = [
    '-w',
    nonce,
    '-p',
    prompt,
    // Note: this bypasses interactive permission prompts but NOT custom hooks.
    // Kaizen gates, review loops, and other hook denials still fire. (kaizen #353)
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (state.budget) {
    args.push('--max-budget-usd', state.budget);
  }

  const runStart = Date.now();

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Heartbeat: every 60s print a status line during silence
    let lastOutputTime = Date.now();
    const heartbeatInterval = setInterval(() => {
      const silence = Math.floor((Date.now() - lastOutputTime) / 1000);
      if (silence >= 55) {
        console.log(
          `  [${formatElapsed(runStart)}]  ... working (${result.toolCalls} tool calls so far)`,
        );
      }
    }, 60_000);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      appendFileSync(logFile, line + '\n');
      lastOutputTime = Date.now();

      try {
        const msg = JSON.parse(line);
        processStreamMessage(msg, result, runStart);
      } catch {
        // Non-JSON line — just log it
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      appendFileSync(logFile, data.toString());
    });

    child.on('close', (code) => {
      clearInterval(heartbeatInterval);
      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolve({ exitCode: code ?? 1, duration, result });
    });

    child.on('error', (err) => {
      clearInterval(heartbeatInterval);
      appendFileSync(logFile, `\nProcess error: ${err.message}\n`);
      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolve({ exitCode: 1, duration, result });
    });
  });
}

// ── Display ──────────────────────────────────────────────────────────────────

function printRunSummary(
  runNum: number,
  exitCode: number,
  duration: number,
  result: RunResult,
): void {
  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`;

  console.log('');
  console.log(
    `  \u250c\u2500 Run #${runNum} Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  );
  console.log(`  \u2502 Status:   ${status}`);
  console.log(`  \u2502 Duration: ${duration}s`);
  console.log(`  \u2502 Cost:     $${result.cost.toFixed(2)}`);
  console.log(`  \u2502 Tools:    ${result.toolCalls} calls`);

  for (const pr of result.prs) console.log(`  \u2502 PR:       ${pr}`);
  for (const issue of result.issuesFiled)
    console.log(`  \u2502 Issue:    ${issue}`);
  if (result.issuesClosed.length > 0)
    console.log(`  \u2502 Closed:   ${result.issuesClosed.join(' ')}`);
  for (const c of result.cases) console.log(`  \u2502 Case:     ${c}`);
  if (result.stopRequested)
    console.log(`  \u2502 STOP:     ${result.stopReason}`);

  console.log(
    `  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  );
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const MIN_RUN_SECONDS = 60;

async function main(): Promise<void> {
  const stateFile = process.argv[2];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: overnight-dent-run.ts <state-file>');
    if (stateFile) console.error(`State file not found: ${stateFile}`);
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const state = readState(stateFile);
  const logDir = dirname(stateFile);
  const runNum = state.run + 1;
  const runTag = `${state.batch_id}/run-${runNum}`;

  // Advisory disk usage check
  const duScript = `${repoRoot}/scripts/worktree-du.sh`;
  if (existsSync(duScript)) {
    try {
      execSync(`"${duScript}" analyze --fast`, {
        cwd: repoRoot,
        stdio: 'inherit',
      });
    } catch {
      /* advisory only */
    }
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
  const logFile = `${logDir}/run-${runNum}-${timestamp}.log`;

  console.log(`Tag: ${runTag}`);
  console.log(`Log: ${logFile}`);

  // Execute Claude with stream-json
  const { exitCode, duration, result } = await runClaude(
    state,
    runNum,
    logFile,
    repoRoot,
  );

  // Append metadata to log
  appendFileSync(
    logFile,
    [
      '',
      '--- overnight-dent metadata ---',
      `batch_id=${state.batch_id}`,
      `run=${runNum}`,
      `exit_code=${exitCode}`,
      `duration_seconds=${duration}`,
      `cost_usd=${result.cost.toFixed(2)}`,
      `prs=${result.prs.join(' ')}`,
      `issues_filed=${result.issuesFiled.join(' ')}`,
      `issues_closed=${result.issuesClosed.join(' ')}`,
      `cases=${result.cases.join(' ')}`,
      `stop_requested=${result.stopRequested}`,
      '',
    ].join('\n'),
  );

  printRunSummary(runNum, exitCode, duration, result);

  // ── Post-run hygiene: label, auto-merge, progress tracking ──────────────

  const progressIssue = ensureBatchProgressIssue(state, stateFile);
  labelArtifacts(result);
  queueAutoMerge(result);

  // Check merge status of each PR (kaizen #322)
  for (const pr of result.prs) {
    const status = checkMergeStatus(pr);
    console.log(`  [merge-tracking] ${pr}: ${status}`);
    if (state.experiment) {
      appendFileSync(logFile, `merge_status=${pr} ${status}\n`);
    }
  }

  updateBatchProgressIssue(progressIssue, runNum, exitCode, duration, result);

  // ── Update state ─────────────────────────────────────────────────────────

  const freshState = readState(stateFile);
  freshState.run = runNum;

  for (const pr of result.prs) {
    if (!freshState.prs.includes(pr)) freshState.prs.push(pr);
  }
  for (const issue of result.issuesFiled) {
    if (!freshState.issues_filed.includes(issue))
      freshState.issues_filed.push(issue);
  }
  for (const closed of result.issuesClosed) {
    if (!freshState.issues_closed.includes(closed))
      freshState.issues_closed.push(closed);
  }
  for (const caseName of result.cases) {
    if (!freshState.cases.includes(caseName)) freshState.cases.push(caseName);
  }

  // Track last-worked-on artifacts for halt/status reporting
  if (result.prs.length > 0) {
    freshState.last_pr = result.prs[result.prs.length - 1];
  }
  if (result.issuesFiled.length > 0) {
    freshState.last_issue = result.issuesFiled[result.issuesFiled.length - 1];
  } else if (result.issuesClosed.length > 0) {
    freshState.last_issue = result.issuesClosed[result.issuesClosed.length - 1];
  }
  if (result.cases.length > 0) {
    const lastCase = result.cases[result.cases.length - 1];
    freshState.last_case = lastCase;
    freshState.last_branch = `case/${lastCase}`;
    freshState.last_worktree = `.claude/worktrees/${lastCase}`;
  }

  // Consecutive failure tracking
  const hasPrs = result.prs.length > 0;
  if (exitCode !== 0 && !hasPrs) {
    freshState.consecutive_failures =
      (freshState.consecutive_failures || 0) + 1;
    console.log(
      `>>> Consecutive failures: ${freshState.consecutive_failures} / ${freshState.max_failures}`,
    );
  } else {
    freshState.consecutive_failures = 0;
    freshState.current_cooldown = freshState.cooldown;
  }

  // Fast-fail detection
  const hasIssues = result.issuesFiled.length > 0;
  if (duration < MIN_RUN_SECONDS && !hasPrs && !hasIssues) {
    console.log(
      `>>> Fast fail detected (${duration}s < ${MIN_RUN_SECONDS}s threshold, no output)`,
    );
    freshState.current_cooldown = Math.min(
      (freshState.current_cooldown || freshState.cooldown) * 2,
      600,
    );
    console.log(`>>> Escalated cooldown to ${freshState.current_cooldown}s`);
  }

  // Stop signal from Claude
  if (result.stopRequested) {
    freshState.stop_reason = `agent requested stop: ${result.stopReason}`;
    console.log(`>>> Claude requested batch stop: ${result.stopReason}`);
  }

  writeState(stateFile, freshState);
  process.exit(exitCode);
}

// ── Close batch subcommand ────────────────────────────────────────────────

function closeBatch(): void {
  const stateFile = process.argv[3];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: overnight-dent-run.ts --close-batch <state-file>');
    process.exit(1);
  }
  const state = readState(stateFile);
  if (state.progress_issue) {
    closeBatchProgressIssue(state.progress_issue, state);
  }
}

// Guard: don't run main() when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith('overnight-dent-run.ts') ||
  process.argv[1]?.endsWith('overnight-dent-run.js');

if (isDirectRun) {
  if (process.argv[2] === '--close-batch') {
    closeBatch();
  } else {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}
