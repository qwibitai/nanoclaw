// Act tools — perform actions on managed bot infrastructure.

import {
  getBotConfig,
  MAX_EDIT_FILE_SIZE,
  ALLOWED_DOCKER_ACTIONS,
  BLOCKED_DOCKER_PATTERNS,
  type DockerAction,
} from './config.js';
import { shellEscape, type SshExecutor } from './ssh.js';
import type { GitHubClient } from './github.js';
import { emitServiceAction } from './telemetry-emit.js';

// ─── editFile ───────────────────────────────────────────────────────────────

export async function editFile(
  bot: string,
  path: string,
  content: string,
  ssh: SshExecutor,
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const isDbRoot = bot.toLowerCase() === 'db';
  const sudo = isDbRoot ? 'sudo ' : '';
  const escapedPath = shellEscape(path);

  // Step 1: Check file size
  const statResult = await ssh(target, `${sudo}stat -c %s ${escapedPath}`);
  if (statResult.exitCode !== 0) {
    return `Error: Could not stat file ${path}: ${statResult.stderr}`;
  }

  const fileSize = parseInt(statResult.stdout.trim(), 10);
  if (isNaN(fileSize) || fileSize > MAX_EDIT_FILE_SIZE) {
    return `Error: File ${path} is too large (${fileSize} bytes, max ${MAX_EDIT_FILE_SIZE} bytes). Refusing to edit.`;
  }

  // Step 2: Create timestamped backup
  const timestamp = Date.now();
  const backupPath = `${path}.bak.${timestamp}`;
  const backupResult = await ssh(target, `${sudo}cp ${escapedPath} ${shellEscape(backupPath)}`);
  if (backupResult.exitCode !== 0) {
    return `Error: Backup creation failed for ${path}: ${backupResult.stderr}. Aborting edit.`;
  }

  // Step 3: Write content
  let writeResult;
  if (isDbRoot) {
    // Use printf + sudo tee for root-owned files
    const escapedContent = shellEscape(content);
    writeResult = await ssh(target, `printf '%s' ${escapedContent} | sudo tee ${escapedPath} > /dev/null`);
  } else {
    // Use heredoc for non-root files
    writeResult = await ssh(target, `cat > ${escapedPath} << 'NANOCLAW_EOF'\n${content}\nNANOCLAW_EOF`);
  }

  if (writeResult.exitCode !== 0) {
    return `Error: Write failed for ${path}: ${writeResult.stderr}`;
  }

  // Step 4: Verify write
  const verifyResult = await ssh(target, `cat ${escapedPath}`);
  if (verifyResult.exitCode !== 0) {
    return `Error: Verification failed — could not read back ${path}: ${verifyResult.stderr}`;
  }

  const readBack = verifyResult.stdout;
  // Trim for comparison since heredoc may add a trailing newline
  if (readBack.trim() !== content.trim()) {
    return `Error: Verification failed — content mismatch after writing ${path}. File may be in an inconsistent state; backup at ${backupPath}.`;
  }

  let result = `File ${path} updated successfully on ${config.name}. Backup saved at ${backupPath}.`;

  // Special reminder for DB's openclaw.json
  if (isDbRoot && path.includes('openclaw.json')) {
    result += `\n\nReminder: After editing openclaw.json, you should clear sessions.json and restart the container for changes to take effect.`;
  }

  // Emit telemetry (fire-and-forget)
  emitServiceAction({
    targetBot: bot,
    action: 'config_edit',
    trigger: 'manual',
    result: 'success',
    summary: `Edited ${path} on ${config.name}`,
  }).catch(() => {});

  return result;
}

// ─── dockerCommand ──────────────────────────────────────────────────────────

const EXEC_BLOCKED_CHARS = [';', '|', '&', '$', '`', '\n', '>>', '>'];

export async function dockerCommand(
  bot: string,
  action: string,
  ssh: SshExecutor,
  options?: { execCommand?: string },
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const container = config.container;

  // Check for blocked patterns in the action string
  const lowerAction = action.toLowerCase();
  for (const pattern of BLOCKED_DOCKER_PATTERNS) {
    if (lowerAction.includes(pattern)) {
      return `Error: Action "${action}" is blocked. Patterns like "${pattern}" are not allowed to prevent data loss.`;
    }
  }

  // Validate action is in the allowed list
  if (!(ALLOWED_DOCKER_ACTIONS as readonly string[]).includes(lowerAction)) {
    return `Error: Invalid docker action "${action}". Allowed actions: ${ALLOWED_DOCKER_ACTIONS.join(', ')}`;
  }

  // For exec: require and sanitize execCommand
  if (lowerAction === 'exec') {
    if (!options?.execCommand) {
      return `Error: execCommand is required for the "exec" action.`;
    }

    const cmd = options.execCommand;

    // CRITICAL: Block docker compose down -v specifically for Nook
    if (cmd.toLowerCase().includes('compose down') || cmd.toLowerCase().includes('down -v')) {
      return `Error: Blocked — "docker compose down -v" causes DATA LOSS and is never allowed.`;
    }

    // Check for blocked docker patterns in exec command
    for (const pattern of BLOCKED_DOCKER_PATTERNS) {
      if (cmd.toLowerCase().includes(pattern)) {
        return `Error: Blocked — exec command contains dangerous pattern "${pattern}".`;
      }
    }

    // Sanitize against shell metacharacters
    for (const char of EXEC_BLOCKED_CHARS) {
      if (cmd.includes(char)) {
        return `Error: Rejected — exec command contains dangerous shell metacharacter "${char === '\n' ? '\\n' : char}". Only simple commands are allowed.`;
      }
    }

    // Execute the command
    const execResult = await ssh(target, `docker exec ${shellEscape(container)} ${cmd}`);
    const statusResult = await ssh(target, `docker ps --filter name=${shellEscape(container)} --format '{{.Status}}'`);

    let output = `Docker exec on ${config.name} (${container}):\n`;
    if (execResult.stdout) output += `Output: ${execResult.stdout}\n`;
    if (execResult.stderr) output += `Stderr: ${execResult.stderr}\n`;
    output += `Exit code: ${execResult.exitCode}\n`;
    output += `Container status: ${statusResult.stdout.trim() || 'not found'}`;
    return output;
  }

  // Execute restart/stop/start
  const actionResult = await ssh(target, `docker ${lowerAction} ${shellEscape(container)}`);
  const statusResult = await ssh(target, `docker ps --filter name=${shellEscape(container)} --format '{{.Status}}'`);

  let output = `Docker ${lowerAction} on ${config.name} (${container}):\n`;
  if (actionResult.exitCode !== 0) {
    output += `Warning: Command exited with code ${actionResult.exitCode}\n`;
    if (actionResult.stderr) output += `Error: ${actionResult.stderr}\n`;
  }
  output += `Container status: ${statusResult.stdout.trim() || 'not found'}`;

  // Emit telemetry (fire-and-forget)
  emitServiceAction({
    targetBot: bot,
    action: lowerAction,
    trigger: 'manual',
    result: actionResult.exitCode === 0 ? 'success' : 'failed',
    summary: `Docker ${lowerAction} on ${config.name} (${container})`,
  }).catch(() => {});

  return output;
}

// ─── createIssue ────────────────────────────────────────────────────────────

export type IssueTrigger = 'manual' | 'watcher' | 'proactive';

export async function createIssue(
  bot: string,
  title: string,
  body: string,
  github: GitHubClient,
  options?: { labels?: string; trigger?: IssueTrigger },
): Promise<string> {
  if (!title || !title.trim()) {
    return `Error: Issue title is required and cannot be empty.`;
  }

  const config = getBotConfig(bot);
  const repoStr = config.githubIssuesRepo;
  const [owner, repo] = repoStr.includes('/') ? repoStr.split('/') : ['', ''];

  // Parse labels
  const labelList: string[] = options?.labels
    ? options.labels.split(',').map((l) => l.trim()).filter(Boolean)
    : [];

  // Auto-add bot-reported
  if (!labelList.includes('bot-reported')) {
    labelList.push('bot-reported');
  }

  // Trigger-based labeling
  const trigger = options?.trigger ?? 'manual';
  if (trigger === 'watcher') {
    if (!labelList.includes('auto-fix')) {
      labelList.push('auto-fix');
    }
  } else if (trigger === 'proactive') {
    if (!labelList.includes('proactive')) {
      labelList.push('proactive');
    }
    if (!labelList.includes('needs-approval')) {
      labelList.push('needs-approval');
    }
  }

  try {
    const issue = await github.createIssue({
      owner,
      repo,
      title: title.trim(),
      body,
      labels: labelList,
    });

    const issueUrl = issue.html_url;

    // Emit telemetry (fire-and-forget)
    emitServiceAction({
      targetBot: bot,
      action: 'issue_created',
      trigger: 'manual',
      ticketRef: issueUrl,
      result: 'success',
      summary: `Created issue #${issue.number}: ${issue.title}`,
    }).catch(() => {});

    return `Created issue #${issue.number}: ${issue.title}\n${issueUrl}`;
  } catch (err: any) {
    return `Error creating issue: ${err.message}`;
  }
}

// ─── runCommand ─────────────────────────────────────────────────────────────

export async function runCommand(
  bot: string,
  command: string,
  ssh: SshExecutor,
  options?: { timeout?: number },
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const timeout = options?.timeout ?? 30;

  let result;
  try {
    result = await ssh(target, command, { commandTimeout: timeout });
  } catch (err: any) {
    return `Error: SSH connection failed to ${config.name}: ${err.message}`;
  }

  let output = '';

  if (result.exitCode === 124) {
    output += `Command timed out after ${timeout}s on ${config.name}.\n`;
  }

  if (result.stdout) {
    output += `${result.stdout}\n`;
  }

  if (result.stderr) {
    output += `stderr: ${result.stderr}\n`;
  }

  output += `exit code: ${result.exitCode}`;
  return output;
}
