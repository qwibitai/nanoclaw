// Diagnose tools — log searching and config inspection for managed bots.

import { getBotConfig, MAX_SEARCH_DEPTH } from './config.js';
import { shellEscape, type SshExecutor } from './ssh.js';

/**
 * Search recent container logs for a pattern via SSH + docker logs + grep.
 */
export async function searchLogs(
  bot: string,
  pattern: string,
  ssh: SshExecutor,
  options?: { lines?: number; context?: number },
): Promise<string> {
  const config = getBotConfig(bot);
  const lines = Math.min(options?.lines ?? 200, MAX_SEARCH_DEPTH);
  const context = options?.context ?? 2;
  const escaped = shellEscape(pattern);

  const command = `docker logs --tail ${lines} ${config.container} 2>&1 | grep -C ${context} ${escaped}`;

  const result = await ssh(config.sshTarget, command);

  if (result.exitCode === 1 && !result.stdout.trim()) {
    return `No matches found for pattern '${pattern}'`;
  }

  if (result.exitCode === 2) {
    return result.stderr || `grep error (exit code 2) for pattern '${pattern}'`;
  }

  return result.stdout;
}

/**
 * Inspect configuration files for a bot via SSH.
 * DB: reads and pretty-prints the JSON config.
 * Nook: reads both .env and docker-compose.yml.
 */
export async function inspectConfig(
  bot: string,
  ssh: SshExecutor,
): Promise<string> {
  const config = getBotConfig(bot);

  if (config.name === 'DB') {
    return inspectDbConfig(config.sshTarget, config.configPaths[0], ssh);
  }

  // Nook — read both config files
  return inspectNookConfig(config.sshTarget, config.configPaths, ssh);
}

async function inspectDbConfig(
  sshTarget: string,
  configPath: string,
  ssh: SshExecutor,
): Promise<string> {
  const result = await ssh(sshTarget, `sudo cat ${configPath}`);

  if (result.exitCode !== 0) {
    return `Config file not found or not readable at ${configPath}\n${result.stderr}`.trim();
  }

  // Try to pretty-print as JSON
  try {
    const parsed = JSON.parse(result.stdout);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Return raw if not valid JSON
    return result.stdout;
  }
}

async function inspectNookConfig(
  sshTarget: string,
  configPaths: string[],
  ssh: SshExecutor,
): Promise<string> {
  const sections: string[] = [];

  for (const path of configPaths) {
    const filename = path.split('/').pop() ?? path;
    const result = await ssh(sshTarget, `cat ${path}`);

    if (result.exitCode !== 0) {
      sections.push(
        `── ${filename} ──\nConfig file not found at ${path}\n${result.stderr}`.trim(),
      );
    } else {
      sections.push(`── ${filename} ──\n${result.stdout}`);
    }
  }

  return sections.join('\n\n');
}
