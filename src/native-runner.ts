/**
 * Native Runner for NanoClaw
 * Spawns the agent-runner as a direct child process on the host,
 * bypassing Docker entirely. Same IPC protocol, same stdin/stdout JSON.
 *
 * Use RUNTIME_MODE=native in .env to activate.
 */
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
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  ContainerInput,
  ContainerOutput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  AvailableGroup,
} from './container-runner.js';

// Re-export types used by index.ts and task-scheduler.ts
export {
  ContainerInput,
  ContainerOutput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
};
export type { AvailableGroup };

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Build environment variables for the native agent-runner process.
 * Maps container paths to real host paths via env vars.
 */
function buildNativeEnv(
  group: RegisteredGroup,
  isMain: boolean,
): Record<string, string> {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  // Per-group Claude sessions directory (same structure as container mode)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Ensure settings.json exists (same as container-runner.ts)
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

  // Sync skills from container/skills/ into ~/.claude/skills/ (the actual path
  // the Claude SDK agent reads from, since HOME = os.homedir() in native mode).
  // container/skills/ is the git-versioned source of truth; this keeps the live
  // skills dir in sync on every agent run without manual copying.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(os.homedir(), '.claude', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Ensure IPC dirs exist
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Build extra mounts paths (for additionalDirectories)
  const extraDir = path.join(DATA_DIR, 'native-extra', group.folder);
  fs.mkdirSync(extraDir, { recursive: true });

  // Symlink additional mounts into the extra directory
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      const linkName =
        mount.containerPath.split('/').pop() || path.basename(mount.hostPath);
      const linkPath = path.join(extraDir, linkName);
      try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(mount.hostPath, linkPath);
      } catch (err) {
        logger.warn({ mount, err }, 'Failed to symlink additional mount');
      }
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');

  // Read credentials from .env or process.env for direct SDK access
  const envFile = path.join(projectRoot, '.env');
  let envVars: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) envVars[match[1]] = match[2];
    }
  }

  return {
    // Inherit host environment (tools, PATH, etc.)
    ...(process.env as Record<string, string>),
    // Path remapping for the agent-runner
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_WORKSPACE_EXTRA: extraDir,
    NANOCLAW_WORKSPACE_PROJECT: isMain ? projectRoot : '',
    NANOCLAW_CLAUDE_HOME: groupSessionsDir,
    NANOCLAW_IPC_INPUT: path.join(groupIpcDir, 'input'),
    NANOCLAW_IPC_DIR: groupIpcDir,
    // Timezone
    TZ: TIMEZONE,
    // SDK credentials — pass directly, no proxy needed
    ...(envVars.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: envVars.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
    ...(envVars.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: envVars.ANTHROPIC_API_KEY }
      : {}),
    // Auto-compact window
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    // Keep HOME as the real user home so SSH keys, gh auth, and git config work.
    // The Claude SDK reads ~/.claude/skills from here. Skills are synced to
    // os.homedir()/.claude/skills by buildNativeEnv (see skills sync below).
    HOME: os.homedir(),
  };
}

/**
 * Find the compiled agent-runner entry point.
 * In native mode, we compile it once and reuse.
 */
function getAgentRunnerPath(group: RegisteredGroup): string {
  const projectRoot = process.cwd();

  // Use per-group agent-runner source (same as container mode — groups can customize)
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
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

  // Symlink node_modules into the group dir so tsx can resolve dependencies
  // relative to the source file location (not cwd).
  const nodeModulesLink = path.join(groupAgentRunnerDir, 'node_modules');
  const nodeModulesSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'node_modules',
  );
  if (fs.existsSync(nodeModulesSrc) && !fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(nodeModulesSrc, nodeModulesLink);
  }

  // Return the TypeScript source — we'll run it with tsx
  return path.join(groupAgentRunnerDir, 'index.ts');
}

export async function runNativeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-native-${safeName}-${Date.now()}`;
  const env = buildNativeEnv(group, input.isMain);
  const agentRunnerPath = getAgentRunnerPath(group);

  // Install agent-runner dependencies if needed
  const agentRunnerDir = path.join(process.cwd(), 'container', 'agent-runner');
  const nodeModules = path.join(agentRunnerDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    logger.info('Installing agent-runner dependencies...');
    const { execSync } = await import('child_process');
    execSync('npm install', { cwd: agentRunnerDir, stdio: 'pipe' });
  }

  // Set NODE_PATH so the agent-runner can find its dependencies
  env.NODE_PATH = nodeModules;

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      agentRunner: agentRunnerPath,
    },
    'Spawning native agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Run agent-runner TypeScript directly via tsx.
    // Use process.execPath (absolute node path) to find npx in the same dir,
    // avoiding PATH issues in launchd/systemd environments.
    // The agent-runner source is in a per-group copy dir but its dependencies
    // live in container/agent-runner/node_modules — set NODE_PATH accordingly.
    const nodeBinDir = path.dirname(process.execPath);
    const npxPath = path.join(nodeBinDir, 'npx');
    const agentRunnerNodeModules = path.join(agentRunnerDir, 'node_modules');
    const proc = spawn(npxPath, ['tsx', agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...env,
        PATH: `${nodeBinDir}:${env.PATH || ''}`,
        NODE_PATH: agentRunnerNodeModules,
      },
      cwd: agentRunnerDir,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Streaming output parsing (identical to container-runner.ts)
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

    proc.stderr.on('data', (data) => {
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
        'Native agent timeout, killing',
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
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Native agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `native-${timestamp}.log`);
      const logLines = [
        `=== Native Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
      ];
      if (code !== 0) {
        logLines.push(`=== Stderr ===`, stderr, ``, `=== Stdout ===`, stdout);
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          'Native agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Native agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Native agent completed',
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
          'Native agent completed',
        );
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse native agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, error: err },
        'Native agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Native agent spawn error: ${err.message}`,
      });
    });
  });
}
