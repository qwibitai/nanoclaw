import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { isErrnoException, isSyntaxError } from './error-utils.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { syncDirectoryEntries } from './host-agent-assets.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const RUNNER_DIR = path.join(process.cwd(), 'runners', 'agent-runner');
const RUNNER_ENTRY = path.join(RUNNER_DIR, 'dist', 'index.js');
const CLAUDE_UNAVAILABLE_RE =
  /(rate_limit_event|you've hit your limit|not logged in|please run \/login|authentication_failed)/i;

export interface ClaudeHostInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  script?: string;
  assistantName?: string;
}

export interface ClaudeHostOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

function ensureClaudeSessionSettings(configDir: string): void {
  const settingsFile = path.join(configDir, 'settings.json');
  const existing = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
    : {};
  const merged = {
    ...existing,
    env: {
      ...(existing.env || {}),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n');
}

function readClaudeUserSettingsEnv(): Record<string, string> {
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as {
      env?: Record<string, string>;
    };
    return parsed.env || {};
  } catch (err) {
    if (!isSyntaxError(err) && !isErrnoException(err, 'ENOENT')) throw err;
    return {};
  }
}

function hasValidLocalClaudeCredentials(): boolean {
  const credentialsFile = path.join(
    os.homedir(),
    '.claude',
    '.credentials.json',
  );
  if (!fs.existsSync(credentialsFile)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const accessToken = data.claudeAiOauth?.accessToken;
    const expiresAt = data.claudeAiOauth?.expiresAt;
    if (!accessToken) return false;
    if (typeof expiresAt !== 'number') return true;
    return expiresAt > Date.now();
  } catch (err) {
    if (!isSyntaxError(err) && !isErrnoException(err, 'ENOENT')) throw err;
    return false;
  }
}

function getLocalClaudeOauthAccessToken(): string | undefined {
  const credentialsFile = path.join(
    os.homedir(),
    '.claude',
    '.credentials.json',
  );
  if (!fs.existsSync(credentialsFile)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const accessToken = data.claudeAiOauth?.accessToken;
    const expiresAt = data.claudeAiOauth?.expiresAt;
    if (!accessToken) return undefined;
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
      return undefined;
    }
    return accessToken;
  } catch (err) {
    if (!isSyntaxError(err) && !isErrnoException(err, 'ENOENT')) throw err;
    return undefined;
  }
}

function prepareClaudeHostEnvironment(
  group: RegisteredGroup,
  input: ClaudeHostInput,
): { env: NodeJS.ProcessEnv; groupDir: string; processName: string } {
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const ipcDir = resolveGroupIpcPath(group.folder);
  const sessionRoot = path.join(DATA_DIR, 'sessions', group.folder);
  const claudeConfigDir = path.join(sessionRoot, '.claude');
  const skillsDir = path.join(claudeConfigDir, 'skills');

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  ensureClaudeSessionSettings(claudeConfigDir);
  syncDirectoryEntries(
    [
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(groupDir, '.claude', 'skills'),
      path.join(process.cwd(), 'container', 'skills'),
    ],
    skillsDir,
  );

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  const currentPath = process.env.PATH || '';
  const homebrewBin = '/opt/homebrew/bin';
  const pathValue = currentPath.includes(homebrewBin)
    ? currentPath
    : `${homebrewBin}:${currentPath || '/usr/local/bin:/usr/bin:/bin'}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathValue,
    TZ: TIMEZONE,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };

  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
  ]);
  const shouldUseEnvClaudeOauthOverride = !hasValidLocalClaudeCredentials();
  const localClaudeOauthAccessToken = getLocalClaudeOauthAccessToken();
  const userClaudeSettingsEnv = readClaudeUserSettingsEnv();
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
  ] as const) {
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN') {
      const value =
        localClaudeOauthAccessToken ||
        (shouldUseEnvClaudeOauthOverride
          ? envVars[key] || process.env[key]
          : undefined);
      if (value) env[key] = value;
      continue;
    }
    const value = envVars[key] || process.env[key];
    if (value) env[key] = value;
  }

  const config = group.containerConfig;
  if (config?.model) env.CLAUDE_MODEL = config.model;
  if (config?.reasoningEffort) env.CLAUDE_EFFORT = config.reasoningEffort;
  if (config?.thinkingBudget !== undefined) {
    env.CLAUDE_THINKING_BUDGET = String(config.thinkingBudget);
  }
  if (config?.thinking !== undefined) {
    env.CLAUDE_THINKING = config.thinking ? '1' : '0';
  }
  if (config?.providerPreset === 'ollama') {
    const baseUrl =
      userClaudeSettingsEnv.ANTHROPIC_BASE_URL || 'http://localhost:11434';
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN =
      userClaudeSettingsEnv.ANTHROPIC_AUTH_TOKEN || 'ollama';
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (config?.providerPreset === 'anthropic') {
    if (envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL =
        envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    } else {
      delete env.ANTHROPIC_BASE_URL;
    }
  }

  return { env, groupDir, processName };
}

export async function runClaudeHostAgent(
  group: RegisteredGroup,
  input: ClaudeHostInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ClaudeHostOutput) => Promise<void>,
): Promise<ClaudeHostOutput> {
  const startTime = Date.now();
  if (!fs.existsSync(RUNNER_ENTRY)) {
    return {
      status: 'error',
      result: null,
      error:
        'Claude host runner is not built. Run `cd container/agent-runner && npm install && npm run build`.',
    };
  }

  const { env, groupDir, processName } = prepareClaudeHostEnvironment(
    group,
    input,
  );
  const logsDir = path.join(groupDir, 'logs');

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [RUNNER_ENTRY], {
      cwd: RUNNER_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, processName);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;
    let streamedError: ClaudeHostOutput | null = null;
    let earlyUnavailableError: string | null = null;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Claude host runner timed out',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (!onOutput) return;

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
          const parsed: ClaudeHostOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) newSessionId = parsed.newSessionId;
          hadStreamingOutput = true;
          if (parsed.status === 'error') {
            streamedError = parsed;
          }
          resetTimeout();
          outputChain = outputChain.then(() => onOutput(parsed));
        } catch (err) {
          if (!isSyntaxError(err)) throw err;
          logger.warn(
            { group: group.name, err },
            'Failed to parse Claude runner output',
          );
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ group: group.folder }, line);
      }
      if (!earlyUnavailableError && CLAUDE_UNAVAILABLE_RE.test(chunk)) {
        earlyUnavailableError = chunk.trim();
        logger.warn(
          { group: group.name, processName },
          'Claude host runner detected an unavailable state and will stop early',
        );
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          if (!isErrnoException(err, 'ESRCH')) throw err;
        }
      }
      resetTimeout();
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `claude-host-${timestamp}.log`);

      fs.writeFileSync(
        logFile,
        [
          '=== Claude Host Runner Log ===',
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Stdout Truncated: ${stdoutTruncated}`,
          `Stderr Truncated: ${stderrTruncated}`,
          '',
          '=== Stderr ===',
          stderr,
          '',
          '=== Stdout ===',
          stdout,
        ].join('\n'),
      );

      if (timedOut) {
        if (hadStreamingOutput) {
          outputChain.then(() =>
            resolve({ status: 'success', result: null, newSessionId }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Claude host runner timed out after ${configTimeout}ms`,
        });
        return;
      }

      const rawOutput = stdout
        .replace(
          new RegExp(
            `${OUTPUT_START_MARKER}[\\s\\S]*?${OUTPUT_END_MARKER}`,
            'g',
          ),
          '',
        )
        .trim();
      if (code !== 0) {
        outputChain.then(() =>
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error:
              earlyUnavailableError ||
              streamedError?.error ||
              stderr ||
              `Claude host runner exited with code ${code}`,
          }),
        );
        return;
      }

      if (streamedError) {
        outputChain.then(() =>
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error:
              earlyUnavailableError ||
              streamedError?.error ||
              stderr ||
              'Claude host runner reported an error',
          }),
        );
        return;
      }

      if (hadStreamingOutput) {
        outputChain.then(() =>
          resolve({ status: 'success', result: null, newSessionId }),
        );
        return;
      }

      resolve({
        status: 'success',
        result: rawOutput || null,
        newSessionId,
      });
    });
  });
}
