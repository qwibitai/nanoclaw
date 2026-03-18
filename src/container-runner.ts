/**
 * Session Runner for NanoClaw
 * Spawns agent execution in tmux sessions and handles IPC
 */
import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import {
  createCorrelationLogger,
  generateCorrelationId,
  logger,
} from './logger.js';
import {
  hasSession,
  stopSession,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Polling interval for reading output file (ms)
const OUTPUT_POLL_INTERVAL = 250;

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
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
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
        ? path.join(process.env.HOME || os.homedir(), mcpMount.hostPath.slice(2))
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

/**
 * Build environment variables for the tmux session.
 * These replace the Docker -e flags and path-mapping volume mounts.
 */
function buildSessionEnv(
  mounts: VolumeMount[],
): Record<string, string> {
  const env: Record<string, string> = {};

  env.TZ = TIMEZONE;

  // Route API traffic through the credential proxy
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`;

  // Auth mode placeholder (proxy handles real credentials)
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  // Map volume mount paths to env vars for the agent-runner
  for (const mount of mounts) {
    if (mount.containerPath === '/workspace/group') {
      env.NANOCLAW_GROUP_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/global') {
      env.NANOCLAW_GLOBAL_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/ipc') {
      env.NANOCLAW_IPC_INPUT_DIR = path.join(mount.hostPath, 'input');
    } else if (mount.containerPath === '/home/node/.claude') {
      env.CLAUDE_CONFIG_DIR = mount.hostPath;
    } else if (mount.containerPath === '/workspace/extra') {
      env.NANOCLAW_EXTRA_DIR = mount.hostPath;
    }
  }

  return env;
}

/**
 * Ensure the agent-runner is compiled and ready to run on the host.
 * Returns the path to the compiled index.js.
 */
function ensureAgentRunnerCompiled(): string {
  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distIndex = path.join(agentRunnerDir, 'dist', 'index.js');

  if (!fs.existsSync(distIndex)) {
    logger.info('Compiling agent-runner for host execution...');
    try {
      execSync('npm run build', {
        cwd: agentRunnerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      logger.info('Agent-runner compiled successfully');
    } catch (err) {
      throw new Error(
        `Failed to compile agent-runner: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return distIndex;
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

    let stdout = '';
    let stdoutTruncated = false;
    let bytesRead = 0;

    // Streaming output: parse OUTPUT_START/END marker pairs
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;

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

    // Poll output file for new data and sentinel markers
    const pollOutput = () => {
      try {
        const stat = fs.statSync(outputFile);
        if (stat.size > bytesRead) {
          const fd = fs.openSync(outputFile, 'r');
          const newBytes = stat.size - bytesRead;
          const buffer = Buffer.alloc(newBytes);
          fs.readSync(fd, buffer, 0, newBytes, bytesRead);
          fs.closeSync(fd);
          bytesRead = stat.size;

          const chunk = buffer.toString('utf-8');

          // Accumulate for logging
          if (!stdoutTruncated) {
            const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
            if (chunk.length > remaining) {
              stdout += chunk.slice(0, remaining);
              stdoutTruncated = true;
              log.warn(
                { sessionName, size: stdout.length },
                'Session stdout truncated due to size limit',
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
                log.warn(
                  { sessionName, error: err },
                  'Failed to parse streamed output chunk',
                );
              }
            }
          }
        }
      } catch {
        // File may not exist yet or be temporarily unavailable
      }
    };

    // Poll for session completion and output
    const checkSession = () => {
      pollOutput();

      if (hasSession(sessionName)) {
        // Session still running, keep polling
        setTimeout(checkSession, OUTPUT_POLL_INTERVAL);
        return;
      }

      // Session has ended — do a final read of the output file
      pollOutput();
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
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          log.info(
            { sessionName, duration },
            'Session timed out after output (idle cleanup)',
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
        `Stdout Truncated: ${stdoutTruncated}`,
        ``,
      ];

      // Determine exit status from whether we got output or not
      const isError = !hadStreamingOutput && stdout.indexOf(OUTPUT_START_MARKER) === -1 && stderr.length > 0;

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
        outputChain.then(() => {
          log.info(
            { sessionName, duration, newSessionId },
            'Session completed (streaming mode)',
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
            stdout: stdout.slice(-500),
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

/** Clean up temporary files created for the session. */
function cleanupTempFiles(...files: string[]): void {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
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
