/**
 * Container Runner for AgentLite
 * Spawns agent execution in BoxLite VMs and handles IPC
 */
import fs from 'fs';
import path from 'path';

import type { RuntimeConfig } from './runtime-config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { spawnBox } from './box-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { copyDirRecursive } from './utils.js';

// Lazy OneCLI — dynamically imported so it's not a hard dependency
let _onecli: any = null;
let _onecliUrl: string | null = null;
async function getOneCLI(onecliUrl: string): Promise<any> {
  if (!_onecli || _onecliUrl !== onecliUrl) {
    try {
      const { OneCLI } = await import('@onecli-sh/sdk');
      _onecli = new OneCLI({ url: onecliUrl });
      _onecliUrl = onecliUrl;
    } catch {
      return null;
    }
  }
  return _onecli;
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---AGENTLITE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTLITE_OUTPUT_END---';

export type CredentialResolver = () => Promise<Record<string, string>>;

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Agent id used to scope runtime box names. */
  agentId?: string;
  workDir?: string;
  /** Override config.GROUPS_DIR for per-instance group paths. */
  groupsDir?: string;
  /** Override config.DATA_DIR for per-instance data paths. */
  dataDir?: string;
  /** Per-agent credential resolver. Bypasses OneCLI when provided. */
  credentialResolver?: CredentialResolver;
  /** Per-agent mount allowlist (resolved). */
  mountAllowlist?: import('./types.js').MountAllowlist | null;
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

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  workDir: string,
  groupsDir: string,
  dataDir: string,
  packageRoot: string,
  mountAllowlist?: import('./types.js').MountAllowlist | null,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder, groupsDir);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    // mounts.push({
    //   hostPath: packageRoot,
    //   containerPath: '/workspace/project',
    //   readonly: true,
    // });
    mounts.push({
      hostPath: workDir,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    // const envFile = path.join(projectRoot, '.env');
    // if (fs.existsSync(envFile)) {
    //   mounts.push({
    //     hostPath: '/dev/null',
    //     containerPath: '/workspace/project/.env',
    //     readonly: true,
    //   });
    // }

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
    const globalDir = path.join(groupsDir, 'global');
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
    dataDir,
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
  const skillsSrc = path.join(packageRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      copyDirRecursive(srcDir, dstDir);
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder, dataDir);
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
    packageRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    dataDir,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    copyDirRecursive(agentRunnerSrc, groupAgentRunnerDir);
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
      mountAllowlist ?? null,
    );
    mounts.push(...validatedMounts);
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
  onecliUrl: string,
  agentIdentifier?: string,
): Promise<Record<string, string>> {
  const onecli = await getOneCLI(onecliUrl);
  if (!onecli) {
    logger.warn(
      { containerName },
      'OneCLI SDK not available — box will have no credentials',
    );
    return {};
  }

  const tempArgs: string[] = [];
  const onecliApplied = await onecli.applyContainerConfig(tempArgs, {
    addHostMapping: false,
    agent: agentIdentifier,
  });
  if (onecliApplied) {
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

interface BoxConfig {
  env: Record<string, string>;
  user: string | undefined;
}

/**
 * Build container environment variables and user config.
 * Encapsulates credential resolution and host uid/gid mapping.
 */
async function buildBoxConfig(
  containerName: string,
  rc: RuntimeConfig,
  agentIdentifier?: string,
  credentialResolver?: CredentialResolver,
): Promise<BoxConfig> {
  // Use SDK-provided credential resolver if set, else OneCLI gateway
  let credentialEnv: Record<string, string>;
  if (credentialResolver) {
    credentialEnv = await credentialResolver();
  } else {
    credentialEnv = await extractOnecliEnv(
      containerName,
      rc.onecliUrl,
      agentIdentifier,
    );
  }

  const env: Record<string, string> = {
    ...credentialEnv,
    TZ: rc.timezone,
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
  };

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  const user =
    hostUid != null && hostUid !== 0 && hostUid !== 1000
      ? `${hostUid}:${hostGid}`
      : undefined;

  if (user) {
    env['HOME'] = '/home/node';
  }

  return { env, user };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  rc: RuntimeConfig,
  onProcess: (boxName: string, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const workDir = input.workDir ?? rc.workdir;
  const groupsDir = input.groupsDir ?? path.join(rc.workdir, 'groups');
  const dataDir = input.dataDir ?? path.join(rc.workdir, 'data');

  const groupDir = resolveGroupFolderPath(group.folder, groupsDir);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    workDir,
    groupsDir,
    dataDir,
    rc.packageRoot,
    input.mountAllowlist,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentPrefix = input.agentId ? `${input.agentId}-` : '';
  const containerName = `agentlite-${agentPrefix}${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  const { env: boxEnv, user: userStr } = await buildBoxConfig(
    containerName,
    rc,
    agentIdentifier,
    input.credentialResolver,
  );

  const boxOptions = {
    image: rc.boxImage,
    rootfsPath: rc.boxRootfsPath || undefined,
    memoryMib: rc.boxMemoryMib,
    cpus: rc.boxCpus,
    user: userStr,
  };

  logger.debug(
    {
      group: group.name,
      containerName,
      boxOptions,
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

  // Create box, run entrypoint, write stdin
  const spawnResult = await spawnBox(
    group.name,
    containerName,
    mounts,
    boxEnv,
    userStr,
    JSON.stringify(input),
    rc,
  );
  if ('status' in spawnResult) return spawnResult; // error
  const { box, execution } = spawnResult;

  onProcess(containerName, containerName);

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
  const configTimeout = group.containerConfig?.timeout || rc.containerTimeout;
  const timeoutMs = Math.max(configTimeout, rc.idleTimeout + 30_000);

  let timeoutHandle: ReturnType<typeof setTimeout>;
  const killOnTimeout = async () => {
    timedOut = true;
    logger.error({ group: group.name, containerName }, 'Box timeout, stopping');
    try {
      await execution.kill();
    } catch {
      /* ignore */
    }
    try {
      await box.stop();
    } catch {
      /* ignore */
    }
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
          const remaining = rc.containerMaxOutputSize - stdout.length;
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

        // Don't reset timeout on stderr — SDK writes debug logs continuously.
        // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
        if (stderrTruncated) continue;
        const remaining = rc.containerMaxOutputSize - stderr.length;
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

    // Timeout after output = idle cleanup, not failure.
    // The agent already sent its response; this is just the
    // container being reaped after the idle period expired.
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
    // On error, log input metadata only — not the full prompt.
    // Full input is only included at verbose level to avoid
    // persisting user conversation content on every non-zero exit.
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
      `=== Box Options ===`,
      JSON.stringify(boxOptions, null, 2),
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
  logger.debug({ logFile, verbose: isVerbose }, 'Box log written');

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
      'Box exited with error',
    );

    return {
      status: 'error',
      result: null,
      error: `Box exited with code ${code}: ${stderr.slice(-200)}`,
    };
  }

  // Streaming mode: wait for output chain to settle, return completion marker
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
      'Box completed',
    );

    return output;
  } catch (err) {
    logger.error(
      {
        group: group.name,
        stdout,
        stderr,
        error: err,
      },
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
  dataDir: string,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder, dataDir);
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
  _registeredJids: Set<string>,
  dataDir: string,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder, dataDir);
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
