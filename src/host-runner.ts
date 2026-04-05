/**
 * Host Runner for NanoClaw
 * Runs agent-runner directly on the host (no container).
 * Drop-in replacement for container-runner when HOST_MODE=true.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Re-export shared types and helpers from container-runner
export {
  ContainerInput,
  ContainerOutput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  AvailableGroup,
} from './container-runner.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

let cachedClaudePath: string | undefined;
function findClaudePath(): string {
  if (cachedClaudePath) return cachedClaudePath;
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cachedClaudePath = p;
      return p;
    }
  }
  try {
    cachedClaudePath = execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    cachedClaudePath = '';
  }
  return cachedClaudePath;
}

function buildEnvironment(
  group: RegisteredGroup,
  input: ContainerInput,
  ipcDir: string,
  groupDir: string,
  globalDir: string,
  extraDir: string,
  claudeHome: string,
): Record<string, string> {
  // Read auth credentials from .env — systemd doesn't load .env into process.env
  const dotenvAuth = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  // Ensure node/npx are on PATH (systemd may not have asdf/nvm paths)
  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const augmentedPath = existingPath.includes(nodeBinDir)
    ? existingPath
    : `${nodeBinDir}:${existingPath}`;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...dotenvAuth,
    PATH: augmentedPath,
    TZ: TIMEZONE,
    // Agent-runner workspace paths (replaces container mount points)
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_EXTRA_DIR: extraDir,
    // MCP server context
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
    // Use globally installed claude CLI in host mode
    CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH || findClaudePath(),
    // Claude SDK reads settings from this directory
    CLAUDE_CONFIG_DIR: claudeHome,
  };

  return env;
}

function setupDirectories(
  group: RegisteredGroup,
  input: ContainerInput,
): {
  groupDir: string;
  ipcDir: string;
  globalDir: string;
  extraDir: string;
  claudeHome: string;
  agentRunnerDir: string;
} {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // IPC directory (same as container-runner)
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  fs.mkdirSync(globalDir, { recursive: true });

  // Extra mounts directory
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  fs.mkdirSync(extraDir, { recursive: true });

  // Symlink additional mounts into extra dir
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const hostPath = mount.hostPath.replace(/^~/, process.env.HOME || '');
      const linkName = mount.containerPath
        ? path.basename(mount.containerPath)
        : path.basename(hostPath);
      const linkPath = path.join(extraDir, linkName);
      try {
        // Remove stale symlink
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(hostPath, linkPath);
      } catch (err) {
        logger.warn(
          { hostPath, linkPath, err },
          'Failed to create extra mount symlink',
        );
      }
    }
  }

  // Per-group Claude sessions directory
  const claudeHome = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  const settingsFile = path.join(claudeHome, 'settings.json');
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
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(claudeHome, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Copy agent-runner source into a per-group writable location
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const agentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(agentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(agentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, agentRunnerDir, { recursive: true });
    }
  }

  return { groupDir, ipcDir, globalDir, extraDir, claudeHome, agentRunnerDir };
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const projectRoot = process.cwd();

  const { groupDir, ipcDir, globalDir, extraDir, claudeHome, agentRunnerDir } =
    setupDirectories(group, input);

  const env = buildEnvironment(
    group,
    input,
    ipcDir,
    groupDir,
    globalDir,
    extraDir,
    claudeHome,
  );

  // Build the agent-runner inside its own package directory so node_modules
  // resolution works naturally (no symlinks needed).
  const agentRunnerPkg = path.join(projectRoot, 'container', 'agent-runner');
  const buildDir = path.join(agentRunnerPkg, 'dist');
  fs.mkdirSync(buildDir, { recursive: true });

  // Compile agent-runner TypeScript
  const tsconfigPath = path.join(agentRunnerPkg, 'tsconfig.json');
  const entryPoint = path.join(buildDir, 'index.js');

  // Only recompile if source is newer than dist
  const srcFile = path.join(agentRunnerPkg, 'src', 'index.ts');
  const srcMtime = fs.existsSync(srcFile) ? fs.statSync(srcFile).mtimeMs : 0;
  const distMtime = fs.existsSync(entryPoint)
    ? fs.statSync(entryPoint).mtimeMs
    : 0;

  if (srcMtime > distMtime) {
    const { execSync } = await import('child_process');
    try {
      const npxPath = path.join(path.dirname(process.execPath), 'npx');
      execSync(`${npxPath} tsc --project ${tsconfigPath}`, {
        cwd: agentRunnerPkg,
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to compile agent-runner');
      return {
        status: 'error',
        result: null,
        error: `Failed to compile agent-runner: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-host-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      groupDir,
      ipcDir,
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [entryPoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: groupDir,
      env,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Streaming output parser (identical to container-runner)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

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
            outputChain = outputChain.then(() =>
              onOutput(parsed).catch((err) =>
                logger.error(
                  { group: group.name, error: err },
                  'Output callback failed',
                ),
              ),
            );
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ host: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, killing',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Host agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Host agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Host Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
      ];

      const isError = code !== 0;
      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Host agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Host agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker
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
          { group: group.name, duration, status: output.status },
          'Host agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse host agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Host agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Host agent spawn error: ${err.message}`,
      });
    });
  });
}
