/**
 * Process Runner for NanoClaw (Linux VPS)
 *
 * Drop-in replacement for container-runner.ts.
 * Spawns agent-runner as a Node.js child process instead of Apple Container.
 * Passes workspace paths via environment variables.
 */
import { ChildProcess, spawn } from 'child_process';
import https from 'https';
import fs from 'fs';
import path from 'path';

import { syncSkills } from './skill-sync.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

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
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Resolve the agent-runner entry point.
 * Auto-compiles on first run if dist/ doesn't exist.
 */
let agentRunnerEntry: string | null = null;

function getAgentRunnerEntry(): string {
  if (agentRunnerEntry) return agentRunnerEntry;

  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distEntry = path.join(agentRunnerDir, 'dist', 'index.js');

  if (!fs.existsSync(distEntry)) {
    throw new Error(
      `Agent runner not compiled: ${distEntry} not found. ` +
      `Run: cd ${agentRunnerDir} && npm install && npx tsc`,
    );
  }

  agentRunnerEntry = distEntry;
  return agentRunnerEntry;
}

/**
 * Set up workspace directories for a group (same layout as container mounts).
 * Returns the env vars to pass to the child process.
 */
function setupWorkspace(
  group: RegisteredGroup,
  isMain: boolean,
): { env: Record<string, string>; groupDir: string; ipcDir: string } {
  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group IPC namespace
  const ipcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }

  // Per-group Claude sessions directory (agent user must own for token refresh)
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  const sessionHomeDir = path.join(DATA_DIR, 'sessions', group.folder);
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  // Ensure agent user owns HOME and .claude/ so SDK can write session data
  const agentUid = parseInt(process.env.AGENT_UID || '999', 10);
  const agentGid = parseInt(process.env.AGENT_GID || '987', 10);
  fs.chownSync(sessionHomeDir, agentUid, agentGid);
  fs.chownSync(groupSessionsDir, agentUid, agentGid);

  // Write default settings.json if missing
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync fresh OAuth credentials from root's Claude config.
  // chown to agent user so the child process (spawned with uid/gid, no
  // supplementary groups) can read and refresh the token.
  const rootCreds = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
  const sessionCreds = path.join(groupSessionsDir, '.credentials.json');
  if (fs.existsSync(rootCreds)) {
    fs.copyFileSync(rootCreds, sessionCreds);
    fs.chownSync(sessionCreds, agentUid, agentGid);
    fs.chmodSync(sessionCreds, 0o600);
  }

  // Sync skills (with per-group filtering)
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  syncSkills(skillsSrc, skillsDst, group.containerConfig?.skillsFilter, group.name);

  // Additional mounts (extra directories)
  const extraBase = path.join(DATA_DIR, 'extra', group.folder);
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      // Create symlink from extra/{containerBasename} → validated hostPath
      const containerBasename = path.basename(mount.containerPath);
      const linkPath = path.join(extraBase, containerBasename);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      // Remove stale symlink
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
      fs.symlinkSync(mount.hostPath, linkPath);
    }
  }

  // HOME for the child process → sessions dir so .claude/ is found
  const homeDir = path.join(DATA_DIR, 'sessions', group.folder);

  const env: Record<string, string> = {
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: ipcDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_WORKSPACE_EXTRA: fs.existsSync(extraBase) ? extraBase : '',
    HOME: homeDir,
  };

  return { env, groupDir, ipcDir };
}

/**
 * Read allowed secrets from .env for passing to the agent process.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

// Claude Code OAuth token endpoint and client ID (from SDK source)
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh 10 minutes before expiry
const OAUTH_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/**
 * Proactively refresh Claude OAuth credentials if they are expired or expiring soon.
 *
 * The SDK's auto-refresh only runs proactively (within a window before expiry),
 * NOT reactively when the token is already expired. Calling this before spawning
 * the agent ensures the SDK always starts with a fresh token.
 *
 * On success, writes the refreshed credentials back to the session file AND
 * copies them to the root ~/.claude/ location for future sessions.
 */
async function refreshOAuthIfNeeded(
  sessionCredFile: string,
  agentUid: number,
  agentGid: number,
): Promise<void> {
  if (!fs.existsSync(sessionCredFile)) return;

  let creds: ClaudeCredentials;
  try {
    creds = JSON.parse(fs.readFileSync(sessionCredFile, 'utf8')) as ClaudeCredentials;
  } catch {
    return; // Not parseable — let the SDK handle it
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken || !oauth?.accessToken) return;

  // Check if token needs refresh
  const now = Date.now();
  if (oauth.expiresAt && oauth.expiresAt > now + OAUTH_REFRESH_THRESHOLD_MS) {
    return; // Still fresh — no refresh needed
  }

  logger.info({ credFile: sessionCredFile }, 'OAuth token expired/expiring — refreshing');

  try {
    const newTokens = await callOAuthRefresh(oauth.refreshToken);

    creds.claudeAiOauth = {
      ...oauth,
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token ?? oauth.refreshToken,
      expiresAt: now + (newTokens.expires_in ?? 3600) * 1000,
    };

    const credsJson = JSON.stringify(creds, null, 2);

    // Write refreshed creds to session file (keep agent ownership)
    fs.writeFileSync(sessionCredFile, credsJson, { mode: 0o600 });
    try { fs.chownSync(sessionCredFile, agentUid, agentGid); } catch { /* ignore */ }

    // Propagate to root ~/.claude/ so future sessions start fresh
    const rootCredFile = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
    try {
      fs.writeFileSync(rootCredFile, credsJson, { mode: 0o600 });
    } catch { /* root fs write may fail if dir doesn't exist */ }

    const newExpiry = new Date(creds.claudeAiOauth.expiresAt).toISOString();
    logger.info({ newExpiry }, 'OAuth token refreshed successfully');
  } catch (err) {
    logger.warn({ err }, 'OAuth token refresh failed — proceeding with expired token');
  }
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function callOAuthRefresh(refreshToken: string): Promise<OAuthTokenResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });

    const req = https.request({
      hostname: 'platform.claude.com',
      path: '/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data) as OAuthTokenResponse);
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${e}`));
          }
        } else {
          reject(new Error(`Token refresh HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('OAuth refresh timeout'));
    });
    req.write(body);
    req.end();
  });
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const entryPoint = getAgentRunnerEntry();

  const agentUid = parseInt(process.env.AGENT_UID || '999', 10);
  const agentGid = parseInt(process.env.AGENT_GID || '987', 10);

  const { env: workspaceEnv, groupDir, ipcDir } = setupWorkspace(group, input.isMain);

  // Proactively refresh OAuth credentials before spawning the agent.
  // The SDK only auto-refreshes while a session is running (not at startup),
  // so we must ensure the token is fresh before handing it to the agent.
  const sessionCredFile = path.join(DATA_DIR, 'sessions', group.folder, '.claude', '.credentials.json');
  await refreshOAuthIfNeeded(sessionCredFile, agentUid, agentGid);

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      workspaceGroup: workspaceEnv.NANOCLAW_WORKSPACE_GROUP,
      workspaceIpc: workspaceEnv.NANOCLAW_WORKSPACE_IPC,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Build child process env: inherit system env + workspace vars + secrets via stdin
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...workspaceEnv,
    // Prevent NODE_OPTIONS from parent leaking (e.g., --inspect)
    NODE_OPTIONS: '',
  };
  // Remove CLAUDECODE so child Claude Code doesn't think it's a nested session
  delete childEnv.CLAUDECODE;

  // Spawn as non-root user if running as root (Claude Code refuses --dangerously-skip-permissions as root)
  const spawnOptions: Parameters<typeof spawn>[2] = {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    env: childEnv,
  };
  if (process.getuid?.() === 0) {
    spawnOptions.uid = agentUid;
    spawnOptions.gid = agentGid;
    // HOME stays as /root — the agent user (docker group) has r/w access
    // to /root/.claude/.credentials.json for OAuth token read/refresh.
  }

  return new Promise((resolve) => {
    const child = spawn('node', [entryPoint], spawnOptions);

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk)
    input.secrets = readSecrets();
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Process stdout truncated due to size limit',
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
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Process stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Process timeout, sending SIGTERM');
      child.kill('SIGTERM');
      // Force kill after 15s if SIGTERM doesn't work
      setTimeout(() => {
        if (!child.killed) {
          logger.warn({ group: group.name, processName }, 'SIGTERM failed, force killing');
          child.kill('SIGKILL');
        }
      }, 15_000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Sync credentials back to root so the next session starts with fresh tokens.
      // The SDK may have refreshed the token mid-session; propagate that back.
      const rootCredFile = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
      if (fs.existsSync(sessionCredFile)) {
        try {
          fs.copyFileSync(sessionCredFile, rootCredFile);
          fs.chmodSync(rootCredFile, 0o600);
        } catch { /* ignore — root fs */ }
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `process-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Process Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Process timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Process timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `process-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Process Run Log ===`,
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
          `=== Workspace Env ===`,
          Object.entries(workspaceEnv).map(([k, v]) => `${k}=${v}`).join('\n'),
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
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Process log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, stdout, logFile },
          'Process exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Process completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
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

        logger.info(
          { group: group.name, duration, status: output.status, hasResult: !!output.result },
          'Process completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse process output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse process output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, processName, error: err }, 'Process spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Process spawn error: ${err.message}`,
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
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
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
