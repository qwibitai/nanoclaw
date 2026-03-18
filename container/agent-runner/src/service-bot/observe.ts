// Observe tools — read-only inspection of bot infrastructure.

import { getBotConfig, MAX_LOG_LINES, MAX_FILE_SIZE } from './config.js';
import type { SshExecutor } from './ssh.js';
import { shellEscape } from './ssh.js';
import type { GitHubClient } from './github.js';

/**
 * Get the running status of a bot's container (and LettaBot service for nook).
 */
export async function botStatus(
  bot: string,
  ssh: SshExecutor,
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const container = config.container;

  const dockerCmd = `docker ps --filter name=${shellEscape(container)} --format '{{.Status}}\t{{.State}}\t{{.RunningFor}}'`;
  const dockerResult = await ssh(target, dockerCmd);

  const lines: string[] = [`**${config.name}** Status`];

  if (dockerResult.exitCode !== 0) {
    lines.push(`SSH/Docker error: ${dockerResult.stderr.trim()}`);
    return lines.join('\n');
  }

  const output = dockerResult.stdout.trim();
  if (!output) {
    lines.push(`Container \`${container}\`: not found or not running.`);
  } else {
    const [status, state, runningFor] = output.split('\t');
    lines.push(`Container \`${container}\`: ${state ?? 'unknown'}`);
    lines.push(`Status: ${status ?? 'unknown'}`);
    lines.push(`Uptime: ${runningFor ?? 'unknown'}`);
  }

  // For nook, also check the LettaBot systemd service
  if (bot.toLowerCase() === 'nook') {
    const svcResult = await ssh(target, 'systemctl --user status lettabot 2>&1 | head -5');
    if (svcResult.exitCode !== 0) {
      lines.push(`\nlettabot service: error checking status\n${svcResult.stderr.trim()}`);
    } else {
      lines.push(`\nlettabot service:\n${svcResult.stdout.trim()}`);
    }
  }

  return lines.join('\n');
}

/**
 * Read recent logs from a bot's main container or bridge service.
 */
export async function readLogs(
  bot: string,
  ssh: SshExecutor,
  options?: { lines?: number; service?: 'main' | 'bridge' },
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const service = options?.service ?? 'main';
  const lines = Math.min(Math.max(options?.lines ?? 50, 1), MAX_LOG_LINES);

  if (service === 'bridge' && bot.toLowerCase() !== 'nook') {
    throw new Error(`Bridge service is not available for ${config.name} (DB). Only Nook has a bridge service.`);
  }

  let cmd: string;
  if (service === 'bridge') {
    cmd = `journalctl --user -u lettabot -n ${lines} --no-pager`;
  } else {
    cmd = `docker logs --tail ${lines} ${shellEscape(config.container)} 2>&1`;
  }

  const result = await ssh(target, cmd);

  if (result.exitCode !== 0) {
    return `Error reading ${service} logs for ${config.name}:\n${result.stderr.trim()}`;
  }

  return result.stdout;
}

/**
 * Read a file from a bot's host via SSH.
 */
export async function readFile(
  bot: string,
  path: string,
  ssh: SshExecutor,
): Promise<string> {
  const config = getBotConfig(bot);
  const target = config.sshTarget;
  const escapedPath = shellEscape(path);
  const needsSudo = path.startsWith('/root/');
  const sudo = needsSudo ? 'sudo ' : '';

  // Check if binary
  const mimeResult = await ssh(target, `${sudo}file --mime-encoding ${escapedPath}`);
  if (mimeResult.exitCode !== 0) {
    return `Error reading file: ${mimeResult.stderr.trim()}`;
  }
  if (mimeResult.stdout.includes('binary')) {
    throw new Error(`File ${path} is a binary file and cannot be displayed.`);
  }

  // Check file size
  const statResult = await ssh(target, `${sudo}stat -c %s ${escapedPath}`);
  if (statResult.exitCode !== 0) {
    return `Error reading file: ${statResult.stderr.trim()}`;
  }

  const fileSize = parseInt(statResult.stdout.trim(), 10);
  const isTruncated = fileSize > MAX_FILE_SIZE;

  // Read file (truncate if needed)
  let catCmd: string;
  if (isTruncated) {
    catCmd = `${sudo}head -c ${MAX_FILE_SIZE} ${escapedPath}`;
  } else {
    catCmd = `${sudo}cat ${escapedPath}`;
  }

  const catResult = await ssh(target, catCmd);
  if (catResult.exitCode !== 0) {
    return `Error reading file: ${catResult.stderr.trim()}`;
  }

  let output = catResult.stdout;
  if (isTruncated) {
    output += `\n\n⚠ Warning: File truncated (${fileSize} bytes > ${MAX_FILE_SIZE} byte limit). Showing first ${MAX_FILE_SIZE} bytes.`;
  }

  return output;
}

/**
 * List GitHub issues for a bot's repository.
 */
export async function listIssues(
  bot: string,
  github: GitHubClient,
  options?: { labels?: string; state?: 'open' | 'closed' | 'all' },
): Promise<string> {
  const config = getBotConfig(bot);
  const [owner, repo] = config.githubIssuesRepo.split('/');

  const issues = await github.listIssues({
    owner: owner ?? '',
    repo: repo ?? '',
    state: options?.state ?? 'open',
    labels: options?.labels,
  });

  if (issues.length === 0) {
    return `No issues found for ${config.name}.`;
  }

  const lines = issues.map((issue) => {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    const date = issue.created_at.split('T')[0];
    return `#${issue.number} ${issue.title}${labels} (${date})`;
  });

  return `**${config.name}** Issues (${issues.length}):\n${lines.join('\n')}`;
}
