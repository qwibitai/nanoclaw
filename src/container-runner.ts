/**
 * Container Runner for NanoClaw
 * Spawns agent execution in BoxLite VMs and handles IPC
 */
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { BOX_IMAGE, BOX_ROOTFS_PATH, BOX_MEMORY_MIB, BOX_CPUS } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { getRuntime } from './box-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

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
  assistantName?: string;
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
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
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

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
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

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const m of validatedMounts) {
      mounts.push({
        hostPath: m.hostPath,
        containerPath: m.containerPath,
        readonly: m.readonly,
      });
    }
  }

  return mounts;
}

/**
 * Extract environment variables from OneCLI gateway config.
 * OneCLI's applyContainerConfig mutates a Docker args array with -e flags.
 * We parse those out to get the env vars for BoxLite.
 */
async function extractOnecliEnv(
  containerName: string,
  agentIdentifier?: string,
): Promise<Record<string, string>> {
  const tempArgs: string[] = [];
  const applied = await onecli.applyContainerConfig(tempArgs, {
    addHostMapping: false,
    agent: agentIdentifier,
  });

  if (applied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — box will have no credentials',
    );
  }

  const env: Record<string, string> = {};
  for (let i = 0; i < tempArgs.length; i++) {
    if (tempArgs[i] === '-e' && i + 1 < tempArgs.length) {
      const [key, ...rest] = tempArgs[i + 1].split('=');
      env[key] = rest.join('=');
      i++;
    }
  }
  return env;
}

// Entrypoint command that runs inside the box (same as old Dockerfile entrypoint)
const ENTRYPOINT_CMD =
  'cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2 && ' +
  'ln -s /app/node_modules /tmp/dist/node_modules && ' +
  'chmod -R a-w /tmp/dist && ' +
  'node /tmp/dist/index.js';

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (boxName: string, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  // Build environment variables
  const onecliEnv = await extractOnecliEnv(containerName, agentIdentifier);
  const boxEnv: Record<string, string> = {
    ...onecliEnv,
    TZ: TIMEZONE,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
  };

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  const userStr =
    hostUid != null && hostUid !== 0 && hostUid !== 1000
      ? `${hostUid}:${hostGid}`
      : undefined;

  if (userStr) {
    boxEnv['HOME'] = '/home/node';
  }

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Box mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning box agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Create box via BoxLite runtime
  const runtime = getRuntime();
  const envArray = Object.entries(boxEnv).map(([key, value]) => ({
    key,
    value,
  }));

  let box;
  try {
    // Use local OCI layout if available (from container/build.sh), else pull from registry.
    // Check for oci-layout file to distinguish a valid OCI directory from an empty one.
    const useLocalRootfs = BOX_ROOTFS_PATH &&
      fs.existsSync(path.join(BOX_ROOTFS_PATH, 'oci-layout'));
    box = await runtime.create(
      {
        image: useLocalRootfs ? undefined : BOX_IMAGE,
        rootfsPath: useLocalRootfs ? BOX_ROOTFS_PATH : undefined,
        autoRemove: true,
        memoryMib: BOX_MEMORY_MIB,
        cpus: BOX_CPUS,
        volumes: mounts.map((m) => ({
          hostPath: m.hostPath,
          guestPath: m.containerPath,
          readOnly: m.readonly,
        })),
        env: envArray,
        workingDir: '/workspace/group',
        user: userStr,
      },
      containerName,
    );
  } catch (err) {
    logger.error(
      { group: group.name, containerName, error: err },
      'Box creation failed',
    );
    return {
      status: 'error',
      result: null,
      error: `Box creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  onProcess(containerName, containerName);

  // Start the agent entrypoint via box.exec (returns JsExecution with streaming)
  let execution;
  try {
    const timeoutSecs = Math.max(
      Math.floor(CONTAINER_TIMEOUT / 1000),
      Math.floor((IDLE_TIMEOUT + 30_000) / 1000),
    );

    execution = await box.exec(
      'bash',
      ['-c', ENTRYPOINT_CMD],
      null, // env already set on box creation
      false, // tty
      null, // user already set on box creation
      timeoutSecs,
      '/workspace/group',
    );
  } catch (err) {
    logger.error(
      { group: group.name, containerName, error: err },
      'Failed to start agent in box',
    );
    try { await box.stop(); } catch { /* ignore */ }
    return {
      status: 'error',
      result: null,
      error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write input via stdin (same protocol as Docker's container.stdin.write)
  try {
    const stdin = await execution.stdin();
    await stdin.writeString(JSON.stringify(input));
    await stdin.close();
  } catch (err) {
    logger.error(
      { group: group.name, containerName, error: err },
      'Failed to write stdin to box',
    );
    try { await execution.kill(); } catch { /* ignore */ }
    try { await box.stop(); } catch { /* ignore */ }
    return {
      status: 'error',
      result: null,
      error: `Failed to write stdin: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Stream stdout and stderr, parse output markers
  let parseBuffer = '';
  let newSessionId: string | undefined;
  let outputChain = Promise.resolve();
  let hadStreamingOutput = false;
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  // Timeout handling
  let timedOut = false;
  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

  let timeoutHandle: ReturnType<typeof setTimeout>;
  const killOnTimeout = async () => {
    timedOut = true;
    logger.error(
      { group: group.name, containerName },
      'Box timeout, stopping',
    );
    try { await execution.kill(); } catch { /* ignore */ }
    try { await box.stop(); } catch { /* ignore */ }
  };
  timeoutHandle = setTimeout(killOnTimeout, timeoutMs);

  const resetTimeout = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(killOnTimeout, timeoutMs);
  };

  // Read stdout line-by-line via BoxLite's streaming API
  const readStdout = async () => {
    try {
      const stdoutStream = await execution.stdout();
      while (true) {
        const line = await stdoutStream.next();
        if (line === null) break;

        // Accumulate for logging
        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (line.length > remaining) {
            stdout += line.slice(0, remaining);
            stdoutTruncated = true;
            logger.warn(
              { group: group.name, size: stdout.length },
              'Box stdout truncated due to size limit',
            );
          } else {
            stdout += line;
          }
        }

        // Parse output markers (same logic as before, adapted for line-by-line)
        if (onOutput) {
          parseBuffer += line;
          let startIdx: number;
          while (
            (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
          ) {
            const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
            if (endIdx === -1) break;

            const jsonStr = parseBuffer
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
            parseBuffer = parseBuffer.slice(
              endIdx + OUTPUT_END_MARKER.length,
            );

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
      }
    } catch {
      // Stream ended or error
    }
  };

  // Read stderr line-by-line for logging
  const readStderr = async () => {
    try {
      const stderrStream = await execution.stderr();
      while (true) {
        const line = await stderrStream.next();
        if (line === null) break;

        const trimmed = line.trim();
        if (trimmed) logger.debug({ container: group.folder }, trimmed);

        if (stderrTruncated) continue;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (line.length > remaining) {
          stderr += line.slice(0, remaining);
          stderrTruncated = true;
          logger.warn(
            { group: group.name, size: stderr.length },
            'Box stderr truncated due to size limit',
          );
        } else {
          stderr += line;
        }
      }
    } catch {
      // Stream ended or error
    }
  };

  // Run stdout/stderr readers and wait for completion in parallel
  const [, , execResult] = await Promise.all([
    readStdout(),
    readStderr(),
    execution.wait().catch((err: unknown) => {
      logger.error(
        { group: group.name, containerName, error: err },
        'Box wait error',
      );
      return { exitCode: 1, errorMessage: String(err) };
    }),
  ]);

  clearTimeout(timeoutHandle);
  const duration = Date.now() - startTime;
  const code = execResult.exitCode;

  if (timedOut) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const timeoutLog = path.join(logsDir, `container-${ts}.log`);
    fs.writeFileSync(
      timeoutLog,
      [
        `=== Box Run Log (TIMEOUT) ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Box: ${containerName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Had Streaming Output: ${hadStreamingOutput}`,
      ].join('\n'),
    );

    if (hadStreamingOutput) {
      logger.info(
        { group: group.name, containerName, duration, code },
        'Box timed out after output (idle cleanup)',
      );
      await outputChain;
      return { status: 'success', result: null, newSessionId };
    }

    logger.error(
      { group: group.name, containerName, duration, code },
      'Box timed out with no output',
    );
    return {
      status: 'error',
      result: null,
      error: `Box timed out after ${configTimeout}ms`,
    };
  }

  // Write log file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `container-${timestamp}.log`);
  const isVerbose =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  const logLines = [
    `=== Box Run Log ===`,
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
    if (isVerbose) {
      logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``,
      );
    }
    logLines.push(
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
  logger.debug({ logFile, verbose: isVerbose }, 'Box log written');

  if (code !== 0) {
    logger.error(
      { group: group.name, code, duration, stderr, stdout, logFile },
      'Box exited with error',
    );
    return {
      status: 'error',
      result: null,
      error: `Box exited with code ${code}: ${stderr.slice(-200)}`,
    };
  }

  // Streaming mode: wait for output chain to settle
  if (onOutput) {
    await outputChain;
    logger.info(
      { group: group.name, duration, newSessionId },
      'Box completed (streaming mode)',
    );
    return { status: 'success', result: null, newSessionId };
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
      {
        group: group.name,
        duration,
        status: output.status,
        hasResult: !!output.result,
      },
      'Box completed',
    );
    return output;
  } catch (err) {
    logger.error(
      { group: group.name, stdout, stderr, error: err },
      'Failed to parse box output',
    );
    return {
      status: 'error',
      result: null,
      error: `Failed to parse box output: ${err instanceof Error ? err.message : String(err)}`,
    };
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
