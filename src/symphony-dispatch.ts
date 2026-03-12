import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

import { buildSymphonyLaunchPlan } from './symphony-backends.js';
import {
  buildSymphonyPrompt,
  parseSymphonyIssueContract,
} from './symphony-issue-contract.js';
import {
  addIssueComment,
  getIssueByIdentifier,
  listReadyIssuesForProject,
  resolveLinearStateId,
  updateIssueState,
  type SymphonyLinearIssueDetail,
} from './symphony-linear.js';
import {
  resolveSymphonyBackend,
  type ProjectRegistryEntry,
} from './symphony-routing.js';
import {
  buildRunId,
  updateRunRecord,
  writeRunRecord,
  type SymphonyRunRecord,
} from './symphony-state.js';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandTemplateEnvName(backend: 'codex' | 'claude-code' | 'opencode-worker'): string {
  switch (backend) {
    case 'codex':
      return 'NANOCLAW_SYMPHONY_CODEX_COMMAND';
    case 'claude-code':
      return 'NANOCLAW_SYMPHONY_CLAUDE_CODE_COMMAND';
    case 'opencode-worker':
      return 'NANOCLAW_SYMPHONY_OPENCODE_COMMAND';
  }
}

function renderCommandTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    const value = replacements[key];
    if (value === undefined) {
      throw new Error(`Unknown Symphony command template placeholder: ${key}`);
    }
    return value;
  });
}

function commandForPlan(plan: ReturnType<typeof buildSymphonyLaunchPlan>): string {
  const envName = commandTemplateEnvName(plan.backend);
  const template = process.env[envName] || '';
  if (!template) {
    throw new Error(`Missing ${envName} for Symphony launch.`);
  }

  const promptFile = path.join(plan.workspacePath, 'PROMPT.md');
  const logFile = path.join(plan.workspacePath, 'run.log');

  return renderCommandTemplate(template, {
    workspace: shellEscape(plan.workspacePath),
    promptFile: shellEscape(promptFile),
    logFile: shellEscape(logFile),
    issueIdentifier: shellEscape(plan.env.NANOCLAW_SYMPHONY_ISSUE_IDENTIFIER),
  });
}

function sortCandidates(issues: Awaited<ReturnType<typeof listReadyIssuesForProject>>) {
  return [...issues].sort((left, right) => {
    const priorityDelta = left.priority - right.priority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.identifier.localeCompare(right.identifier);
  });
}

function runGitCommand(args: string[], cwd: string): string {
  return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf8' });
}

function createGitWorktree(workspacePath: string, githubRepo: string, branchName: string): void {
  // Determine the source repo - use current nanoclaw repo, otherwise use remote
  let sourceRepo: string | undefined;

  // Use current nanoclaw repo as source if it exists
  const currentDir = process.cwd();
  if (fs.existsSync(path.join(currentDir, '.git'))) {
    sourceRepo = currentDir;
  }

  if (!sourceRepo) {
    // Use remote URL
    sourceRepo = `https://github.com/${githubRepo}.git`;
  }

  console.log(`Creating git worktree at ${workspacePath} from ${sourceRepo} branch ${branchName}`);

  // Create the worktree
  try {
    runGitCommand(['worktree', 'add', '-B', branchName, workspacePath, 'origin/main'], sourceRepo);
  } catch (err) {
    // If worktree already exists, try to prune and recreate
    try {
      runGitCommand(['worktree', 'remove', '--force', workspacePath], sourceRepo);
      runGitCommand(['worktree', 'add', '-B', branchName, workspacePath, 'origin/main'], sourceRepo);
    } catch (retryErr) {
      console.error('Failed to create worktree:', retryErr);
      throw retryErr;
    }
  }
}

function injectMcpConfig(workspacePath: string): void {
  const symphonyMcpConfig = {
    mcpServers: {
      symphony: {
        command: 'bash',
        args: [
          'scripts/workflow/run-with-env.sh',
          'npx',
          'tsx',
          'scripts/workflow/symphony-mcp.ts',
        ],
      },
    },
  };

  const symphonyCodexConfig = `[mcp_servers.symphony]
command = "bash"
args = [
  "scripts/workflow/run-with-env.sh",
  "npx",
  "tsx",
  "scripts/workflow/symphony-mcp.ts"
]
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
env_vars = ["NOTION_TOKEN", "NOTION_SESSION_SUMMARY_DATABASE_ID", "NOTION_NIGHTLY_DATABASE_ID", "NOTION_PROJECT_REGISTRY_DATABASE_ID", "LINEAR_API_KEY", "NANOCLAW_LINEAR_TEAM_KEY"]
`;

  fs.writeFileSync(
    path.join(workspacePath, '.mcp.json'),
    JSON.stringify(symphonyMcpConfig, null, 2) + '\n',
    'utf8',
  );
  fs.mkdirSync(path.join(workspacePath, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, '.codex', 'config.toml'), symphonyCodexConfig, 'utf8');
}

function prepareWorkspace(
  issue: SymphonyLinearIssueDetail,
  plan: ReturnType<typeof buildSymphonyLaunchPlan>,
  prompt: string,
  runId: string,
): { promptFile: string; manifestFile: string; logFile: string; exitFile: string } {
  // Create worktree if enabled
  if (plan.useWorktree) {
    const branchName = `symphony-${issue.identifier.toLowerCase()}`;
    createGitWorktree(plan.workspacePath, plan.githubRepo, branchName);
  } else {
    fs.mkdirSync(plan.workspacePath, { recursive: true });
  }

  // Inject MCP config for agents running in this workspace
  injectMcpConfig(plan.workspacePath);

  const promptFile = path.join(plan.workspacePath, 'PROMPT.md');
  const manifestFile = path.join(plan.workspacePath, 'RUN.json');
  const logFile = path.join(plan.workspacePath, 'run.log');
  const exitFile = path.join(plan.workspacePath, 'RUN_EXIT.json');

  fs.writeFileSync(promptFile, `${prompt}\n`, 'utf8');
  fs.writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
        },
        runId,
        plan,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { promptFile, manifestFile, logFile, exitFile };
}

function launchDetached(
  command: string,
  cwd: string,
  env: Record<string, string>,
  logFile: string,
  exitFile: string,
): number {
  const out = fs.openSync(logFile, 'a');
  const wrapped = `${command}
code=$?
python3 - <<'PY' ${shellEscape(exitFile)} "$code"
import json
import sys
from datetime import datetime, timezone

path = sys.argv[1]
code = int(sys.argv[2])
payload = {
  "code": code,
  "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
with open(path, "w", encoding="utf-8") as handle:
  json.dump(payload, handle)
  handle.write("\\n")
PY
exit $code`;

  const { CLAUDECODE: _omit, ...envWithoutClaudeCode } = { ...process.env, ...env };
  const child = spawn('/bin/sh', ['-lc', wrapped], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env: envWithoutClaudeCode,
  });
  child.unref();
  return child.pid ?? 0;
}

function commentBody(input: {
  issue: SymphonyLinearIssueDetail;
  plan: ReturnType<typeof buildSymphonyLaunchPlan>;
  pid: number;
  logFile: string;
}): string {
  return [
    '<!-- symphony-dispatch -->',
    `Project: ${input.plan.env.NANOCLAW_SYMPHONY_PROJECT_KEY}`,
    `Backend: ${input.plan.backend}`,
    `Issue: ${input.issue.identifier}`,
    `PID: ${input.pid}`,
    `Workspace: ${input.plan.workspacePath}`,
    `Log File: ${input.logFile}`,
    `Status: In Progress`,
  ].join('\n');
}

export async function dispatchOnceForProject(
  project: ProjectRegistryEntry,
  options: { issueIdentifier?: string; dryRun?: boolean } = {},
) {
  const candidates = sortCandidates(await listReadyIssuesForProject(project));
  const selectedSummary = options.issueIdentifier
    ? candidates.find((issue) => issue.identifier === options.issueIdentifier)
    : candidates[0];

  if (!selectedSummary) {
    return {
      action: 'noop' as const,
      reason: options.issueIdentifier ? 'issue_not_found_or_not_ready' : 'no_ready_issue',
    };
  }

  const issue = await getIssueByIdentifier(selectedSummary.identifier);
  const parsed = parseSymphonyIssueContract(issue.description);
  const resolved = resolveSymphonyBackend(
    { schemaVersion: 1, projects: [project] },
    {
      issueId: issue.id,
      identifier: issue.identifier,
      projectKey: project.projectKey,
      state: issue.state,
      workClass: parsed.workClass,
      executionLane: parsed.executionLane,
      targetRuntime: parsed.targetRuntime,
      repoUrl: project.githubRepo,
      baseBranch: 'main',
      notionContextUrl: project.notionRoot,
    },
  );
  const plan = buildSymphonyLaunchPlan({
    ...resolved,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    githubRepo: project.githubRepo,
  });
  const prompt = buildSymphonyPrompt(issue);
  const runId = buildRunId(issue.identifier);
  const workspaceFiles = prepareWorkspace(issue, plan, prompt, runId);

  const baseRecord: SymphonyRunRecord = {
    runId,
    projectKey: project.projectKey,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    linearIssueUrl: issue.url,
    notionRoot: project.notionRoot,
    githubRepo: project.githubRepo,
    backend: plan.backend,
    status: options.dryRun ? 'planned' : 'dispatching',
    workspacePath: plan.workspacePath,
    promptFile: workspaceFiles.promptFile,
    manifestFile: workspaceFiles.manifestFile,
    logFile: workspaceFiles.logFile,
    exitFile: workspaceFiles.exitFile,
    pid: null,
    startedAt: new Date().toISOString(),
  };
  writeRunRecord(baseRecord);

  if (options.dryRun) {
    return {
      action: 'prepared' as const,
      issue: issue.identifier,
      runId,
      plan,
      workspaceFiles,
    };
  }

  const command = commandForPlan(plan);
  const pid = launchDetached(
    command,
    plan.workspacePath,
    plan.env,
    workspaceFiles.logFile,
    workspaceFiles.exitFile,
  );
  updateRunRecord(runId, {
    pid,
    status: 'running',
  });
  const inProgressStateId = resolveLinearStateId(issue, 'In Progress');
  await updateIssueState(issue.id, inProgressStateId);
  await addIssueComment(
    issue.id,
    commentBody({
      issue,
      plan,
      pid,
      logFile: workspaceFiles.logFile,
    }),
  );

  return {
    action: 'dispatched' as const,
    issue: issue.identifier,
    runId,
    pid,
    plan,
    workspaceFiles,
  };
}
