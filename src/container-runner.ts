/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Apple Container and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  loadVaultConfig,
  expandPath,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { ContextTier, RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  effectiveTier?: ContextTier;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Get the session directory path based on context tier
 * Owner: data/sessions/owner/.claude/
 * Family: data/sessions/family/.claude/
 * Friend: data/sessions/friends/{group}/.claude/
 */
function getSessionDirPath(groupFolder: string, tier: ContextTier): string {
  switch (tier) {
    case 'owner':
      return path.join(DATA_DIR, 'sessions', 'owner', '.claude');
    case 'family':
      return path.join(DATA_DIR, 'sessions', 'family', '.claude');
    case 'friend':
      return path.join(DATA_DIR, 'sessions', 'friends', groupFolder, '.claude');
    default: {
      const _exhaustive: never = tier;
      throw new Error(`Unknown context tier: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Validate that a vault path exists and is not blocked
 */
function validateVaultMount(vaultPath: string, vaultName: string): void {
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(vaultPath);
  } catch (err: any) {
    const code = (err && typeof err === 'object' && 'code' in err)
      ? (err as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ENOENT') {
      throw new Error(
        `${vaultName} vault path does not exist: ${vaultPath}. ` +
          `Please verify the path in data/vault-config.json or disable the vault.`,
      );
    }
    throw new Error(
      `Failed to resolve real path for ${vaultName} vault path "${vaultPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const blockedPatterns = ['.ssh', '.gnupg', '.gpg', '.aws', 'credentials'];
  const lowerPath = resolvedPath.toLowerCase();
  for (const pattern of blockedPatterns) {
    if (lowerPath.includes(pattern)) {
      throw new Error(
        `${vaultName} vault path contains blocked pattern "${pattern}": ${vaultPath} (resolved to ${resolvedPath}). ` +
          `Vaults cannot be mounted from sensitive directories.`,
      );
    }
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(
      `${vaultName} vault path is not a directory: ${vaultPath} (resolved to ${resolvedPath})`,
    );
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  effectiveTier?: ContextTier,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Determine context tier: use effectiveTier if provided (from authorization),
  // otherwise fall back to group's contextTier, or isMain logic for legacy behavior
  const contextTier: ContextTier = effectiveTier || group.contextTier || (isMain ? 'owner' : 'friend');

  logger.debug(
    {
      group: group.name,
      contextTier,
      isMain,
      hasExplicitTier: !!group.contextTier,
    },
    'Building volume mounts for tier-based access',
  );

  // Load vault configuration
  const vaultConfig = loadVaultConfig();

  // Mount vaults and project root based on tier
  switch (contextTier) {
    case 'owner':
      // Owner: Project root + private vault + main vault + group folder
      mounts.push({
        hostPath: projectRoot,
        containerPath: '/workspace/project',
        readonly: false,
      });

      if (vaultConfig.privateVault?.enabled && vaultConfig.privateVault.path) {
        const privateVaultPath = expandPath(vaultConfig.privateVault.path);
        try {
          validateVaultMount(privateVaultPath, 'Private');
          mounts.push({
            hostPath: privateVaultPath,
            containerPath: '/workspace/vaults/private',
            readonly: false,
          });
          logger.info({ path: privateVaultPath }, 'Private vault mounted for owner');
        } catch (err) {
          logger.error(
            { group: group.name, path: privateVaultPath, error: err instanceof Error ? err.message : String(err) },
            'Failed to mount private vault - skipping',
          );
        }
      }

      if (vaultConfig.mainVault?.enabled && vaultConfig.mainVault.path) {
        const mainVaultPath = expandPath(vaultConfig.mainVault.path);
        try {
          validateVaultMount(mainVaultPath, 'Main');
          mounts.push({
            hostPath: mainVaultPath,
            containerPath: '/workspace/vaults/main',
            readonly: false,
          });
          logger.info({ path: mainVaultPath }, 'Main vault mounted for owner');
        } catch (err) {
          logger.error(
            { group: group.name, path: mainVaultPath, error: err instanceof Error ? err.message : String(err) },
            'Failed to mount main vault - skipping',
          );
        }
      }

      mounts.push({
        hostPath: path.join(GROUPS_DIR, group.folder),
        containerPath: '/workspace/group',
        readonly: false,
      });
      break;

    case 'family':
      // Family: Main vault + group folder (NO private vault, NO project root)
      if (vaultConfig.mainVault?.enabled && vaultConfig.mainVault.path) {
        const mainVaultPath = expandPath(vaultConfig.mainVault.path);
        try {
          validateVaultMount(mainVaultPath, 'Main');
          mounts.push({
            hostPath: mainVaultPath,
            containerPath: '/workspace/vaults/main',
            readonly: false,
          });
          logger.info({ path: mainVaultPath }, 'Main vault mounted for family');
        } catch (err) {
          logger.error(
            { group: group.name, path: mainVaultPath, error: err instanceof Error ? err.message : String(err) },
            'Failed to mount main vault - skipping',
          );
        }
      }

      mounts.push({
        hostPath: path.join(GROUPS_DIR, group.folder),
        containerPath: '/workspace/group',
        readonly: false,
      });

      // Global memory directory (read-only for family)
      const globalDirFamily = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDirFamily)) {
        mounts.push({
          hostPath: globalDirFamily,
          containerPath: '/workspace/global',
          readonly: true,
        });
      }
      break;

    case 'friend':
      // Friend: Group folder only (NO vaults, NO project root)
      mounts.push({
        hostPath: path.join(GROUPS_DIR, group.folder),
        containerPath: '/workspace/group',
        readonly: false,
      });

      // Global memory directory (read-only for friends)
      const globalDirFriend = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDirFriend)) {
        mounts.push({
          hostPath: globalDirFriend,
          containerPath: '/workspace/global',
          readonly: true,
        });
      }
      break;
  }

  // Tier-aware session directory
  const sessionDir = getSessionDirPath(group.folder, contextTier);
  fs.mkdirSync(sessionDir, { recursive: true });
  const settingsFile = path.join(sessionDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each session's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(sessionDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  mounts.push({
    hostPath: sessionDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (workaround for Apple Container -i env var bug)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
    });

    if (filteredLines.length > 0) {
      fs.writeFileSync(
        path.join(envDir, 'env'),
        filteredLines.join('\n') + '\n',
      );
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
    }
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Apple Container's sticky build cache for code changes.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      contextTier,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Apple Container: --mount for readonly, -v for read-write
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain, input.effectiveTier);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('container', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Write input and close stdin (Apple Container doesn't flush pipe without EOF)
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
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
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
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

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`container stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
        ].join('\n'));

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${group.containerConfig?.timeout || CONTAINER_TIMEOUT}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
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
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
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
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
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
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
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
