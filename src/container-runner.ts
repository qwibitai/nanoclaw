/**
 * Session Runner for NanoClaw
 * Orchestrates agent execution in tmux sessions — delegates output polling
 * to output-reader.ts and session bootstrapping to session-settings.ts.
 */
import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import {
  createCorrelationLogger,
  generateCorrelationId,
  logger,
} from './logger.js';
import { hasSession, stopSession } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  OUTPUT_POLL_INTERVAL,
  createOutputReaderState,
  pollOutput,
  cleanupTempFiles,
} from './output-reader.js';
import {
  bootstrapSessionSettings,
  buildSessionEnv,
  ensureAgentRunnerCompiled,
} from './session-settings.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Prepare directories and paths for the agent session.
 * Previously built Docker volume mounts; now ensures host directories exist
 * and returns the path mapping for environment variable injection.
 *
 * @internal Exported for testing.
 */
export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Global shared context directory (read-only for all groups).
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  const groupSessionsDir = bootstrapSessionSettings(group.folder);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location
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
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // MCP credential mounts
  if (group.containerConfig?.mcpCredentialMounts) {
    for (const mcpMount of group.containerConfig.mcpCredentialMounts) {
      const expandedPath = mcpMount.hostPath.startsWith('~/')
        ? path.join(
            process.env.HOME || os.homedir(),
            mcpMount.hostPath.slice(2),
          )
        : path.resolve(mcpMount.hostPath);

      if (!fs.existsSync(expandedPath)) {
        logger.warn(
          { hostPath: mcpMount.hostPath, expandedPath },
          'MCP credential mount path does not exist, skipping',
        );
        continue;
      }

      const name = mcpMount.name || path.basename(expandedPath);
      mounts.push({
        hostPath: expandedPath,
        containerPath: `/workspace/mcp-credentials/${name}`,
        readonly: true,
      });
    }
  }

  // Additional mounts validated against external allowlist
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

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: null, sessionName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  correlationId?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const cid = correlationId ?? generateCorrelationId();
  const log = createCorrelationLogger(cid, { group: group.name });

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const sessionName = `nanoclaw-${safeName}-${Date.now()}`;

  log.debug(
    {
      sessionName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Session mount configuration',
  );

  log.info(
    {
      sessionName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning tmux agent session',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Ensure agent-runner is compiled
  const agentRunnerPath = ensureAgentRunnerCompiled();

  // Write input to temp file (stdin replacement)
  const tmpDir = path.join(os.tmpdir(), 'nanoclaw');
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputFile = path.join(tmpDir, `input-${sessionName}.json`);
  const outputFile = path.join(tmpDir, `output-${sessionName}.log`);
  const stderrFile = path.join(tmpDir, `stderr-${sessionName}.log`);

  fs.writeFileSync(inputFile, JSON.stringify(input));
  fs.writeFileSync(outputFile, ''); // Create empty output file
  fs.writeFileSync(stderrFile, ''); // Create empty stderr file

  // Build environment for the session
  const sessionEnv = buildSessionEnv(mounts);

  // Build the tmux command
  const envString = Object.entries(sessionEnv)
    .map(([k, v]) => `${k}=${shellEscape(v)}`)
    .join(' ');

  const nodeCmd = `env ${envString} node ${shellEscape(agentRunnerPath)} < ${shellEscape(inputFile)} > ${shellEscape(outputFile)} 2>${shellEscape(stderrFile)}`;

  log.debug({ sessionName, cmd: nodeCmd }, 'Tmux session command');

  return new Promise((resolve) => {
    // Spawn tmux session
    try {
      execSync(
        `tmux new-session -d -s ${sessionName} ${shellEscape(nodeCmd)}`,
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
      );
    } catch (err) {
      log.error({ sessionName, error: err }, 'Failed to start tmux session');
      cleanupTempFiles(inputFile, outputFile, stderrFile);
      resolve({
        status: 'error',
        result: null,
        error: `Failed to start tmux session: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    onProcess(null, sessionName);

    const readerState = createOutputReaderState();
    let timedOut = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      log.error({ sessionName }, 'Session timeout, killing');
      exec(stopSession(sessionName), { timeout: 15000 }, (err) => {
        if (err) {
          log.warn({ sessionName, err }, 'Failed to kill tmux session');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const doPoll = () => {
      pollOutput(
        outputFile,
        readerState,
        CONTAINER_MAX_OUTPUT_SIZE,
        sessionName,
        log,
        onOutput,
        resetTimeout,
      );
    };

    // Poll for session completion and output
    const checkSession = () => {
      doPoll();

      if (hasSession(sessionName)) {
        // Session still running, keep polling
        setTimeout(checkSession, OUTPUT_POLL_INTERVAL);
        return;
      }

      // Session has ended — do a final read of the output file
      doPoll();
      clearTimeout(timeout);

      const duration = Date.now() - startTime;

      // Read stderr for logging
      let stderr = '';
      try {
        stderr = fs.readFileSync(stderrFile, 'utf-8');
      } catch {
        // ignore
      }

      // Clean up temp files
      cleanupTempFiles(inputFile, outputFile, stderrFile);

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `session-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Session Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Session: ${sessionName}`,
            `Duration: ${duration}ms`,
            `Had Streaming Output: ${readerState.hadStreamingOutput}`,
          ].join('\n'),
        );

        if (readerState.hadStreamingOutput) {
          log.info(
            { sessionName, duration },
            'Session timed out after output (idle cleanup)',
          );
          readerState.outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId: readerState.newSessionId,
            });
          });
          return;
        }

        log.error(
          { sessionName, duration },
          'Session timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Session timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `session-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Session Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Stdout Truncated: ${readerState.stdoutTruncated}`,
        ``,
      ];

      // Determine exit status from whether we got output or not
      const isError =
        !readerState.hadStreamingOutput &&
        readerState.stdout.indexOf(OUTPUT_START_MARKER) === -1 &&
        stderr.length > 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout${readerState.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          readerState.stdout,
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
      log.debug({ logFile, verbose: isVerbose }, 'Session log written');

      if (isError) {
        log.error(
          {
            duration,
            stderr: stderr.slice(-500),
            logFile,
          },
          'Session exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Session exited with error: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        readerState.outputChain.then(() => {
          log.info(
            { sessionName, duration, newSessionId: readerState.newSessionId },
            'Session completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId: readerState.newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        const startIdx = readerState.stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = readerState.stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = readerState.stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = readerState.stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        log.info(
          {
            sessionName,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Session completed',
        );

        resolve(output);
      } catch (err) {
        log.error(
          {
            sessionName,
            stdout: readerState.stdout.slice(-500),
            stderr: stderr.slice(-500),
            error: err,
          },
          'Failed to parse session output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse session output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    // Start polling
    setTimeout(checkSession, OUTPUT_POLL_INTERVAL);
  });
}

/** Escape a string for use in a shell command. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

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

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
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
