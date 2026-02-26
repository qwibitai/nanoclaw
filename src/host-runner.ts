/**
 * Host Runner for NanoClaw
 * Spawns claude CLI directly on the host (not in a container) for skills
 * that need Chrome MCP access (e.g., scout with EverBee).
 *
 * Intermediate messages: The agent writes IPC JSON files via Bash.
 * The existing IPC watcher picks them up and routes to the channel.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_TIMEOUT } from './config.js';
import { ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface HostRunnerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  assistantName?: string;
}

/**
 * Read and prepare a skill's SKILL.md content.
 * Strips YAML frontmatter and appends IPC instructions.
 */
function buildSkillPrompt(
  skillName: string,
  chatJid: string,
  ipcMessagesDir: string,
  groupDir: string,
): string {
  const projectRoot = process.cwd();
  const skillPath = path.join(
    projectRoot,
    '.claude',
    'skills',
    skillName,
    'SKILL.md',
  );

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill "${skillName}" not found at ${skillPath}`);
  }

  let content = fs.readFileSync(skillPath, 'utf-8');
  // Strip YAML frontmatter
  content = content.replace(/^---[\s\S]*?---\n*/, '');

  // Append IPC instructions so the agent can send status updates
  const ipcInstructions = `

## Sending Messages to User

To send a message to the user while you're still working, use Bash:

\`\`\`bash
echo '{"type":"message","chatJid":"${chatJid}","text":"YOUR MESSAGE HERE"}' > ${ipcMessagesDir}/msg_$(date +%s%N).json
\`\`\`

Use this for progress updates like "Searching keyword 3/8..." or "Found 14/25 so far".

## Output Directory

Save research reports to: ${groupDir}/research/
`;

  return content + ipcInstructions;
}

export async function runHostSkillAgent(
  group: RegisteredGroup,
  input: HostRunnerInput,
  onProcess: (proc: ChildProcess) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const hostSkill = group.hostSkill!;

  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  const ipcMessagesDir = path.join(ipcDir, 'messages');
  fs.mkdirSync(ipcMessagesDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'research'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  let skillPrompt: string;
  try {
    skillPrompt = buildSkillPrompt(
      hostSkill,
      input.chatJid,
      ipcMessagesDir,
      groupDir,
    );
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : `Failed to load skill: ${err}`;
    logger.error({ hostSkill, err }, 'Failed to load skill');
    return { status: 'error', result: null, error: msg };
  }

  // Read secrets — same pattern as container-runner.ts
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

  logger.info(
    { group: group.name, hostSkill, groupDir },
    'Spawning host skill agent',
  );

  const args = [
    '-p',
    '--chrome',
    '--model',
    'sonnet',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    skillPrompt,
    input.prompt,
  ];

  const child = spawn('claude', args, {
    cwd: groupDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...secrets },
  });

  onProcess(child);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, hostSkill },
        'Host skill timeout, killing process',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10000);
    }, configTimeout);

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length < 1_000_000) stdout += text;
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < 100_000) stderr += text;
      // Log stderr lines for debugging
      for (const line of text.trim().split('\n')) {
        if (line) logger.debug({ hostSkill }, line);
      }
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log file
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(groupDir, 'logs', `host-skill-${ts}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Host Skill Run Log ===`,
          `Skill: ${hostSkill}`,
          `Group: ${group.name}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
          ``,
          `=== Stderr ===`,
          stderr.slice(0, 5000),
          ``,
          `=== Stdout (last 2000 chars) ===`,
          stdout.slice(-2000),
        ].join('\n'),
      );

      if (timedOut) {
        logger.error(
          { group: group.name, hostSkill, duration },
          'Host skill timed out',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host skill timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, hostSkill, code, duration },
          'Host skill failed',
        );
        resolve({
          status: 'error',
          result: null,
          error: `claude exited with code ${code}: ${stderr.slice(-500)}`,
        });
        return;
      }

      logger.info(
        { group: group.name, hostSkill, duration },
        'Host skill completed',
      );

      const result = stdout.trim() || null;
      if (onOutput && result) {
        await onOutput({ status: 'success', result });
      }
      resolve({ status: 'success', result });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, hostSkill, err }, 'Host skill spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn claude: ${err.message}`,
      });
    });
  });
}
