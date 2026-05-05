/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  OLLAMA_ADMIN_TOOLS,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import {
  loadProviderEnvDefaults,
  mergeProviderConfig,
  readEnvFile,
} from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Provider defaults from .env (single-tenant Talon — most operators set
// TALON_PROVIDER once and every group inherits it). Loaded at module init;
// per-group containerConfig still overrides via mergeProviderConfig().
// Restart Talon to pick up .env changes.
const PROVIDER_ENV_DEFAULTS = loadProviderEnvDefaults();
if (PROVIDER_ENV_DEFAULTS.provider) {
  logger.info(
    {
      provider: PROVIDER_ENV_DEFAULTS.provider,
      ollamaModel: PROVIDER_ENV_DEFAULTS.ollama?.model,
    },
    'Provider defaults loaded from .env',
  );
}

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
    // Credentials are injected by OneCLI gateway, never exposed to containers.
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
  // When running as root, make writable mount dirs accessible to the container's
  // node user (uid 1000) — non-main containers always run as non-root.
  if (!isMain && process.getuid?.() === 0) {
    fs.chmodSync(groupSessionsDir, 0o777);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.chmodSync(groupDir, 0o777);
  }
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

  // Sync settings.json `model` field with the effective provider:
  //   - provider=ollama → upsert model = ollama.model
  //   - provider=anthropic (or unset) → remove any leftover model field so
  //     the SDK falls back to Anthropic defaults instead of erroring with
  //     "model qwen2.5-... doesn't exist" after a provider switch.
  // Read-merge-write to preserve other keys (env, hooks, permissions).
  const effectiveConfig = mergeProviderConfig(
    PROVIDER_ENV_DEFAULTS,
    group.containerConfig,
  );
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let dirty = false;
    if (
      effectiveConfig.provider === 'ollama' &&
      effectiveConfig.ollama?.model
    ) {
      if (parsed.model !== effectiveConfig.ollama.model) {
        parsed.model = effectiveConfig.ollama.model;
        dirty = true;
      }
    } else if (parsed.model !== undefined) {
      // Provider is anthropic (or unset) — strip any stale Ollama model
      // left behind from a previous spawn. Without this, switching back
      // to Anthropic fails with "model not found" until the file is
      // hand-edited.
      delete parsed.model;
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
    }
  } catch (err) {
    logger.warn(
      { group: group.name, settingsFile, err },
      'Failed to sync model field in settings.json',
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
  if (!isMain && process.getuid?.() === 0) {
    fs.chmodSync(groupIpcDir, 0o777);
    for (const sub of ['messages', 'tasks', 'input']) {
      fs.chmodSync(path.join(groupIpcDir, sub), 0o777);
    }
  }
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
    if (!isMain && process.getuid?.() === 0) {
      fs.chmodSync(groupAgentRunnerDir, 0o777);
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

  // --- Per-MCP credential isolation shadows ---
  // For each MCP that has a dedicated mcp-* uid in the container, add
  // host-side bind mounts AFTER the directory mount so they take precedence:
  //
  //   1. /dev/null over /workspace/extra/<dir>/<file> so the agent (node uid)
  //      can't read the original cred file.
  //   2. The host file into /etc/mcp-staging/<id>.<file> so the entrypoint
  //      (running as root) can copy it to /etc/mcp-secrets/<id>.<file> with
  //      ownership chowned to mcp-<id> and mode 600. /etc/mcp-staging is
  //      mode 700 root, unreadable by node.
  //
  // The mount --bind /dev/null trick from inside the container fails on
  // read-only mounts ("mount point is not a directory"), so we do this at
  // docker run time instead.
  //
  // `id` is the short identifier used for mcp-<id> uid + sudoers + secret
  // file naming. `dir` is the directory under /workspace/extra/ (often
  // suffixed with -mcp). `extraFiles` lists additional credential files
  // beyond .env (e.g. velociraptor's mTLS api.config.yaml).
  const ISOLATED_MCPS: Array<{
    id: string;
    dir: string;
    extraFiles?: string[];
  }> = [
    { id: 'siem', dir: 'siem' },
    { id: 'mysql', dir: 'mysql' },
    { id: 'wazuh', dir: 'wazuh-mcp' },
    { id: 'copilot', dir: 'copilot-mcp' },
    { id: 'shuffle', dir: 'shuffle-mcp' },
    {
      id: 'velociraptor',
      dir: 'velociraptor-mcp',
      extraFiles: ['api.config.yaml'],
    },
    { id: 'cve', dir: 'cve-mcp' },
  ];
  for (const mcp of ISOLATED_MCPS) {
    const mcpMount = mounts.find(
      (m) => m.containerPath === `/workspace/extra/${mcp.dir}`,
    );
    if (!mcpMount) continue;

    const fileMounts: Array<{
      host: string;
      staging: string;
      visible: string;
    }> = [];

    // Primary .env (always)
    const hostEnvPath = path.join(mcpMount.hostPath, '.env');
    if (fs.existsSync(hostEnvPath)) {
      fileMounts.push({
        host: hostEnvPath,
        staging: `/etc/mcp-staging/${mcp.id}.env`,
        visible: `/workspace/extra/${mcp.dir}/.env`,
      });
    }

    // Extra credential files (e.g. mTLS cert)
    for (const extra of mcp.extraFiles ?? []) {
      const hostExtraPath = path.join(mcpMount.hostPath, extra);
      if (fs.existsSync(hostExtraPath)) {
        fileMounts.push({
          host: hostExtraPath,
          staging: `/etc/mcp-staging/${mcp.id}.${extra}`,
          visible: `/workspace/extra/${mcp.dir}/${extra}`,
        });
      }
    }

    for (const fm of fileMounts) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: fm.visible,
        readonly: true,
      });
      mounts.push({
        hostPath: fm.host,
        containerPath: fm.staging,
        readonly: true,
      });
    }
  }

  return mounts;
}

/**
 * Resolve provider-derived env + host-block args.
 *
 * Returns the env and `--add-host` args that the provider config implies,
 * plus any raw `env`/`blockedHosts` overlays from `containerConfig`. Pure
 * function — no I/O. The caller appends to `args` in the right place
 * (after OneCLI applies its proxy vars so NO_PROXY actually wins).
 */
function buildProviderArgs(containerConfig: ContainerConfig | undefined): {
  envArgs: string[];
  addHostArgs: string[];
} {
  const env: Record<string, string> = {};
  const blockedHosts = new Set<string>();

  if (containerConfig?.provider === 'ollama' && containerConfig.ollama) {
    const { baseUrl, apiKey } = containerConfig.ollama;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = apiKey ?? 'ollama';
    // NO_PROXY beats HTTPS_PROXY at request time — the SDK's HTTP client
    // honours both lowercase and uppercase, so set both for safety.
    let host: string | null = null;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* non-URL; skip NO_PROXY wiring */
    }
    if (host) {
      env.NO_PROXY = host;
      env.no_proxy = host;
    }
    // Fail-closed: if the SDK ever ignores ANTHROPIC_BASE_URL (e.g. someone
    // unsets it post-spawn), DNS for api.anthropic.com resolves to the
    // container itself — request fails fast instead of leaking traffic.
    blockedHosts.add('api.anthropic.com');
  }

  // Raw overlay — user-provided env wins.
  if (containerConfig?.env) {
    Object.assign(env, containerConfig.env);
  }
  for (const h of containerConfig?.blockedHosts ?? []) {
    blockedHosts.add(h);
  }

  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  const addHostArgs: string[] = [];
  for (const h of blockedHosts) {
    addHostArgs.push('--add-host', `${h}:127.0.0.1`);
  }
  return { envArgs, addHostArgs };
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  containerConfig: ContainerConfig | undefined,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Forward Ollama admin tools flag if enabled
  if (OLLAMA_ADMIN_TOOLS) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  // Skip OneCLI entirely when running an Ollama-only container — there are no
  // upstream secrets to inject and we don't want the proxy intercepting our
  // ANTHROPIC_BASE_URL redirect.
  if (containerConfig?.provider !== 'ollama') {
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false, // Nanoclaw already handles host gateway
      agent: agentIdentifier,
    });
    if (onecliApplied) {
      logger.info({ containerName }, 'OneCLI gateway config applied');
    } else {
      const { CLAUDE_CODE_OAUTH_TOKEN } = readEnvFile([
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]);
      if (CLAUDE_CODE_OAUTH_TOKEN) {
        // Long-lived OAuth token (generated via `claude setup-token`) — inject
        // directly so containers authenticate without a separate login.
        args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}`);
        logger.info(
          { containerName },
          'Injecting CLAUDE_CODE_OAUTH_TOKEN into container',
        );
      } else {
        logger.warn(
          { containerName },
          'No credentials available — container may fail to authenticate',
        );
      }
    }
  } else {
    logger.info(
      { containerName, provider: 'ollama' },
      'Provider=ollama — skipping OneCLI gateway, using ANTHROPIC_BASE_URL redirect',
    );
  }

  // Provider-derived env + host blocks. Pushed AFTER OneCLI so NO_PROXY
  // (set by Ollama provider) overrides any HTTPS_PROXY OneCLI may have applied.
  const { envArgs, addHostArgs } = buildProviderArgs(containerConfig);
  args.push(...envArgs);
  args.push(...addHostArgs);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // When getuid is unavailable (native Windows without WSL), skip user mapping.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      // When host is root (uid 0), main container stays root (no setpriv needed).
      if (hostUid !== 0) {
        args.push('-e', `RUN_UID=${hostUid}`);
        args.push('-e', `RUN_GID=${hostGid}`);
        args.push('-e', 'HOME=/home/node');
      }
    } else {
      // Non-main containers START as root so entrypoint.sh can:
      //   - copy per-MCP .env files to /etc/mcp-secrets/ with restricted perms
      //   - shadow original bind-mounts so the agent can't read them
      // Then setpriv drops to RUN_UID before exec'ing claude-code (which
      // refuses to run as root). Must NOT pass --user here.
      const targetUid = hostUid !== 0 ? hostUid : 1000;
      const targetGid = hostGid != null && hostGid !== 0 ? hostGid : 1000;
      args.push('-e', `RUN_UID=${targetUid}`);
      args.push('-e', `RUN_GID=${targetGid}`);
      args.push('-e', 'HOME=/home/node');
    }
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
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  // Merge .env provider defaults with per-group overrides — single source
  // of truth for provider-related decisions in buildContainerArgs.
  const effectiveContainerConfig = mergeProviderConfig(
    PROVIDER_ENV_DEFAULTS,
    group.containerConfig,
  );
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    effectiveContainerConfig,
    agentIdentifier,
  );

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
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
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
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
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
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
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
        // Exit 137 = SIGKILL. Claude Code kills itself after a rate_limit_event.
        // If streaming output already arrived, the agent completed — treat as success
        // to prevent retry loops that pile up more requests against the same token.
        if (code === 137 && hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container killed after rate limit (output already received — treating as success)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

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
