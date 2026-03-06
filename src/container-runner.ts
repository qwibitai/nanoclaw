/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_NO_OUTPUT_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const AGENT_RUNNER_HEARTBEAT_PREFIX =
  '[agent-runner] heartbeat worker-opencode-active';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
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

type RunnerSyncMetadata = {
  sourceHash: string;
  destinationHash: string;
  syncedAt: string;
};

const AGENT_RUNNER_SYNC_FILE = '.nanoclaw-agent-runner-sync.json';

function stableDirectoryHash(dir: string): string {
  const hash = createHash('sha256');

  const walk = (baseDir: string, relDir = ''): void => {
    const absDir = relDir ? path.join(baseDir, relDir) : baseDir;
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      const normalizedRel = relPath.split(path.sep).join('/');
      if (normalizedRel === AGENT_RUNNER_SYNC_FILE) continue;
      if (entry.isDirectory()) {
        walk(baseDir, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`file:${normalizedRel}\n`);
      hash.update(fs.readFileSync(path.join(baseDir, relPath)));
      hash.update('\n');
    }
  };

  walk(dir);
  return hash.digest('hex');
}

function readRunnerSyncMetadata(
  groupAgentRunnerDir: string,
): RunnerSyncMetadata | null {
  const metadataFile = path.join(groupAgentRunnerDir, AGENT_RUNNER_SYNC_FILE);
  if (!fs.existsSync(metadataFile)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(metadataFile, 'utf-8'),
    ) as RunnerSyncMetadata;
  } catch {
    return null;
  }
}

function writeRunnerSyncMetadata(
  groupAgentRunnerDir: string,
  metadata: RunnerSyncMetadata,
): void {
  const metadataFile = path.join(groupAgentRunnerDir, AGENT_RUNNER_SYNC_FILE);
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
}

function replaceAgentRunnerSource(
  agentRunnerSrc: string,
  groupAgentRunnerDir: string,
): void {
  const backupDir = `${groupAgentRunnerDir}.backup-${Date.now()}`;
  if (fs.existsSync(groupAgentRunnerDir)) {
    fs.renameSync(groupAgentRunnerDir, backupDir);
  }
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
}

function syncAgentRunnerSource(
  groupFolder: string,
  agentRunnerSrc: string,
  groupAgentRunnerDir: string,
): void {
  if (!fs.existsSync(agentRunnerSrc)) return;

  const sourceHash = stableDirectoryHash(agentRunnerSrc);

  if (!fs.existsSync(groupAgentRunnerDir)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    writeRunnerSyncMetadata(groupAgentRunnerDir, {
      sourceHash,
      destinationHash: sourceHash,
      syncedAt: new Date().toISOString(),
    });
    return;
  }

  const destinationHash = stableDirectoryHash(groupAgentRunnerDir);
  const metadata = readRunnerSyncMetadata(groupAgentRunnerDir);

  if (!metadata) {
    if (destinationHash === sourceHash) {
      writeRunnerSyncMetadata(groupAgentRunnerDir, {
        sourceHash,
        destinationHash,
        syncedAt: new Date().toISOString(),
      });
      return;
    }

    // Legacy lanes without sync metadata drift silently. Fail closed by
    // resetting to repo source and keeping a timestamped backup.
    replaceAgentRunnerSource(agentRunnerSrc, groupAgentRunnerDir);
    writeRunnerSyncMetadata(groupAgentRunnerDir, {
      sourceHash,
      destinationHash: sourceHash,
      syncedAt: new Date().toISOString(),
    });
    logger.warn(
      { groupFolder },
      'Reset stale agent-runner source from repository baseline',
    );
    return;
  }

  // Local lane edits take priority; keep them and only log drift.
  if (destinationHash !== metadata.destinationHash) {
    logger.warn(
      { groupFolder },
      'Detected local agent-runner edits; skipping repository sync',
    );
    return;
  }

  if (sourceHash === metadata.sourceHash) return;

  replaceAgentRunnerSource(agentRunnerSrc, groupAgentRunnerDir);
  writeRunnerSyncMetadata(groupAgentRunnerDir, {
    sourceHash,
    destinationHash: sourceHash,
    syncedAt: new Date().toISOString(),
  });
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Secrets are passed via stdin instead (see readSecrets()).
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      // Hidden entries (for example .docs symlinks) are metadata helpers, not
      // runnable skills. Copying them can resolve to the same target path.
      if (skillDir.startsWith('.')) continue;

      const srcDir = path.join(skillsSrc, skillDir);
      const srcStat = fs.statSync(srcDir);
      if (!srcStat.isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);

      // Guard against symlinked skills resolving to the same real path.
      if (fs.existsSync(dstDir)) {
        try {
          if (fs.realpathSync(srcDir) === fs.realpathSync(dstDir)) {
            logger.debug(
              { group: group.name, skillDir },
              'Skipping skill sync for identical source and destination',
            );
            continue;
          }
        } catch {
          // Fall through and let cpSync surface unexpected filesystem errors.
        }
      }

      // Copy skill contents (dereferenced) so destination folders can be
      // refreshed even when source skills are symlinks.
      fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Keep agent-runner source in a per-group writable location.
  // We sync from repo source with drift detection so contract/runtime fixes
  // are not silently skipped in long-lived lanes.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  syncAgentRunnerSource(group.folder, agentRunnerSrc, groupAgentRunnerDir);
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const isAppleContainerRuntime = /(^|\/)container$/.test(
    CONTAINER_RUNTIME_BIN,
  );

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  // Apple Container runtime currently fails to start when --user is passed,
  // so keep default container user in that mode.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (
    !isAppleContainerRuntime &&
    hostUid != null &&
    hostUid !== 0 &&
    hostUid !== 1000
  ) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
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

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
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

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;
    let timeoutReason: 'hard_timeout' | 'no_output_timeout' | null = null;

    const configTimeout =
      group.containerConfig?.timeout && group.containerConfig.timeout > 0
        ? group.containerConfig.timeout
        : CONTAINER_TIMEOUT;
    const configIdleTimeout =
      group.containerConfig?.idleTimeout && group.containerConfig.idleTimeout > 0
        ? group.containerConfig.idleTimeout
        : IDLE_TIMEOUT;
    const configNoOutputTimeout =
      group.containerConfig?.noOutputTimeout &&
      group.containerConfig.noOutputTimeout > 0
        ? group.containerConfig.noOutputTimeout
        : CONTAINER_NO_OUTPUT_TIMEOUT;

    // Grace period: hard timeout must be at least idle timeout + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const hardTimeoutMs = Math.max(configTimeout, configIdleTimeout + 30_000);
    // No-output timeout tracks "still alive but not producing markers" windows.
    const noOutputTimeoutMs = Math.max(
      10_000,
      Math.min(configNoOutputTimeout, hardTimeoutMs),
    );

    let hardTimeout: ReturnType<typeof setTimeout>;
    let noOutputTimeout: ReturnType<typeof setTimeout>;

    const stopForTimeout = (reason: 'hard_timeout' | 'no_output_timeout') => {
      if (timedOut) return;
      timedOut = true;
      timeoutReason = reason;
      logger.error(
        { group: group.name, containerName, reason },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    const resetHardTimeout = () => {
      clearTimeout(hardTimeout);
      hardTimeout = setTimeout(
        () => stopForTimeout('hard_timeout'),
        hardTimeoutMs,
      );
    };

    const resetNoOutputTimeout = () => {
      clearTimeout(noOutputTimeout);
      noOutputTimeout = setTimeout(
        () => stopForTimeout('no_output_timeout'),
        noOutputTimeoutMs,
      );
    };

    hardTimeout = setTimeout(() => stopForTimeout('hard_timeout'), hardTimeoutMs);
    noOutputTimeout = setTimeout(
      () => stopForTimeout('no_output_timeout'),
      noOutputTimeoutMs,
    );

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
            hadStreamingOutput = true;
            // Activity detected — reset hard + no-output timeouts.
            resetHardTimeout();
            resetNoOutputTimeout();
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
        if (!line) continue;
        logger.debug({ container: group.folder }, line);
        // Worker runner heartbeats signal active progress even when no marker
        // has been emitted yet. Count them as no-output activity only.
        if (line.includes(AGENT_RUNNER_HEARTBEAT_PREFIX)) {
          resetNoOutputTimeout();
        }
      }

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

    container.on('close', (code) => {
      clearTimeout(hardTimeout);
      clearTimeout(noOutputTimeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Timeout Reason: ${timeoutReason || 'unknown'}`,
            `Configured Hard Timeout: ${configTimeout}ms`,
            `Configured No-Output Timeout: ${configNoOutputTimeout}ms`,
            `Configured Idle Timeout: ${configIdleTimeout}ms`,
            `Effective Hard Timeout: ${hardTimeoutMs}ms`,
            `Effective No-Output Timeout: ${noOutputTimeoutMs}ms`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code, timeoutReason },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code, timeoutReason },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out (${timeoutReason || 'unknown'}) after ${duration}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

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
      clearTimeout(hardTimeout);
      clearTimeout(noOutputTimeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
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
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
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
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
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
