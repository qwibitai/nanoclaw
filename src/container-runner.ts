/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Apple Container and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_DAILY_SPEND_USD,
  IDLE_TIMEOUT,
} from './config.js';

// Use 'docker' on Linux, 'container' (Apple Container) on macOS
const CONTAINER_CMD = os.platform() === 'linux' ? 'docker' : 'container';
import { getDailySpendUsd, getRecentMessages, logUsage } from './db.js';
import { readEnvFile } from './env.js';
import { audit, logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner).
// A random nonce is generated per-run so agent output cannot inject these markers.
function makeMarkers(nonce: string) {
  return {
    start: `---NANOCLAW_OUTPUT_${nonce}_START---`,
    end: `---NANOCLAW_OUTPUT_${nonce}_END---`,
  };
}

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
  secrets?: Record<string, string>;
  outputNonce?: string;
  model?: string;          // e.g. 'claude-haiku-4-5' for scheduled tasks
  maxBudgetUsd?: number;   // per-query spend cap
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
  };
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
    // Apple Container only supports directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Mount tools directory read-only so non-main groups can use skills
    // (all skills reference tools at /workspace/project/tools/...)
    const toolsDir = path.join(projectRoot, 'tools');
    if (fs.existsSync(toolsDir)) {
      mounts.push({
        hostPath: toolsDir,
        containerPath: '/workspace/project/tools',
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
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
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
 * Secret scoping: restrict which secrets non-main groups receive.
 * Main gets everything. Non-main gets only what their tools need.
 * This limits blast radius if a non-main container is prompt-injected.
 */

// Auth keys every container needs to call the Claude API
const SECRETS_CORE = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

// Google APIs (Sheets, Calendar, Drive, Gmail) — needed by most groups
const SECRETS_GOOGLE = [
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'GOOGLE_SPREADSHEET_ID',
  'GOOGLE_CALENDAR_ID',
  'GMAIL_USER_EMAIL',
] as const;

// Email sending (SMTP + Gmail send)
const SECRETS_EMAIL = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
] as const;

// Square Payments
const SECRETS_SQUARE = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT',
] as const;

// Social media posting (X, Facebook, LinkedIn)
const SECRETS_SOCIAL = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'FB_PAGE_ID',
  'FB_PAGE_ACCESS_TOKEN',
  'LINKEDIN_ACCESS_TOKEN',
  'LINKEDIN_PERSON_URN',
] as const;

// Vending platform (IDDI)
const SECRETS_IDDI = [
  'IDDI_BASE_URL',
  'IDDI_EMAIL',
  'IDDI_PASSWORD',
] as const;

// Lead generation
const SECRETS_LEADS = [
  'GOOGLE_MAPS_API_KEY',
] as const;

// All secret keys (main group gets everything)
const ALL_SECRET_KEYS = [
  ...SECRETS_CORE,
  ...SECRETS_EMAIL,
  ...SECRETS_SOCIAL,
  ...SECRETS_GOOGLE,
  ...SECRETS_LEADS,
  ...SECRETS_IDDI,
  ...SECRETS_SQUARE,
] as const;

// Non-main groups get core + google + email (enough for briefings, CRM, follow-ups)
// They do NOT get social media keys, lead gen, or IDDI unless explicitly granted
const STANDARD_SECRET_KEYS = [
  ...SECRETS_CORE,
  ...SECRETS_GOOGLE,
  ...SECRETS_EMAIL,
  ...SECRETS_SQUARE,
] as const;

/** Map scope names to their secret key sets. */
const SCOPE_MAP: Record<string, readonly string[]> = {
  social: SECRETS_SOCIAL,
  iddi: SECRETS_IDDI,
  leads: SECRETS_LEADS,
};

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 * Non-main groups receive a restricted set to limit blast radius.
 * Extra scopes can be granted via containerConfig.extraSecretScopes.
 */
function readSecrets(isMain: boolean, extraScopes?: string[]): Record<string, string> {
  if (isMain) return readEnvFile([...ALL_SECRET_KEYS]);

  const keys: string[] = [...STANDARD_SECRET_KEYS];
  if (extraScopes) {
    for (const scope of extraScopes) {
      const scopeKeys = SCOPE_MAP[scope];
      if (scopeKeys) keys.push(...scopeKeys);
    }
  }
  return readEnvFile(keys);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Docker: drop all capabilities, prevent privilege escalation, and set resource limits.
  // Apple Container is VM-based (inherently isolated), so these flags are not needed.
  if (CONTAINER_CMD === 'docker') {
    args.push(
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory=2048m',
      '--cpus=2',
      '--pids-limit=512',
      '--shm-size=512m',
    );
  }

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

/** Validate that a group folder name is safe (no path traversal). */
function validateGroupFolder(folder: string): void {
  if (
    folder.includes('..') ||
    folder.includes('/') ||
    folder.includes('\\') ||
    path.isAbsolute(folder) ||
    folder !== path.basename(folder)
  ) {
    throw new Error(`Invalid group folder name: ${folder}`);
  }
}

/**
 * Write a snapshot of recent messages for the container to read.
 * Called before scheduled tasks so agents can query cross-channel message activity.
 */
export function writeMessagesSnapshot(groupFolder: string): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const messages = getRecentMessages(48, 200);
  const snapshotPath = path.join(groupIpcDir, 'recent_messages.json');
  fs.writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    messages: messages.map(m => ({
      chat_jid: m.chat_jid,
      sender_name: m.sender_name,
      content: m.content,
      timestamp: m.timestamp,
      is_bot_message: !!m.is_bot_message,
    })),
  }, null, 2));
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  // Enforce daily spend cap before spawning a container
  if (MAX_DAILY_SPEND_USD > 0) {
    const todaySpend = getDailySpendUsd();
    if (todaySpend >= MAX_DAILY_SPEND_USD) {
      logger.warn(
        { todaySpend: todaySpend.toFixed(2), cap: MAX_DAILY_SPEND_USD },
        'Daily spend cap reached, refusing to spawn container',
      );
      return {
        status: 'error',
        error: `Daily spend cap reached ($${todaySpend.toFixed(2)} / $${MAX_DAILY_SPEND_USD}). No more containers will be spawned today.`,
        result: null,
        newSessionId: undefined,
      };
    }
  }

  // Validate group folder to prevent path traversal in mount paths
  validateGroupFolder(group.folder);

  // Generate per-run nonce for output markers to prevent injection
  const outputNonce = crypto.randomBytes(16).toString('hex');
  const { start: OUTPUT_START_MARKER, end: OUTPUT_END_MARKER } =
    makeMarkers(outputNonce);
  input.outputNonce = outputNonce;

  const groupDir = path.join(GROUPS_DIR, group.folder);
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

  audit('container_spawn', {
    group: group.name,
    containerName,
    mountCount: mounts.length,
    isMain: input.isMain,
  });

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_CMD, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets(input.isMain, group.containerConfig?.extraSecretScopes);
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;
    // Accumulate usage across all streamed outputs
    const accumulatedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
    };

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
            if (parsed.usage) {
              accumulatedUsage.input_tokens += parsed.usage.input_tokens;
              accumulatedUsage.output_tokens += parsed.usage.output_tokens;
              accumulatedUsage.cache_read_tokens +=
                parsed.usage.cache_read_tokens;
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
      audit('container_timeout', { group: group.name, containerName });
      exec(
        `${CONTAINER_CMD} stop ${containerName}`,
        { timeout: 15000 },
        (err) => {
          if (err) {
            logger.warn(
              { group: group.name, containerName, err },
              'Graceful stop failed, force killing',
            );
            container.kill('SIGKILL');
          }
        },
      );
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
            // Log accumulated token usage (critical for daily spend cap accuracy)
            if (
              accumulatedUsage.input_tokens > 0 ||
              accumulatedUsage.output_tokens > 0
            ) {
              try {
                logUsage({
                  group_folder: input.groupFolder,
                  model: input.model || null,
                  ...accumulatedUsage,
                  timestamp: new Date().toISOString(),
                });
              } catch (err) {
                logger.debug({ err }, 'Failed to log usage on idle cleanup');
              }
            }
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
          // Log accumulated token usage
          if (
            accumulatedUsage.input_tokens > 0 ||
            accumulatedUsage.output_tokens > 0
          ) {
            try {
              logUsage({
                group_folder: input.groupFolder,
                model: input.model || null,
                ...accumulatedUsage,
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              logger.debug({ err }, 'Failed to log usage');
            }
          }
          logger.info(
            {
              group: group.name,
              duration,
              newSessionId,
              usage: accumulatedUsage,
            },
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
