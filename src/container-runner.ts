/**
 * Agent runner for NanoClaw.
 * Supports container execution (default) and optional host execution.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_RUNTIME,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  getEffectiveModelConfig,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { readEnvFile } from './env.js';
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
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface RunContainerAgentOptions {
  timeoutMs?: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface HostRuntimeContext {
  groupDir: string;
  globalDir?: string;
  groupSessionRoot: string;
  groupSessionsDir: string;
  groupIpcDir: string;
}

function ensureGroupSessionSettings(groupSessionsDir: string): void {
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (fs.existsSync(settingsFile)) return;

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

function syncGroupSkills(groupSessionsDir: string): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (!fs.existsSync(skillsSrc)) return;

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}

function prepareHostRuntimeContext(group: RegisteredGroup): HostRuntimeContext {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groupSessionRoot = path.join(DATA_DIR, 'sessions', group.folder);
  const groupSessionsDir = path.join(groupSessionRoot, '.claude');
  ensureGroupSessionSettings(groupSessionsDir);
  syncGroupSkills(groupSessionsDir);

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const globalDirCandidate = path.join(GROUPS_DIR, 'global');
  const globalDir = fs.existsSync(globalDirCandidate)
    ? globalDirCandidate
    : undefined;

  return {
    groupDir,
    globalDir,
    groupSessionRoot,
    groupSessionsDir,
    groupIpcDir,
  };
}

const HOST_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
];

const HOST_RUNTIME_REWRITE_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'ANTHROPIC_BASE_URL',
];

const DOCKER_HOST_ALIASES = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'docker.for.mac.host.internal',
  'docker.for.mac.localhost',
]);

function rewriteDockerHostAlias(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    const host = parsed.hostname.toLowerCase();
    if (!DOCKER_HOST_ALIASES.has(host)) return urlValue;
    parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function normalizeHostRuntimeEnv(
  input: Record<string, string>,
): Record<string, string> {
  const env = { ...input };
  for (const key of HOST_RUNTIME_REWRITE_KEYS) {
    const current = env[key];
    if (!current) continue;
    env[key] = rewriteDockerHostAlias(current);
  }
  return env;
}

/** @internal - for tests only */
export function _normalizeHostRuntimeEnvForTests(
  input: Record<string, string>,
): Record<string, string> {
  return normalizeHostRuntimeEnv(input);
}

function writeOneCLICertificate(
  certificatePath: string,
  certificatePem: string,
): boolean {
  try {
    fs.mkdirSync(path.dirname(certificatePath), { recursive: true });
    fs.writeFileSync(certificatePath, certificatePem, { mode: 0o600 });
    return true;
  } catch (err) {
    logger.warn(
      { certificatePath, err },
      'Failed to write OneCLI CA certificate for host runtime',
    );
    return false;
  }
}

async function getHostRuntimeCredentialEnv(agentIdentifier?: string): Promise<{
  env: Record<string, string>;
  onecliApplied: boolean;
  onecliCaPath?: string;
}> {
  const envFromFile = readEnvFile(HOST_AUTH_ENV_KEYS);
  let onecliEnv: Record<string, string> = {};
  let onecliApplied = false;
  let onecliCaPath: string | undefined;

  try {
    const config = await onecli.getContainerConfig(agentIdentifier);
    onecliEnv = normalizeHostRuntimeEnv(config.env);
    onecliApplied = true;
    if (config.caCertificate && config.caCertificateContainerPath) {
      if (
        writeOneCLICertificate(
          config.caCertificateContainerPath,
          config.caCertificate,
        )
      ) {
        onecliCaPath = config.caCertificateContainerPath;
      }
    }
  } catch (err) {
    logger.warn(
      { err, agentIdentifier: agentIdentifier || 'default' },
      'OneCLI gateway not reachable for host runtime',
    );
  }

  return {
    env: {
      ...envFromFile,
      ...onecliEnv,
    },
    onecliApplied,
    onecliCaPath,
  };
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
    // (store, group folder, IPC, .claude/) are mounted separately below.
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

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
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
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
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
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  effectiveModel: string | undefined,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass effective model for startup/default selection inside the container.
  // ANTHROPIC_MODEL is canonical; CLAUDE_MODEL remains for compatibility.
  if (effectiveModel) {
    args.push('-e', `ANTHROPIC_MODEL=${effectiveModel}`);
    args.push('-e', `CLAUDE_MODEL=${effectiveModel}`);
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
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
  options?: RunContainerAgentOptions,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;
  const modelConfig = getEffectiveModelConfig(group.containerConfig?.model);
  const runtime = AGENT_RUNTIME;
  const runnerLabel = runtime === 'host' ? 'Host agent' : 'Container';
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  const mounts: VolumeMount[] = [];
  let command = CONTAINER_RUNTIME_BIN;
  let args: string[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  let runtimeDetails: string[] = [];

  if (runtime === 'host') {
    const hostRuntime = prepareHostRuntimeContext(group);
    const hostCredentials = await getHostRuntimeCredentialEnv(agentIdentifier);
    const agentRunnerDir = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'dist',
    );
    const hostRunnerPath = path.join(agentRunnerDir, 'index.js');
    const mcpServerPath = path.join(agentRunnerDir, 'ipc-mcp-stdio.js');
    if (!fs.existsSync(hostRunnerPath) || !fs.existsSync(mcpServerPath)) {
      return {
        status: 'error',
        result: null,
        error:
          'Host runtime is missing built agent-runner files. Run "npm --prefix container/agent-runner run build".',
      };
    }

    command = process.execPath;
    args = [hostRunnerPath];
    env = {
      ...process.env,
      ...hostCredentials.env,
      TZ: TIMEZONE,
      HOME: hostRuntime.groupSessionRoot,
      NANOCLAW_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
      NANOCLAW_WORKSPACE_GLOBAL_DIR: hostRuntime.globalDir || '',
      NANOCLAW_WORKSPACE_EXTRA_DIR: path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'extra',
      ),
      NANOCLAW_IPC_INPUT_DIR: path.join(hostRuntime.groupIpcDir, 'input'),
    };
    if (modelConfig.model) {
      env.ANTHROPIC_MODEL = modelConfig.model;
      env.CLAUDE_MODEL = modelConfig.model;
    }

    runtimeDetails = [
      `groupDir=${hostRuntime.groupDir}`,
      `globalDir=${hostRuntime.globalDir || '(none)'}`,
      `home=${hostRuntime.groupSessionRoot}`,
      `ipcInput=${path.join(hostRuntime.groupIpcDir, 'input')}`,
      `onecliApplied=${hostCredentials.onecliApplied}`,
      `onecliCaPath=${hostCredentials.onecliCaPath || '(none)'}`,
      `runner=${hostRunnerPath}`,
    ];
  } else {
    mounts.push(...buildVolumeMounts(group, input.isMain));
    // Main group uses the default OneCLI agent; others use their own agent.
    args = await buildContainerArgs(
      mounts,
      processName,
      modelConfig.model,
      agentIdentifier,
    );
    runtimeDetails = mounts.map(
      (m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
    );
  }

  logger.debug(
    {
      group: group.name,
      runtime,
      processName,
      command,
      args: args.join(' '),
      runtimeDetails,
    },
    `${runnerLabel} runtime configuration`,
  );

  logger.info(
    {
      group: group.name,
      runtime,
      processName,
      model: modelConfig.model ?? null,
      modelSource: modelConfig.source,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    `Spawning ${runnerLabel.toLowerCase()}`,
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const runner = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    onProcess(runner, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    runner.stdin.write(JSON.stringify(input));
    runner.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    runner.stdout.on('data', (data) => {
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

    runner.stderr.on('data', (data) => {
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
    let hadStreamingOutput = false;
    const configuredTimeout =
      options?.timeoutMs ?? group.containerConfig?.timeout ?? CONTAINER_TIMEOUT;
    const timeoutMs =
      options?.timeoutMs != null
        ? configuredTimeout
        : // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
          // graceful _close sentinel has time to trigger before the hard kill fires.
          Math.max(configuredTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, runtime, processName },
        `${runnerLabel} timeout, stopping`,
      );
      if (runtime === 'container') {
        try {
          stopContainer(processName);
          return;
        } catch (err) {
          logger.warn(
            { group: group.name, processName, err },
            'Graceful stop failed, force killing',
          );
        }
      }
      runner.kill('SIGKILL');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    runner.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Runtime: ${runtime}`,
            `Process: ${processName}`,
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
            { group: group.name, runtime, processName, duration, code },
            `${runnerLabel} timed out after output (idle cleanup)`,
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
          { group: group.name, runtime, processName, duration, code },
          `${runnerLabel} timed out with no output`,
        );

        resolve({
          status: 'error',
          result: null,
          error: `${runnerLabel} timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Runtime: ${runtime}`,
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
          `=== Spawn Command ===`,
          [command, ...args].join(' '),
          ``,
          `=== Runtime Details ===`,
          runtimeDetails.join('\n'),
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
          `=== Runtime Details ===`,
          runtime === 'container'
            ? mounts
                .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
                .join('\n')
            : runtimeDetails.join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            runtime,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          `${runnerLabel} exited with error`,
        );

        resolve({
          status: 'error',
          result: null,
          error: `${runnerLabel} exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, runtime, duration, newSessionId },
            `${runnerLabel} completed (streaming mode)`,
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
            runtime,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          `${runnerLabel} completed`,
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            runtime,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse runner output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse runner output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    runner.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, runtime, processName, error: err },
        `${runnerLabel} spawn error`,
      );
      resolve({
        status: 'error',
        result: null,
        error: `${runnerLabel} spawn error: ${err.message}`,
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
    script?: string | null;
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
  _registeredJids: Set<string>,
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
