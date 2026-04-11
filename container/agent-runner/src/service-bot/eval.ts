// Eval tools — run and score MBot trust evaluations via SSH.

import { getBotConfig } from './config.js';
import { shellEscape, type SshExecutor } from './ssh.js';
import type { GitHubClient } from './github.js';
import { emitServiceAction } from './telemetry-emit.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const EVAL_HARNESS = 'python3 scripts/eval_harness.py';
const EVAL_SCORER = 'python3 scripts/eval_scorer.py';
const STIMULI_DIR = '/opt/mbot/scripts/eval_stimuli/';
const RESULTS_DIR = '/mnt/mbot-data/eval/results/';
const BASE_URL = 'http://localhost:8000';
const VERDICT_PATH = `${RESULTS_DIR}verdict.json`;

/** Eval harness can be slow — allow up to 5 minutes per stage. */
const EVAL_COMMAND_TIMEOUT = 300;

// ─── runEvalStage ───────────────────────────────────────────────────────────

/**
 * Run a single eval stage (1-4) on the MBot droplet.
 * SSHs in, executes the eval harness, then reads the results file.
 */
export async function runEvalStage(
  stage: number,
  ssh: SshExecutor,
  botName: string = 'mbot',
): Promise<string> {
  if (stage < 1 || stage > 4 || !Number.isInteger(stage)) {
    return `Error: stage must be an integer between 1 and 4 (got ${stage}).`;
  }

  const config = getBotConfig(botName);
  const target = config.sshTarget;

  // Step 1: Run the eval harness
  const cmd = [
    `cd /opt/mbot &&`,
    EVAL_HARNESS,
    `--stage ${stage}`,
    `--stimuli-dir ${shellEscape(STIMULI_DIR)}`,
    `--results-dir ${shellEscape(RESULTS_DIR)}`,
    `--base-url ${shellEscape(BASE_URL)}`,
  ].join(' ');

  const runResult = await ssh(target, cmd, { commandTimeout: EVAL_COMMAND_TIMEOUT });

  if (runResult.exitCode !== 0) {
    let output = `Error: Eval harness stage ${stage} failed (exit ${runResult.exitCode}).\n`;
    if (runResult.stderr) output += `stderr: ${runResult.stderr}\n`;
    if (runResult.stdout) output += `stdout: ${runResult.stdout}`;
    return output;
  }

  // Step 2: Read the results file
  const resultsFile = `${RESULTS_DIR}stage${stage}.json`;
  const catResult = await ssh(target, `cat ${shellEscape(resultsFile)}`);

  if (catResult.exitCode !== 0) {
    return `Eval harness completed but could not read results at ${resultsFile}: ${catResult.stderr}`;
  }

  // Validate JSON
  let parsed: any;
  try {
    parsed = JSON.parse(catResult.stdout);
  } catch {
    return `Eval harness completed but results file is not valid JSON:\n${catResult.stdout.slice(0, 2000)}`;
  }

  // Emit telemetry (fire-and-forget)
  emitServiceAction({
    targetBot: botName,
    action: 'eval_stage',
    trigger: 'manual',
    result: 'success',
    summary: `Ran eval stage ${stage} on ${config.name}`,
  }).catch(() => {});

  return JSON.stringify(parsed, null, 2);
}

// ─── scoreEval ──────────────────────────────────────────────────────────────

/**
 * Score eval results for a specific stage or all stages.
 * If "all", produces a verdict.json with the aggregate result.
 */
export async function scoreEval(
  stage: number | 'all',
  ssh: SshExecutor,
  botName: string = 'mbot',
): Promise<string> {
  if (stage !== 'all' && (stage < 1 || stage > 4 || !Number.isInteger(stage))) {
    return `Error: stage must be 1-4 or "all" (got ${stage}).`;
  }

  const config = getBotConfig(botName);
  const target = config.sshTarget;

  let cmd: string;
  let outputFile: string;

  if (stage === 'all') {
    cmd = [
      `cd /opt/mbot &&`,
      EVAL_SCORER,
      `--all`,
      `--results-dir ${shellEscape(RESULTS_DIR)}`,
      `--output ${shellEscape(VERDICT_PATH)}`,
    ].join(' ');
    outputFile = VERDICT_PATH;
  } else {
    cmd = [
      `cd /opt/mbot &&`,
      EVAL_SCORER,
      `--stage ${stage}`,
      `--results-dir ${shellEscape(RESULTS_DIR)}`,
    ].join(' ');
    // Single-stage scorer prints to stdout
    outputFile = '';
  }

  const runResult = await ssh(target, cmd, { commandTimeout: EVAL_COMMAND_TIMEOUT });

  if (runResult.exitCode !== 0) {
    let output = `Error: Eval scorer failed (exit ${runResult.exitCode}).\n`;
    if (runResult.stderr) output += `stderr: ${runResult.stderr}\n`;
    if (runResult.stdout) output += `stdout: ${runResult.stdout}`;
    return output;
  }

  // For "all", read the verdict file; for single stage, return stdout
  if (outputFile) {
    const catResult = await ssh(target, `cat ${shellEscape(outputFile)}`);
    if (catResult.exitCode !== 0) {
      return `Scorer completed but could not read output at ${outputFile}: ${catResult.stderr}`;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(catResult.stdout);
    } catch {
      return `Scorer completed but output is not valid JSON:\n${catResult.stdout.slice(0, 2000)}`;
    }

    // Emit telemetry (fire-and-forget)
    emitServiceAction({
      targetBot: botName,
      action: 'eval_score_all',
      trigger: 'manual',
      result: 'success',
      summary: `Scored all eval stages on ${config.name}`,
    }).catch(() => {});

    return JSON.stringify(parsed, null, 2);
  }

  // Single stage — scorer output is on stdout
  emitServiceAction({
    targetBot: botName,
    action: 'eval_score_stage',
    trigger: 'manual',
    result: 'success',
    summary: `Scored eval stage ${stage} on ${config.name}`,
  }).catch(() => {});

  return runResult.stdout || '(no output)';
}

// ─── evalVerdictReport ──────────────────────────────────────────────────────

/**
 * Read the verdict.json, format it as a GitHub issue, and create it
 * in the bot's issues repo.
 */
export async function evalVerdictReport(
  botName: string,
  ssh: SshExecutor,
  github: GitHubClient,
): Promise<string> {
  const config = getBotConfig(botName);
  const target = config.sshTarget;

  // Step 1: Read verdict.json
  const catResult = await ssh(target, `cat ${shellEscape(VERDICT_PATH)}`);

  if (catResult.exitCode !== 0) {
    return `Error: Could not read verdict at ${VERDICT_PATH}: ${catResult.stderr}\nRun score_eval with stage="all" first to generate the verdict.`;
  }

  let verdict: any;
  try {
    verdict = JSON.parse(catResult.stdout);
  } catch {
    return `Error: verdict.json is not valid JSON:\n${catResult.stdout.slice(0, 2000)}`;
  }

  // Step 2: Format as GitHub issue body
  const date = new Date().toISOString().split('T')[0];
  const overallVerdict = verdict.verdict ?? verdict.overall ?? 'unknown';
  const overallScore = verdict.score ?? verdict.overall_score ?? 'N/A';

  const title = `MBot Trust Evaluation — ${date} — ${overallVerdict}`;

  const stageLines: string[] = [];
  const stages = verdict.stages ?? verdict.stage_results ?? [];
  for (const s of stages) {
    const stageName = s.name ?? `Stage ${s.stage ?? '?'}`;
    const stageScore = s.score ?? s.result ?? 'N/A';
    const stagePass = s.passed !== undefined ? (s.passed ? 'PASS' : 'FAIL') : '';
    stageLines.push(`| ${stageName} | ${stageScore} | ${stagePass} |`);
  }

  const body = [
    `## MBot Trust Evaluation Report`,
    ``,
    `**Date:** ${date}`,
    `**Bot:** ${config.name}`,
    `**Verdict:** ${overallVerdict}`,
    `**Score:** ${overallScore}`,
    ``,
    `### Stage Results`,
    ``,
    `| Stage | Score | Status |`,
    `|-------|-------|--------|`,
    ...stageLines,
    ``,
    `### Raw Verdict`,
    ``,
    '```json',
    JSON.stringify(verdict, null, 2),
    '```',
    ``,
    `---`,
    `*Generated by X (NanoClaw) eval orchestrator.*`,
  ].join('\n');

  // Step 3: Create the GitHub issue
  const repoStr = config.githubIssuesRepo;
  const [owner, repo] = repoStr.includes('/') ? repoStr.split('/') : ['', ''];

  try {
    const issue = await github.createIssue({
      owner,
      repo,
      title,
      body,
      labels: ['bot-reported', 'eval'],
    });

    // Emit telemetry (fire-and-forget)
    emitServiceAction({
      targetBot: botName,
      action: 'eval_verdict_report',
      trigger: 'manual',
      ticketRef: issue.html_url,
      result: 'success',
      summary: `Created eval verdict issue #${issue.number}: ${title}`,
    }).catch(() => {});

    return `Created eval verdict issue #${issue.number}: ${title}\n${issue.html_url}`;
  } catch (err: any) {
    return `Error creating verdict issue: ${err.message}`;
  }
}
