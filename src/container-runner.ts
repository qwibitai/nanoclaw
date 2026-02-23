/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  WORKER_CONTAINER_IMAGE,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopRunningContainersByPrefix,
  stopContainerWithVerification,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

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

function isWorkerImage(image?: string): boolean {
  if (!image) return false;
  return image === 'nanoclaw-worker' || image.startsWith('nanoclaw-worker:');
}

function isWorkerGroup(group: RegisteredGroup): boolean {
  return group.folder.startsWith('jarvis-worker') || isWorkerImage(group.containerConfig?.image);
}

function isAndyDeveloperGroup(group: RegisteredGroup): boolean {
  return group.folder === 'andy-developer';
}

function isAndyBotGroup(group: RegisteredGroup): boolean {
  return group.folder === 'andy-bot';
}

const WORKER_PREBAKED_SKILLS = new Set([
  'agent-browser',
  'browser-testing',
  'context-graph',
  'global-hook-setup',
  'implementation',
  'initialization',
  'mcp-setup',
  'orchestrator',
  'project-hook-setup',
  'react-best-practices',
  'research-evaluator',
  'testing',
  'testing-tracker',
  'token-efficient',
  'worktree-orchestrator',
]);

const ANDY_DEVELOPER_PREBAKED_SKILLS = new Set([
  'agent-browser',
  'browser-testing',
  'claude-md-creator',
  'context-graph',
  'implementation',
  'mcp-setup',
  'research-evaluator',
  'testing',
  'token-efficient',
  'worktree-orchestrator',
]);

const ANDY_BOT_PREBAKED_SKILLS = new Set([
  'context-graph',
  'research-evaluator',
  'token-efficient',
]);

const WORKER_PREBAKED_RULES = new Set([
  'compression-loop.md',
  'jarvis-worker-operating-rule.md',
]);

const ANDY_DEVELOPER_PREBAKED_RULES = new Set([
  'compression-loop.md',
  'andy-developer-operating-rule.md',
]);

const ANDY_BOT_PREBAKED_RULES = new Set([
  'compression-loop.md',
  'andy-bot-operating-rule.md',
]);

const WORKER_DEFAULT_OPENCODE_CONFIG = JSON.stringify({
  model: 'opencode/minimax-m2.5-free',
  autoupdate: false,
  instructions: ['/workspace/group/CLAUDE.md'],
  skills: { paths: ['/home/node/.claude/skills'] },
  mcp: {
    deepwiki: {
      type: 'local',
      enabled: true,
      command: ['mcp-remote', 'https://mcp.deepwiki.com/mcp', '--transport', 'streamable-http'],
    },
    context7: {
      type: 'local',
      enabled: true,
      command: ['context7-mcp'],
    },
    'token-efficient': {
      type: 'local',
      enabled: true,
      command: ['node', '/workspace/mcp-servers/token-efficient-mcp/dist/index.js'],
    },
    'chrome-devtools': {
      type: 'local',
      enabled: true,
      command: [
        'chrome-devtools-mcp',
        '--headless',
        '--isolated',
        '--executablePath',
        '/usr/bin/chromium',
        '--chromeArg=--disable-dev-shm-usage',
        '--chromeArg=--no-sandbox',
      ],
    },
  },
});

function getPrebakedSkillFilter(group: RegisteredGroup): Set<string> | null {
  if (isWorkerGroup(group)) return WORKER_PREBAKED_SKILLS;
  if (isAndyDeveloperGroup(group)) return ANDY_DEVELOPER_PREBAKED_SKILLS;
  if (isAndyBotGroup(group)) return ANDY_BOT_PREBAKED_SKILLS;
  return null;
}

function getPrebakedRuleFilter(group: RegisteredGroup): Set<string> | null {
  if (isWorkerGroup(group)) return WORKER_PREBAKED_RULES;
  if (isAndyDeveloperGroup(group)) return ANDY_DEVELOPER_PREBAKED_RULES;
  if (isAndyBotGroup(group)) return ANDY_BOT_PREBAKED_RULES;
  return null;
}

function copySkills(
  skillsSrc: string,
  skillsDst: string,
  allowedSkills: Set<string> | null,
): void {
  if (!fs.existsSync(skillsSrc)) return;
  fs.rmSync(skillsDst, { recursive: true, force: true });
  fs.mkdirSync(skillsDst, { recursive: true });
  const dstRoot = path.resolve(skillsDst);

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    // Hidden directories (for example ".docs") are metadata and can create
    // self-copy edge cases when symlinked from external skill roots.
    if (skillDir.startsWith('.')) continue;
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    if (allowedSkills && !allowedSkills.has(skillDir)) continue;
    const dstDir = path.join(skillsDst, skillDir);
    const dstResolved = path.resolve(dstDir);
    let srcResolved = path.resolve(srcDir);
    try {
      srcResolved = fs.realpathSync(srcDir);
    } catch {
      // Keep lexical path fallback if realpath fails on transient symlink targets.
    }

    if (
      srcResolved === dstResolved
      || srcResolved.startsWith(`${dstRoot}${path.sep}`)
    ) {
      logger.warn(
        { srcResolved, dstResolved },
        'Skipping skill copy due to overlapping source/destination',
      );
      continue;
    }

    // dereference:true follows symlinks so container gets real files only.
    fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
  }
}

function copyRules(
  rulesSrc: string,
  rulesDst: string,
  allowedRules: Set<string> | null,
): void {
  if (!fs.existsSync(rulesSrc)) return;
  fs.rmSync(rulesDst, { recursive: true, force: true });
  fs.mkdirSync(rulesDst, { recursive: true });

  for (const ruleFile of fs.readdirSync(rulesSrc)) {
    if (!ruleFile.endsWith('.md')) continue;
    if (allowedRules && !allowedRules.has(ruleFile)) continue;
    fs.copyFileSync(path.join(rulesSrc, ruleFile), path.join(rulesDst, ruleFile));
  }
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  runId?: string;
  secrets?: Record<string, string>;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  peak_rss_mb: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: UsageStats;
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
  const isWorker = isWorkerGroup(group);
  const skillFilter = getPrebakedSkillFilter(group);
  const ruleFilter = getPrebakedRuleFilter(group);
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
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

  // MCP servers (read-only) — provides token-efficient and other stdio MCP servers.
  // Mounted for all groups; MCP_SERVERS_ROOT env var points agents to this path.
  const mcpServersDir = path.join(getHomeDir(), 'Documents', 'remote-claude', 'mcp-servers');
  if (fs.existsSync(mcpServersDir)) {
    mounts.push({
      hostPath: mcpServersDir,
      containerPath: '/workspace/mcp-servers',
      readonly: true,
    });
  }

  if (isWorker) {
    // Worker runtime uses OpenCode. Stage skills/rules with symlinks dereferenced
    // so mounted content is self-contained and always readable inside container.
    const workerRuntimeDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.opencode',
    );
    const workerSkillsDir = path.join(workerRuntimeDir, 'skills');
    const workerRulesDir = path.join(workerRuntimeDir, 'rules');
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    const rulesSrc = path.join(projectRoot, 'container', 'rules');

    if (fs.existsSync(skillsSrc)) {
      copySkills(skillsSrc, workerSkillsDir, skillFilter);
      mounts.push({
        hostPath: workerSkillsDir,
        containerPath: '/home/node/.claude/skills',
        readonly: true,
      });
    }

    if (fs.existsSync(rulesSrc)) {
      copyRules(rulesSrc, workerRulesDir, ruleFilter);
      mounts.push({
        hostPath: workerRulesDir,
        containerPath: '/home/node/.claude/rules',
        readonly: true,
      });
    }
  }

  if (!isWorker) {
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
      fs.writeFileSync(settingsFile, JSON.stringify({
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
          // MCP servers root — used by mcp-setup skill to write correct paths into .mcp.json
          MCP_SERVERS_ROOT: '/workspace/mcp-servers',
        },
      }, null, 2) + '\n');
    }

    // Write .mcp.json for Claude Agent SDK MCP servers.
    // Agent container has chromium at /usr/bin/chromium (Debian package).
    const mcpJsonFile = path.join(groupSessionsDir, '.mcp.json');
    const mcpConfig = {
      mcpServers: {
        deepwiki: {
          type: 'url' as const,
          url: 'https://mcp.deepwiki.com/mcp',
        },
        context7: {
          command: 'context7-mcp',
          args: [],
        },
        'token-efficient': {
          command: 'node',
          args: ['/workspace/mcp-servers/token-efficient-mcp/dist/index.js'],
        },
        'chrome-devtools': {
          command: 'chrome-devtools-mcp',
          args: [
            '--headless',
            '--isolated',
            '--executablePath',
            '/usr/bin/chromium',
            '--chromeArg=--disable-dev-shm-usage',
            '--chromeArg=--no-sandbox',
          ],
        },
      },
    };
    fs.writeFileSync(mcpJsonFile, JSON.stringify(mcpConfig, null, 2) + '\n');

    // Sync skills from container/skills/ into each group's .claude/skills/
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    const skillsDst = path.join(groupSessionsDir, 'skills');
    if (fs.existsSync(skillsSrc)) {
      copySkills(skillsSrc, skillsDst, skillFilter);
    }

    // Sync rules from container/rules/ into each group's .claude/rules/
    const rulesSrc = path.join(process.cwd(), 'container', 'rules');
    const rulesDst = path.join(groupSessionsDir, 'rules');
    if (fs.existsSync(rulesSrc)) {
      copyRules(rulesSrc, rulesDst, ruleFilter);
    }

    mounts.push({
      hostPath: groupSessionsDir,
      containerPath: '/home/node/.claude',
      readonly: false,
    });
  }

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

  if (!isWorker) {
    // Mount agent-runner source from host — recompiled on container startup.
    // Bypasses sticky build cache for code changes.
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    mounts.push({
      hostPath: agentRunnerSrc,
      containerPath: '/app/src',
      readonly: true,
    });
  }

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

function getContainerImage(group: RegisteredGroup): string {
  if (group.containerConfig?.image) return group.containerConfig.image;
  if (group.folder.startsWith('jarvis-worker')) return WORKER_CONTAINER_IMAGE;
  return CONTAINER_IMAGE;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(group: RegisteredGroup): Record<string, string> {
  const isWorker = isWorkerGroup(group);
  if (isWorker) return readEnvFile(['GITHUB_TOKEN']);
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string, group: RegisteredGroup): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Run as host user so bind-mounted files are accessible (Docker only).
  // Apple Container uses a Linux VM — macOS UIDs (e.g. 501) can't be mapped to the
  // container's Linux UID namespace, causing XPC connection failure on startup.
  // The image already sets USER node via Dockerfile so no --user flag is needed.
  if (CONTAINER_RUNTIME_BIN !== 'container') {
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
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

  if (isWorkerGroup(group)) {
    // Enforce worker MCP defaults at runtime even if the worker image is stale.
    args.push('-e', `OPENCODE_CONFIG_CONTENT=${WORKER_DEFAULT_OPENCODE_CONFIG}`);
  }

  args.push(getContainerImage(group));

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

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const groupContainerPrefix = `nanoclaw-${safeName}-`;
  try {
    const cleanup = stopRunningContainersByPrefix(groupContainerPrefix);
    if (cleanup.stopped.length > 0) {
      logger.info(
        {
          group: group.name,
          count: cleanup.stopped.length,
          names: cleanup.stopped,
        },
        'Stopped stale running containers before launch',
      );
    }
    if (cleanup.failures.length > 0) {
      logger.warn(
        {
          group: group.name,
          count: cleanup.failures.length,
          failures: cleanup.failures,
        },
        'Failed to stop stale running containers before launch',
      );
    }
  } catch (err) {
    logger.warn(
      { group: group.name, err },
      'Failed pre-launch stale container cleanup',
    );
  }

  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, group);

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
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets(group);
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

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
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      const stopResult = stopContainerWithVerification(containerName);
      if (!stopResult.stopped) {
        logger.warn(
          { group: group.name, containerName, attempts: stopResult.attempts },
          'Container stop verification failed; forcing local process kill',
        );
      }
      try {
        container.kill('SIGKILL');
      } catch {
        // ignore local process kill errors
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
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

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
        // SIGKILL (137) after output was already streamed = container runtime's idle
        // cleanup (e.g. Apple Container VM timeout). Treat as idle cleanup, not failure.
        if (hadStreamingOutput && code === 137) {
          logger.info(
            { group: group.name, code, duration, newSessionId },
            'Container killed after output (idle cleanup)',
          );
          outputChain.then(() => resolve({ status: 'success', result: null, newSessionId }));
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
