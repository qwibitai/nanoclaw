/**
 * Process Runner for NanoClaw (Linux VPS)
 *
 * Drop-in replacement for container-runner.ts.
 * Spawns agent-runner as a Node.js child process instead of Apple Container.
 * Passes workspace paths via environment variables.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Resolve the agent-runner entry point.
 * Auto-compiles on first run if dist/ doesn't exist.
 */
let agentRunnerEntry: string | null = null;

function getAgentRunnerEntry(): string {
  if (agentRunnerEntry) return agentRunnerEntry;

  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distEntry = path.join(agentRunnerDir, 'dist', 'index.js');

  if (!fs.existsSync(distEntry)) {
    throw new Error(
      `Agent runner not compiled: ${distEntry} not found. ` +
      `Run: cd ${agentRunnerDir} && npm install && npx tsc`,
    );
  }

  agentRunnerEntry = distEntry;
  return agentRunnerEntry;
}

/**
 * Set up workspace directories for a group (same layout as container mounts).
 * Returns the env vars to pass to the child process.
 */
function setupWorkspace(
  group: RegisteredGroup,
  isMain: boolean,
): { env: Record<string, string>; groupDir: string; ipcDir: string } {
  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group IPC namespace
  const ipcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Write default settings.json if missing
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
      }
    }
  }

  // Additional mounts (extra directories)
  const extraBase = path.join(DATA_DIR, 'extra', group.folder);
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      // Create symlink from extra/{containerBasename} → validated hostPath
      const containerBasename = path.basename(mount.containerPath);
      const linkPath = path.join(extraBase, containerBasename);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      // Remove stale symlink
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
      fs.symlinkSync(mount.hostPath, linkPath);
    }
  }

  // HOME for the child process → sessions dir so .claude/ is found
  const homeDir = path.join(DATA_DIR, 'sessions', group.folder);

  const env: Record<string, string> = {
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: ipcDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_WORKSPACE_EXTRA: fs.existsSync(extraBase) ? extraBase : '',
    HOME: homeDir,
  };

  return { env, groupDir, ipcDir };
}

/**
 * Read allowed secrets from .env for passing to the agent process.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const entryPoint = getAgentRunnerEntry();

  const { env: workspaceEnv, groupDir, ipcDir } = setupWorkspace(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      workspaceGroup: workspaceEnv.NANOCLAW_WORKSPACE_GROUP,
      workspaceIpc: workspaceEnv.NANOCLAW_WORKSPACE_IPC,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Build child process env: inherit system env + workspace vars + secrets via stdin
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...workspaceEnv,
    // Prevent NODE_OPTIONS from parent leaking (e.g., --inspect)
    NODE_OPTIONS: '',
  };
  // Remove CLAUDECODE so child Claude Code doesn't think it's a nested session
  delete childEnv.CLAUDECODE;

  // Spawn as non-root user if running as root (Claude Code refuses --dangerously-skip-permissions as root)
  const spawnOptions: Parameters<typeof spawn>[2] = {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    env: childEnv,
  };
  if (process.getuid?.() === 0) {
    const AGENT_UID = parseInt(process.env.AGENT_UID || '999', 10);
    const AGENT_GID = parseInt(process.env.AGENT_GID || '987', 10);
    spawnOptions.uid = AGENT_UID;
    spawnOptions.gid = AGENT_GID;
  }

  return new Promise((resolve) => {
    const child = spawn('node', [entryPoint], spawnOptions);

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk)
    input.secrets = readSecrets();
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Process stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Process stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Process timeout, sending SIGTERM');
      child.kill('SIGTERM');
      // Force kill after 15s if SIGTERM doesn't work
      setTimeout(() => {
        if (!child.killed) {
          logger.warn({ group: group.name, processName }, 'SIGTERM failed, force killing');
          child.kill('SIGKILL');
        }
      }, 15_000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `process-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Process Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Process timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Process timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `process-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Process Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Workspace Env ===`,
          Object.entries(workspaceEnv).map(([k, v]) => `${k}=${v}`).join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Process log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, stdout, logFile },
          'Process exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Process completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          { group: group.name, duration, status: output.status, hasResult: !!output.result },
          'Process completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse process output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse process output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, processName, error: err }, 'Process spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Process spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
